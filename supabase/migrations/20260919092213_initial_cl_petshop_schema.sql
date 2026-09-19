create extension if not exists pgcrypto;

create type public.app_role as enum ('owner', 'cashier');
create type public.sale_status as enum ('completed', 'voided', 'deleted');
create type public.receiving_status as enum ('waiting_check', 'owner_review', 'approved');

create table public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.store_members (
  store_id uuid not null references public.stores(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  role public.app_role not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (store_id, user_id)
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  local_id bigint,
  sku text not null,
  barcode text,
  name text not null,
  base_name text,
  image_url text,
  sell_price bigint not null check (sell_price >= 0),
  cost_price bigint not null check (cost_price >= 0),
  stock integer not null default 0,
  track_stock boolean not null default false,
  active boolean not null default true,
  pricing_rule jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now(),
  unique (store_id, sku),
  unique (store_id, barcode)
);

create table public.sales (
  id uuid primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  receipt_number text not null,
  cashier_id uuid references auth.users(id),
  cashier_name text not null,
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  total bigint not null check (total >= 0),
  cost_total bigint not null check (cost_total >= 0),
  payment_method text not null check (payment_method in ('cash', 'qris', 'transfer', 'debit')),
  cash_received bigint not null default 0,
  change_due bigint not null default 0,
  status public.sale_status not null default 'completed',
  correction_reason text,
  business_date date not null,
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  unique (store_id, receipt_number)
);

create table public.expenses (
  id uuid primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  amount bigint not null check (amount > 0),
  recipient text not null,
  purpose text not null,
  note text,
  status text not null default 'active' check (status in ('active', 'cancelled')),
  business_date date not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table public.receivings (
  id uuid primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  receiving_number text not null,
  supplier text not null,
  reference_number text,
  expected_date date,
  owner_note text,
  cashier_note text,
  review_note text,
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  status public.receiving_status not null default 'waiting_check',
  created_by uuid references auth.users(id),
  checked_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  created_at timestamptz not null,
  checked_at timestamptz,
  approved_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (store_id, receiving_number)
);

create table public.cash_closings (
  id uuid primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  business_date date not null,
  cashier_id uuid references auth.users(id),
  cashier_name text not null,
  denominations jsonb not null default '{}'::jsonb,
  payment_totals jsonb not null default '{}'::jsonb,
  expected_cash bigint not null,
  actual_cash bigint not null,
  difference bigint not null,
  note text,
  status text not null default 'closed' check (status in ('closed', 'needs_review')),
  created_at timestamptz not null,
  updated_at timestamptz not null default now(),
  unique (store_id, business_date, cashier_id)
);

create table public.audit_logs (
  id text primary key,
  store_id uuid not null references public.stores(id) on delete cascade,
  actor_id uuid references auth.users(id),
  actor_name text not null,
  actor_role public.app_role,
  action text not null,
  entity_id text,
  detail text not null,
  created_at timestamptz not null
);

create index products_store_active_idx on public.products (store_id, active);
create index products_store_stock_idx on public.products (store_id, stock) where track_stock = true and active = true;
create index sales_store_business_date_idx on public.sales (store_id, business_date desc);
create index expenses_store_business_date_idx on public.expenses (store_id, business_date desc);
create index receivings_store_status_idx on public.receivings (store_id, status, created_at desc);
create index closings_store_business_date_idx on public.cash_closings (store_id, business_date desc);
create index audit_logs_store_created_idx on public.audit_logs (store_id, created_at desc);

create or replace function public.is_store_member(target_store uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.store_members
    where store_id = target_store and user_id = auth.uid() and active = true
  );
$$;

create or replace function public.is_store_owner(target_store uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.store_members
    where store_id = target_store and user_id = auth.uid() and role = 'owner' and active = true
  );
$$;

create or replace function public.bootstrap_store(store_name text, owner_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_store_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Login required';
  end if;

  insert into public.stores (name, created_by)
  values (store_name, auth.uid())
  returning id into new_store_id;

  insert into public.store_members (store_id, user_id, display_name, role)
  values (new_store_id, auth.uid(), owner_name, 'owner');

  return new_store_id;
end;
$$;

create or replace function public.submit_receiving_check(
  receiving_id uuid,
  checked_items jsonb,
  new_cashier_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.receivings;
begin
  if auth.uid() is null then
    raise exception 'Login required';
  end if;

  select * into target
  from public.receivings
  where id = receiving_id
  for update;

  if target.id is null or target.status <> 'waiting_check' then
    raise exception 'Receiving is not available for cashier checking';
  end if;

  if not public.is_store_member(target.store_id) or public.is_store_owner(target.store_id) then
    raise exception 'Cashier membership required';
  end if;

  if jsonb_typeof(checked_items) <> 'array' then
    raise exception 'Checked items must be an array';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(checked_items) as item("orderedQty" integer, "actualQty" integer, "discrepancyNote" text)
    where coalesce(item."actualQty", 0) <> coalesce(item."orderedQty", 0)
      and nullif(btrim(coalesce(item."discrepancyNote", '')), '') is null
  ) then
    raise exception 'Discrepancy note is required when quantities differ';
  end if;

  update public.receivings
  set items = checked_items,
      cashier_note = nullif(btrim(new_cashier_note), ''),
      review_note = null,
      status = 'owner_review',
      checked_by = auth.uid(),
      checked_at = now(),
      updated_at = now()
  where id = receiving_id;
end;
$$;

create or replace function public.return_receiving_to_cashier(receiving_id uuid, reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.receivings;
begin
  select * into target
  from public.receivings
  where id = receiving_id
  for update;

  if target.id is null or target.status <> 'owner_review' or not public.is_store_owner(target.store_id) then
    raise exception 'Owner review is required';
  end if;

  if nullif(btrim(reason), '') is null then
    raise exception 'Return reason is required';
  end if;

  update public.receivings
  set status = 'waiting_check',
      review_note = btrim(reason),
      updated_at = now()
  where id = receiving_id;
end;
$$;

create or replace function public.approve_receiving(receiving_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target public.receivings;
  total_received integer := 0;
begin
  select * into target
  from public.receivings
  where id = receiving_id
  for update;

  if target.id is null or target.status <> 'owner_review' or not public.is_store_owner(target.store_id) then
    raise exception 'Owner review is required';
  end if;

  with received_items as (
    select item."productId" as local_id, greatest(coalesce(item."actualQty", 0), 0) as actual_qty
    from jsonb_to_recordset(target.items) as item("productId" bigint, "actualQty" integer)
  ), updated_products as (
    update public.products product
    set stock = product.stock + received.actual_qty,
        track_stock = true,
        updated_by = auth.uid(),
        updated_at = now()
    from received_items received
    where product.store_id = target.store_id
      and product.local_id = received.local_id
    returning received.actual_qty
  )
  select coalesce(sum(actual_qty), 0) into total_received from updated_products;

  update public.receivings
  set status = 'approved',
      approved_by = auth.uid(),
      approved_at = now(),
      updated_at = now()
  where id = receiving_id;

  return jsonb_build_object('receiving_id', receiving_id, 'total_received', total_received);
end;
$$;

alter table public.stores enable row level security;
alter table public.store_members enable row level security;
alter table public.products enable row level security;
alter table public.sales enable row level security;
alter table public.expenses enable row level security;
alter table public.receivings enable row level security;
alter table public.cash_closings enable row level security;
alter table public.audit_logs enable row level security;

create policy stores_read on public.stores for select using (public.is_store_member(id));
create policy stores_owner_update on public.stores for update using (public.is_store_owner(id));
create policy members_read on public.store_members for select using (public.is_store_member(store_id));
create policy members_owner_write on public.store_members for all using (public.is_store_owner(store_id)) with check (public.is_store_owner(store_id));
create policy products_read on public.products for select using (public.is_store_member(store_id));
create policy products_owner_write on public.products for all using (public.is_store_owner(store_id)) with check (public.is_store_owner(store_id));
create policy sales_read on public.sales for select using (public.is_store_owner(store_id) or cashier_id = auth.uid());
create policy sales_member_insert on public.sales for insert with check (public.is_store_member(store_id) and cashier_id = auth.uid());
create policy sales_owner_update on public.sales for update using (public.is_store_owner(store_id)) with check (public.is_store_owner(store_id));
create policy expenses_owner_all on public.expenses for all using (public.is_store_owner(store_id)) with check (public.is_store_owner(store_id));
create policy receivings_read on public.receivings for select using (public.is_store_member(store_id));
create policy receivings_owner_insert on public.receivings for insert with check (public.is_store_owner(store_id));
create policy receivings_owner_update on public.receivings for update using (public.is_store_owner(store_id)) with check (public.is_store_owner(store_id));
create policy closings_member_insert on public.cash_closings for insert with check (public.is_store_member(store_id) and cashier_id = auth.uid());
create policy closings_read on public.cash_closings for select using (public.is_store_owner(store_id) or cashier_id = auth.uid());
create policy closings_owner_update on public.cash_closings for update using (public.is_store_owner(store_id)) with check (public.is_store_owner(store_id));
create policy audit_member_insert on public.audit_logs for insert with check (public.is_store_member(store_id) and actor_id = auth.uid());
create policy audit_owner_read on public.audit_logs for select using (public.is_store_owner(store_id));

revoke all on table public.stores, public.store_members, public.products, public.sales, public.expenses, public.receivings, public.cash_closings, public.audit_logs from anon;
grant select on table public.stores, public.store_members, public.products, public.sales, public.receivings, public.cash_closings, public.audit_logs to authenticated;
grant insert, update, delete on table public.store_members, public.products, public.expenses to authenticated;
grant insert, update on table public.sales, public.receivings, public.cash_closings to authenticated;
grant select on table public.expenses to authenticated;
grant insert on table public.audit_logs to authenticated;

revoke execute on function public.is_store_member(uuid) from public, anon;
revoke execute on function public.is_store_owner(uuid) from public, anon;
revoke execute on function public.bootstrap_store(text, text) from public, anon;
revoke execute on function public.submit_receiving_check(uuid, jsonb, text) from public, anon;
revoke execute on function public.return_receiving_to_cashier(uuid, text) from public, anon;
revoke execute on function public.approve_receiving(uuid) from public, anon;

grant execute on function public.is_store_member(uuid) to authenticated;
grant execute on function public.is_store_owner(uuid) to authenticated;
grant execute on function public.bootstrap_store(text, text) to authenticated;
grant execute on function public.submit_receiving_check(uuid, jsonb, text) to authenticated;
grant execute on function public.return_receiving_to_cashier(uuid, text) to authenticated;
grant execute on function public.approve_receiving(uuid) to authenticated;
