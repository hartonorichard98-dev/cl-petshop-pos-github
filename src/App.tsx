import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  Box,
  CheckCircle2,
  CircleDollarSign,
  CloudOff,
  History,
  LogOut,
  Minus,
  PackagePlus,
  PawPrint,
  Plus,
  Search,
  ShoppingCart,
  Trash2,
  Wifi,
  X,
} from 'lucide-react'
import { db, rupiah, seedDatabase, todayKey } from './db'
import type { CartItem, Product, Sale, User } from './types'

type View = 'pos' | 'dashboard' | 'products' | 'history'

const nowIso = () => new Date().toISOString()

function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)
  const [view, setView] = useState<View>('pos')

  useEffect(() => {
    seedDatabase().then(() => setReady(true))
  }, [])

  if (!ready) return <div className="loading-screen">Menyiapkan database lokal…</div>
  if (!currentUser) return <Login onLogin={setCurrentUser} />

  return (
    <Shell currentUser={currentUser} view={view} onView={setView} onLogout={() => setCurrentUser(null)}>
      {view === 'pos' && <PointOfSale currentUser={currentUser} />}
      {view === 'dashboard' && <Dashboard currentUser={currentUser} />}
      {view === 'products' && currentUser.role === 'admin' && <Products currentUser={currentUser} />}
      {view === 'history' && <SalesHistory currentUser={currentUser} />}
    </Shell>
  )
}

function Login({ onLogin }: { onLogin: (user: User) => void }) {
  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [error, setError] = useState('')

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const user = await db.users.where('username').equals(username.trim().toLowerCase()).first()
    if (!user || !user.active || user.pin !== pin) {
      setError('Username atau PIN salah.')
      return
    }
    setError('')
    onLogin(user)
  }

  return (
    <main className="login-page">
      <section className="login-brand">
        <div className="brand-mark"><img src="/brand/cl-petshop-logo-192.png" alt="Logo CL Petshop" /></div>
        <p className="eyebrow">Sistem kasir offline-first</p>
        <h1>CL Petshop<br />Point of Sale</h1>
        <p className="login-copy">Transaksi tetap jalan saat internet mati. Data tersimpan aman di perangkat.</p>
        <div className="login-status"><CheckCircle2 size={18} /> Database lokal aktif</div>
      </section>
      <section className="login-card-wrap">
        <form className="login-card" onSubmit={submit}>
          <div>
            <p className="eyebrow">Selamat datang</p>
            <h2>Masuk ke kasir</h2>
            <p className="muted">Gunakan akun owner atau kasir.</p>
          </div>
          <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="contoh: kasir" autoFocus /></label>
          <label>PIN<input value={pin} onChange={(e) => setPin(e.target.value)} placeholder="Masukkan PIN" type="password" inputMode="numeric" /></label>
          {error && <div className="error-box">{error}</div>}
          <button className="primary-button" type="submit">Masuk</button>
          <div className="demo-accounts">
            <strong>Akun demo</strong>
            <span>Owner: <code>owner</code> / <code>123456</code></span>
            <span>Kasir: <code>kasir</code> / <code>1234</code></span>
          </div>
        </form>
      </section>
    </main>
  )
}

