import type { CloudExpense, CloudSale } from './types'

function compactFingerprint(value: unknown): string {
  const text = JSON.stringify(value)
  let first = 2166136261
  let second = 2246822507
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    first = Math.imul(first ^ code, 16777619)
    second = Math.imul(second ^ code, 3266489909)
  }
  return `v2:${text.length}:${(first >>> 0).toString(36)}:${(second >>> 0).toString(36)}`
}

export function saleFingerprint(sale: CloudSale): string {
  return compactFingerprint({
    id: sale.id,
    receipt: sale.receipt,
    cashier: sale.cashier,
    items: sale.items,
    total: sale.total,
    cost: sale.cost,
    paymentMethod: sale.paymentMethod,
    paymentBreakdown: sale.paymentBreakdown,
    status: sale.status,
    day: sale.day,
    createdAt: sale.createdAt,
    updatedAt: sale.updatedAt,
  })
}

export function expenseFingerprint(expense: CloudExpense): string {
  return compactFingerprint({
    id: expense.id,
    day: expense.day,
    amount: expense.amount,
    status: expense.status,
    type: expense.type,
    pocket: expense.pocket,
    createdAt: expense.createdAt,
    updatedAt: expense.updatedAt,
  })
}

export function changedAfter<T extends Record<string, unknown>>(rows: T[], cursor: string, fields: string[]): T[] {
  const since = Date.parse(cursor)
  if (!Number.isFinite(since)) return rows
  return rows.filter((row) => {
    const timestamp = fields.map((field) => row[field]).find(Boolean)
    return !timestamp || Date.parse(String(timestamp)) > since
  })
}

