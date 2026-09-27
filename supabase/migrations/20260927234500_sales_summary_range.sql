create or replace function public.pos_pull_sales_summary(
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
  monthly jsonb;
  yearly jsonb;
begin
  if p_from is null or p_to is null or p_from > p_to then
    raise exception 'Invalid summary range';
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

  select coalesce(jsonb_object_agg(period_key, row_data), '{}'::jsonb)
    into monthly
  from (
    select to_char(date_trunc('month', business_date), 'YYYY-MM') as period_key,
           jsonb_build_object(
             'omzet', sum(total),
             'hpp', case when staff.role = 'owner' then sum(cost_total) else 0 end,
             'count', count(*)
           ) as row_data
    from public.sales
    where store_id = p_store_id
      and status = 'completed'
      and business_date between p_from and p_to
    group by date_trunc('month', business_date)
  ) grouped_months;

  select coalesce(jsonb_object_agg(period_key, row_data), '{}'::jsonb)
    into yearly
  from (
    select to_char(date_trunc('year', business_date), 'YYYY') as period_key,
           jsonb_build_object(
             'omzet', sum(total),
             'hpp', case when staff.role = 'owner' then sum(cost_total) else 0 end,
             'count', count(*)
           ) as row_data
    from public.sales
    where store_id = p_store_id
      and status = 'completed'
      and business_date between p_from and p_to
    group by date_trunc('year', business_date)
  ) grouped_years;

  return jsonb_build_object('role', staff.role, 'monthly', monthly, 'yearly', yearly);
end;
$$;

revoke execute on function public.pos_pull_sales_summary(text, uuid, text, text, date, date) from public;
grant execute on function public.pos_pull_sales_summary(text, uuid, text, text, date, date) to anon, authenticated;
