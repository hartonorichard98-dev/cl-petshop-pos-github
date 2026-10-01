import json
import re
import sys
import unicodedata
from collections import OrderedDict
from pathlib import Path


TIER_PATTERN = re.compile(r"^\((\d+)\+\)\s*(.+)$", re.IGNORECASE)
UNIT_PATTERN = re.compile(r"^\(SATUAN\)\s*(.+)$", re.IGNORECASE)


def parse_money(value: str) -> float:
    cleaned = re.sub(r"[^0-9,.-]", "", value or "").replace(",", "")
    return round(float(cleaned), 2) if cleaned else 0


def parse_number(value: str) -> int:
    cleaned = re.sub(r"[^0-9-]", "", value or "")
    return int(cleaned) if cleaned else 0


def base_name(value: str) -> tuple[str, int]:
    name = value.strip()
    tier_match = TIER_PATTERN.match(name)
    if tier_match:
        return tier_match.group(2).strip(), int(tier_match.group(1))
    unit_match = UNIT_PATTERN.match(name)
    if unit_match:
        return unit_match.group(1).strip(), 1
    return name, 1


def normalized_name(value: str) -> str:
    return " ".join(value.casefold().split())


def stock_key(value: str) -> str:
    normalized = unicodedata.normalize("NFD", value.casefold())
    normalized = "".join(character for character in normalized if unicodedata.category(character) != "Mn")
    normalized = re.sub(r"\b(grams?|gram)\b", "gr", normalized)
    normalized = re.sub(r"\b(kilograms?|kilogram|kilo)\b", "kg", normalized)
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", normalized)).strip()


def read_existing_catalog(path: Path) -> list[dict]:
    if not path.exists():
        return []
    match = re.search(r"window\.CL_PRICE_LIST=(\[.*\]);\s*$", path.read_text(encoding="utf-8"), re.DOTALL)
    return json.loads(match.group(1)) if match else []


def read_stock(path: Path) -> dict[str, int]:
    rows = path.read_text(encoding="utf-8").splitlines()
    stock = {}
    for line_number, line in enumerate(rows[1:], start=2):
        if not line.strip():
            continue
        columns = line.split("\t")
        if len(columns) != 2:
            raise ValueError(f"Baris stok {line_number} tidak punya 2 kolom")
        name, _ = base_name(columns[0])
        key = stock_key(name)
        if key in stock:
            raise ValueError(f"Nama stok duplikat: {name}")
        stock[key] = parse_number(columns[1])
    return stock


def build_catalog(selling_path: Path, stock_path: Path, existing_path: Path) -> tuple[list[dict], list[str], list[str]]:
    existing = read_existing_catalog(existing_path)
    existing_by_name = {normalized_name(item.get("baseName") or item["name"]): item for item in existing}
    next_id = max((int(item.get("id") or 0) for item in existing), default=0) + 1
    stock = read_stock(stock_path)
    groups = OrderedDict()

    rows = selling_path.read_text(encoding="utf-8").splitlines()
    for line_number, line in enumerate(rows[1:], start=2):
        if not line.strip():
            continue
        columns = line.split("\t")
        if len(columns) != 4:
            raise ValueError(f"Baris harga {line_number} tidak punya 4 kolom")
        source_name, selling, cost, barcode = (column.strip() for column in columns)
        name, minimum = base_name(source_name)
        key = normalized_name(name)
        group = groups.setdefault(key, {"name": name, "rows": []})
        group["rows"].append(
            {
                "minimum": minimum,
                "sell": parse_money(selling),
                "cost": parse_money(cost),
                "barcode": barcode,
            }
        )

    products = []
    missing_stock = []
    for key, group in groups.items():
        priced_rows = sorted((row for row in group["rows"] if row["sell"] > 0), key=lambda row: row["minimum"])
        tiers = OrderedDict()
        for row in priced_rows:
            if row["minimum"] in tiers:
                raise ValueError(f"Tangga harga {row['minimum']}+ duplikat untuk {group['name']}")
            tiers[row["minimum"]] = {
                "minQty": row["minimum"],
                "sell": row["sell"],
                "cost": row["cost"],
            }
        if key == "liebao 15 gr" and 1 not in tiers:
            reference = tiers.get(5) or next(iter(tiers.values()))
            tiers[1] = {"minQty": 1, "sell": 1000, "cost": reference["cost"]}
            tiers = OrderedDict(sorted(tiers.items()))

        existing_product = existing_by_name.get(key)
        if existing_product:
            product_id = int(existing_product["id"])
            sku = existing_product.get("sku") or f"CL-{product_id:04d}"
        else:
            product_id = next_id
            next_id += 1
            sku = f"CL-{product_id:04d}"

        primary = tiers.get(1) or (next(iter(tiers.values())) if tiers else {"sell": 0, "cost": 0})
        barcode = next((row["barcode"] for row in group["rows"] if row["barcode"]), "")
        product_stock = stock.get(stock_key(group["name"]), 0)
        if stock_key(group["name"]) not in stock:
            missing_stock.append(group["name"])
        products.append(
            {
                "id": product_id,
                "sku": sku,
                "barcode": barcode,
                "image": "",
                "name": group["name"],
                "baseName": group["name"],
                "sell": primary["sell"],
                "cost": primary["cost"],
                "tiers": list(tiers.values()),
                "stock": product_stock,
                "trackStock": True,
                "active": bool(tiers),
                "needsPrice": not tiers,
            }
        )

    catalog_stock_keys = {stock_key(group["name"]) for group in groups.values()}
    unused_stock = sorted(set(stock) - catalog_stock_keys)
    return products, missing_stock, unused_stock


