create or replace function public.pos_pull_popular_products(
  p_api_secret text,
  p_store_id uuid,
  p_username text,
  p_pin text,
  p_limit integer default 48
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  staff public.pos_staff_credentials;
  expected_secret_hash text;
  popular_products jsonb;
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

  select coalesce(jsonb_agg(to_jsonb(ranked) order by ranked.orders desc, ranked.qty desc, ranked.key), '[]'::jsonb)
    into popular_products
  from (
    select coalesce(nullif(item->>'groupKey', ''), nullif(item->>'baseName', ''), item->>'name') as key,
           count(distinct sale.id) as orders,
           sum(case when coalesce(item->>'qty', '') ~ '^\d+(\.\d+)?$' then (item->>'qty')::numeric else 0 end) as qty
    from public.sales sale
    cross join lateral jsonb_array_elements(sale.items) item
    where sale.store_id = p_store_id
      and sale.status = 'completed'
      and coalesce(nullif(item->>'groupKey', ''), nullif(item->>'baseName', ''), item->>'name') is not null
    group by coalesce(nullif(item->>'groupKey', ''), nullif(item->>'baseName', ''), item->>'name')
    order by orders desc, qty desc, key
    limit least(100, greatest(1, coalesce(p_limit, 48)))
  ) ranked;

  return jsonb_build_object('role', staff.role, 'products', popular_products);
end;
$$;

revoke execute on function public.pos_pull_popular_products(text, uuid, text, text, integer) from public;
grant execute on function public.pos_pull_popular_products(text, uuid, text, text, integer) to anon, authenticated;
