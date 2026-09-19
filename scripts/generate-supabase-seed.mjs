import fs from 'node:fs'
import vm from 'node:vm'

const storeId = '24a3a058-991b-4b64-b1d2-912910842d34'
const source = fs.readFileSync(new URL('../price-list-data.js', import.meta.url), 'utf8')
const context = { window: {} }

vm.createContext(context)
vm.runInContext(source, context)

const products = context.window.CL_PRICE_LIST.map((product) => ({
  i: product.id,
  s: product.sku,
  b: product.barcode || null,
  n: product.name,
  a: product.baseName || product.name,
  u: product.image || null,
  j: Math.round(Number(product.sell || 0)),
  c: Math.round(Number(product.cost || 0)),
  q: Math.max(0, Math.round(Number(product.stock || 0))),
  t: Boolean(product.trackStock),
  v: Boolean(product.active),
  r: {
    tierMin: Math.max(1, Math.round(Number(product.tierMin || 1))),
    isTier: Boolean(product.isTier),
    needsPrice: Boolean(product.needsPrice),
  },
}))

const statements = []

for (let start = 0; start < products.length; start += 100) {
  const batch = JSON.stringify(products.slice(start, start + 100))
  statements.push(`
insert into public.products (
  store_id, local_id, sku, barcode, name, base_name, image_url,
  sell_price, cost_price, stock, track_stock, active, pricing_rule
)
select
  '${storeId}'::uuid, item.i, item.s, item.b, item.n, item.a, item.u,
  item.j, item.c, item.q, item.t, item.v, item.r
from jsonb_to_recordset($catalog$${batch}$catalog$::jsonb) as item(
  i bigint, s text, b text, n text, a text, u text,
  j bigint, c bigint, q integer, t boolean, v boolean, r jsonb
)
on conflict (store_id, sku) do update set
  local_id = excluded.local_id,
  barcode = excluded.barcode,
  name = excluded.name,
  base_name = excluded.base_name,
  image_url = excluded.image_url,
  sell_price = excluded.sell_price,
  cost_price = excluded.cost_price,
  stock = excluded.stock,
  track_stock = excluded.track_stock,
  active = excluded.active,
  pricing_rule = excluded.pricing_rule,
  updated_at = now();
`)
}

fs.writeFileSync(new URL('../supabase/seed.sql', import.meta.url), statements.join('\n'))
console.log(`Generated Supabase seed for ${products.length} products.`)
