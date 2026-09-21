alter table public.sale_deletions
  add column if not exists cashier_name text,
  add column if not exists items jsonb not null default '[]'::jsonb,
  add column if not exists total bigint,
  add column if not exists cost_total bigint,
  add column if not exists payment_method text,
  add column if not exists business_date date,
  add column if not exists sale_created_at timestamptz;

create or replace function public.capture_deleted_sale_details()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.sale_deletions (
    store_id,
    sale_id,
    receipt_number,
    reason,
    deleted_by,
    deleted_at,
    cashier_name,
    items,
    total,
    cost_total,
    payment_method,
    business_date,
    sale_created_at
  ) values (
    old.store_id,
    old.id,
    old.receipt_number,
    old.correction_reason,
    coalesce(old.cashier_name, 'Owner CL Petshop'),
    now(),
    old.cashier_name,
    old.items,
    old.total,
    old.cost_total,
    old.payment_method,
    old.business_date,
    old.created_at
  )
  on conflict (store_id, sale_id) do update set
    receipt_number = excluded.receipt_number,
    cashier_name = excluded.cashier_name,
    items = excluded.items,
    total = excluded.total,
    cost_total = excluded.cost_total,
    payment_method = excluded.payment_method,
    business_date = excluded.business_date,
    sale_created_at = excluded.sale_created_at;

  return old;
end;
$$;

drop trigger if exists capture_deleted_sale_details on public.sales;
create trigger capture_deleted_sale_details
before delete on public.sales
for each row execute function public.capture_deleted_sale_details();