function Shell({ currentUser, view, onView, onLogout, children }: {
  currentUser: User
  view: View
  onView: (view: View) => void
  onLogout: () => void
  children: React.ReactNode
}) {
  const [online, setOnline] = useState(navigator.onLine)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const nav = [
    { id: 'pos' as View, label: 'Kasir', icon: ShoppingCart },
    { id: 'dashboard' as View, label: 'Ringkasan', icon: BarChart3 },
    ...(currentUser.role === 'admin' ? [{ id: 'products' as View, label: 'Produk', icon: Box }] : []),
    { id: 'history' as View, label: 'Transaksi', icon: History },
  ]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><span><img src="/brand/cl-petshop-logo-192.png" alt="Logo CL Petshop" /></span><div><strong>CL Petshop</strong><small>Point of Sale</small></div></div>
        <nav>
          {nav.map(({ id, label, icon: Icon }) => (
            <button key={id} className={view === id ? 'active' : ''} onClick={() => onView(id)}><Icon size={19} />{label}</button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className={`network-status ${online ? 'online' : 'offline'}`}>{online ? <Wifi size={17} /> : <CloudOff size={17} />}<span>{online ? 'Online' : 'Mode offline'}</span></div>
          <div className="user-card"><div className="avatar">{currentUser.displayName.charAt(0)}</div><div><strong>{currentUser.displayName}</strong><small>{currentUser.role === 'admin' ? 'Owner / Admin' : 'Kasir'}</small></div><button aria-label="Keluar" onClick={onLogout}><LogOut size={17} /></button></div>
        </div>
      </aside>
      <div className="mobile-header"><div className="sidebar-brand"><span><img src="/brand/cl-petshop-logo-192.png" alt="Logo CL Petshop" /></span><strong>CL Petshop</strong></div><div className={`network-dot ${online ? 'online' : 'offline'}`} /></div>
      <main className="content">{children}</main>
      <nav className="mobile-nav">
        {nav.map(({ id, label, icon: Icon }) => <button key={id} className={view === id ? 'active' : ''} onClick={() => onView(id)}><Icon size={20} /><span>{label}</span></button>)}
      </nav>
    </div>
  )
}

function PointOfSale({ currentUser }: { currentUser: User }) {
  const [products, setProducts] = useState<Product[]>([])
  const [cart, setCart] = useState<CartItem[]>([])
  const [query, setQuery] = useState('')
  const [cashReceived, setCashReceived] = useState('')
  const [receipt, setReceipt] = useState<Sale | null>(null)
  const [checkingOut, setCheckingOut] = useState(false)

  const loadProducts = useCallback(async () => {
    setProducts(await db.products.filter((product) => product.active).sortBy('name'))
  }, [])
  useEffect(() => { loadProducts() }, [loadProducts])

  const filtered = products.filter((product) => `${product.name} ${product.sku}`.toLowerCase().includes(query.toLowerCase()))
  const subtotal = cart.reduce((sum, item) => sum + item.sellPrice * item.quantity, 0)
  const costTotal = cart.reduce((sum, item) => sum + item.costPrice * item.quantity, 0)
  const cash = Number(cashReceived.replace(/\D/g, '')) || 0
  const change = Math.max(0, cash - subtotal)

  function addProduct(product: Product) {
    if (!product.id) return
    setCart((items) => {
      const existing = items.find((item) => item.productId === product.id)
      if (existing) return items.map((item) => item.productId === product.id ? { ...item, quantity: item.quantity + 1 } : item)
      return [...items, { productId: product.id!, sku: product.sku, name: product.name, sellPrice: product.sellPrice, costPrice: product.costPrice, quantity: 1 }]
    })
  }

  function updateQuantity(productId: number, quantity: number) {
    if (quantity <= 0) return setCart((items) => items.filter((item) => item.productId !== productId))
    setCart((items) => items.map((item) => item.productId === productId ? { ...item, quantity } : item))
  }

  async function checkout() {
    if (!currentUser.id || cart.length === 0 || cash < subtotal) return
    setCheckingOut(true)
    try {
      const createdAt = nowIso()
      const businessDate = todayKey()
      const sequence = (await db.sales.where('businessDate').equals(businessDate).count()) + 1
      const id = crypto.randomUUID()
      const sale: Sale = {
        id,
        receiptNumber: `CL-${todayKey().replaceAll('-', '')}-${String(sequence).padStart(4, '0')}`,
        cashierId: currentUser.id,
        cashierName: currentUser.displayName,
        items: cart,
        subtotal,
        costTotal,
        cashReceived: cash,
        changeDue: change,
        status: 'completed',
        businessDate,
        createdAt,
        syncStatus: 'pending',
      }
      await db.transaction('rw', db.sales, db.products, db.auditLogs, async () => {
        for (const item of cart) {
          const product = await db.products.get(item.productId)
          if (!product) throw new Error(`Produk ${item.name} tidak ditemukan.`)
          await db.products.update(item.productId, { stock: product.stock - item.quantity, updatedAt: createdAt })
        }
        await db.sales.add(sale)
        await db.auditLogs.add({ actor: currentUser.displayName, action: 'CREATE_SALE', entityType: 'sale', entityId: id, detail: `${sale.receiptNumber} senilai ${subtotal}`, createdAt })
      })
      setReceipt(sale)
      setCart([])
      setCashReceived('')
      await loadProducts()
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Transaksi gagal.')
    } finally {
      setCheckingOut(false)
    }
  }

  return (
    <div className="pos-page">
      <section className="product-panel">
        <PageHeader eyebrow="Transaksi baru" title="Kasir" description={`${new Intl.DateTimeFormat('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(new Date())}`} />
        <div className="search-box"><Search size={19} /><input placeholder="Cari nama barang atau SKU…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
        <div className="product-grid">
          {filtered.map((product) => (
            <button className="product-card" key={product.id} onClick={() => addProduct(product)}>
              <span className="product-icon"><PawPrint size={22} /></span>
              <span className="product-name">{product.name}</span>
              <span className="product-sku">{product.sku}</span>
              <strong>{rupiah(product.sellPrice)}</strong>
              <small className={product.stock <= 5 ? 'stock-low' : ''}>{product.stock < 0 ? `Stok ${product.stock} · minus` : product.stock === 0 ? 'Stok 0 · tetap bisa dijual' : `Stok ${product.stock}`}</small>
            </button>
          ))}
          {filtered.length === 0 && <EmptyState icon={<Search />} title="Produk tidak ditemukan" text="Coba kata pencarian lain." />}
        </div>
      </section>
      <aside className="cart-panel">
        <div className="cart-title"><div><p className="eyebrow">Pesanan</p><h2>Keranjang</h2></div><span>{cart.reduce((sum, item) => sum + item.quantity, 0)} item</span></div>
        <div className="cart-items">
          {cart.length === 0 ? <EmptyState icon={<ShoppingCart />} title="Keranjang kosong" text="Pilih barang untuk mulai transaksi." /> : cart.map((item) => (
            <div className="cart-item" key={item.productId}>
              <div className="cart-item-main"><strong>{item.name}</strong><span>{rupiah(item.sellPrice)}</span></div>
              <div className="quantity-control"><button onClick={() => updateQuantity(item.productId, item.quantity - 1)}><Minus size={15} /></button><input value={item.quantity} onChange={(e) => updateQuantity(item.productId, Number(e.target.value))} type="number" min="1" /><button onClick={() => updateQuantity(item.productId, item.quantity + 1)}><Plus size={15} /></button></div>
              <strong className="line-total">{rupiah(item.sellPrice * item.quantity)}</strong>
              <button className="remove-item" onClick={() => updateQuantity(item.productId, 0)} aria-label="Hapus dari keranjang"><Trash2 size={16} /></button>
            </div>
          ))}
        </div>
        <div className="checkout-box">
          <div className="total-row"><span>Total</span><strong>{rupiah(subtotal)}</strong></div>
          <label>Uang diterima<div className="money-input"><span>Rp</span><input value={cashReceived} onChange={(e) => setCashReceived(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="0" /></div></label>
          <div className="change-row"><span>Kembalian</span><strong>{rupiah(change)}</strong></div>
          <button className="primary-button pay-button" onClick={checkout} disabled={cart.length === 0 || cash < subtotal || checkingOut}>{checkingOut ? 'Menyimpan…' : 'Bayar & Simpan'}</button>
        </div>
      </aside>
      {receipt && <ReceiptModal sale={receipt} onClose={() => setReceipt(null)} />}
    </div>
  )
}

function Dashboard({ currentUser }: { currentUser: User }) {
  const [sales, setSales] = useState<Sale[]>([])
  useEffect(() => { db.sales.where('businessDate').equals(todayKey()).toArray().then(setSales) }, [])
  const completed = sales.filter((sale) => sale.status === 'completed')
  const omzet = completed.reduce((sum, sale) => sum + sale.subtotal, 0)
  const hpp = completed.reduce((sum, sale) => sum + sale.costTotal, 0)
  const profit = omzet - hpp
  const items = completed.reduce((sum, sale) => sum + sale.items.reduce((qty, item) => qty + item.quantity, 0), 0)

  return (
    <div>
      <PageHeader eyebrow="Performa hari ini" title="Ringkasan toko" description="Data transaksi dari database lokal perangkat ini." />
      <div className="metric-grid">
        <Metric icon={<CircleDollarSign />} label="Omzet hari ini" value={rupiah(omzet)} accent />
        {currentUser.role === 'admin' && <Metric icon={<BarChart3 />} label="Laba kotor" value={rupiah(profit)} detail={omzet ? `Margin ${((profit / omzet) * 100).toFixed(1)}%` : 'Belum ada penjualan'} />}
        {currentUser.role === 'admin' && <Metric icon={<Box />} label="Total HPP" value={rupiah(hpp)} />}
        <Metric icon={<ShoppingCart />} label="Transaksi" value={String(completed.length)} detail={`${items} barang terjual`} />
      </div>
      <section className="table-card">
        <div className="section-heading"><div><p className="eyebrow">Aktivitas terbaru</p><h2>Penjualan hari ini</h2></div></div>
        <SalesTable sales={completed.slice().reverse().slice(0, 8)} showProfit={currentUser.role === 'admin'} />
      </section>
    </div>
  )
}

function Products({ currentUser }: { currentUser: User }) {
  const emptyForm = { sku: '', name: '', sellPrice: '', costPrice: '', stock: '' }
  const [products, setProducts] = useState<Product[]>([])
  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [showForm, setShowForm] = useState(false)

  const load = useCallback(() => db.products.orderBy('name').toArray().then(setProducts), [])
  useEffect(() => { load() }, [load])

  function edit(product: Product) {
    setEditingId(product.id!)
    setForm({ sku: product.sku, name: product.name, sellPrice: String(product.sellPrice), costPrice: String(product.costPrice), stock: String(product.stock) })
    setShowForm(true)
  }

  async function save(event: React.FormEvent) {
    event.preventDefault()
    const timestamp = nowIso()
    const payload = { sku: form.sku.trim().toUpperCase(), name: form.name.trim(), sellPrice: Number(form.sellPrice), costPrice: Number(form.costPrice), stock: Number(form.stock), active: true, updatedAt: timestamp }
    if (!payload.sku || !payload.name || payload.sellPrice < 0 || payload.costPrice < 0 || payload.stock < 0) return
    if (editingId) {
      await db.products.update(editingId, payload)
      await db.auditLogs.add({ actor: currentUser.displayName, action: 'UPDATE_PRODUCT', entityType: 'product', entityId: String(editingId), detail: payload.name, createdAt: timestamp })
    } else {
      const id = await db.products.add(payload)
      await db.auditLogs.add({ actor: currentUser.displayName, action: 'CREATE_PRODUCT', entityType: 'product', entityId: String(id), detail: payload.name, createdAt: timestamp })
    }
    setForm(emptyForm)
    setEditingId(null)
    setShowForm(false)
    await load()
  }

  async function toggleActive(product: Product) {
    await db.products.update(product.id!, { active: !product.active, updatedAt: nowIso() })
    await db.auditLogs.add({ actor: currentUser.displayName, action: product.active ? 'DEACTIVATE_PRODUCT' : 'ACTIVATE_PRODUCT', entityType: 'product', entityId: String(product.id), detail: product.name, createdAt: nowIso() })
    await load()
  }

  return (
    <div>
      <div className="heading-actions"><PageHeader eyebrow="Master data" title="Daftar produk" description="Harga modal hanya terlihat oleh owner." /><button className="primary-button compact" onClick={() => { setEditingId(null); setForm(emptyForm); setShowForm(true) }}><PackagePlus size={18} /> Tambah produk</button></div>
      <section className="table-card product-table-wrap">
        <div className="data-table-wrap"><table className="data-table"><thead><tr><th>Produk</th><th>SKU</th><th>Harga jual</th><th>HPP</th><th>Margin</th><th>Stok</th><th>Status</th><th /></tr></thead><tbody>
          {products.map((product) => <tr key={product.id}><td><strong>{product.name}</strong></td><td><code>{product.sku}</code></td><td>{rupiah(product.sellPrice)}</td><td>{rupiah(product.costPrice)}</td><td>{product.sellPrice ? `${(((product.sellPrice - product.costPrice) / product.sellPrice) * 100).toFixed(1)}%` : '0%'}</td><td><span className={product.stock <= 5 ? 'stock-low' : ''}>{product.stock}</span></td><td><span className={`status-pill ${product.active ? 'success' : 'neutral'}`}>{product.active ? 'Aktif' : 'Nonaktif'}</span></td><td><div className="row-actions"><button onClick={() => edit(product)}>Edit</button><button className="ghost-danger" onClick={() => toggleActive(product)}>{product.active ? 'Nonaktifkan' : 'Aktifkan'}</button></div></td></tr>)}
        </tbody></table></div>
      </section>
      {showForm && <Modal title={editingId ? 'Edit produk' : 'Tambah produk'} onClose={() => setShowForm(false)}><form className="product-form" onSubmit={save}><label>SKU<input required value={form.sku} onChange={(e) => setForm({ ...form, sku: e.target.value })} placeholder="CL-001" /></label><label>Nama barang<input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label><div className="form-grid"><label>Harga jual<input required type="number" min="0" value={form.sellPrice} onChange={(e) => setForm({ ...form, sellPrice: e.target.value })} /></label><label>HPP / modal<input required type="number" min="0" value={form.costPrice} onChange={(e) => setForm({ ...form, costPrice: e.target.value })} /></label></div><label>Stok awal<input required type="number" min="0" value={form.stock} onChange={(e) => setForm({ ...form, stock: e.target.value })} /></label><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setShowForm(false)}>Batal</button><button className="primary-button" type="submit">Simpan produk</button></div></form></Modal>}
    </div>
  )
}

function SalesHistory({ currentUser }: { currentUser: User }) {
  const [sales, setSales] = useState<Sale[]>([])
  const [voidTarget, setVoidTarget] = useState<Sale | null>(null)
  const [reason, setReason] = useState('')
  const load = useCallback(() => db.sales.orderBy('createdAt').reverse().toArray().then(setSales), [])
  useEffect(() => { load() }, [load])

  async function voidSale() {
    if (!voidTarget || !reason.trim()) return
    await db.transaction('rw', db.sales, db.products, db.auditLogs, async () => {
      for (const item of voidTarget.items) {
        const product = await db.products.get(item.productId)
        if (product) await db.products.update(item.productId, { stock: product.stock + item.quantity, updatedAt: nowIso() })
      }
      await db.sales.update(voidTarget.id, { status: 'voided', voidReason: reason.trim(), voidedBy: currentUser.displayName, voidedAt: nowIso(), syncStatus: 'pending' })
      await db.auditLogs.add({ actor: currentUser.displayName, action: 'VOID_SALE', entityType: 'sale', entityId: voidTarget.id, detail: `${voidTarget.receiptNumber}: ${reason.trim()}`, createdAt: nowIso() })
    })
    setVoidTarget(null)
    setReason('')
    await load()
  }

  return (
    <div>
      <PageHeader eyebrow="Riwayat" title="Semua transaksi" description={currentUser.role === 'admin' ? 'Pembatalan transaksi wajib menyimpan alasan dan jejak audit.' : 'Transaksi yang selesai tidak dapat diubah atau dihapus.'} />
      <section className="table-card"><SalesTable sales={sales} showProfit={currentUser.role === 'admin'} onVoid={currentUser.role === 'admin' ? setVoidTarget : undefined} /></section>
      {voidTarget && <Modal title="Batalkan transaksi" onClose={() => setVoidTarget(null)}><div className="void-summary"><span>{voidTarget.receiptNumber}</span><strong>{rupiah(voidTarget.subtotal)}</strong></div><label>Alasan pembatalan<textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Contoh: salah input jumlah barang" autoFocus /></label><p className="warning-text">Transaksi tidak dihapus. Status berubah menjadi batal dan stok dikembalikan.</p><div className="modal-actions"><button className="secondary-button" onClick={() => setVoidTarget(null)}>Kembali</button><button className="danger-button" disabled={!reason.trim()} onClick={voidSale}>Batalkan transaksi</button></div></Modal>}
    </div>
  )
}

function SalesTable({ sales, showProfit, onVoid }: { sales: Sale[]; showProfit: boolean; onVoid?: (sale: Sale) => void }) {
  if (sales.length === 0) return <EmptyState icon={<History />} title="Belum ada transaksi" text="Transaksi yang selesai akan muncul di sini." />
  return <div className="data-table-wrap"><table className="data-table"><thead><tr><th>No. struk</th><th>Waktu</th><th>Kasir</th><th>Item</th><th>Omzet</th>{showProfit && <th>Laba</th>}<th>Status</th>{onVoid && <th />}</tr></thead><tbody>{sales.map((sale) => <tr key={sale.id} className={sale.status === 'voided' ? 'voided-row' : ''}><td><strong>{sale.receiptNumber}</strong>{sale.syncStatus === 'pending' && <small className="sync-note">Tersimpan lokal</small>}</td><td>{new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(sale.createdAt))}</td><td>{sale.cashierName}</td><td>{sale.items.reduce((sum, item) => sum + item.quantity, 0)}</td><td>{rupiah(sale.subtotal)}</td>{showProfit && <td>{rupiah(sale.subtotal - sale.costTotal)}</td>}<td><span className={`status-pill ${sale.status === 'completed' ? 'success' : 'danger'}`}>{sale.status === 'completed' ? 'Selesai' : 'Batal'}</span>{sale.voidReason && <small className="void-reason">{sale.voidReason}</small>}</td>{onVoid && <td>{sale.status === 'completed' && <button className="ghost-danger" onClick={() => onVoid(sale)}>Void</button>}</td>}</tr>)}</tbody></table></div>
}

function ReceiptModal({ sale, onClose }: { sale: Sale; onClose: () => void }) {
  return <Modal title="Transaksi berhasil" onClose={onClose}><div className="receipt"><div className="receipt-success"><span><CheckCircle2 size={28} /></span><div><strong>Pembayaran tersimpan</strong><small>{sale.receiptNumber}</small></div></div><div className="receipt-lines">{sale.items.map((item) => <div key={item.productId}><span>{item.quantity}× {item.name}</span><strong>{rupiah(item.quantity * item.sellPrice)}</strong></div>)}</div><div className="receipt-totals"><div><span>Total</span><strong>{rupiah(sale.subtotal)}</strong></div><div><span>Dibayar</span><span>{rupiah(sale.cashReceived)}</span></div><div className="receipt-change"><span>Kembalian</span><strong>{rupiah(sale.changeDue)}</strong></div></div><p className="local-save-note"><CloudOff size={16} /> Aman tersimpan di database lokal</p><button className="primary-button" onClick={onClose}>Transaksi berikutnya</button></div></Modal>
}

function PageHeader({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <header className="page-header"><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></header>
}

function Metric({ icon, label, value, detail, accent }: { icon: React.ReactNode; label: string; value: string; detail?: string; accent?: boolean }) {
  return <article className={`metric-card ${accent ? 'accent' : ''}`}><span className="metric-icon">{icon}</span><div><p>{label}</p><strong>{value}</strong>{detail && <small>{detail}</small>}</div></article>
}

function EmptyState({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return <div className="empty-state"><span>{icon}</span><strong>{title}</strong><p>{text}</p></div>
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><section className="modal"><header><h2>{title}</h2><button onClick={onClose}><X size={20} /></button></header>{children}</section></div>
}

export default App
