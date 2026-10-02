export interface SyncBatchLimits {
  sales: number
  expenses: number
  movements: number
}

export const DEFAULT_BATCH_LIMITS: SyncBatchLimits = { sales: 100, expenses: 100, movements: 200 }

export function takeBatch<T>(records: T[], limit: number): T[] {
  return records.slice(0, Math.max(0, Math.floor(limit)))
}

export function pendingCount(...groups: unknown[][]): number {
  return groups.reduce((total, group) => total + group.length, 0)
}

