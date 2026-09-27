create or replace function public.pos_pull_sales_range(
  p_api_secret text,
  p_store_id uuid,
  p_username text,
  p_pin text,
  p_from date,
  p_to date
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  staff public.pos_staff_credentials;
  expected_secret_hash text;
  pulled_sales jsonb;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Invalid history range';
  end if;

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

  select coalesce(jsonb_agg(row_data order by row_data->>'created_at' desc), '[]'::jsonb)
    into pulled_sales
  from (
    select to_jsonb(sales) || case when staff.role = 'owner'
      then '{}'::jsonb
      else jsonb_build_object('cost_total', null)
    end as row_data
    from public.sales sales
    where sales.store_id = p_store_id
      and sales.business_date between p_from and p_to
  ) visible_sales;

  return jsonb_build_object('role', staff.role, 'sales', pulled_sales);
end;
$$;

revoke execute on function public.pos_pull_sales_range(text, uuid, text, text, date, date) from public;
grant execute on function public.pos_pull_sales_range(text, uuid, text, text, date, date) to anon, authenticated;
