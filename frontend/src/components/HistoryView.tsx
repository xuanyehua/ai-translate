import { useState, useEffect, useCallback } from 'react'

interface TranslationSummary {
  task_id: string
  filename: string
  ext: string
  target_lang: string
  status: string
  created_at: string
}

interface TranslationRecord {
  task_id: string
  filename: string
  ext: string
  original: string
  translated: string
}

interface Props {
  onViewTranslation: (data: TranslationRecord) => void
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function HistoryView({ onViewTranslation }: Props) {
  const [items, setItems] = useState<TranslationSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  const limit = 20

  const fetchList = useCallback(async () => {
    setLoading(true)
    try {
      const resp = await fetch(
        `/api/translations?q=${encodeURIComponent(search)}&page=${page}&limit=${limit}`
      )
      const data = await resp.json()
      setItems(data.items)
      setTotal(data.total)
    } catch (err) {
      console.error('Failed to fetch translations:', err)
    } finally {
      setLoading(false)
    }
  }, [search, page])

  useEffect(() => { fetchList() }, [fetchList])

  const handleView = async (task_id: string) => {
    try {
      const resp = await fetch(`/api/translations/${task_id}`)
      if (!resp.ok) return
      const data: TranslationRecord = await resp.json()
      onViewTranslation(data)
    } catch {}
  }

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-3xl font-bold text-slate-900 dark:text-white">翻译历史</h2>
        <p className="text-slate-500 dark:text-slate-400">查看、搜索和下载过往翻译记录</p>
      </div>

      {/* Search */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="搜索文件名..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }}
          className="flex-1 px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:ring-2 focus:ring-violet-500 focus:border-transparent outline-none"
        />
        {items.length > 0 && (
          <span className="text-xs text-slate-500">共 {total} 条</span>
        )}
      </div>

      {/* List */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 bg-slate-100 dark:bg-slate-800 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-slate-500 dark:text-slate-400">暂无翻译记录</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item.task_id}
              className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-3 flex items-center gap-4 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-900 dark:text-white truncate">
                  {item.filename}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {formatDate(item.created_at)} · {item.target_lang}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleView(item.task_id)}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30"
                >
                  查看
                </button>
                <button
                  onClick={async () => {
                    try {
                      const resp = await fetch(`/api/download?task_id=${item.task_id}`)
                      const blob = await resp.blob()
                      const url = URL.createObjectURL(blob)
                      const a = document.createElement('a')
                      a.href = url
                      a.download = item.filename.replace(/\.[^.]+$/, '') + `_translated.${item.ext}`
                      document.body.appendChild(a)
                      a.click()
                      document.body.removeChild(a)
                      URL.revokeObjectURL(url)
                    } catch {}
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                >
                  下载
                </button>
              </div>
            </div>
          ))}

        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 disabled:opacity-40 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            上一页
          </button>
          <span className="text-sm text-slate-500">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1.5 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 disabled:opacity-40 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  )
}