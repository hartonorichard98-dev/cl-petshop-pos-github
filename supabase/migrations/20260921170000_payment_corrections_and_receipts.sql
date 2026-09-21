create table if not exists public.pos_receipt_sequences (
  store_id uuid not null references public.stores(id) on delete cascade,
  month_key text not null,
  last_number bigint not null default 0,
  primary key (store_id, month_key)
);

alter table public.sales
  add column if not exists payment_edit_history jsonb not null default '[]'::jsonb;

alter table public.sales
  drop constraint if exists sales_payment_edit_history_check;

alter table public.sales
  add constraint sales_payment_edit_history_check
  check (jsonb_typeof(payment_edit_history) = 'array');

alter table public.pos_receipt_sequences enable row level security;
revoke all on table public.pos_receipt_sequences from anon, authenticated;

with numbered as (
  select id,
         to_char(business_date, 'DDMMYY') || '-' ||
         lpad(row_number() over (
           partition by store_id, date_trunc('month', business_date)
           order by created_at, id
         )::text, 4, '0') as new_receipt
  from public.sales
)
update public.sales sales
set receipt_number = numbered.new_receipt
from numbered
where numbered.id = sales.id;

insert into public.pos_receipt_sequences (store_id, month_key, last_number)
select store_id, to_char(business_date, 'YYYYMM'), count(*)
from public.sales
group by store_id, to_char(business_date, 'YYYYMM')
on conflict (store_id, month_key) do update
set last_number = greatest(public.pos_receipt_sequences.last_number, excluded.last_number);

create or replace function public.assign_pos_receipt_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  receipt_month text;
  receipt_number bigint;
  existing_receipt text;
begin
  select receipt_number into existing_receipt
  from public.sales
  where store_id = new.store_id and id = new.id;

  if existing_receipt is not null then
    new.receipt_number := existing_receipt;
    return new;
  end if;

  receipt_month := to_char(new.business_date, 'YYYYMM');
  perform pg_advisory_xact_lock(hashtextextended(new.store_id::text || receipt_month, 0));

  insert into public.pos_receipt_sequences (store_id, month_key, last_number)
  values (
    new.store_id,
    receipt_month,
    (
      select count(*)
      from public.sales existing
      where existing.store_id = new.store_id
        and to_char(existing.business_date, 'YYYYMM') = receipt_month
    )
  )
  on conflict (store_id, month_key) do nothing;

  update public.pos_receipt_sequences
  set last_number = last_number + 1
  where store_id = new.store_id and month_key = receipt_month
  returning last_number into receipt_number;

  new.receipt_number := to_char(new.business_date, 'DDMMYY') || '-' ||
    case when receipt_number < 10000 then lpad(receipt_number::text, 4, '0') else receipt_number::text end;
  return new;
end;
$$;

drop trigger if exists assign_pos_receipt_number_trigger on public.sales;
create trigger assign_pos_receipt_number_trigger
before insert on public.sales
for each row execute function public.assign_pos_receipt_number();

