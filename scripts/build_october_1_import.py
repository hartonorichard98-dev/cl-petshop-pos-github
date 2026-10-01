import hashlib
import importlib.util
import json
import re
import sys
import uuid
from collections import OrderedDict, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


STORE_ID = "24a3a058-991b-4b64-b1d2-912910842d34"
IMPORT_NAMESPACE = uuid.UUID("5f0e2168-9e32-4ef8-b3c4-c604ea4ef40d")


def load_catalog_module(path: Path):
    spec = importlib.util.spec_from_file_location("catalog_builder", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def money(value: str) -> int:
    return int(re.sub(r"[^0-9]", "", value or "") or 0)


def payment_method(value: str) -> str:
    normalized = value.casefold()
    if "qris" in normalized:
        return "qris"
    if "trf" in normalized or "transfer" in normalized:
        return "transfer"
    if "debit" in normalized:
        return "debit"
    return "cash"


def build_sales(transaction_path: Path, products: list[dict], catalog_module) -> list[dict]:
    products_by_name = {catalog_module.normalized_name(product["name"]): product for product in products}
    products_by_barcode = {product["barcode"]: product for product in products if product["barcode"]}
    selling_rows = {}
    for product in products:
        for tier in product["tiers"]:
            selling_rows[(catalog_module.normalized_name(product["name"]), int(tier["minQty"]))] = tier

    groups = OrderedDict()
    current_transaction = None
    rows = transaction_path.read_text(encoding="utf-8").splitlines()[1:]
    for line_number, line in enumerate(rows, start=2):
        if not line.strip():
            continue
        columns = line.split("\t")
        if len(columns) != 9:
            raise ValueError(f"Baris transaksi {line_number} tidak punya 9 kolom")
        if columns[1].strip():
            current_transaction = int(columns[1])
        if current_transaction is None:
            raise ValueError(f"Nomor transaksi kosong pada baris {line_number}")

        raw_name = (columns[4] or columns[2]).strip()
        name, tier_minimum = catalog_module.base_name(raw_name)
        product = products_by_name.get(catalog_module.normalized_name(name))
        if not product and columns[3].strip():
            product = products_by_barcode.get(columns[3].strip())
        if not product:
            raise ValueError(f"Produk transaksi tidak ditemukan: {raw_name}")
        tier = selling_rows.get((catalog_module.normalized_name(product["name"]), tier_minimum))
        if not tier:
            raise ValueError(f"Tier {tier_minimum}+ tidak ditemukan untuk {raw_name}")

        quantity = int(columns[6])
        unit_price = money(columns[5])
        line_total = money(columns[7])
        if abs(float(tier["sell"]) - unit_price) > 0.51:
            raise ValueError(f"Harga berbeda untuk {raw_name}: {unit_price} vs {tier['sell']}")

        group = groups.setdefault(current_transaction, {"items": [], "payments": set()})
        group["payments"].add(payment_method(columns[8]))
        group["items"].append(
            {
                "id": product["id"],
                "productId": product["id"],
                "sku": product["sku"],
                "barcode": columns[3].strip() or product["barcode"],
                "name": raw_name,
                "baseName": product["name"],
                "sell": unit_price,
                "cost": tier["cost"],
                "qty": quantity,
                "lineCost": round(float(tier["cost"]) * quantity, 2),
                "lineTotal": line_total,
                "active": True,
                "trackStock": True,
                "isTier": tier_minimum > 1,
                "tierMin": tier_minimum,
                "minQty": tier_minimum,
                "groupKey": catalog_module.normalized_name(product["name"]),
                "image": "",
                "needsPrice": False,
            }
        )

    if sorted(groups) != list(range(1, 88)):
        raise ValueError("Nomor transaksi harus lengkap 1 sampai 87")

    jakarta = timezone(timedelta(hours=7))
    sales = []
    for transaction_number, group in groups.items():
        if len(group["payments"]) != 1:
            raise ValueError(f"Transaksi {transaction_number} punya metode pembayaran campur")
        method = next(iter(group["payments"]))
        total = sum(item["lineTotal"] for item in group["items"])
        cost_total = round(sum(item["lineCost"] for item in group["items"]))
        created_at = datetime(2026, 10, 1, 12, 0, tzinfo=jakarta) + timedelta(seconds=transaction_number)
        sale_id = str(uuid.uuid5(IMPORT_NAMESPACE, f"2026-10-01:{transaction_number}"))
        signature = hashlib.sha256(
            json.dumps({"trx": transaction_number, "items": group["items"], "total": total, "payment": method}, sort_keys=True).encode()
        ).hexdigest()
        sales.append(
            {
                "trx": transaction_number,
                "id": sale_id,
                "receipt": f"011026-{transaction_number:04d}",
                "cashier": "Admin Excel 1 Oktober",
                "items": group["items"],
                "total": total,
                "cost": cost_total,
                "paymentMethod": method,
                "paymentBreakdown": [{"method": method, "amount": total}],
                "cash": total if method == "cash" else 0,
                "change": 0,
                "status": "completed",
                "reason": "Excel import 1 Oktober 2026 setelah SO 30 September",
                "createdAt": created_at.isoformat(),
                "signature": signature,
            }
        )
    return sales


def final_stocks(products: list[dict], sales: list[dict]) -> dict[int, int]:
    quantities = defaultdict(int)
    for sale in sales:
        for item in sale["items"]:
            quantities[int(item["productId"])] += int(item["qty"])
    return {int(product["id"]): int(product["stock"]) - quantities[int(product["id"])] for product in products}


def sql_payload(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("$oct$", "$oct $")


def write_snapshot(catalog_module, products: list[dict], stocks: dict[int, int], destination: Path) -> None:
    snapshot = {catalog_module.stock_key(product["name"]): stocks[int(product["id"])] for product in products}
    destination.write_text(
        "window.CL_STOCK_SNAPSHOT_VERSION='2026-10-01-stock-after-excel-sales-v1';\n"
        f"window.CL_STOCK_SNAPSHOT={json.dumps(snapshot, ensure_ascii=False, separators=(',', ':'))};\n",
        encoding="utf-8",
    )


def write_migration(products: list[dict], sales: list[dict], stocks: dict[int, int], destination: Path) -> None:
    catalog = [{**product, "finalStock": stocks[int(product["id"])]} for product in products]
    total = sum(sale["total"] for sale in sales)
    cost = sum(sale["cost"] for sale in sales)
    payment_totals = defaultdict(int)
    payment_counts = defaultdict(int)
    for sale in sales:
        payment_totals[sale["paymentMethod"]] += sale["total"]
        payment_counts[sale["paymentMethod"]] += 1

    sql = f"""begin;

create temporary table preserved_sales_before on commit drop as
select count(*)::bigint as sale_count, coalesce(sum(total), 0)::bigint as omzet, coalesce(sum(cost_total), 0)::bigint as hpp
from public.sales
where store_id = '{STORE_ID}'::uuid and business_date < date '2026-10-01';

create temporary table incoming_oct_catalog on commit drop as
select * from jsonb_to_recordset($oct${sql_payload(catalog)}$oct$::jsonb) as item(
  id bigint, sku text, barcode text, image text, name text, \"baseName\" text,
  sell numeric, cost numeric, tiers jsonb, stock integer, \"finalStock\" integer,
  \"trackStock\" boolean, active boolean, \"needsPrice\" boolean
);

update public.products product
set name = incoming.name,
    base_name = incoming.\"baseName\",
    sell_price = round(incoming.sell),
    cost_price = round(incoming.cost),
    stock = incoming.stock,
    track_stock = true,
    active = incoming.active,
    pricing_rule = jsonb_build_object('tiers', incoming.tiers),
    updated_at = now()
from incoming_oct_catalog incoming
where product.store_id = '{STORE_ID}'::uuid
  and (product.local_id = incoming.id or lower(btrim(coalesce(product.base_name, product.name))) = lower(btrim(incoming.name)));

insert into public.products (store_id, local_id, sku, barcode, name, base_name, sell_price, cost_price, stock, track_stock, active, pricing_rule)
select '{STORE_ID}'::uuid, incoming.id,
       case when exists (select 1 from public.products conflict where conflict.store_id = '{STORE_ID}'::uuid and conflict.sku = incoming.sku) then 'CL-Q4-' || incoming.id::text else incoming.sku end,
       case when nullif(incoming.barcode, '') is null or exists (select 1 from public.products conflict where conflict.store_id = '{STORE_ID}'::uuid and conflict.barcode = incoming.barcode) then null else incoming.barcode end,
       incoming.name, incoming.\"baseName\", round(incoming.sell), round(incoming.cost), incoming.stock, true, incoming.active, jsonb_build_object('tiers', incoming.tiers)
from incoming_oct_catalog incoming
where not exists (
  select 1 from public.products product
  where product.store_id = '{STORE_ID}'::uuid
    and (product.local_id = incoming.id or lower(btrim(coalesce(product.base_name, product.name))) = lower(btrim(incoming.name)))
);

update public.products product set active = false, updated_at = now()
where product.store_id = '{STORE_ID}'::uuid
  and not exists (select 1 from incoming_oct_catalog incoming where lower(btrim(incoming.name)) = lower(btrim(coalesce(product.base_name, product.name))));

create temporary table old_october_sales on commit drop as
select id from public.sales where store_id = '{STORE_ID}'::uuid and business_date = date '2026-10-01';

delete from public.inventory_movement_change_requests request
where request.store_id = '{STORE_ID}'::uuid
  and exists (select 1 from public.inventory_movements movement join old_october_sales old_sale on movement.reference_id = old_sale.id::text where movement.id = request.movement_id);
delete from public.inventory_movements movement
where movement.store_id = '{STORE_ID}'::uuid and exists (select 1 from old_october_sales old_sale where movement.reference_id = old_sale.id::text);
delete from public.audit_logs log
where log.store_id = '{STORE_ID}'::uuid and exists (select 1 from old_october_sales old_sale where log.entity_id = old_sale.id::text);
delete from public.sales sale
where sale.store_id = '{STORE_ID}'::uuid and sale.business_date = date '2026-10-01';

delete from public.pos_receipt_sequences where store_id = '{STORE_ID}'::uuid and month_key = '202610';

create temporary table incoming_october_sales on commit drop as
select * from jsonb_to_recordset($oct${sql_payload(sales)}$oct$::jsonb) as sale(
  trx integer, id uuid, receipt text, cashier text, items jsonb, total bigint, cost bigint,
  \"paymentMethod\" text, \"paymentBreakdown\" jsonb, cash bigint, change bigint,
  status public.sale_status, reason text, \"createdAt\" timestamptz, signature text
);

delete from public.sale_deletions deletion
where deletion.store_id = '{STORE_ID}'::uuid and exists (select 1 from incoming_october_sales incoming where incoming.id = deletion.sale_id);

insert into public.sales (
  id, store_id, receipt_number, cashier_id, cashier_name, items, total, cost_total,
  payment_method, payment_breakdown, cash_received, change_due, status, correction_reason,
  business_date, created_at, updated_at, payment_edit_history
)
select sale.id, '{STORE_ID}'::uuid, sale.receipt, null, sale.cashier, sale.items, sale.total, sale.cost,
       sale.\"paymentMethod\", sale.\"paymentBreakdown\", sale.cash, sale.change, sale.status, sale.reason,
       date '2026-10-01', sale.\"createdAt\", now(), '[]'::jsonb
from incoming_october_sales sale
order by sale.trx;

update public.products product
set stock = incoming.\"finalStock\", track_stock = true, updated_at = now()
from incoming_oct_catalog incoming
where product.store_id = '{STORE_ID}'::uuid
  and (product.local_id = incoming.id or lower(btrim(coalesce(product.base_name, product.name))) = lower(btrim(incoming.name)));

insert into public.audit_logs (id, store_id, actor_id, actor_name, actor_role, action, entity_id, detail, created_at)
values (
  'excel-import-2026-10-01', '{STORE_ID}'::uuid, null, 'Owner CL Petshop', 'owner',
  'IMPORT_EXCEL_SALES', '2026-10-01',
  'SO 30 September diterapkan lalu 87 transaksi Excel 1 Oktober diimpor. Omzet Rp5.070.000.', now()
)
on conflict (id) do update set detail = excluded.detail, created_at = excluded.created_at;

do $validation$
declare
  preserved_before record;
  preserved_after record;
  oct_count bigint;
  oct_total bigint;
  oct_cost bigint;
  wrong_stock bigint;
begin
  select * into preserved_before from preserved_sales_before;
  select count(*)::bigint as sale_count, coalesce(sum(total), 0)::bigint as omzet, coalesce(sum(cost_total), 0)::bigint as hpp
  into preserved_after
  from public.sales where store_id = '{STORE_ID}'::uuid and business_date < date '2026-10-01';
  if row(preserved_before.sale_count, preserved_before.omzet, preserved_before.hpp) is distinct from row(preserved_after.sale_count, preserved_after.omzet, preserved_after.hpp) then
    raise exception 'Historical sales before October changed';
  end if;

  select count(*), coalesce(sum(total), 0), coalesce(sum(cost_total), 0)
  into oct_count, oct_total, oct_cost
  from public.sales where store_id = '{STORE_ID}'::uuid and business_date = date '2026-10-01';
  if oct_count <> {len(sales)} or oct_total <> {total} or oct_cost <> {cost} then
    raise exception 'October import validation failed: count %, omzet %, hpp %', oct_count, oct_total, oct_cost;
  end if;

  select count(*) into wrong_stock
  from public.products product
  join incoming_oct_catalog incoming on lower(btrim(coalesce(product.base_name, product.name))) = lower(btrim(incoming.name))
  where product.store_id = '{STORE_ID}'::uuid and product.stock <> incoming.\"finalStock\";
  if wrong_stock <> 0 then raise exception 'Final stock validation failed: %', wrong_stock; end if;

  if (select count(*) from public.sales where store_id = '{STORE_ID}'::uuid and business_date = date '2026-10-01' and payment_method = 'cash') <> {payment_counts['cash']}
     or (select coalesce(sum(total),0) from public.sales where store_id = '{STORE_ID}'::uuid and business_date = date '2026-10-01' and payment_method = 'cash') <> {payment_totals['cash']}
     or (select count(*) from public.sales where store_id = '{STORE_ID}'::uuid and business_date = date '2026-10-01' and payment_method = 'qris') <> {payment_counts['qris']}
     or (select coalesce(sum(total),0) from public.sales where store_id = '{STORE_ID}'::uuid and business_date = date '2026-10-01' and payment_method = 'qris') <> {payment_totals['qris']}
     or (select count(*) from public.sales where store_id = '{STORE_ID}'::uuid and business_date = date '2026-10-01' and payment_method = 'transfer') <> {payment_counts['transfer']}
     or (select coalesce(sum(total),0) from public.sales where store_id = '{STORE_ID}'::uuid and business_date = date '2026-10-01' and payment_method = 'transfer') <> {payment_totals['transfer']}
     or (select count(*) from public.sales where store_id = '{STORE_ID}'::uuid and business_date = date '2026-10-01' and payment_method = 'debit') <> {payment_counts['debit']}
     or (select coalesce(sum(total),0) from public.sales where store_id = '{STORE_ID}'::uuid and business_date = date '2026-10-01' and payment_method = 'debit') <> {payment_totals['debit']} then
    raise exception 'Payment totals validation failed';
  end if;
end
$validation$;

commit;
"""
    destination.write_text(sql, encoding="utf-8")


def main() -> None:
    if len(sys.argv) != 7:
        raise SystemExit("usage: build_october_1_import.py SELLING STOCK TRANSACTIONS PRICE_JS STOCK_JS MIGRATION_SQL")
    selling, stock, transactions, price_js, stock_js, migration = map(Path, sys.argv[1:])
    catalog_module = load_catalog_module(Path(__file__).with_name("build_catalog_from_text.py"))
    products, missing_stock, unused_stock = catalog_module.build_catalog(selling, stock, price_js)
    catalog_module.write_javascript(products, price_js, stock_js)
    price_text = price_js.read_text(encoding="utf-8").replace("2026-10-01-product-selling-v1", "2026-10-01-product-selling-v2")
    price_js.write_text(price_text, encoding="utf-8")
    sales = build_sales(transactions, products, catalog_module)
    stocks = final_stocks(products, sales)
    write_snapshot(catalog_module, products, stocks, stock_js)
    write_migration(products, sales, stocks, migration)
    print(f"Products: {len(products)}")
    print(f"Sales: {len(sales)}")
    print(f"Items: {sum(len(sale['items']) for sale in sales)}")
    print(f"Omzet: {sum(sale['total'] for sale in sales)}")
    print(f"HPP: {sum(sale['cost'] for sale in sales)}")
    print(f"Profit: {sum(sale['total'] - sale['cost'] for sale in sales)}")
    print(f"Missing stock default 0: {missing_stock}")
    print(f"Unused stock rows: {unused_stock}")


if __name__ == "__main__":
    main()