def write_javascript(products: list[dict], price_path: Path, stock_path: Path) -> None:
    price_payload = [{**product, "stock": 0, "trackStock": False} for product in products]
    price_path.write_text(
        "window.CL_PRICE_LIST_VERSION='2026-10-01-product-selling-v1';\n"
        f"window.CL_PRICE_LIST={json.dumps(price_payload, ensure_ascii=False, separators=(',', ':'))};\n",
        encoding="utf-8",
    )
    snapshot = {stock_key(product["name"]): product["stock"] for product in products}
    stock_path.write_text(
        "window.CL_STOCK_SNAPSHOT_VERSION='2026-10-01-product-stock-v2';\n"
        f"window.CL_STOCK_SNAPSHOT={json.dumps(snapshot, ensure_ascii=False, separators=(',', ':'))};\n",
        encoding="utf-8",
    )


def write_migration(products: list[dict], migration_path: Path) -> None:
    payload = json.dumps(products, ensure_ascii=False, separators=(",", ":")).replace("$catalog$", "$catalog $ ")
    migration_path.write_text(
        "begin;\n\n"
        "create temporary table incoming_authoritative_catalog on commit drop as\n"
        "select * from jsonb_to_recordset($catalog$"
        f"{payload}"
        "$catalog$::jsonb) as item(\n"
        "  id bigint, sku text, barcode text, image text, name text, \"baseName\" text,\n"
        "  sell numeric, cost numeric, tiers jsonb, stock integer, \"trackStock\" boolean,\n"
        "  active boolean, \"needsPrice\" boolean\n"
        ");\n\n"
        "update public.products product\n"
        "set sku = incoming.sku,\n"
        "    barcode = nullif(incoming.barcode, ''),\n"
        "    name = incoming.name,\n"
        "    base_name = incoming.\"baseName\",\n"
        "    sell_price = round(incoming.sell),\n"
        "    cost_price = round(incoming.cost),\n"
        "    stock = incoming.stock,\n"
        "    track_stock = true,\n"
        "    active = incoming.active,\n"
        "    pricing_rule = jsonb_build_object('tiers', incoming.tiers),\n"
        "    updated_at = now()\n"
        "from incoming_authoritative_catalog incoming\n"
        "where product.store_id = '24a3a058-991b-4b64-b1d2-912910842d34'::uuid\n"
        "  and lower(btrim(coalesce(product.base_name, product.name))) = lower(btrim(incoming.name));\n\n"
        "insert into public.products (store_id, local_id, sku, barcode, name, base_name, sell_price, cost_price, stock, track_stock, active, pricing_rule)\n"
        "select '24a3a058-991b-4b64-b1d2-912910842d34'::uuid, incoming.id, incoming.sku, nullif(incoming.barcode, ''), incoming.name, incoming.\"baseName\", round(incoming.sell), round(incoming.cost), incoming.stock, true, incoming.active, jsonb_build_object('tiers', incoming.tiers)\n"
        "from incoming_authoritative_catalog incoming\n"
        "where not exists (\n"
        "  select 1 from public.products product\n"
        "  where product.store_id = '24a3a058-991b-4b64-b1d2-912910842d34'::uuid\n"
        "    and lower(btrim(coalesce(product.base_name, product.name))) = lower(btrim(incoming.name))\n"
        ");\n\n"
        "update public.products product\n"
        "set active = false, updated_at = now()\n"
        "where product.store_id = '24a3a058-991b-4b64-b1d2-912910842d34'::uuid\n"
        "  and not exists (\n"
        "    select 1 from incoming_authoritative_catalog incoming\n"
        "    where lower(btrim(incoming.name)) = lower(btrim(coalesce(product.base_name, product.name)))\n"
        "  );\n\n"
        "commit;\n",
        encoding="utf-8",
    )


def main() -> None:
    if len(sys.argv) != 6:
        raise SystemExit("usage: build_catalog_from_text.py SELLING STOCK PRICE_JS STOCK_JS MIGRATION_SQL")
    selling_path, stock_source, price_path, stock_path, migration_path = map(Path, sys.argv[1:])
    products, missing_stock, unused_stock = build_catalog(selling_path, stock_source, price_path)
    write_javascript(products, price_path, stock_path)
    write_migration(products, migration_path)
    tier_count = sum(len(product["tiers"]) for product in products)
    print(f"Products: {len(products)}")
    print(f"Price tiers: {tier_count}")
    print(f"Missing stock set to 0: {len(missing_stock)}")
    for name in missing_stock:
        print(f"  - {name}")
    print(f"Unused stock rows: {len(unused_stock)}")
    for name in unused_stock:
        print(f"  - {name}")


if __name__ == "__main__":
    main()
