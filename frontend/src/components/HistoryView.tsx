import { useCallback, useEffect, useState } from 'react'
import { TaskList } from './TaskList'
import type { TranslationSummary } from './taskTypes'
import { useTaskEvents } from './useTaskEvents'

export function HistoryView({ onOpenTask }: { onOpenTask: (taskId: string) => void }) {
  const initialParams = new URLSearchParams(window.location.search)
  const [items, setItems] = useState<TranslationSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(() => Math.max(1, Number(initialParams.get('page')) || 1))
  const [search, setSearch] = useState(() => initialParams.get('q') || '')
  const [loading, setLoading] = useState(true)
  const limit = 20

  const fetchList = useCallback(async (initial = false) => {
    if (initial) setLoading(true)
    try {
      const response = await fetch(`/api/tasks?q=${encodeURIComponent(search)}&page=${page}&limit=${limit}`)
      if (!response.ok) return
      const data = await response.json()
      setItems(data.items)
      setTotal(data.total)
    } finally {
      if (initial) setLoading(false)
    }
  }, [search, page])

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchList(true), 0)
    return () => window.clearTimeout(timer)
  }, [fetchList])

  useEffect(() => {
    const params = new URLSearchParams()
    if (search) params.set('q', search)
    if (page > 1) params.set('page', String(page))
    const query = params.toString()
    window.history.replaceState(window.history.state, '', `/history${query ? `?${query}` : ''}`)
  }, [page, search])

  useEffect(() => {
    if (!loading && typeof window.history.state?.scrollY === 'number') {
      const scrollY = window.history.state.scrollY
      requestAnimationFrame(() => window.scrollTo({ top: scrollY }))
    }
  }, [loading])

  const onTask = useCallback((task: TranslationSummary) => {
    setItems(previous => {
      const index = previous.findIndex(item => item.task_id === task.task_id)
      if (index >= 0) return previous.map(item => item.task_id === task.task_id ? task : item)
      if (page === 1 && !search) return [task, ...previous].slice(0, limit)
      return previous
    })
    if (page === 1 && !search) setTotal(value => value + (items.some(item => item.task_id === task.task_id) ? 0 : 1))
  }, [page, search, items])

  useTaskEvents({ onTask, onReconnect: () => void fetchList() })

  const action = async (taskId: string, name: 'cancel' | 'retry') => {
    const response = await fetch(`/api/tasks/${taskId}/${name}`, { method: 'POST' })
    if (response.ok) onTask(await response.json())
    void fetchList()
  }

  const triggerEmbed = async (taskId: string) => {
    const response = await fetch(`/api/translations/${taskId}/embed`, { method: 'POST' })
    if (response.ok) {
      setItems(previous => previous.map(item => item.task_id === taskId ? { ...item, embedding_status: 'building' } : item))
    }
  }

  const download = async (item: TranslationSummary) => {
    const response = await fetch(`/api/download?task_id=${item.task_id}`)
    if (!response.ok) return
    const url = URL.createObjectURL(await response.blob())
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = item.filename.replace(/\.[^.]+$/, '') + `_translated.${item.ext}`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const remove = async (item: TranslationSummary) => {
    if (!window.confirm(`确定删除“${item.filename}”吗？源文件、译文、图片和索引都将被永久删除。`)) return
    const response = await fetch(`/api/tasks/${item.task_id}`, { method: 'DELETE' })
    if (!response.ok) return
    setItems(previous => previous.filter(task => task.task_id !== item.task_id))
    setTotal(value => Math.max(0, value - 1))
  }

  const totalPages = Math.ceil(total / limit)
  return (
    <div className="space-y-6">
      <div className="max-w-4xl mx-auto text-center space-y-2">
        <h2 className="text-3xl font-bold text-slate-900 dark:text-white">翻译历史</h2>
        <p className="text-slate-500 dark:text-slate-400">任务状态会实时同步，无需刷新页面</p>
      </div>
      <div className="max-w-4xl mx-auto flex items-center gap-3">
        <input value={search} onChange={event => { setSearch(event.target.value); setPage(1) }} placeholder="搜索文件名..." className="flex-1 px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white outline-none" />
        <span className="text-xs text-slate-500">共 {total} 条</span>
      </div>
      <div className="max-w-4xl mx-auto">
        {loading ? <div className="space-y-2">{Array.from({ length: 5 }).map((_, index) => <div key={index} className="h-16 bg-slate-100 dark:bg-slate-800 rounded-xl animate-pulse" />)}</div> : items.length ? (
          <TaskList
            items={items}
            showDownload
            onCancel={id => void action(id, 'cancel')}
            onRetry={id => void action(id, 'retry')}
            onView={onOpenTask}
            onDownload={item => void download(item)}
            onEmbed={id => void triggerEmbed(id)}
            onDelete={item => void remove(item)}
          />
        ) : <div className="text-center py-12 text-slate-500">暂无翻译记录</div>}
      </div>
      {totalPages > 1 && <div className="flex justify-center items-center gap-3">
        <button disabled={page === 1} onClick={() => setPage(value => value - 1)} className="px-3 py-1.5 text-sm disabled:opacity-40">上一页</button>
        <span className="text-sm text-slate-500">{page} / {totalPages}</span>
        <button disabled={page === totalPages} onClick={() => setPage(value => value + 1)} className="px-3 py-1.5 text-sm disabled:opacity-40">下一页</button>
      </div>}
    </div>
  )
}
