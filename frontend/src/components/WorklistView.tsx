import { useCallback, useEffect, useState } from 'react'
import { TaskList } from './TaskList'
import { sortWorklist } from './taskTypes'
import type { TranslationSummary } from './taskTypes'
import { useTaskEvents } from './useTaskEvents'

interface Props {
  refreshToken: number
}

export function WorklistView({ refreshToken }: Props) {
  const [items, setItems] = useState<TranslationSummary[]>([])
  const [loading, setLoading] = useState(true)

  const fetchList = useCallback(async () => {
    try {
      const response = await fetch('/api/tasks?scope=worklist&page=1&limit=100')
      if (!response.ok) return
      const data = await response.json()
      setItems(sortWorklist(data.items))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void fetchList() }, [fetchList])
  useEffect(() => {
    if (refreshToken) void fetchList()
  }, [refreshToken, fetchList])

  const onTask = useCallback((task: TranslationSummary, completed: boolean) => {
    setItems(previous => {
      if (completed || task.status === 'completed') return previous.filter(item => item.task_id !== task.task_id)
      const found = previous.some(item => item.task_id === task.task_id)
      const next = found ? previous.map(item => item.task_id === task.task_id ? task : item) : [task, ...previous]
      return sortWorklist(next)
    })
  }, [])
  useTaskEvents({ onTask, onReconnect: () => void fetchList() })

  const action = async (taskId: string, name: 'cancel' | 'retry') => {
    const response = await fetch(`/api/tasks/${taskId}/${name}`, { method: 'POST' })
    if (response.ok) {
      const task = await response.json()
      onTask(task, false)
      void fetchList()
    }
  }

  const remove = async (item: TranslationSummary) => {
    if (!window.confirm(`确定删除“${item.filename}”吗？相关文件和结果将无法恢复。`)) return
    const response = await fetch(`/api/tasks/${item.task_id}`, { method: 'DELETE' })
    if (response.ok) setItems(previous => previous.filter(task => task.task_id !== item.task_id))
  }

  return (
    <section className="max-w-4xl mx-auto space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-slate-900 dark:text-white">任务列表</h2>
        <p className="text-sm text-slate-500 mt-1">任务在后台依次处理，完成后可在翻译历史中查看。</p>
      </div>
      {loading ? (
        <div className="space-y-2">{Array.from({ length: 3 }).map((_, index) => <div key={index} className="h-16 rounded-xl bg-slate-100 dark:bg-slate-800 animate-pulse" />)}</div>
      ) : items.length ? (
        <TaskList items={items} onCancel={id => void action(id, 'cancel')} onRetry={id => void action(id, 'retry')} onDelete={item => void remove(item)} />
      ) : (
        <div className="rounded-xl border border-dashed border-slate-300 dark:border-slate-700 py-10 text-center text-sm text-slate-500">暂无等待处理的任务</div>
      )}
    </section>
  )
}
