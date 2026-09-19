import json
import re
import sys
from pathlib import Path

import openpyxl


def barcode_value(value: object) -> str:
    if value in (None, ''):
        return ''
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def main() -> None:
    source = Path(sys.argv[1])
    destination = Path(sys.argv[2])
    sheet = openpyxl.load_workbook(source, read_only=True, data_only=True).active
    products = []

    for row_number, row in enumerate(sheet.iter_rows(values_only=True), start=1):
        if row_number == 1:
            continue

        name = str(row[0] or '').strip()
        if not name:
            continue

        sell_price = row[1] if len(row) > 1 and isinstance(row[1], (int, float)) else 0
        cost_price = row[2] if len(row) > 2 and isinstance(row[2], (int, float)) else 0
        barcode = barcode_value(row[3]) if len(row) > 3 else ''
        has_price = sell_price > 0
        tier_match = re.match(r'^\((\d+)\+\)\s*(.+)$', name, re.IGNORECASE)
        unit_match = re.match(r'^\(SATUAN\)\s*(.+)$', name, re.IGNORECASE)
        tier_minimum = int(tier_match.group(1)) if tier_match else 1
        base_name = tier_match.group(2).strip() if tier_match else unit_match.group(1).strip() if unit_match else name

        products.append(
            {
                'id': len(products) + 1,
                'sku': f'CL-{len(products) + 1:04d}',
                'barcode': barcode,
                'image': '',
                'name': name,
                'baseName': base_name,
                'tierMin': tier_minimum,
                'isTier': bool(tier_match),
                'sell': round(float(sell_price), 2),
                'cost': round(float(cost_price), 2) if has_price else 0,
                'stock': 0,
                'trackStock': False,
                'active': has_price,
                'needsPrice': not has_price,
            }
        )

    payload = json.dumps(products, ensure_ascii=False, separators=(',', ':'))
    destination.write_text(
        "window.CL_PRICE_LIST_VERSION='2026-09-19-database-app-kasir-2-v1';\n"
        f'window.CL_PRICE_LIST={payload};\n',
        encoding='utf-8',
    )

    missing = [product for product in products if product['needsPrice']]
    print(f'products={len(products)} missing_price={len(missing)}')
    for product in missing:
        print(f"missing: {product['sku']} {product['name']}")


if __name__ == '__main__':
    main()
