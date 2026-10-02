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
  normalized_changes jsonb;
  change_item jsonb;
  movement_id uuid;
  movement_type text;
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
    next_stock := coalesce((product_snapshot->>'stock')::integer, 0);
    update public.products set stock = next_stock, track_stock = coalesce((product_snapshot->>'trackStock')::boolean, true), updated_at = now()
      where store_id = p_store_id and local_id = product_local_id and stock = 0 and track_stock = false
        and not exists (select 1 from public.inventory_movements existing where existing.store_id = p_store_id and existing.changes @> jsonb_build_array(jsonb_build_object('productId', product_local_id)));
  end loop;

  for movement in select value from jsonb_array_elements(coalesce(p_movements, '[]'::jsonb)) loop
    movement_id := (movement->>'id')::uuid;
    movement_type := coalesce(movement->>'type', '');
    if exists (select 1 from public.inventory_movements where id = movement_id and store_id = p_store_id) then continue; end if;

    select coalesce(jsonb_agg(value), '[]'::jsonb)
    into normalized_changes
    from (select distinct value from jsonb_array_elements(coalesce(movement->'changes', '[]'::jsonb))) unique_changes;

    rejection_reason := null;
    if jsonb_typeof(normalized_changes) <> 'array' or jsonb_array_length(normalized_changes) = 0 then
      rejection_reason := 'Perubahan stok kosong';
    else
      for change_item in select value from jsonb_array_elements(normalized_changes) loop
        product_local_id := nullif(change_item->>'productId', '')::bigint;
        quantity_delta := coalesce(nullif(change_item->>'quantityDelta', '')::integer, 0);
        select stock + quantity_delta into next_stock from public.products where store_id = p_store_id and local_id = product_local_id for update;
        if next_stock is null then rejection_reason := 'Produk stok tidak ditemukan'; exit; end if;
        if quantity_delta = 0 then rejection_reason := 'Perubahan stok nol'; exit; end if;
        if next_stock < 0 and movement_type not in ('sale', 'sale_adjustment', 'sale_edit_apply') then rejection_reason := 'Stok cloud tidak cukup'; exit; end if;
      end loop;
    end if;
    if rejection_reason is not null then
      rejected_movements := rejected_movements || jsonb_build_array(jsonb_build_object('id', movement_id, 'reason', rejection_reason));
      continue;
    end if;
    insert into public.inventory_movements (id, store_id, movement_type, reference_id, changes, note, actor_name, status, created_at, updated_at)
    values (movement_id, p_store_id, movement_type, coalesce(nullif(btrim(movement->>'referenceId'), ''), movement->>'id'), normalized_changes, nullif(btrim(movement->>'note'), ''), coalesce(nullif(btrim(movement->>'createdBy'), ''), staff.display_name), 'active', coalesce(nullif(movement->>'createdAt', '')::timestamptz, now()), now());
    for change_item in select value from jsonb_array_elements(normalized_changes) loop
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

begin;

update public.products
set stock = 6,
    track_stock = true,
    updated_at = now()
where store_id = '24a3a058-991b-4b64-b1d2-912910842d34'::uuid
  and lower(btrim(coalesce(base_name, name))) = 'nature bridge recovery 190 gr';

insert into public.audit_logs (id, store_id, actor_name, actor_role, action, entity_id, detail, created_at)
values (
  'fix-nature-bridge-recovery-stock-20261002',
  '24a3a058-991b-4b64-b1d2-912910842d34'::uuid,
  'System stock audit',
  'owner',
  'RECONCILE_RECEIVING_STOCK',
  'nature-bridge-recovery-190-gr',
  'Stok awal 0 dan penerimaan 2 Oktober 2026 sebanyak 6 pcs. Duplikasi movement penerimaan dikoreksi dari 12 menjadi 6.',
  now()
)
on conflict (id) do update set detail = excluded.detail, created_at = excluded.created_at;

commit;
