if (!window.__CL_POS_CLOUD_SYNC_LOADED__) {
  window.__CL_POS_CLOUD_SYNC_LOADED__ = true
const FINGERPRINTS_KEY = 'cl-petshop-cloud-fingerprints-v3'
const POLL_MS = 15000
const SYNC_ENDPOINT = window.location.protocol === 'file:'
  ? 'https://cl-petshop-pos.vercel.app/api/pos-sync'
  : '/api/pos-sync'

let credentials = null
let syncing = false
let rerunRequested = false
let timer = null

function fingerprint(sale) {
  return JSON.stringify({
    id: sale.id,
    receipt: sale.receipt,
    cashier: sale.cashier,
    items: sale.items,
    total: sale.total,
    cost: sale.cost,
    paymentMethod: sale.paymentMethod,
    cash: sale.cash,
    change: sale.change,
    status: sale.status,
    reason: sale.reason,
    day: sale.day,
    createdAt: sale.createdAt,
    updatedAt: sale.updatedAt,
    editedAt: sale.editedAt,
    editedBy: sale.editedBy,
    editReason: sale.editReason,
    deletedAt: sale.deletedAt,
    deletedBy: sale.deletedBy,
    deleteReason: sale.deleteReason,
    voidedAt: sale.voidedAt,
    voidedBy: sale.voidedBy,
  })
}

function fingerprints() {
  try { return JSON.parse(localStorage.getItem(FINGERPRINTS_KEY) || '{}') || {} } catch { return {} }
}

function saveFingerprints(value) {
  localStorage.setItem(FINGERPRINTS_KEY, JSON.stringify(value))
}

function setStatus(message, state = 'local') {
  window.CL_POS?.setCloudStatus(message, state)
}

function currentSales() {
  return window.CL_POS?.getSales?.() || []
}

function wholeMoney(value) {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.round(amount) : 0
}

function cloudPayloadSale(sale) {
  return {
    ...sale,
    total: wholeMoney(sale.total),
    cost: wholeMoney(sale.cost),
    cash: wholeMoney(sale.cash),
    change: wholeMoney(sale.change),
  }
}

async function syncSales() {
  if (!credentials || !navigator.onLine) return
  if (syncing) {
    rerunRequested = true
    return
  }
  syncing = true
  rerunRequested = false
  setStatus('Menyinkronkan cloud…', 'syncing')
  try {
    const previous = fingerprints()
    const sales = currentSales()
    const requestFingerprints = new Map(sales.map(sale => [sale.id, fingerprint(sale)]))
    const eligibleSales = credentials.role === 'cashier'
      ? sales.filter(sale => sale.status === 'completed')
      : sales
    const changed = eligibleSales.filter(sale => previous[sale.id] !== requestFingerprints.get(sale.id))
    const response = await fetch(SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: credentials.username,
        pin: credentials.pin,
        sales: changed.map(cloudPayloadSale),
      }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)

    const latestBeforeMerge = currentSales()
    const latestFingerprints = new Map(latestBeforeMerge.map(sale => [sale.id, fingerprint(sale)]))
    const preserveIds = latestBeforeMerge
      .filter(sale => requestFingerprints.get(sale.id) !== latestFingerprints.get(sale.id))
      .map(sale => sale.id)
    const cloudSales = Array.isArray(result.sales) ? result.sales : []
    window.CL_POS?.mergeCloudSales?.(cloudSales, {
      includeCost: result.role === 'owner',
      preserveIds,
      deletedIds: Array.isArray(result.deleted_ids) ? result.deleted_ids : [],
    })

    const next = fingerprints()
    const preserved = new Set(preserveIds)
    const current = new Map(currentSales().map(sale => [sale.id, sale]))
    cloudSales.forEach(sale => {
      const local = current.get(sale.id)
      if (local && !preserved.has(sale.id)) next[sale.id] = fingerprint(local)
    })
    changed.forEach(sale => {
      const local = current.get(sale.id)
      const sentFingerprint = requestFingerprints.get(sale.id)
      if (local && fingerprint(local) === sentFingerprint) next[sale.id] = sentFingerprint
    })
    Object.keys(next).forEach(id => {
      if (!current.has(id)) delete next[id]
    })
    saveFingerprints(next)

    const pending = [...current.values()].some(sale => {
      if (credentials.role === 'cashier' && sale.status !== 'completed') return false
      return next[sale.id] !== fingerprint(sale)
    })
    if (pending) {
      rerunRequested = true
      setStatus('Mengirim perubahan terbaru…', 'syncing')
    } else {
      setStatus('Cloud tersambung · data terbaru', 'online')
    }
  } catch (error) {
    console.warn('[CL POS] cloud sync:', error)
    const message = error instanceof Error ? error.message : 'Cloud gagal dihubungi'
    setStatus(`Cloud gagal · ${message}`, 'error')
  } finally {
    syncing = false
    if (rerunRequested && credentials && navigator.onLine) queueMicrotask(syncSales)
  }
}

function startSync(detail) {
  credentials = detail
  clearInterval(timer)
  syncSales()
  timer = setInterval(syncSales, POLL_MS)
}

window.addEventListener('cl-pos-login', event => startSync(event.detail))
window.addEventListener('cl-pos-data-changed', () => syncSales())
window.addEventListener('online', () => syncSales())
window.addEventListener('offline', () => setStatus('Offline · antrean tersimpan', 'error'))
window.addEventListener('focus', () => syncSales())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') syncSales()
})

const restoredCredentials = window.CL_POS?.getCloudCredentials?.()
if (restoredCredentials) startSync(restoredCredentials)
else if (!navigator.onLine) setStatus('Offline · antrean tersimpan', 'error')
else setStatus('Internet tersedia · masuk untuk sinkronisasi', 'local')

}