create or replace function public.pos_update_sale_payment(
  p_api_secret text,
  p_store_id uuid,
  p_username text,
  p_pin text,
  p_sale_id uuid,
  p_payment_method text,
  p_payment_breakdown jsonb,
  p_cash_received bigint,
  p_reason text,
  p_edit_id text,
  p_edited_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  staff public.pos_staff_credentials;
  expected_secret_hash text;
  existing_sale public.sales;
  normalized_breakdown jsonb;
  previous_label text;
  updated_label text;
begin
  select api_secret_hash into expected_secret_hash
  from public.pos_sync_config
  where store_id = p_store_id;

  if expected_secret_hash is null
     or encode(digest(p_api_secret, 'sha256'), 'hex') <> expected_secret_hash then
    raise exception 'Invalid sync secret';
  end if;

  select * into staff
  from public.pos_staff_credentials
  where store_id = p_store_id
    and username = lower(btrim(p_username))
    and active = true;

  if staff.store_id is null or not (staff.pin_hash = crypt(p_pin, staff.pin_hash)) then
    raise exception 'Invalid POS login';
  end if;

  select * into existing_sale
  from public.sales
  where store_id = p_store_id and id = p_sale_id
  for update;

  if existing_sale.id is null then
    return false;
  end if;

  if existing_sale.status <> 'completed' then
    raise exception 'Only completed sales can change payment';
  end if;

  if p_payment_method not in ('cash', 'qris', 'transfer', 'debit', 'split') then
    raise exception 'Invalid payment method';
  end if;

  normalized_breakdown := case
    when p_payment_method = 'split' then p_payment_breakdown
    else jsonb_build_array(jsonb_build_object('method', p_payment_method, 'amount', existing_sale.total))
  end;

  if p_payment_method = 'split' and (
    jsonb_typeof(normalized_breakdown) <> 'array'
    or jsonb_array_length(normalized_breakdown) <> 2
    or exists (
      select 1 from jsonb_array_elements(normalized_breakdown) part
      where part->>'method' not in ('cash', 'qris', 'transfer', 'debit')
         or coalesce((part->>'amount')::bigint, 0) <= 0
    )
    or (select count(distinct part->>'method') from jsonb_array_elements(normalized_breakdown) part) <> 2
    or (select coalesce(sum((part->>'amount')::bigint), 0) from jsonb_array_elements(normalized_breakdown) part) <> existing_sale.total
  ) then
    raise exception 'Invalid split payment payload';
  end if;

  previous_label := existing_sale.payment_method || ' ' || existing_sale.payment_breakdown::text;
  updated_label := p_payment_method || ' ' || normalized_breakdown::text;

  update public.sales
  set payment_method = p_payment_method,
      payment_breakdown = normalized_breakdown,
      payment_edit_history = case
        when payment_edit_history @> jsonb_build_array(jsonb_build_object('id', p_edit_id)) then payment_edit_history
        else payment_edit_history || jsonb_build_array(jsonb_build_object(
          'id', p_edit_id,
          'actor', staff.display_name,
          'role', staff.role,
          'reason', coalesce(nullif(btrim(p_reason), ''), '-'),
          'before', previous_label,
          'after', updated_label,
          'createdAt', coalesce(p_edited_at, now())
        ))
      end,
      cash_received = greatest(coalesce(p_cash_received, 0), 0),
      change_due = 0,
      correction_reason = nullif(btrim(p_reason), ''),
      updated_at = coalesce(p_edited_at, now())
  where store_id = p_store_id and id = p_sale_id;

  insert into public.audit_logs (
    id, store_id, actor_id, actor_name, actor_role,
    action, entity_id, detail, created_at
  ) values (
    left(coalesce(nullif(btrim(p_edit_id), ''), gen_random_uuid()::text), 120),
    p_store_id, null, staff.display_name, staff.role,
    'UPDATE_PAYMENT', p_sale_id::text,
    existing_sale.receipt_number || ' · ' || previous_label || ' menjadi ' || updated_label || ' · alasan: ' || coalesce(nullif(btrim(p_reason), ''), '-'),
    coalesce(p_edited_at, now())
  ) on conflict (id) do nothing;

  return true;
end;
$$;

revoke execute on function public.pos_update_sale_payment(text, uuid, text, text, uuid, text, jsonb, bigint, text, text, timestamptz) from public;
grant execute on function public.pos_update_sale_payment(text, uuid, text, text, uuid, text, jsonb, bigint, text, text, timestamptz) to anon, authenticated;

create or replace function public.pos_pull_audit_logs(
  p_api_secret text,
  p_store_id uuid,
  p_username text,
  p_pin text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  staff public.pos_staff_credentials;
  expected_secret_hash text;
  pulled_logs jsonb;
begin
  select api_secret_hash into expected_secret_hash
  from public.pos_sync_config
  where store_id = p_store_id;

  if expected_secret_hash is null
     or encode(digest(p_api_secret, 'sha256'), 'hex') <> expected_secret_hash then
    raise exception 'Invalid sync secret';
  end if;

  select * into staff
  from public.pos_staff_credentials
  where store_id = p_store_id
    and username = lower(btrim(p_username))
    and active = true;

  if staff.store_id is null or not (staff.pin_hash = crypt(p_pin, staff.pin_hash)) then
    raise exception 'Invalid POS login';
  end if;

  if staff.role <> 'owner' then
    return '[]'::jsonb;
  end if;

  select coalesce(jsonb_agg(to_jsonb(logs) order by logs.created_at desc), '[]'::jsonb)
  into pulled_logs
  from (
    select id, actor_name, actor_role, action, entity_id, detail, created_at
    from public.audit_logs
    where store_id = p_store_id
    order by created_at desc
    limit 5000
  ) logs;

  return pulled_logs;
end;
$$;

revoke execute on function public.pos_pull_audit_logs(text, uuid, text, text) from public;
grant execute on function public.pos_pull_audit_logs(text, uuid, text, text) to anon, authenticated;
