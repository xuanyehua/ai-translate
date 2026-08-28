import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { ACTIVE_STATUSES, formatDate } from './taskTypes'
import type { TranslationSummary } from './taskTypes'

function TaskStatus({ item }: { item: TranslationSummary }) {
  if (item.status === 'completed') {
    const text = item.embedding_status === 'ready' ? '已完成 · 索引就绪' : item.embedding_status === 'building' ? '已完成 · 正在构建索引' : item.embedding_status === 'failed' ? '已完成 · 索引失败' : '已完成'
    return <span className={`text-xs ${item.embedding_status === 'failed' ? 'text-amber-600' : 'text-emerald-600'}`}>{text}</span>
  }
  if (item.status === 'failed') return <span className="text-xs text-red-500">失败：{item.error || item.message}</span>
  if (item.status === 'cancelled') return <span className="text-xs text-slate-500">已取消</span>
  const progress = item.total ? ` ${item.current}/${item.total}` : ''
  return (
    <span className="flex items-center gap-1 text-xs text-amber-500">
      <span className="w-2.5 h-2.5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
      {item.message || item.status}{progress}
    </span>
  )
}

interface Props {
  items: TranslationSummary[]
  expandedTaskId?: string
  showDownload?: boolean
  onCancel: (taskId: string) => void
  onRetry: (taskId: string) => void
  onView?: (taskId: string) => void
  onDownload?: (item: TranslationSummary) => void
  onEmbed?: (taskId: string) => void
  onDelete?: (item: TranslationSummary) => void
  expandedContent?: ReactNode
}

export function TaskList({ items, expandedTaskId, showDownload, onCancel, onRetry, onView, onDownload, onEmbed, onDelete, expandedContent }: Props) {
  return (
    <div className="space-y-2">
      {items.map(item => (
        <Fragment key={item.task_id}>
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-3 flex items-center gap-4 transition-all">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-900 dark:text-white truncate">{item.filename}</p>
            <div className="flex flex-wrap items-center gap-3 mt-0.5">
              <p className="text-xs text-slate-500">{formatDate(item.created_at)} · {item.target_lang}</p>
              <TaskStatus item={item} />
            </div>
          </div>
          <div className="flex items-center gap-2">
            {item.status === 'completed' && (item.embedding_status === 'pending' || item.embedding_status === 'failed') && onEmbed && <button onClick={() => onEmbed(item.task_id)} className="px-3 py-1.5 rounded-lg text-xs text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20">构建索引</button>}
            {ACTIVE_STATUSES.has(item.status) && <button onClick={() => onCancel(item.task_id)} className="px-3 py-1.5 rounded-lg text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20">取消</button>}
            {(item.status === 'failed' || item.status === 'cancelled') && <button onClick={() => onRetry(item.task_id)} className="px-3 py-1.5 rounded-lg text-xs text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20">重试</button>}
            {onView && <button onClick={() => onView(item.task_id)} className="px-3 py-1.5 rounded-lg text-xs text-violet-600 hover:bg-violet-50 dark:hover:bg-violet-900/20">{expandedTaskId === item.task_id ? '收起' : '查看'}</button>}
            {showDownload && item.status === 'completed' && onDownload && <button onClick={() => onDownload(item)} className="px-3 py-1.5 rounded-lg text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">下载</button>}
            {!ACTIVE_STATUSES.has(item.status) && onDelete && <button onClick={() => onDelete(item)} className="px-3 py-1.5 rounded-lg text-xs text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20">删除</button>}
          </div>
        </div>
        {expandedTaskId === item.task_id && expandedContent && (
          <div className="relative left-1/2 w-[calc(100vw-3rem)] max-w-[1536px] -translate-x-1/2 py-2">{expandedContent}</div>
        )}
        </Fragment>
      ))}
    </div>
  )
}
