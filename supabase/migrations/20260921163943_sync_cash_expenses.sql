alter table public.expenses
  add column if not exists created_by_name text not null default '';

create or replace function public.pos_sync_expenses(
  p_api_secret text,
  p_store_id uuid,
  p_username text,
  p_pin text,
  p_expenses jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  staff public.pos_staff_credentials;
  expected_secret_hash text;
  expense jsonb;
  expense_id uuid;
  incoming_updated timestamptz;
  changed_count integer;
  pulled_expenses jsonb;
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

  if jsonb_typeof(coalesce(p_expenses, '[]'::jsonb)) <> 'array' then
    raise exception 'Invalid expense payload';
  end if;

  for expense in select value from jsonb_array_elements(coalesce(p_expenses, '[]'::jsonb)) loop
    expense_id := (expense->>'id')::uuid;
    incoming_updated := coalesce(nullif(expense->>'updatedAt', '')::timestamptz, now());

    if coalesce((expense->>'amount')::bigint, 0) <= 0
       or nullif(btrim(expense->>'recipient'), '') is null
       or nullif(btrim(expense->>'purpose'), '') is null then
      raise exception 'Invalid expense payload';
    end if;

    if coalesce(expense->>'status', 'active') = 'cancelled' and staff.role <> 'owner' then
      raise exception 'Only owner can cancel expenses';
    end if;

    insert into public.expenses (
      id, store_id, amount, recipient, purpose, note, status,
      business_date, created_by, created_by_name, created_at, updated_at
    ) values (
      expense_id,
      p_store_id,
      (expense->>'amount')::bigint,
      btrim(expense->>'recipient'),
      btrim(expense->>'purpose'),
      nullif(btrim(expense->>'note'), ''),
      case when coalesce(expense->>'status', 'active') = 'cancelled' then 'cancelled' else 'active' end,
      (expense->>'day')::date,
      null,
      coalesce(nullif(btrim(expense->>'createdBy'), ''), staff.display_name),
      coalesce(nullif(expense->>'createdAt', '')::timestamptz, incoming_updated),
      incoming_updated
    )
    on conflict (id) do update set
      amount = excluded.amount,
      recipient = excluded.recipient,
      purpose = excluded.purpose,
      note = excluded.note,
      status = excluded.status,
      business_date = excluded.business_date,
      created_by_name = excluded.created_by_name,
      updated_at = excluded.updated_at
    where excluded.updated_at > public.expenses.updated_at;

    get diagnostics changed_count = row_count;
    if changed_count > 0 then
      insert into public.audit_logs (
        id, store_id, actor_id, actor_name, actor_role, action, entity_id, detail, created_at
      ) values (
        'expense-sync-' || expense_id::text || '-' || md5(incoming_updated::text),
        p_store_id,
        null,
        staff.display_name,
        staff.role,
        'SYNC_CASH_EXPENSE',
        expense_id::text,
        'Rp' || to_char((expense->>'amount')::bigint, 'FM999G999G999G999') || ' · ' || btrim(expense->>'purpose') || ' · kepada ' || btrim(expense->>'recipient'),
        incoming_updated
      )
      on conflict (id) do nothing;
    end if;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(expenses) order by expenses.business_date desc, expenses.created_at desc), '[]'::jsonb)
  into pulled_expenses
  from public.expenses
  where store_id = p_store_id;

  return jsonb_build_object(
    'role', staff.role,
    'expenses', pulled_expenses
  );
end;
$$;

grant execute on function public.pos_sync_expenses(text, uuid, text, text, jsonb) to anon, authenticated;
