import { useCallback, useEffect, useState } from 'react'
import { FileUpload } from './components/FileUpload'
import type { PendingUpload } from './components/FileUpload'
import { HistoryView } from './components/HistoryView'
import { TaskDetailPage } from './components/TaskDetailPage'
import { WorklistView } from './components/WorklistView'

type AppView = 'translate' | 'history'

function currentRoute() {
  const detailMatch = window.location.pathname.match(/^\/tasks\/([^/]+)$/)
  if (detailMatch) return { view: 'detail' as const, taskId: decodeURIComponent(detailMatch[1]) }
  const legacyTaskId = new URLSearchParams(window.location.search).get('task')
  if (legacyTaskId) return { view: 'detail' as const, taskId: legacyTaskId }
  return { view: window.location.pathname === '/history' ? 'history' as const : 'translate' as const }
}

const LANGUAGES = [
  { value: '中文', label: '中文' },
  { value: 'English', label: 'English' },
  { value: '日本語', label: '日本語' },
  { value: '한국어', label: '한국어' },
  { value: 'Français', label: 'Français' },
  { value: 'Deutsch', label: 'Deutsch' },
  { value: 'Español', label: 'Español' },
]

export default function App() {
  const [route, setRoute] = useState(currentRoute)

  useEffect(() => {
    const onPopState = () => setRoute(currentRoute())
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = useCallback((url: string, options?: { detail?: boolean }) => {
    window.history.replaceState({ ...window.history.state, scrollY: window.scrollY }, '')
    window.history.pushState(options?.detail ? { returnToHistory: true } : {}, '', url)
    setRoute(currentRoute())
    window.scrollTo({ top: 0 })
  }, [])

  if (route.view === 'detail') {
    return <TaskDetailPage taskId={route.taskId} onBack={() => {
      if (window.history.state?.returnToHistory) window.history.back()
      else navigate('/history')
    }} />
  }
  return <MainApp view={route.view} onNavigate={navigate} />
}

function MainApp({ view, onNavigate }: { view: AppView; onNavigate: (url: string, options?: { detail?: boolean }) => void }) {
  const [targetLang, setTargetLang] = useState('中文')
  const [files, setFiles] = useState<PendingUpload[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState('')
  const [refreshToken, setRefreshToken] = useState(0)

  const addFiles = useCallback((incoming: File[]) => {
    setFiles(current => {
      const available = Math.max(0, 10 - current.length)
      const accepted = incoming.slice(0, available).map(file => ({
        id: crypto.randomUUID(), file, state: 'pending' as const,
      }))
      if (incoming.length > available) setNotice(`单次最多选择 10 个文件，已保留前 ${available} 个。`)
      else setNotice('')
      return [...current, ...accepted]
    })
  }, [])

  const submitFiles = async () => {
    const candidates = files.filter(item => item.state !== 'uploading')
    if (!candidates.length) return
    setSubmitting(true)
    setNotice('')
    const ids = new Set(candidates.map(item => item.id))
    setFiles(current => current.map(item => ids.has(item.id) ? { ...item, state: 'uploading', error: undefined } : item))

    const results = await Promise.all(candidates.map(async item => {
      const formData = new FormData()
      formData.append('file', item.file)
      formData.append('target_lang', targetLang)
      try {
        const response = await fetch('/api/tasks', { method: 'POST', body: formData })
        if (!response.ok) {
          const body = await response.json().catch(() => null)
          throw new Error(typeof body?.detail === 'string' ? body.detail : '上传失败')
        }
        const result = await response.json()
        setFiles(current => current.filter(candidate => candidate.id !== item.id))
        return result.duplicate ? 'duplicate' : 'created'
      } catch (error) {
        setFiles(current => current.map(candidate => candidate.id === item.id ? {
          ...candidate,
          state: 'failed',
          error: error instanceof Error ? error.message : '上传失败',
        } : candidate))
        return 'failed'
      }
    }))
    setSubmitting(false)
    const duplicateCount = results.filter(result => result === 'duplicate').length
    if (duplicateCount) setNotice(`${duplicateCount} 个文件已有相同语言的翻译任务，未重复入队。`)
    setRefreshToken(token => token + 1)
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
      <header className="border-b border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-900/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-[1600px] mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-violet-600 flex items-center justify-center text-white">译</div>
            <h1 className="text-xl font-semibold text-slate-900 dark:text-white">AI Translate</h1>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => onNavigate('/')} className={`px-3 py-2 rounded-lg text-sm font-medium ${view === 'translate' ? 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300' : 'text-slate-600 dark:text-slate-400'}`}>翻译新文档</button>
            <button onClick={() => onNavigate('/history')} className={`px-3 py-2 rounded-lg text-sm font-medium ${view === 'history' ? 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300' : 'text-slate-600 dark:text-slate-400'}`}>翻译历史</button>
          </div>
        </div>
      </header>

      <main className="max-w-[1600px] mx-auto px-6 py-8">
        {view === 'translate' ? (
          <div className="space-y-10">
            <section className="max-w-4xl mx-auto space-y-6">
              <div className="text-center space-y-2">
                <h2 className="text-3xl font-bold text-slate-900 dark:text-white">文档翻译</h2>
                <p className="text-slate-500 dark:text-slate-400">一次最多上传 10 个文件，提交后可离开页面</p>
              </div>
              <FileUpload files={files} disabled={submitting} onAdd={addFiles} onRemove={id => setFiles(current => current.filter(item => item.id !== id))} onClear={() => setFiles([])} />
              {notice && <p className="text-sm text-amber-600 dark:text-amber-400">{notice}</p>}
              <div className="flex flex-col sm:flex-row gap-3">
                <select value={targetLang} disabled={submitting} onChange={event => setTargetLang(event.target.value)} className="flex-1 px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white outline-none">
                  {LANGUAGES.map(language => <option key={language.value} value={language.value}>{language.label}</option>)}
                </select>
                <button disabled={!files.length || submitting} onClick={() => void submitFiles()} className="px-6 py-3 rounded-xl bg-violet-600 text-white font-medium hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed">
                  {submitting ? '正在上传…' : `开始翻译${files.length ? `（${files.length}）` : ''}`}
                </button>
              </div>
            </section>
            <WorklistView refreshToken={refreshToken} />
          </div>
        ) : <HistoryView onOpenTask={taskId => onNavigate(`/tasks/${encodeURIComponent(taskId)}`, { detail: true })} />}
      </main>
    </div>
  )
}
