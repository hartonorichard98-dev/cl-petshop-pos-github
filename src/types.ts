export type Role = 'admin' | 'cashier'

export interface User {
  id?: number
  username: string
  displayName: string
  pin: string
  role: Role
  active: boolean
}

export interface Product {
  id?: number
  sku: string
  name: string
  sellPrice: number
  costPrice: number
  stock: number
  active: boolean
  updatedAt: string
}

export interface CartItem {
  productId: number
  sku: string
  name: string
  sellPrice: number
  costPrice: number
  quantity: number
}

export interface Sale {
  id: string
  receiptNumber: string
  cashierId: number
  cashierName: string
  items: CartItem[]
  subtotal: number
  costTotal: number
  cashReceived: number
  changeDue: number
  status: 'completed' | 'voided'
  voidReason?: string
  voidedBy?: string
  voidedAt?: string
  businessDate: string
  createdAt: string
  syncStatus: 'pending' | 'synced'
}

export interface AuditLog {
  id?: number
  actor: string
  action: string
  entityType: string
  entityId: string
  detail: string
  createdAt: string
}
