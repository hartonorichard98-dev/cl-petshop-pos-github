alter table public.inventory_movements
  add column if not exists status text not null default 'active',
  add column if not exists updated_at timestamptz not null default now();

alter table public.inventory_movements drop constraint if exists inventory_movements_movement_type_check;
alter table public.inventory_movements add constraint inventory_movements_movement_type_check
  check (movement_type in ('sale', 'sale_adjustment', 'sale_edit_restore', 'sale_edit_apply', 'sale_delete', 'sale_void', 'goods_expense', 'repack', 'repack_update', 'repack_delete', 'receiving', 'stock_adjustment'));

create table if not exists public.inventory_movement_change_requests (
  id uuid primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  movement_id uuid not null references public.inventory_movements(id) on delete cascade,
  request_type text not null check (request_type in ('update', 'delete')),
  proposed_changes jsonb not null default '[]'::jsonb check (jsonb_typeof(proposed_changes) = 'array'),
  proposed_note text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  requested_by text not null,
  requested_at timestamptz not null default now(),
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text,
  updated_at timestamptz not null default now()
);

create index if not exists inventory_change_requests_store_status_idx
  on public.inventory_movement_change_requests (store_id, status, requested_at desc);
create index if not exists inventory_change_requests_movement_idx
  on public.inventory_movement_change_requests (movement_id);

alter table public.inventory_movement_change_requests enable row level security;
revoke all on table public.inventory_movement_change_requests from anon, authenticated;

create or replace function public.pos_sync_inventory(
  p_api_secret text,
  p_store_id uuid,
  p_username text,
  p_pin text,
  p_products jsonb,
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
  product_snapshot jsonb;
  movement jsonb;
  change_item jsonb;
  movement_id uuid;
  product_local_id bigint;
  quantity_delta integer;
  next_stock integer;
  rejection_reason text;
  rejected_movements jsonb := '[]'::jsonb;
  pulled_products jsonb;
  pulled_movements jsonb;
begin
  select api_secret_hash into expected_secret_hash from public.pos_sync_config where store_id = p_store_id;
  if expected_secret_hash is null or encode(digest(p_api_secret, 'sha256'), 'hex') <> expected_secret_hash then raise exception 'Invalid sync secret'; end if;
  select * into staff from public.pos_staff_credentials where store_id = p_store_id and username = lower(btrim(p_username)) and active = true;
  if staff.store_id is null or not (staff.pin_hash = crypt(p_pin, staff.pin_hash)) then raise exception 'Invalid POS login'; end if;
  if jsonb_typeof(coalesce(p_products, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_products, '[]'::jsonb)) > 500 then raise exception 'Invalid inventory product baseline'; end if;
  if jsonb_typeof(coalesce(p_movements, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_movements, '[]'::jsonb)) > 500 then raise exception 'Invalid inventory movement batch'; end if;

  for product_snapshot in select value from jsonb_array_elements(coalesce(p_products, '[]'::jsonb)) loop
    product_local_id := (product_snapshot->>'productId')::bigint;
    next_stock := greatest(coalesce((product_snapshot->>'stock')::integer, 0), 0);
    update public.products set stock = next_stock, track_stock = coalesce((product_snapshot->>'trackStock')::boolean, true), updated_at = now()
      where store_id = p_store_id and local_id = product_local_id and stock = 0 and track_stock = false
        and not exists (select 1 from public.inventory_movements existing where existing.store_id = p_store_id and existing.changes @> jsonb_build_array(jsonb_build_object('productId', product_local_id)));
  end loop;

  for movement in select value from jsonb_array_elements(coalesce(p_movements, '[]'::jsonb)) loop
    movement_id := (movement->>'id')::uuid;
    if exists (select 1 from public.inventory_movements where id = movement_id and store_id = p_store_id) then continue; end if;
    rejection_reason := null;
    if jsonb_typeof(coalesce(movement->'changes', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(movement->'changes', '[]'::jsonb)) = 0 then
      rejection_reason := 'Perubahan stok kosong';
    else
      for change_item in select value from jsonb_array_elements(movement->'changes') loop
        product_local_id := nullif(change_item->>'productId', '')::bigint;
        quantity_delta := coalesce(nullif(change_item->>'quantityDelta', '')::integer, 0);
        select stock + quantity_delta into next_stock from public.products where store_id = p_store_id and local_id = product_local_id for update;
        if next_stock is null then rejection_reason := 'Produk stok tidak ditemukan'; exit; end if;
        if quantity_delta = 0 then rejection_reason := 'Perubahan stok nol'; exit; end if;
        if next_stock < 0 then rejection_reason := 'Stok cloud tidak cukup'; exit; end if;
      end loop;
    end if;
    if rejection_reason is not null then
      rejected_movements := rejected_movements || jsonb_build_array(jsonb_build_object('id', movement_id, 'reason', rejection_reason));
      continue;
    end if;
    insert into public.inventory_movements (id, store_id, movement_type, reference_id, changes, note, actor_name, status, created_at, updated_at)
    values (movement_id, p_store_id, movement->>'type', coalesce(nullif(btrim(movement->>'referenceId'), ''), movement->>'id'), movement->'changes', nullif(btrim(movement->>'note'), ''), coalesce(nullif(btrim(movement->>'createdBy'), ''), staff.display_name), 'active', coalesce(nullif(movement->>'createdAt', '')::timestamptz, now()), now());
    for change_item in select value from jsonb_array_elements(movement->'changes') loop
      product_local_id := (change_item->>'productId')::bigint;
      quantity_delta := (change_item->>'quantityDelta')::integer;
      update public.products set stock = stock + quantity_delta, track_stock = true, updated_at = now() where store_id = p_store_id and local_id = product_local_id;
    end loop;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(products) order by products.local_id), '[]'::jsonb) into pulled_products from public.products where store_id = p_store_id and track_stock = true;
  select coalesce(jsonb_agg(row_data order by row_data->>'created_at'), '[]'::jsonb) into pulled_movements from (select to_jsonb(inventory_movements) as row_data from public.inventory_movements where store_id = p_store_id order by created_at desc limit 1000) latest_movements;
  return jsonb_build_object('products', pulled_products, 'movements', pulled_movements, 'rejected_movements', rejected_movements);
