export type EmbeddingStatus = 'pending' | 'building' | 'ready' | 'failed'

export interface TranslationSummary {
  task_id: string
  filename: string
  ext: string
  target_lang: string
  status: string
  stage: string
  created_at: string
  updated_at: string
  embedding_status: EmbeddingStatus
  current: number
  total: number
  message: string
  error?: string | null
}

export interface TranslationRecord extends TranslationSummary {
  original: string
  translated: string
}

export const ACTIVE_STATUSES = new Set(['queued', 'parsing', 'translating', 'saving', 'indexing', 'interrupted'])

const PROCESSING_STATUSES = new Set(['parsing', 'translating', 'saving', 'indexing'])

export function sortWorklist(items: TranslationSummary[]): TranslationSummary[] {
  return [...items].sort((left, right) => {
    const rank = (item: TranslationSummary) => {
      if (PROCESSING_STATUSES.has(item.status)) return 0
      if (item.status === 'queued' || item.status === 'interrupted') return 1
      return 2
    }
    const rankDifference = rank(left) - rank(right)
    if (rankDifference !== 0) return rankDifference
    if (rank(left) === 2) return right.created_at.localeCompare(left.created_at)
    return left.created_at.localeCompare(right.created_at)
  })
}

export function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  } catch {
    return iso
  }
}
