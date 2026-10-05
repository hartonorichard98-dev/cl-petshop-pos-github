begin;

update public.products
set sell_price = 15000,
    cost_price = 10000,
    pricing_rule = jsonb_build_object(
      'tiers', jsonb_build_array(
        jsonb_build_object('minQty', 1, 'sell', 15000, 'cost', 10000),
        jsonb_build_object('minQty', 10, 'sell', 12500, 'cost', 10000)
      ),
      'needsPrice', false
    ),
    updated_at = now()
where store_id = '24a3a058-991b-4b64-b1d2-912910842d34'::uuid
  and local_id = 1
  and lower(btrim(coalesce(base_name, name))) = 'anthel cat';

insert into public.audit_logs (
  id, store_id, actor_name, actor_role, action, entity_id, detail, created_at
)
values (
  'restore-anthel-cat-tier-20261003',
  '24a3a058-991b-4b64-b1d2-912910842d34'::uuid,
  'System catalog repair',
  'owner',
  'RESTORE_PRODUCT_PRICE_TIER',
  '1',
  'Memulihkan tier harga 10+ Anthel Cat dari perubahan 3 Oktober 2026. Harga jual 1+ Rp15.000, 10+ Rp12.500. HPP tetap Rp10.000. Transaksi lama tidak diubah.',
  now()
)
on conflict (id) do update set detail = excluded.detail, created_at = excluded.created_at;

commit;
