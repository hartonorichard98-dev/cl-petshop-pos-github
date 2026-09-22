alter table public.expenses
  add column if not exists expense_type text not null default 'cash' check (expense_type in ('cash', 'goods')),
  add column if not exists product_local_id bigint,
  add column if not exists product_name text,
  add column if not exists quantity integer,
  add column if not exists unit_value bigint;

create table if not exists public.inventory_movements (
  id uuid primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  movement_type text not null check (movement_type in ('sale', 'sale_adjustment', 'sale_edit_restore', 'sale_edit_apply', 'sale_delete', 'sale_void', 'goods_expense', 'repack', 'receiving', 'stock_adjustment')),
  reference_id text not null,
  changes jsonb not null check (jsonb_typeof(changes) = 'array'),
  note text,
  actor_name text not null,
  created_at timestamptz not null
);

create index if not exists inventory_movements_store_created_idx
  on public.inventory_movements (store_id, created_at desc);

alter table public.inventory_movements enable row level security;
revoke all on table public.inventory_movements from anon, authenticated;

create or replace function public.pos_sync_inventory(
  p_api_secret text,
  p_store_id uuid,
  p_username text,
  p_pin text,
  p_movements jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  staff public.pos_staff_credentials;
  expected_secret_hash text;
  movement jsonb;
  change_item jsonb;
  inserted_id uuid;
  product_local_id bigint;
  quantity_delta integer;
  pulled_products jsonb;
  pulled_movements jsonb;
begin
  select api_secret_hash into expected_secret_hash from public.pos_sync_config where store_id = p_store_id;
  if expected_secret_hash is null or encode(digest(p_api_secret, 'sha256'), 'hex') <> expected_secret_hash then
    raise exception 'Invalid sync secret';
  end if;
  select * into staff from public.pos_staff_credentials
    where store_id = p_store_id and username = lower(btrim(p_username)) and active = true;
  if staff.store_id is null or not (staff.pin_hash = crypt(p_pin, staff.pin_hash)) then
    raise exception 'Invalid POS login';
  end if;
  if jsonb_typeof(coalesce(p_movements, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_movements, '[]'::jsonb)) > 500 then
    raise exception 'Invalid inventory movement batch';
  end if;
  for movement in select value from jsonb_array_elements(coalesce(p_movements, '[]'::jsonb)) loop
    inserted_id := null;
    insert into public.inventory_movements (id, store_id, movement_type, reference_id, changes, note, actor_name, created_at)
    values (
      (movement->>'id')::uuid, p_store_id, movement->>'type', coalesce(nullif(btrim(movement->>'referenceId'), ''), movement->>'id'),
      coalesce(movement->'changes', '[]'::jsonb), nullif(btrim(movement->>'note'), ''),
      coalesce(nullif(btrim(movement->>'createdBy'), ''), staff.display_name),
      coalesce(nullif(movement->>'createdAt', '')::timestamptz, now())
    ) on conflict (id) do nothing returning id into inserted_id;
    if inserted_id is not null then
      for change_item in select value from jsonb_array_elements(coalesce(movement->'changes', '[]'::jsonb)) loop
        product_local_id := (change_item->>'productId')::bigint;
        quantity_delta := (change_item->>'quantityDelta')::integer;
        if quantity_delta = 0 then raise exception 'Invalid zero inventory delta'; end if;
        update public.products set stock = stock + quantity_delta, track_stock = true, updated_at = now()
          where store_id = p_store_id and local_id = product_local_id;
        if not found then raise exception 'Inventory product not found'; end if;
      end loop;
    end if;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(products) order by products.local_id), '[]'::jsonb) into pulled_products
    from public.products where store_id = p_store_id;
  select coalesce(jsonb_agg(row_data order by row_data->>'created_at'), '[]'::jsonb) into pulled_movements from (
    select to_jsonb(inventory_movements) as row_data from public.inventory_movements
    where store_id = p_store_id order by created_at desc limit 1000
  ) latest_movements;
  return jsonb_build_object('products', pulled_products, 'movements', pulled_movements);
end;
$$;

revoke execute on function public.pos_sync_inventory(text, uuid, text, text, jsonb) from public;
grant execute on function public.pos_sync_inventory(text, uuid, text, text, jsonb) to anon, authenticated;

