#!/usr/bin/env python3
import json
import importlib.util
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
STORE_ID = "24a3a058-991b-4b64-b1d2-912910842d34"
OLD_MIGRATION = ROOT / "supabase/migrations/20260927213000_reset_and_import_sales_through_sep_28.sql"
WORKBOOK = Path("/Users/macmii/Downloads/(ADM) 2026's OFFLINE - Q3-2.xlsx")
STOCK_SOURCE = Path("/Users/macmii/.codex/attachments/fec0034d-8920-42da-a2c8-72077f760cad/Pasted text.txt")
PRICE_LIST = ROOT / "price-list-data.js"
OUTPUT = ROOT / "supabase/migrations/20260930120000_import_q3_2_sales_and_clear_test.sql"


def extract_payload(path: Path, tag: str):
    source = path.read_text()
    match = re.search(rf"\${tag}\$(\[.*\])\${tag}\$::jsonb", source, re.S)
    if not match:
        raise RuntimeError(f"Payload {tag} tidak ditemukan di {path}")
    return json.loads(match.group(1))


def normalize(value):
    return re.sub(r"\s+", " ", str(value or "").strip().lower())


def load_products():
    source = PRICE_LIST.read_text()
    match = re.search(r"window\.CL_PRICE_LIST=(\[.*\]);\s*$", source, re.S)
    if not match:
        raise RuntimeError("price-list-data.js tidak dapat dibaca")
    return json.loads(match.group(1))


def load_stock(products):
    raw_rows = {}
    for line in STOCK_SOURCE.read_text().splitlines()[1:]:
        if not line.strip():
            continue
        name, stock = line.rsplit("\t", 1)
        raw_rows[normalize(name)] = int(stock.strip()) if stock.strip() else 0

    aliases = {"anthel cat": "(satuan) anthel cat"}
    stock_rows = []
    missing = []
    for product in products:
        base_name = normalize(product.get("baseName") or product["name"])
        source_name = aliases.get(base_name, base_name)
        if source_name not in raw_rows:
            missing.append(base_name)
        stock_rows.append({"baseName": base_name, "stock": raw_rows.get(source_name, 0)})
    return stock_rows, missing


def comparable(sale):
    financial_items = []
    for item in sale["items"]:
        financial_items.append({
            "name": item.get("name"),
            "baseName": item.get("baseName"),
            "sell": item.get("sell"),
            "cost": item.get("cost"),
            "qty": item.get("qty"),
            "lineCost": item.get("lineCost"),
            "lineTotal": item.get("lineTotal"),
        })
    return {
        "date": sale["date"],
        "items": financial_items,
        "total": sale["total"],
        "costTotal": sale["costTotal"],
        "paymentMethod": sale["paymentMethod"],
        "paymentBreakdown": sale.get("paymentBreakdown", []),
        "cashReceived": sale["cashReceived"],
        "changeDue": sale["changeDue"],
        "paymentEditHistory": sale.get("paymentEditHistory", []),
    }


def sql_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


old_sales = extract_payload(OLD_MIGRATION, "cl_reset_import")
generator_spec = importlib.util.spec_from_file_location("q3_generator", ROOT / "scripts/generate_reset_import_sep_2026.py")
generator = importlib.util.module_from_spec(generator_spec)
generator_spec.loader.exec_module(generator)
generator.WORKBOOK = WORKBOOK
generator.IMPORT_REASON = "Historical Excel import 2026-07-01 to 2026-09-30"
new_sales, unmatched_sales = generator.build_sales()
old_by_id = {sale["id"]: sale for sale in old_sales}
delta = [sale for sale in new_sales if sale["id"] not in old_by_id or comparable(sale) != comparable(old_by_id[sale["id"]])]
products = load_products()
stock_rows, missing_stock = load_stock(products)

expected_count = len(new_sales)
expected_total = sum(sale["total"] for sale in new_sales)
expected_cost = sum(sale["costTotal"] for sale in new_sales)
expected_sep_count = sum(1 for sale in new_sales if sale["date"].startswith("2026-09"))
expected_sep_total = sum(sale["total"] for sale in new_sales if sale["date"].startswith("2026-09"))
expected_sep_cost = sum(sale["costTotal"] for sale in new_sales if sale["date"].startswith("2026-09"))
expected_sep_profit = expected_sep_total - expected_sep_cost

