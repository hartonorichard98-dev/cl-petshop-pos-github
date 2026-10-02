begin;

update public.products
set stock = 0,
    track_stock = true,
    updated_at = now()
where store_id = '24a3a058-991b-4b64-b1d2-912910842d34'::uuid
  and lower(btrim(coalesce(base_name, name))) = 'ori cat pouch 80 gr - chicken';

insert into public.audit_logs (id, store_id, actor_id, actor_name, actor_role, action, entity_id, detail, created_at)
values (
  'fix-ori-cat-stock-2026-10-02',
  '24a3a058-991b-4b64-b1d2-912910842d34'::uuid,
  null,
  'System stock audit',
  'owner',
  'RECONCILE_DUPLICATE_STOCK_ID',
  'ori-cat-pouch-80-gr-chicken',
  'Stok disamakan menjadi 0 setelah SO 11 dikurangi transaksi 1 Oktober 11; sinkron berikutnya hanya memakai satu ID produk canonical.',
  now()
)
on conflict (id) do update set detail = excluded.detail, created_at = excluded.created_at;

commit;
