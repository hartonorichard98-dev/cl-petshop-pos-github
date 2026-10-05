(function applyCatalogHotfixes() {
  const products = Array.isArray(window.CL_PRICE_LIST) ? window.CL_PRICE_LIST : []
  const anthel = products.find(product => String(product.name || '').trim().toLowerCase() === 'anthel cat')
  if (!anthel) return

  anthel.sell = 15000
  anthel.cost = 10000
  anthel.tiers = [
    { minQty: 1, sell: 15000, cost: 10000 },
    { minQty: 10, sell: 12500, cost: 10000 },
  ]
  anthel.catalogUpdatedAt = '2026-10-03T11:39:37.716Z'
  window.CL_PRICE_LIST_VERSION = '2026-10-05-product-selling-v3'
})()