sql = f"""begin;

do $guard$
begin
  if not exists (select 1 from public.stores where id = '{STORE_ID}'::uuid) then
    raise exception 'Target store not found';
  end if;
end
$guard$;

-- Semua aktivitas operasional aplikasi sebelum go-live adalah data testing.
delete from public.inventory_movement_change_requests where store_id = '{STORE_ID}'::uuid;
delete from public.inventory_movements where store_id = '{STORE_ID}'::uuid;
delete from public.sale_deletions where store_id = '{STORE_ID}'::uuid;
delete from public.audit_logs where store_id = '{STORE_ID}'::uuid;
delete from public.cash_closings where store_id = '{STORE_ID}'::uuid;
delete from public.receivings where store_id = '{STORE_ID}'::uuid;
delete from public.expenses where store_id = '{STORE_ID}'::uuid;
delete from public.pos_receipt_sequences where store_id = '{STORE_ID}'::uuid;
delete from public.sales
where store_id = '{STORE_ID}'::uuid
  and coalesce(correction_reason, '') not like 'Historical Excel import%';

-- Triggers on test-sale deletion may create operational audit rows; remove those generated test rows too.
delete from public.inventory_movement_change_requests where store_id = '{STORE_ID}'::uuid;
delete from public.inventory_movements where store_id = '{STORE_ID}'::uuid;
delete from public.sale_deletions where store_id = '{STORE_ID}'::uuid;
delete from public.audit_logs where store_id = '{STORE_ID}'::uuid;
delete from public.pos_receipt_sequences where store_id = '{STORE_ID}'::uuid;

-- Stok opname final per 30 September 2026. Produk Q4 yang kosong/tidak tercantum menjadi 0.
update public.products
set stock = 0,
    track_stock = true,
    updated_at = now()
where store_id = '{STORE_ID}'::uuid;

with stock_payload as (
  select value->>'baseName' as base_name, (value->>'stock')::integer as stock
  from jsonb_array_elements($cl_stock${sql_json(stock_rows)}$cl_stock$::jsonb)
)
update public.products product
set stock = stock_payload.stock,
    track_stock = true,
    updated_at = now()
from stock_payload
where product.store_id = '{STORE_ID}'::uuid
  and lower(regexp_replace(coalesce(product.base_name, product.name), '\\s+', ' ', 'g')) = stock_payload.base_name;

-- Hanya update transaksi berubah dan insert transaksi baru untuk menghemat write/egress.
with payload as (
  select jsonb_array_elements($cl_q3_delta${sql_json(delta)}$cl_q3_delta$::jsonb) as sale
)
insert into public.sales (
  id, store_id, receipt_number, cashier_id, cashier_name, items, total,
  cost_total, payment_method, cash_received, change_due, status,
  correction_reason, business_date, created_at, updated_at,
  payment_breakdown, payment_edit_history
)
select
  (sale->>'id')::uuid,
  '{STORE_ID}'::uuid,
  sale->>'receipt',
  null,
  sale->>'cashier',
  sale->'items',
  (sale->>'total')::bigint,
  (sale->>'costTotal')::bigint,
  sale->>'paymentMethod',
  (sale->>'cashReceived')::bigint,
  (sale->>'changeDue')::bigint,
  'completed'::public.sale_status,
  sale->>'reason',
  (sale->>'date')::date,
  (sale->>'createdAt')::timestamptz,
  (sale->>'createdAt')::timestamptz,
  sale->'paymentBreakdown',
  sale->'paymentEditHistory'
from payload
on conflict (id) do update set
  receipt_number = excluded.receipt_number,
  cashier_id = excluded.cashier_id,
  cashier_name = excluded.cashier_name,
  items = excluded.items,
  total = excluded.total,
  cost_total = excluded.cost_total,
  payment_method = excluded.payment_method,
  cash_received = excluded.cash_received,
  change_due = excluded.change_due,
  status = excluded.status,
  correction_reason = excluded.correction_reason,
  business_date = excluded.business_date,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at,
  payment_breakdown = excluded.payment_breakdown,
  payment_edit_history = excluded.payment_edit_history;

-- Remove migration-generated operational logs after product and sales writes.
delete from public.inventory_movement_change_requests where store_id = '{STORE_ID}'::uuid;
delete from public.inventory_movements where store_id = '{STORE_ID}'::uuid;
delete from public.sale_deletions where store_id = '{STORE_ID}'::uuid;
delete from public.audit_logs where store_id = '{STORE_ID}'::uuid;
delete from public.pos_receipt_sequences where store_id = '{STORE_ID}'::uuid;

do $validation$
declare
  actual_sales bigint;
  actual_total bigint;
  actual_cost bigint;
  actual_min date;
  actual_max date;
  non_excel bigint;
  operational_rows bigint;
  sep_count bigint;
  sep_total bigint;
  sep_cost bigint;
  wrong_stock bigint;
begin
  select count(*), coalesce(sum(total), 0), coalesce(sum(cost_total), 0), min(business_date), max(business_date)
  into actual_sales, actual_total, actual_cost, actual_min, actual_max
  from public.sales where store_id = '{STORE_ID}'::uuid;
  if actual_sales <> {expected_count} or actual_total <> {expected_total} or actual_cost <> {expected_cost}
     or actual_min <> date '2026-07-01' or actual_max <> date '2026-09-30' then
    raise exception 'Sales validation failed: count %, total %, cost %, range % to %', actual_sales, actual_total, actual_cost, actual_min, actual_max;
  end if;

  select count(*) into non_excel from public.sales
  where store_id = '{STORE_ID}'::uuid and coalesce(correction_reason, '') not like 'Historical Excel import%';
  if non_excel <> 0 then raise exception 'Non-Excel sales remain: %', non_excel; end if;

  select count(*), coalesce(sum(total), 0), coalesce(sum(cost_total), 0)
  into sep_count, sep_total, sep_cost
  from public.sales
  where store_id = '{STORE_ID}'::uuid and business_date between date '2026-09-01' and date '2026-09-30';
  if sep_count <> {expected_sep_count} or sep_total <> {expected_sep_total} or sep_cost <> {expected_sep_cost} then
    raise exception 'September validation failed: count %, omzet %, cost %', sep_count, sep_total, sep_cost;
  end if;

  select
    (select count(*) from public.inventory_movement_change_requests where store_id = '{STORE_ID}'::uuid) +
    (select count(*) from public.inventory_movements where store_id = '{STORE_ID}'::uuid) +
    (select count(*) from public.sale_deletions where store_id = '{STORE_ID}'::uuid) +
    (select count(*) from public.audit_logs where store_id = '{STORE_ID}'::uuid) +
    (select count(*) from public.cash_closings where store_id = '{STORE_ID}'::uuid) +
    (select count(*) from public.receivings where store_id = '{STORE_ID}'::uuid) +
    (select count(*) from public.expenses where store_id = '{STORE_ID}'::uuid) +
    (select count(*) from public.pos_receipt_sequences where store_id = '{STORE_ID}'::uuid)
  into operational_rows;
  if operational_rows <> 0 then raise exception 'Testing operational rows remain: %', operational_rows; end if;

  with expected as (
    select value->>'baseName' as base_name, (value->>'stock')::integer as stock
    from jsonb_array_elements($cl_stock_check${sql_json(stock_rows)}$cl_stock_check$::jsonb)
  )
  select count(*) into wrong_stock
  from public.products product
  join expected on lower(regexp_replace(coalesce(product.base_name, product.name), '\\s+', ' ', 'g')) = expected.base_name
  where product.store_id = '{STORE_ID}'::uuid and product.stock <> expected.stock;
  if wrong_stock <> 0 then raise exception 'Stock validation failed: %', wrong_stock; end if;
end
$validation$;

select date_trunc('month', business_date)::date as month,
       count(*) as transactions,
       sum(total) as omzet,
       sum(cost_total) as hpp,
       sum(total - cost_total) as profit
from public.sales
where store_id = '{STORE_ID}'::uuid
group by 1
order by 1;

-- Expected September profit: {expected_sep_profit}
commit;
"""

OUTPUT.write_text(sql)
print(json.dumps({
    "old_sales": len(old_sales),
    "new_sales": len(new_sales),
    "delta_sales": len(delta),
    "inserted_sales": sum(sale["id"] not in old_by_id for sale in delta),
    "updated_sales": sum(sale["id"] in old_by_id for sale in delta),
    "expected_total": expected_total,
    "expected_cost": expected_cost,
    "september_count": expected_sep_count,
    "september_omzet": expected_sep_total,
    "september_hpp": expected_sep_cost,
    "september_profit": expected_sep_profit,
    "q4_products": len(products),
    "missing_stock_defaulted_to_zero": missing_stock,
    "unmatched_sales_rows": len(unmatched_sales),
    "migration_bytes": len(sql.encode()),
}, ensure_ascii=False, indent=2))