create or replace function public.pos_sync_expenses(
  p_api_secret text, p_store_id uuid, p_username text, p_pin text, p_expenses jsonb
)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  staff public.pos_staff_credentials;
  expected_secret_hash text;
  expense jsonb;
  expense_id uuid;
  incoming_updated timestamptz;
  changed_count integer;
  pulled_expenses jsonb;
begin
  select api_secret_hash into expected_secret_hash from public.pos_sync_config where store_id = p_store_id;
  if expected_secret_hash is null or encode(digest(p_api_secret, 'sha256'), 'hex') <> expected_secret_hash then raise exception 'Invalid sync secret'; end if;
  select * into staff from public.pos_staff_credentials where store_id = p_store_id and username = lower(btrim(p_username)) and active = true;
  if staff.store_id is null or not (staff.pin_hash = crypt(p_pin, staff.pin_hash)) then raise exception 'Invalid POS login'; end if;
  if jsonb_typeof(coalesce(p_expenses, '[]'::jsonb)) <> 'array' then raise exception 'Invalid expense payload'; end if;
  for expense in select value from jsonb_array_elements(coalesce(p_expenses, '[]'::jsonb)) loop
    expense_id := (expense->>'id')::uuid;
    incoming_updated := coalesce(nullif(expense->>'updatedAt', '')::timestamptz, now());
    if coalesce((expense->>'amount')::bigint, 0) <= 0 or nullif(btrim(expense->>'purpose'), '') is null then raise exception 'Invalid expense payload'; end if;
    if coalesce(expense->>'status', 'active') = 'cancelled' and staff.role <> 'owner' then raise exception 'Only owner can cancel expenses'; end if;
    insert into public.expenses (id,store_id,amount,recipient,purpose,note,status,business_date,created_by,created_by_name,expense_type,product_local_id,product_name,quantity,unit_value,created_at,updated_at)
    values (expense_id,p_store_id,(expense->>'amount')::bigint,coalesce(nullif(btrim(expense->>'recipient'), ''),'Stok toko'),btrim(expense->>'purpose'),nullif(btrim(expense->>'note'), ''),case when coalesce(expense->>'status','active')='cancelled' then 'cancelled' else 'active' end,(expense->>'day')::date,null,coalesce(nullif(btrim(expense->>'createdBy'), ''),staff.display_name),case when expense->>'type'='goods' then 'goods' else 'cash' end,nullif(expense->>'productId','')::bigint,nullif(btrim(expense->>'productName'), ''),nullif(expense->>'quantity','')::integer,nullif(expense->>'unitValue','')::bigint,coalesce(nullif(expense->>'createdAt','')::timestamptz,incoming_updated),incoming_updated)
    on conflict (id) do update set amount=excluded.amount,recipient=excluded.recipient,purpose=excluded.purpose,note=excluded.note,status=excluded.status,business_date=excluded.business_date,created_by_name=excluded.created_by_name,expense_type=excluded.expense_type,product_local_id=excluded.product_local_id,product_name=excluded.product_name,quantity=excluded.quantity,unit_value=excluded.unit_value,updated_at=excluded.updated_at where excluded.updated_at > public.expenses.updated_at;
    get diagnostics changed_count = row_count;
    if changed_count > 0 then
      insert into public.audit_logs (id,store_id,actor_id,actor_name,actor_role,action,entity_id,detail,created_at) values ('expense-sync-'||expense_id::text||'-'||md5(incoming_updated::text),p_store_id,null,staff.display_name,staff.role,case when expense->>'type'='goods' then 'SYNC_GOODS_EXPENSE' else 'SYNC_CASH_EXPENSE' end,expense_id::text,btrim(expense->>'purpose')||' · '||coalesce(nullif(btrim(expense->>'productName'), ''),btrim(expense->>'recipient')),incoming_updated) on conflict (id) do nothing;
    end if;
  end loop;
  select coalesce(jsonb_agg(to_jsonb(expenses) order by expenses.business_date desc, expenses.created_at desc),'[]'::jsonb) into pulled_expenses from public.expenses where store_id=p_store_id;
  return jsonb_build_object('role',staff.role,'expenses',pulled_expenses);
end;
$$;

revoke execute on function public.pos_sync_expenses(text, uuid, text, text, jsonb) from public;
grant execute on function public.pos_sync_expenses(text, uuid, text, text, jsonb) to anon, authenticated;
