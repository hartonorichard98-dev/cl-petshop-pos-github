begin;

update public.products
set
  name = 'whiskas pouch 80 gr',
  base_name = 'whiskas pouch 80 gr',
  sell_price = 7000,
  cost_price = 5393,
  stock = 714,
  track_stock = true,
  active = true,
  pricing_rule = jsonb_build_object(
    'tiers', jsonb_build_array(
      jsonb_build_object('minQty', 1, 'sell', 7000, 'cost', 5392.86),
      jsonb_build_object('minQty', 3, 'sell', 6666.67, 'cost', 5392.86),
      jsonb_build_object('minQty', 12, 'sell', 6500, 'cost', 5392.86),
      jsonb_build_object('minQty', 24, 'sell', 6250, 'cost', 5392.86),
      jsonb_build_object('minQty', 28, 'sell', 6142.86, 'cost', 5392.86)
    ),
    'needsPrice', false
  ),
  updated_at = now()
where local_id = 332
  and lower(coalesce(base_name, name)) = 'whiskas pouch 80 gr';

delete from public.products
where local_id in (333, 334, 335, 336)
  and lower(coalesce(base_name, name)) = 'whiskas pouch 80 gr';

commit;
