const FINGERPRINTS_KEY = 'cl-petshop-cloud-fingerprints-v1'
const POLL_MS = 15000

let credentials = null
let syncing = false
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

async function syncSales() {
  if (!credentials || syncing || !navigator.onLine) return
  syncing = true
  setStatus('Menyinkronkan cloud…', 'syncing')
  try {
    const previous = fingerprints()
    const sales = currentSales()
    const changed = sales.filter(sale => previous[sale.id] !== fingerprint(sale))
    const response = await fetch('/api/pos-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: credentials.username,
        pin: credentials.pin,
        sales: changed,
      }),
    })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`)

    window.CL_POS?.mergeCloudSales?.(Array.isArray(result.sales) ? result.sales : [], {
      includeCost: result.role === 'owner',
    })
    const next = fingerprints()
    currentSales().forEach(sale => { next[sale.id] = fingerprint(sale) })
    saveFingerprints(next)
    setStatus('Cloud tersambung', 'online')
  } catch (error) {
    console.warn('[CL POS] cloud sync:', error)
    setStatus('Offline · antrean tersimpan', 'error')
  } finally {
    syncing = false
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
