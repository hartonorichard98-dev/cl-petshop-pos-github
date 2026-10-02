begin;

update public.receivings as receiving
set items = updated.items,
    status = 'owner_review'::public.receiving_status,
    checked_by_name = coalesce(nullif(receiving.checked_by_name, ''), 'Kasir CL Petshop'),
    checked_at = coalesce(receiving.checked_at, now()),
    updated_at = greatest(receiving.updated_at, now())
from (
  select r.id,
         jsonb_agg(
           item || jsonb_build_object(
             'actualQty', coalesce((item->>'actualQty')::integer, (item->>'orderedQty')::integer, 0),
             'variance', coalesce((item->>'variance')::integer, 0)
           )
           order by ordinality
         ) as items
  from public.receivings r
  cross join lateral jsonb_array_elements(coalesce(r.items, '[]'::jsonb)) with ordinality as elements(item, ordinality)
  where r.store_id = '24a3a058-991b-4b64-b1d2-912910842d34'::uuid
    and r.receiving_number = 'PB-20261001-0001'
    and r.status = 'waiting_check'
  group by r.id
) as updated
where receiving.id = updated.id;

update public.products
set stock = 1,
    track_stock = true,
    updated_at = now()
where store_id = '24a3a058-991b-4b64-b1d2-912910842d34'::uuid
  and lower(btrim(coalesce(base_name, name))) = 'life cat 20 kg';

update public.products
set stock = 27,
    track_stock = true,
    updated_at = now()
where store_id = '24a3a058-991b-4b64-b1d2-912910842d34'::uuid
  and lower(btrim(coalesce(base_name, name))) = 'life cat 1 kg';

insert into public.audit_logs (id, store_id, actor_name, actor_role, action, entity_id, detail, created_at)
values
(
  'reconcile-receiving-pb-20261001-0001',
  '24a3a058-991b-4b64-b1d2-912910842d34'::uuid,
  'System stock audit',
  'owner',
  'RECONCILE_RECEIVING_CHECK',
  'PB-20261001-0001',
  'Status dipulihkan ke owner_review setelah simpan lokal kasir gagal; stok belum ditambahkan.',
  now()
),
(
  'reconcile-life-cat-repack-20261002',
  '24a3a058-991b-4b64-b1d2-912910842d34'::uuid,
  'System stock audit',
  'owner',
  'RECONCILE_REPACK_STOCK',
  'life-cat-repack-20261002',
  'Stok disamakan lintas tier setelah repack: Life Cat 20 kg = 1 bag, Life Cat 1 kg = 27 pcs. Tidak mengubah transaksi atau HPP.',
  now()
)
on conflict (id) do update set detail = excluded.detail, created_at = excluded.created_at;

commit;
