import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Message {
  role: 'user' | 'assistant'
  content: string
  ts?: string
}

interface Props {
  taskId: string
  onClose: () => void
}

const SUGGESTIONS = [
  '这篇文档的核心观点是什么？',
  '请总结一下文档的主要内容',
  '文档中提到了哪些关键数据或结论？',
]

export function ChatDrawer({ taskId, onClose }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [loaded, setLoaded] = useState(false)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  // Load history on first mount
  useEffect(() => {
    let cancelled = false
    fetch(`/api/translate/${taskId}/chat/history`)
      .then(r => r.ok ? r.json() : { messages: [] })
      .then(data => {
        if (cancelled) return
        const cleaned: Message[] = (data.messages || [])
          .filter((m: any) => m.role === 'user' || m.role === 'assistant')
          .map((m: any) => ({ role: m.role, content: m.content, ts: m.ts }))
        setMessages(cleaned)
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [taskId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = async (question?: string) => {
    const q = (question || input).trim()
    if (!q || streaming) return

    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: q }])
    setMessages(prev => [...prev, { role: 'assistant', content: '' }])
    setStreaming(true)

    try {
      const formData = new FormData()
      formData.append('question', q)

      const resp = await fetch(`/api/translate/${taskId}/chat`, {
        method: 'POST',
        body: formData,
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ detail: 'Request failed' }))
        throw new Error(typeof err.detail === 'string' ? err.detail : 'Request failed')
      }

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
            if (eventType === 'chunk') {
              setMessages(prev => {
                const next = [...prev]
                const last = next[next.length - 1]
                if (last.role === 'assistant') {
                  last.content += data.text
                }
                return [...next]
              })
            } else if (eventType === 'done') {
              setMessages(prev => {
                const last = prev[prev.length - 1]
                if (last.role === 'assistant' && !last.content.trim()) {
                  return prev.slice(0, -1)
                }
                return prev
              })
            }
          }
        }
      }
    } catch (e: unknown) {
      setMessages(prev => {
        const next = [...prev]
        const last = next[next.length - 1]
        if (last.role === 'assistant' && !last.content) {
          last.content = `❌ 出错了: ${e instanceof Error ? e.message : 'Unknown error'}`
        }
        return [...next]
      })
    } finally {
      setStreaming(false)
    }
  }

  const handleClear = async () => {
    if (streaming) return
    if (!confirm('确认清空当前文档的对话记录？')) return
    try {
      await fetch(`/api/translate/${taskId}/chat/history`, { method: 'DELETE' })
      setMessages([])
    } catch {}
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 flex flex-col overflow-hidden h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 flex items-center justify-between">
        <span className="text-sm font-medium text-slate-700 dark:text-slate-300">AI 对话</span>
        <div className="flex items-center gap-2">
          <button
            onClick={handleClear}
            disabled={streaming || messages.length === 0}
            className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white disabled:opacity-40"
            title="清空对话"
          >
            清空
          </button>
          <button
            onClick={onClose}
            className="text-xs text-slate-500 hover:text-slate-900 dark:hover:text-white"
            title="收起对话"
          >
            《 收起
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {!loaded && (
          <div className="text-center text-xs text-slate-400 py-4">加载历史...</div>
        )}
        {loaded && messages.length === 0 && (
          <div className="text-sm text-slate-700 dark:text-slate-300 space-y-3">
            <p>我是文档助手，可以回答关于这篇文档的任何问题。</p>
            <p className="text-xs text-slate-500">试试：</p>
            <div className="flex flex-col gap-1.5">
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={i}
                  onClick={() => handleSend(s)}
                  disabled={streaming}
                  className="text-left px-3 py-2 rounded-lg text-xs text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-900/30 hover:bg-violet-100 dark:hover:bg-violet-900/50 transition-colors disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[90%] rounded-xl px-3 py-2 ${
              msg.role === 'user'
                ? 'bg-violet-600 text-white'
                : 'bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200'
            }`}>
              {msg.role === 'user' ? (
                <p className="text-sm whitespace-pre-wrap break-words">{msg.content}</p>
              ) : (
                <div className="prose prose-sm max-w-none dark:prose-invert">
                  {msg.content ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                  ) : (
                    <div className="flex items-center gap-1 text-slate-400">
                      <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-slate-200 dark:border-slate-700 p-3">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入问题..."
            disabled={streaming}
            className="flex-1 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-violet-500 focus:border-transparent outline-none disabled:opacity-50"
          />
          <button
            onClick={() => handleSend()}
            disabled={streaming || !input.trim()}
            className="px-3 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700 transition-colors disabled:opacity-50"
            title="发送"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
