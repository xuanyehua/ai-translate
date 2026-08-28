import { useCallback, useEffect, useState } from 'react'
import { CompareView } from './CompareView'
import { TaskList } from './TaskList'
import type { TranslationRecord, TranslationSummary } from './taskTypes'
import { useTaskEvents } from './useTaskEvents'

export function HistoryView() {
  const [items, setItems] = useState<TranslationSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<TranslationRecord | null>(null)
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

  const fetchDetail = useCallback(async (taskId: string) => {
    const response = await fetch(`/api/tasks/${taskId}`)
    if (response.ok) setExpanded(await response.json())
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void fetchList(true), 0)
    return () => window.clearTimeout(timer)
  }, [fetchList])

  const onTask = useCallback((task: TranslationSummary, completed: boolean) => {
    setItems(previous => {
      const index = previous.findIndex(item => item.task_id === task.task_id)
      if (index >= 0) return previous.map(item => item.task_id === task.task_id ? task : item)
      if (page === 1 && !search) return [task, ...previous].slice(0, limit)
      return previous
    })
    if (page === 1 && !search) setTotal(value => value + (items.some(item => item.task_id === task.task_id) ? 0 : 1))
    if (completed && expanded?.task_id === task.task_id) void fetchDetail(task.task_id)
  }, [page, search, items, expanded?.task_id, fetchDetail])

  useTaskEvents({ onTask, onReconnect: () => void fetchList() })

  const action = async (taskId: string, name: 'cancel' | 'retry') => {
    const response = await fetch(`/api/tasks/${taskId}/${name}`, { method: 'POST' })
    if (response.ok) onTask(await response.json(), false)
    void fetchList()
  }

  const toggleDetail = (taskId: string) => {
    if (expanded?.task_id === taskId) setExpanded(null)
    else void fetchDetail(taskId)
  }

  const triggerEmbed = async (taskId: string) => {
    const response = await fetch(`/api/translations/${taskId}/embed`, { method: 'POST' })
    if (response.ok) {
      setItems(previous => previous.map(item => item.task_id === taskId ? { ...item, embedding_status: 'building' } : item))
      if (expanded?.task_id === taskId) setExpanded(current => current ? { ...current, embedding_status: 'building' } : current)
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
    if (expanded?.task_id === item.task_id) setExpanded(null)
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
            expandedTaskId={expanded?.task_id}
            expandedContent={expanded ? <CompareView taskId={expanded.task_id} original={expanded.original} translated={expanded.translated} isStreaming={expanded.status !== 'completed'} translatedCount={expanded.current} totalChunks={expanded.total} embeddingStatus={expanded.embedding_status} onTriggerEmbed={expanded.status === 'completed' ? () => void triggerEmbed(expanded.task_id) : undefined} /> : undefined}
            showDownload
            onCancel={id => void action(id, 'cancel')}
            onRetry={id => void action(id, 'retry')}
            onView={toggleDetail}
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
