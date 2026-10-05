begin;

alter table public.products
  add column if not exists catalog_revision bigint not null default 0,
  add column if not exists catalog_updated_at timestamptz;

update public.products
set catalog_updated_at = coalesce(catalog_updated_at, updated_at, now())
where catalog_updated_at is null;

create or replace function public.pos_sync_product_catalog(
  p_api_secret text,
  p_store_id uuid,
  p_username text,
  p_pin text,
  p_products jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  staff public.pos_staff_credentials;
  expected_secret_hash text;
  incoming jsonb;
  current_product public.products%rowtype;
  product_local_id bigint;
  base_revision bigint;
  next_revision bigint;
  incoming_tiers jsonb;
  accepted jsonb := '[]'::jsonb;
  rejected jsonb := '[]'::jsonb;
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
    raise exception 'Only owner can update product catalog';
  end if;
  if jsonb_typeof(coalesce(p_products, '[]'::jsonb)) <> 'array'
     or jsonb_array_length(coalesce(p_products, '[]'::jsonb)) > 100 then
    raise exception 'Invalid product catalog batch';
  end if;

  for incoming in select value from jsonb_array_elements(coalesce(p_products, '[]'::jsonb)) loop
    product_local_id := coalesce(
      nullif(incoming->>'cloudProductId', '')::bigint,
      nullif(incoming->>'productId', '')::bigint,
      nullif(incoming->>'id', '')::bigint
    );
    base_revision := coalesce(nullif(incoming->>'baseRevision', '')::bigint, 0);

    select * into current_product
    from public.products
    where store_id = p_store_id and local_id = product_local_id
    for update;

    if current_product.id is null then
      rejected := rejected || jsonb_build_array(jsonb_build_object(
        'localId', product_local_id,
        'reason', 'Produk cloud tidak ditemukan'
      ));
      continue;
    end if;

    if base_revision <> current_product.catalog_revision then
      rejected := rejected || jsonb_build_array(jsonb_build_object(
        'localId', product_local_id,
        'reason', 'Versi produk sudah berubah di perangkat lain',
        'current', to_jsonb(current_product)
      ));
      continue;
    end if;

    incoming_tiers := coalesce(incoming->'tiers', '[]'::jsonb);
    if jsonb_typeof(incoming_tiers) <> 'array'
       or jsonb_array_length(incoming_tiers) = 0
       or exists (
         select 1 from jsonb_array_elements(incoming_tiers) tier
         where coalesce((tier->>'minQty')::integer, 0) < 1
            or coalesce((tier->>'sell')::numeric, 0) <= 0
            or coalesce((tier->>'cost')::numeric, 0) < 0
       ) then
      rejected := rejected || jsonb_build_array(jsonb_build_object(
        'localId', product_local_id,
        'reason', 'Tangga harga tidak valid',
        'current', to_jsonb(current_product)
      ));
      continue;
    end if;

    next_revision := current_product.catalog_revision + 1;
    update public.products
    set sku = coalesce(nullif(btrim(incoming->>'sku'), ''), sku),
        barcode = nullif(btrim(incoming->>'barcode'), ''),
        name = coalesce(nullif(btrim(incoming->>'name'), ''), name),
        base_name = coalesce(nullif(btrim(incoming->>'baseName'), ''), nullif(btrim(incoming->>'name'), ''), base_name),
        sell_price = round(coalesce((incoming->>'sell')::numeric, sell_price)),
        cost_price = round(coalesce((incoming->>'cost')::numeric, cost_price)),
        active = coalesce((incoming->>'active')::boolean, active),
        pricing_rule = jsonb_build_object('tiers', incoming_tiers, 'needsPrice', false),
        catalog_revision = next_revision,
        catalog_updated_at = coalesce(nullif(incoming->>'catalogUpdatedAt', '')::timestamptz, now()),
        updated_at = now()
    where id = current_product.id;

    insert into public.audit_logs (
      id, store_id, actor_name, actor_role, action, entity_id, detail, created_at
    ) values (
      gen_random_uuid()::text,
      p_store_id,
      staff.display_name,
      staff.role,
      'UPDATE_PRODUCT_CATALOG',
      product_local_id::text,
      jsonb_build_object(
        'revision_before', current_product.catalog_revision,
        'revision_after', next_revision,
        'pricing_before', current_product.pricing_rule,
        'pricing_after', jsonb_build_object('tiers', incoming_tiers, 'needsPrice', false),
        'sell_before', current_product.sell_price,
        'sell_after', round(coalesce((incoming->>'sell')::numeric, current_product.sell_price)),
        'cost_before', current_product.cost_price,
        'cost_after', round(coalesce((incoming->>'cost')::numeric, current_product.cost_price))
      )::text,
      now()
    );

    accepted := accepted || jsonb_build_array(jsonb_build_object(
      'localId', product_local_id,
      'revision', next_revision,
      'catalogUpdatedAt', coalesce(nullif(incoming->>'catalogUpdatedAt', ''), now()::text)
    ));
  end loop;

  return jsonb_build_object('accepted', accepted, 'rejected', rejected);
end;
$$;

revoke execute on function public.pos_sync_product_catalog(text, uuid, text, text, jsonb) from public;
grant execute on function public.pos_sync_product_catalog(text, uuid, text, text, jsonb) to anon, authenticated;

commit;
