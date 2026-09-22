drop function if exists public.pos_sync_inventory(text, uuid, text, text, jsonb);

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
  inserted_id uuid;
  product_local_id bigint;
  quantity_delta integer;
  next_stock integer;
  touched_product_ids bigint[] := '{}';
  pulled_products jsonb;
  pulled_movements jsonb;
begin
  select api_secret_hash into expected_secret_hash
    from public.pos_sync_config
   where store_id = p_store_id;
  if expected_secret_hash is null or encode(digest(p_api_secret, 'sha256'), 'hex') <> expected_secret_hash then
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
  if jsonb_typeof(coalesce(p_products, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_products, '[]'::jsonb)) > 500 then
    raise exception 'Invalid inventory product baseline';
  end if;
  if jsonb_typeof(coalesce(p_movements, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_movements, '[]'::jsonb)) > 500 then
    raise exception 'Invalid inventory movement batch';
  end if;

  for product_snapshot in select value from jsonb_array_elements(coalesce(p_products, '[]'::jsonb)) loop
    product_local_id := (product_snapshot->>'productId')::bigint;
    touched_product_ids := array_append(touched_product_ids, product_local_id);
    next_stock := greatest(coalesce((product_snapshot->>'stock')::integer, 0), 0);
    update public.products
       set stock = next_stock,
           track_stock = coalesce((product_snapshot->>'trackStock')::boolean, true),
           updated_at = now()
     where store_id = p_store_id
       and local_id = product_local_id
       and stock = 0
       and track_stock = false
       and not exists (
         select 1
           from public.inventory_movements existing
          where existing.store_id = p_store_id
            and existing.changes @> jsonb_build_array(jsonb_build_object('productId', product_local_id))
       );
  end loop;

  for movement in select value from jsonb_array_elements(coalesce(p_movements, '[]'::jsonb)) loop
    inserted_id := null;
    insert into public.inventory_movements (id, store_id, movement_type, reference_id, changes, note, actor_name, created_at)
    values (
      (movement->>'id')::uuid,
      p_store_id,
      movement->>'type',
      coalesce(nullif(btrim(movement->>'referenceId'), ''), movement->>'id'),
      coalesce(movement->'changes', '[]'::jsonb),
      nullif(btrim(movement->>'note'), ''),
      coalesce(nullif(btrim(movement->>'createdBy'), ''), staff.display_name),
      coalesce(nullif(movement->>'createdAt', '')::timestamptz, now())
    ) on conflict (id) do nothing returning id into inserted_id;

    if inserted_id is not null then
      for change_item in select value from jsonb_array_elements(coalesce(movement->'changes', '[]'::jsonb)) loop
        product_local_id := (change_item->>'productId')::bigint;
        touched_product_ids := array_append(touched_product_ids, product_local_id);
        quantity_delta := (change_item->>'quantityDelta')::integer;
        if quantity_delta = 0 then
          raise exception 'Invalid zero inventory delta';
        end if;
        select stock + quantity_delta into next_stock
          from public.products
         where store_id = p_store_id and local_id = product_local_id
         for update;
        if next_stock is null then
          raise exception 'Inventory product not found';
        end if;
        if next_stock < 0 then
          raise exception 'Inventory stock cannot be negative';
        end if;
        update public.products
           set stock = next_stock, track_stock = true, updated_at = now()
         where store_id = p_store_id and local_id = product_local_id;
      end loop;
    end if;
  end loop;

  select coalesce(jsonb_agg(to_jsonb(products) order by products.local_id), '[]'::jsonb)
    into pulled_products
    from public.products
   where store_id = p_store_id
     and track_stock = true;
  select coalesce(jsonb_agg(row_data order by row_data->>'created_at'), '[]'::jsonb)
    into pulled_movements
    from (
      select to_jsonb(inventory_movements) as row_data
        from public.inventory_movements
       where store_id = p_store_id
       order by created_at desc
       limit 1000
    ) latest_movements;
  return jsonb_build_object('products', pulled_products, 'movements', pulled_movements);
end;
$$;

revoke execute on function public.pos_sync_inventory(text, uuid, text, text, jsonb, jsonb) from public;
grant execute on function public.pos_sync_inventory(text, uuid, text, text, jsonb, jsonb) to anon, authenticated;
