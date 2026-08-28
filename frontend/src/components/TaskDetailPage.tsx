import { useEffect, useState } from 'react'
import { CompareView } from './CompareView'
import { ACTIVE_STATUSES } from './taskTypes'
import type { TranslationRecord } from './taskTypes'

interface Props {
  taskId: string
  onBack: () => void
}

export function TaskDetailPage({ taskId, onBack }: Props) {
  const [task, setTask] = useState<TranslationRecord | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let disposed = false
    fetch(`/api/tasks/${taskId}`)
      .then(response => response.ok ? response.json() : Promise.reject(new Error('任务不存在或已删除')))
      .then(data => { if (!disposed) setTask(data) })
      .catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : '加载任务失败') })

    const source = new EventSource(`/api/tasks/${taskId}/events`)
    const update = (event: Event) => {
      const message = event as MessageEvent<string>
      if (!disposed) setTask(JSON.parse(message.data))
    }
    source.addEventListener('status', update)
    source.addEventListener('done', update)
    source.onerror = () => {
      if (!disposed) setError('实时连接暂时不可用，正在自动重连')
    }
    return () => {
      disposed = true
      source.close()
    }
  }, [taskId])

  useEffect(() => {
    document.title = task ? `${task.filename} - AI Translate` : '任务详情 - AI Translate'
    return () => { document.title = 'AI Translate' }
  }, [task])

  const triggerEmbed = async () => {
    const response = await fetch(`/api/translations/${taskId}/embed`, { method: 'POST' })
    if (response.ok) setTask(current => current ? { ...current, embedding_status: 'building' } : current)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
      <header className="border-b border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-900/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-[1600px] mx-auto px-6 py-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-slate-900 dark:text-white truncate">{task?.filename || '任务详情'}</h1>
            {task && <p className="text-xs text-slate-500 mt-0.5">{task.message || task.status}</p>}
          </div>
          <button onClick={onBack} className="shrink-0 px-3 py-2 rounded-lg text-sm text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">← 返回翻译历史</button>
        </div>
      </header>
      <main className="max-w-[1600px] mx-auto px-6 py-6">
        {error && !task ? (
          <div className="py-20 text-center text-red-500">{error}</div>
        ) : !task || !task.original ? (
          <div className="py-20 text-center space-y-3">
            <span className="inline-block w-8 h-8 border-2 border-violet-500 border-t-transparent rounded-full animate-spin" />
            <p className="text-sm text-slate-500">{task?.message || '正在加载任务…'}</p>
          </div>
        ) : (
          <CompareView
            taskId={task.task_id}
            original={task.original}
            translated={task.translated}
            isStreaming={ACTIVE_STATUSES.has(task.status)}
            translatedCount={task.current}
            totalChunks={task.total}
            embeddingStatus={task.embedding_status}
            onTriggerEmbed={task.status === 'completed' ? () => void triggerEmbed() : undefined}
          />
        )}
      </main>
    </div>
  )
}
