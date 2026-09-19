import Dexie, { type EntityTable } from 'dexie'
import type { AuditLog, Product, Sale, User } from './types'

class CLPetshopDatabase extends Dexie {
  users!: EntityTable<User, 'id'>
  products!: EntityTable<Product, 'id'>
  sales!: EntityTable<Sale, 'id'>
  auditLogs!: EntityTable<AuditLog, 'id'>

  constructor() {
    super('cl-petshop-pos')
    this.version(1).stores({
      users: '++id, &username, role, active',
      products: '++id, &sku, name, active, updatedAt',
      sales: '&id, receiptNumber, cashierId, status, businessDate, createdAt, syncStatus',
      auditLogs: '++id, actor, action, entityType, entityId, createdAt',
    })
  }
}

export const db = new CLPetshopDatabase()

const seedProducts: Product[] = [
  { sku: 'CL-001', name: 'Makanan Kucing Adult 1 kg', sellPrice: 45000, costPrice: 34000, stock: 24, active: true, updatedAt: new Date().toISOString() },
  { sku: 'CL-002', name: 'Pasir Kucing 10 L', sellPrice: 65000, costPrice: 49000, stock: 18, active: true, updatedAt: new Date().toISOString() },
  { sku: 'CL-003', name: 'Snack Kucing Tuna', sellPrice: 15000, costPrice: 9500, stock: 40, active: true, updatedAt: new Date().toISOString() },
  { sku: 'CL-004', name: 'Shampoo Pet 250 ml', sellPrice: 38000, costPrice: 27000, stock: 12, active: true, updatedAt: new Date().toISOString() },
]

export async function seedDatabase() {
  if ((await db.users.count()) === 0) {
    await db.users.bulkAdd([
      { username: 'owner', displayName: 'Owner CL Petshop', pin: '123456', role: 'admin', active: true },
      { username: 'kasir', displayName: 'Kasir CL Petshop', pin: '1234', role: 'cashier', active: true },
    ])
  }

  if ((await db.products.count()) === 0) {
    await db.products.bulkAdd(seedProducts)
  }
}

export function rupiah(value: number) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(value)
}

export function todayKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