end;
$$;

revoke execute on function public.pos_sync_inventory(text, uuid, text, text, jsonb, jsonb) from public;
grant execute on function public.pos_sync_inventory(text, uuid, text, text, jsonb, jsonb) to anon, authenticated;

create or replace function public.pos_sync_inventory_change_requests(
  p_api_secret text,
  p_store_id uuid,
  p_username text,
  p_pin text,
  p_requests jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  staff public.pos_staff_credentials;
  expected_secret_hash text;
  request_item jsonb;
  request_id uuid;
  original public.inventory_movements;
  current_request public.inventory_movement_change_requests;
  desired_status text;
  adjustment_changes jsonb;
  change_item jsonb;
  product_local_id bigint;
  quantity_delta integer;
  next_stock integer;
  failure_reason text;
  pulled_requests jsonb;
  pulled_products jsonb;
  pulled_movements jsonb;
begin
  select api_secret_hash into expected_secret_hash from public.pos_sync_config where store_id = p_store_id;
  if expected_secret_hash is null or encode(digest(p_api_secret, 'sha256'), 'hex') <> expected_secret_hash then raise exception 'Invalid sync secret'; end if;
  select * into staff from public.pos_staff_credentials where store_id = p_store_id and username = lower(btrim(p_username)) and active = true;
  if staff.store_id is null or not (staff.pin_hash = crypt(p_pin, staff.pin_hash)) then raise exception 'Invalid POS login'; end if;
  if jsonb_typeof(coalesce(p_requests, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_requests, '[]'::jsonb)) > 200 then raise exception 'Invalid inventory request batch'; end if;

  for request_item in select value from jsonb_array_elements(coalesce(p_requests, '[]'::jsonb)) loop
    request_id := (request_item->>'id')::uuid;
    desired_status := case when request_item->>'status' in ('approved', 'rejected') then request_item->>'status' else 'pending' end;
    select * into original from public.inventory_movements where id = (request_item->>'movementId')::uuid and store_id = p_store_id for update;
    if original.id is null or original.movement_type <> 'repack' then raise exception 'Repack movement not found'; end if;
    insert into public.inventory_movement_change_requests (id, store_id, movement_id, request_type, proposed_changes, proposed_note, status, requested_by, requested_at, updated_at)
    values (request_id, p_store_id, original.id, request_item->>'requestType', coalesce(request_item->'proposedChanges', '[]'::jsonb), nullif(btrim(request_item->>'proposedNote'), ''), 'pending', coalesce(nullif(btrim(request_item->>'requestedBy'), ''), staff.display_name), coalesce(nullif(request_item->>'requestedAt', '')::timestamptz, now()), now())
    on conflict (id) do nothing;
    select * into current_request from public.inventory_movement_change_requests where id = request_id and store_id = p_store_id for update;
    if desired_status = 'pending' or current_request.status <> 'pending' then continue; end if;
    if staff.role <> 'owner' then raise exception 'Only owner can review repack changes'; end if;
    if desired_status = 'rejected' then
      update public.inventory_movement_change_requests set status = 'rejected', reviewed_by = staff.display_name, reviewed_at = now(), review_note = nullif(btrim(request_item->>'reviewNote'), ''), updated_at = now() where id = request_id;
      continue;
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('productId', product_id, 'quantityDelta', delta) order by product_id), '[]'::jsonb)
      into adjustment_changes
      from (
        select product_id, sum(delta)::integer as delta
          from (
            select (value->>'productId')::bigint product_id, -((value->>'quantityDelta')::integer) delta from jsonb_array_elements(original.changes)
            union all
            select (value->>'productId')::bigint product_id, (value->>'quantityDelta')::integer delta from jsonb_array_elements(case when current_request.request_type = 'update' then current_request.proposed_changes else '[]'::jsonb end)
          ) combined
         group by product_id having sum(delta) <> 0
      ) totals;
    failure_reason := null;
    for change_item in select value from jsonb_array_elements(adjustment_changes) loop
      product_local_id := (change_item->>'productId')::bigint;
      quantity_delta := (change_item->>'quantityDelta')::integer;
      select stock + quantity_delta into next_stock from public.products where store_id = p_store_id and local_id = product_local_id for update;
      if next_stock is null then failure_reason := 'Produk stok tidak ditemukan'; exit; end if;
      if next_stock < 0 then failure_reason := 'Stok hasil repack sudah terpakai; koreksi stok manual diperlukan'; exit; end if;
    end loop;
    if failure_reason is not null then
      update public.inventory_movement_change_requests set review_note = failure_reason, updated_at = now() where id = request_id;
      continue;
    end if;
    for change_item in select value from jsonb_array_elements(adjustment_changes) loop
      update public.products set stock = stock + (change_item->>'quantityDelta')::integer, track_stock = true, updated_at = now() where store_id = p_store_id and local_id = (change_item->>'productId')::bigint;
    end loop;
    insert into public.inventory_movements (id, store_id, movement_type, reference_id, changes, note, actor_name, status, created_at, updated_at)
    values (request_id, p_store_id, case when current_request.request_type = 'delete' then 'repack_delete' else 'repack_update' end, original.id::text, adjustment_changes, current_request.proposed_note, staff.display_name, 'active', now(), now()) on conflict (id) do nothing;
    update public.inventory_movements set status = case when current_request.request_type = 'delete' then 'deleted' else 'revised' end, updated_at = now() where id = original.id;
    update public.inventory_movement_change_requests set status = 'approved', reviewed_by = staff.display_name, reviewed_at = now(), review_note = nullif(btrim(request_item->>'reviewNote'), ''), updated_at = now() where id = request_id;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(inventory_movement_change_requests) order by requested_at desc), '[]'::jsonb) into pulled_requests from public.inventory_movement_change_requests where store_id = p_store_id;
  select coalesce(jsonb_agg(to_jsonb(products) order by products.local_id), '[]'::jsonb) into pulled_products from public.products where store_id = p_store_id and track_stock = true;
  select coalesce(jsonb_agg(row_data order by row_data->>'created_at'), '[]'::jsonb) into pulled_movements from (select to_jsonb(inventory_movements) as row_data from public.inventory_movements where store_id = p_store_id order by created_at desc limit 1000) latest_movements;
  return jsonb_build_object('requests', pulled_requests, 'products', pulled_products, 'movements', pulled_movements);
end;
$$;

revoke execute on function public.pos_sync_inventory_change_requests(text, uuid, text, text, jsonb) from public;
grant execute on function public.pos_sync_inventory_change_requests(text, uuid, text, text, jsonb) to anon, authenticated;
