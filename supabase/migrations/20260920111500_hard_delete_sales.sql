create table if not exists public.sale_deletions (
  store_id uuid not null references public.stores(id) on delete cascade,
  sale_id uuid not null,
  receipt_number text,
  reason text,
  deleted_by text not null,
  deleted_at timestamptz not null default now(),
  primary key (store_id, sale_id)
);

alter table public.sale_deletions enable row level security;

insert into public.sale_deletions (
  store_id, sale_id, receipt_number, reason, deleted_by, deleted_at
)
select
  store_id,
  id,
  receipt_number,
  correction_reason,
  coalesce(cashier_name, 'Owner CL Petshop'),
  updated_at
from public.sales
where status = 'deleted'
on conflict (store_id, sale_id) do update set
  receipt_number = excluded.receipt_number,
  reason = excluded.reason,
  deleted_by = excluded.deleted_by,
  deleted_at = excluded.deleted_at;

delete from public.sales where status = 'deleted';

create or replace function public.pos_sync_and_pull(
  p_api_secret text,
  p_store_id uuid,
  p_username text,
  p_pin text,
  p_sales jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  staff public.pos_staff_credentials;
  expected_secret_hash text;
  sale jsonb;
  sale_id uuid;
  sale_receipt text;
  sale_day date;
  sale_created timestamptz;
  sale_status public.sale_status;
  collision boolean;
  pulled_sales jsonb;
  pulled_deletions jsonb;
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
  if jsonb_typeof(p_sales) <> 'array' or jsonb_array_length(p_sales) > 250 then
    raise exception 'Invalid sales batch';
  end if;

  for sale in select value from jsonb_array_elements(p_sales) loop
    sale_id := (sale->>'id')::uuid;
    sale_receipt := left(nullif(btrim(sale->>'receipt'), ''), 80);
    sale_day := coalesce(nullif(sale->>'day', '')::date, current_date);
    sale_created := coalesce(nullif(sale->>'createdAt', '')::timestamptz, now());
    sale_status := coalesce(nullif(sale->>'status', '')::public.sale_status, 'completed');

    if sale_receipt is null or jsonb_typeof(sale->'items') <> 'array'
       or coalesce((sale->>'total')::bigint, -1) < 0
       or coalesce((sale->>'cost')::bigint, -1) < 0
       or (sale->>'paymentMethod') not in ('cash', 'qris', 'transfer', 'debit') then
      raise exception 'Invalid sale payload';
    end if;

    if sale_status = 'deleted' then
      if staff.role <> 'owner' then
        raise exception 'Only owner can delete sales';
      end if;

      insert into public.sale_deletions (
        store_id, sale_id, receipt_number, reason, deleted_by, deleted_at
      ) values (
        p_store_id,
        sale_id,
        sale_receipt,
        nullif(coalesce(sale->>'deleteReason', sale->>'reason'), ''),
        staff.display_name,
        coalesce(nullif(sale->>'deletedAt', '')::timestamptz, now())
      )
      on conflict (store_id, sale_id) do update set
        receipt_number = excluded.receipt_number,
        reason = excluded.reason,
        deleted_by = excluded.deleted_by,
        deleted_at = excluded.deleted_at;

      delete from public.sales
      where store_id = p_store_id and id = sale_id;
      continue;
    end if;

    if staff.role = 'cashier' and sale_status <> 'completed' then
      raise exception 'Cashier can only sync completed sales';
    end if;

    if exists (
      select 1 from public.sale_deletions deleted
      where deleted.store_id = p_store_id and deleted.sale_id = sale_id
    ) then
      continue;
    end if;

    select exists (
      select 1 from public.sales existing
      where existing.store_id = p_store_id
        and existing.receipt_number = sale_receipt
        and existing.id <> sale_id
    ) into collision;
    if collision then
      sale_receipt := left(sale_receipt || '-' || right(replace(sale_id::text, '-', ''), 4), 80);
    end if;

    insert into public.sales (
      id, store_id, receipt_number, cashier_id, cashier_name, items, total,
      cost_total, payment_method, cash_received, change_due, status,
      correction_reason, business_date, created_at, updated_at
    ) values (
      sale_id, p_store_id, sale_receipt, null,
      case when staff.role = 'owner'
        then coalesce(nullif(btrim(sale->>'cashier'), ''), staff.display_name)
        else staff.display_name
      end,
      sale->'items', (sale->>'total')::bigint, (sale->>'cost')::bigint,
      sale->>'paymentMethod', coalesce((sale->>'cash')::bigint, 0),
      coalesce((sale->>'change')::bigint, 0), sale_status,
      nullif(coalesce(sale->>'editReason', sale->>'reason'), ''),
      sale_day, sale_created, now()
    )
    on conflict (id) do update set
      receipt_number = excluded.receipt_number,
      cashier_name = case when staff.role = 'owner' then excluded.cashier_name else public.sales.cashier_name end,
      items = case when staff.role = 'owner' then excluded.items else public.sales.items end,
      total = case when staff.role = 'owner' then excluded.total else public.sales.total end,
      cost_total = case when staff.role = 'owner' then excluded.cost_total else public.sales.cost_total end,
      payment_method = case when staff.role = 'owner' then excluded.payment_method else public.sales.payment_method end,
      cash_received = case when staff.role = 'owner' then excluded.cash_received else public.sales.cash_received end,
      change_due = case when staff.role = 'owner' then excluded.change_due else public.sales.change_due end,
      status = case when staff.role = 'owner' then excluded.status else public.sales.status end,
      correction_reason = case when staff.role = 'owner' then excluded.correction_reason else public.sales.correction_reason end,
      business_date = case when staff.role = 'owner' then excluded.business_date else public.sales.business_date end,
      updated_at = now();
  end loop;

  select coalesce(jsonb_agg(row_data order by row_data->>'created_at' desc), '[]'::jsonb)
  into pulled_sales
  from (
    select to_jsonb(sales) || case when staff.role = 'owner'
      then '{}'::jsonb
      else jsonb_build_object('cost_total', null)
    end as row_data
    from public.sales sales
    where sales.store_id = p_store_id
  ) visible_sales;

  select coalesce(jsonb_agg(deletions.sale_id), '[]'::jsonb)
  into pulled_deletions
  from public.sale_deletions deletions
  where deletions.store_id = p_store_id;

  return jsonb_build_object(
    'role', staff.role,
    'sales', pulled_sales,
    'deleted_ids', pulled_deletions
  );
end;
$$;

revoke all on table public.sale_deletions from anon, authenticated;
revoke execute on function public.pos_sync_and_pull(text, uuid, text, text, jsonb) from public;
grant execute on function public.pos_sync_and_pull(text, uuid, text, text, jsonb) to anon, authenticated;
