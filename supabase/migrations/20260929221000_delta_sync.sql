create or replace function public.pos_write_batch(
  p_api_secret text,
  p_store_id uuid,
  p_username text,
  p_pin text,
  p_sales jsonb,
  p_expenses jsonb,
  p_inventory_products jsonb,
  p_movements jsonb,
  p_inventory_requests jsonb,
  p_receivings jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  sales_result jsonb;
  expenses_result jsonb;
  inventory_result jsonb;
  requests_result jsonb;
  receivings_result jsonb;
begin
  if jsonb_array_length(coalesce(p_sales, '[]'::jsonb)) > 0 then
    sales_result := public.pos_sync_and_pull(p_api_secret, p_store_id, p_username, p_pin, p_sales);
  end if;
  if jsonb_array_length(coalesce(p_expenses, '[]'::jsonb)) > 0 then
    expenses_result := public.pos_sync_expenses(p_api_secret, p_store_id, p_username, p_pin, p_expenses);
  end if;
  if jsonb_array_length(coalesce(p_inventory_products, '[]'::jsonb)) > 0 or jsonb_array_length(coalesce(p_movements, '[]'::jsonb)) > 0 then
    inventory_result := public.pos_sync_inventory(p_api_secret, p_store_id, p_username, p_pin, coalesce(p_inventory_products, '[]'::jsonb), coalesce(p_movements, '[]'::jsonb));
  end if;
  if jsonb_array_length(coalesce(p_inventory_requests, '[]'::jsonb)) > 0 then
    requests_result := public.pos_sync_inventory_change_requests(p_api_secret, p_store_id, p_username, p_pin, p_inventory_requests);
  end if;
  if jsonb_array_length(coalesce(p_receivings, '[]'::jsonb)) > 0 then
    receivings_result := public.pos_sync_receivings(p_api_secret, p_store_id, p_username, p_pin, p_receivings);
  end if;
  return jsonb_build_object('role', coalesce(sales_result->'role', expenses_result->'role'), 'rejected_inventory_movements', coalesce(inventory_result->'rejected_movements', '[]'::jsonb));
end;
$$;

revoke execute on function public.pos_write_batch(text, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) from public;
grant execute on function public.pos_write_batch(text, uuid, text, text, jsonb, jsonb, jsonb, jsonb, jsonb, jsonb) to anon, authenticated;

create or replace function public.pos_sync_delta(
  p_api_secret text,
  p_store_id uuid,
  p_username text,
  p_pin text,
  p_since timestamptz
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
  pulled_deletions jsonb;
  pulled_expenses jsonb;
  pulled_products jsonb;
  pulled_movements jsonb;
  pulled_requests jsonb;
  pulled_receivings jsonb;
  pulled_audit_logs jsonb := '[]'::jsonb;
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

  select coalesce(jsonb_agg(row_data order by row_data->>'created_at' desc), '[]'::jsonb)
  into pulled_sales
  from (
    select to_jsonb(sales) || case when staff.role = 'owner' then '{}'::jsonb else jsonb_build_object('cost_total', null) end as row_data
    from public.sales sales
    where sales.store_id = p_store_id
      and (case when p_since is null then sales.business_date >= current_date - 45 else sales.updated_at > p_since end)
    order by sales.created_at desc
    limit 2000
  ) recent_sales;

  select coalesce(jsonb_agg(sale_id), '[]'::jsonb)
  into pulled_deletions
  from public.sale_deletions
  where store_id = p_store_id
    and (p_since is null or deleted_at > p_since);

  select coalesce(jsonb_agg(to_jsonb(expenses) order by expenses.created_at desc), '[]'::jsonb)
  into pulled_expenses
  from public.expenses
  where store_id = p_store_id
    and (case when p_since is null then business_date >= current_date - 90 else updated_at > p_since end);

  select coalesce(jsonb_agg(to_jsonb(products) order by products.local_id), '[]'::jsonb)
  into pulled_products
  from public.products
  where store_id = p_store_id
    and track_stock = true
    and (p_since is null or updated_at > p_since);

  select coalesce(jsonb_agg(row_data order by row_data->>'created_at' desc), '[]'::jsonb)
  into pulled_movements
  from (
    select to_jsonb(inventory_movements) as row_data
    from public.inventory_movements
    where store_id = p_store_id
      and (p_since is null or updated_at > p_since)
    order by created_at desc
    limit 500
  ) recent_movements;

  select coalesce(jsonb_agg(to_jsonb(inventory_movement_change_requests) order by requested_at desc), '[]'::jsonb)
  into pulled_requests
  from public.inventory_movement_change_requests
  where store_id = p_store_id
    and (case when p_since is null then status = 'pending' or updated_at > now() - interval '90 days' else updated_at > p_since end);

  select coalesce(jsonb_agg(to_jsonb(receivings) order by created_at desc), '[]'::jsonb)
  into pulled_receivings
  from public.receivings
  where store_id = p_store_id
    and (case when p_since is null then deleted_at is null or updated_at > now() - interval '180 days' else updated_at > p_since or deleted_at > p_since end);

  if staff.role = 'owner' then
    select coalesce(jsonb_agg(row_data order by row_data->>'created_at' desc), '[]'::jsonb)
    into pulled_audit_logs
    from (
      select to_jsonb(logs) as row_data
      from public.audit_logs logs
      where store_id = p_store_id
        and (p_since is null or created_at > p_since)
      order by created_at desc
      limit 500
    ) recent_logs;
  end if;

  return jsonb_build_object(
    'role', staff.role,
    'sales', pulled_sales,
    'deleted_ids', pulled_deletions,
    'expenses', pulled_expenses,
    'inventory_products', pulled_products,
    'inventory_movements', pulled_movements,
    'inventory_change_requests', pulled_requests,
    'receivings', pulled_receivings,
    'audit_logs', pulled_audit_logs
  );
end;
$$;

revoke execute on function public.pos_sync_delta(text, uuid, text, text, timestamptz) from public;
grant execute on function public.pos_sync_delta(text, uuid, text, text, timestamptz) to anon, authenticated;
