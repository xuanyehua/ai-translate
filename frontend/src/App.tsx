import { useState, useRef, useCallback } from 'react'
import { FileUpload } from './components/FileUpload'
import { CompareView } from './components/CompareView'
import { HistoryView } from './components/HistoryView'
import { ChatView } from './components/ChatView'

type AppStatus = 'idle' | 'uploading' | 'translating' | 'done' | 'error'
type AppView = 'translate' | 'history' | 'chat'

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
  const [view, setView] = useState<AppView>('translate')
  const [status, setStatus] = useState<AppStatus>('idle')
  const [targetLang, setTargetLang] = useState('中文')
  const [errorMsg, setErrorMsg] = useState('')

  const [taskId, setTaskId] = useState<string | undefined>()
  const [originalMarkdown, setOriginalMarkdown] = useState('')
  const [translatedChunks, setTranslatedChunks] = useState<string[]>([])
  const [totalChunks, setTotalChunks] = useState(0)
  const [chatTaskId, setChatTaskId] = useState<string>('')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const handleTranslate = useCallback(async (file: File) => {
    setView('translate')
    setStatus('uploading')
    setErrorMsg('')
    setOriginalMarkdown('')
    setTranslatedChunks([])
    setTotalChunks(0)
    setTaskId(undefined)

    const formData = new FormData()
    formData.append('file', file)
    formData.append('target_lang', targetLang)

    const controller = new AbortController()
    abortRef.current = controller

    try {
      const resp = await fetch('/api/translate', {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: 'Unknown error' }))
        throw new Error(typeof err.detail === 'string' ? err.detail : 'Translation failed')
      }

      setStatus('translating')

      const reader = resp.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        let eventType = ''
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim()
          } else if (line.startsWith('data: ')) {
            const data = JSON.parse(line.slice(6))
            switch (eventType) {
              case 'original':
                setOriginalMarkdown(data.markdown)
                setTaskId(data.task_id)
                break
              case 'start':
                setTotalChunks(data.total)
                setTranslatedChunks(new Array(data.total).fill(''))
                break
              case 'chunk':
                setTranslatedChunks(prev => {
                  const next = [...prev]
                  next[data.index] = data.text
                  return next
                })
                break
              case 'done':
                setTaskId(data.task_id)
                setStatus('done')
                break
              case 'error':
                throw new Error(data.message || 'Translation error')
            }
          }
        }
      }
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setStatus('error')
      setErrorMsg(e instanceof Error ? e.message : 'Unknown error')
    }
  }, [targetLang])

  const handleReset = () => {
    abortRef.current?.abort()
    setStatus('idle')
    setOriginalMarkdown('')
    setTranslatedChunks([])
    setTotalChunks(0)
    setTaskId(undefined)
    setErrorMsg('')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const translatedMarkdown = translatedChunks.filter(Boolean).join('\n\n')
  const translatedCount = translatedChunks.filter(Boolean).length

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
      {/* Header */}
      <header className="border-b border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-900/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-violet-600 flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
              </svg>
            </div>
            <h1 className="text-xl font-semibold text-slate-900 dark:text-white">AI Translate</h1>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={() => setView('translate')}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                view === 'translate'
                  ? 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              翻译新文档
            </button>
            <button
              onClick={() => setView('history')}
              className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                view === 'history'
                  ? 'bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
              }`}
            >
              翻译历史
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {/* Translate View */}
        {view === 'translate' && (
          <>
            {/* Upload View */}
            {status === 'idle' && (
              <div className="max-w-xl mx-auto space-y-8">
                <div className="text-center space-y-2">
                  <h2 className="text-3xl font-bold text-slate-900 dark:text-white">文档翻译</h2>
                  <p className="text-slate-500 dark:text-slate-400">支持 PDF、Word、PPT、Excel、Markdown 及图片，保留原文档格式</p>
                </div>

                <FileUpload onFileSelect={handleTranslate} inputRef={fileInputRef} />

                <div className="space-y-2">
                  <label className="text-sm font-medium text-slate-700 dark:text-slate-300">目标语言</label>
                  <select
                    value={targetLang}
                    onChange={e => setTargetLang(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:ring-2 focus:ring-violet-500 focus:border-transparent outline-none transition-all"
                  >
                    {LANGUAGES.map(lang => (
                      <option key={lang.value} value={lang.value}>{lang.label}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* Uploading spinner */}
            {status === 'uploading' && (
              <div className="max-w-md mx-auto text-center space-y-6 pt-20">
                <div className="relative w-16 h-16 mx-auto">
                  <div className="absolute inset-0 border-4 border-slate-200 dark:border-slate-700 rounded-full" />
                  <div className="absolute inset-0 border-4 border-violet-600 rounded-full border-t-transparent animate-spin" />
                </div>
                <p className="text-slate-600 dark:text-slate-400 text-sm">正在解析文档...</p>
              </div>
            )}

            {/* Translating & done — show CompareView */}
            {(status === 'translating' || status === 'done') && originalMarkdown && (
              <CompareView
                taskId={taskId}
                original={originalMarkdown}
                translated={translatedMarkdown}
                isStreaming={status === 'translating'}
                translatedCount={translatedCount}
                totalChunks={totalChunks}
                onChatClick={status === 'done' ? () => { setChatTaskId(taskId || ''); setView('chat') } : undefined}
              />
            )}

            {/* Error View */}
            {status === 'error' && (
              <div className="max-w-md mx-auto text-center space-y-4 pt-20">
                <div className="w-16 h-16 mx-auto rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                  <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <h3 className="text-lg font-semibold text-slate-900 dark:text-white">翻译失败</h3>
                <p className="text-slate-500 dark:text-slate-400 text-sm">{errorMsg}</p>
                <button
                  onClick={handleReset}
                  className="px-6 py-2.5 rounded-xl bg-violet-600 text-white font-medium hover:bg-violet-700 transition-colors"
                >
                  重试
                </button>
              </div>
            )}
          </>
        )}

        {/* History View */}
        {view === 'history' && (
          <HistoryView
            onViewTranslation={(data) => {
              setTaskId(data.task_id)
              setOriginalMarkdown(data.original)
              setTranslatedChunks([data.translated])
              setTotalChunks(1)
              setStatus('done')
              setView('translate')
            }}
          />
        )}

        {/* Chat View */}
        {view === 'chat' && chatTaskId && (
          <ChatView
            taskId={chatTaskId}
            onBack={() => setView('translate')}
          />
        )}
      </main>
    </div>
  )
}
