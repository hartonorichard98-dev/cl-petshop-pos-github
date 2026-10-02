begin;

update public.products
set stock = 0,
    track_stock = true,
    updated_at = now()
where store_id = '24a3a058-991b-4b64-b1d2-912910842d34'::uuid
  and lower(btrim(coalesce(base_name, name))) = 'ori cat kaleng 400 gr - tuna shrimp';

insert into public.audit_logs (id, store_id, actor_name, actor_role, action, entity_id, detail, created_at)
values (
  'fix-ori-cat-tuna-shrimp-stock-20261002',
  '24a3a058-991b-4b64-b1d2-912910842d34'::uuid,
  'System stock audit',
  'owner',
  'RECONCILE_DUPLICATE_STOCK_ID',
  'ori-cat-kaleng-400-gr-tuna-shrimp',
  'SO 30 September 12 pcs dikurangi transaksi 1 Oktober 6 pcs dan 2 Oktober 6 pcs; stok seluruh ID duplikat disamakan menjadi 0.',
  now()
)
on conflict (id) do update set detail = excluded.detail, created_at = excluded.created_at;

commit;
