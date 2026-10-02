import type { CloudExpense, CloudSale } from './types'

export function wholeMoney(value: unknown): number {
  const amount = Number(value)
  return Number.isFinite(amount) ? Math.round(amount) : 0
}

export function normalizeSale(sale: CloudSale): CloudSale {
  return {
    ...sale,
    total: wholeMoney(sale.total),
    cost: wholeMoney(sale.cost),
    items: sale.items.map((item) => ({ ...item, quantity: Math.max(0, Math.round(Number(item.quantity) || 0)), sellPrice: wholeMoney(item.sellPrice), cost: wholeMoney(item.cost) })),
    paymentBreakdown: sale.paymentBreakdown?.map((part) => ({ ...part, amount: wholeMoney(part.amount) })),
  }
}

export function normalizeExpense(expense: CloudExpense): CloudExpense {
  return { ...expense, amount: wholeMoney(expense.amount) }
}

