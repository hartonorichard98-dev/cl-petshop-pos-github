export type PaymentMethod = 'cash' | 'qris' | 'transfer' | 'debit' | 'split'

export type SaleStatus = 'completed' | 'voided' | 'deleted'

export interface CloudSaleItem {
  name: string
  sku?: string
  barcode?: string
  quantity: number
  sellPrice: number
  cost?: number
}

export interface CloudSale {
  id: string
  receipt: string
  cashier?: string
  items: CloudSaleItem[]
  total: number
  cost?: number
  paymentMethod: PaymentMethod
  paymentBreakdown?: Array<{ method: PaymentMethod; amount: number }>
  status: SaleStatus
  day: string
  createdAt: string
  updatedAt?: string
}

export interface CloudExpense {
  id: string
  day: string
  amount: number
  status: 'active' | 'cancelled'
  type: 'cash' | 'goods'
  pocket: 'store' | 'profit' | 'pending'
  createdAt: string
  updatedAt?: string
}

