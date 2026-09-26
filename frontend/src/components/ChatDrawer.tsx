import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Message {
  role: 'user' | 'assistant'
  content: string
  ts?: string
  quote?: string
  quote_source?: QuoteSource
}

export type QuoteSource = 'original' | 'translated'

export interface ChatQuote {
  content: string
  source: QuoteSource
  truncated?: boolean
}

interface RawMessage {
  role?: string
  content?: string
  ts?: string
  quote?: string
  quote_source?: string
}

interface Props {
  taskId: string
  onClose: () => void
  quote: ChatQuote | null
  onQuoteChange: (quote: ChatQuote | null) => void
}

const SUGGESTIONS = [
  '这篇文档的核心观点是什么？',
  '请总结一下文档的主要内容',
  '文档中提到了哪些关键数据或结论？',
]

export function ChatDrawer({ taskId, onClose, quote, onQuoteChange }: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [loaded, setLoaded] = useState(false)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Load history on first mount
  useEffect(() => {
    let cancelled = false
    fetch(`/api/translate/${taskId}/chat/history`)
      .then(r => r.ok ? r.json() : { messages: [] })
      .then(data => {
        if (cancelled) return
        const cleaned: Message[] = ((data.messages || []) as RawMessage[])
          .filter((m): m is RawMessage & { role: 'user' | 'assistant', content: string } =>
            (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'
          )
          .map(m => ({
            role: m.role,
            content: m.content,
            ts: m.ts,
            quote: typeof m.quote === 'string' ? m.quote : undefined,
            quote_source: m.quote_source === 'original' || m.quote_source === 'translated'
              ? m.quote_source
              : undefined,
          }))
        setMessages(cleaned)
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [taskId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    const element = inputRef.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 160)}px`
  }, [input])

  const handleSend = async (question?: string) => {
    const q = (question || input).trim()
    if (!q || streaming) return

    setInput('')
    const submittedQuote = quote
    setMessages(prev => [...prev, {
      role: 'user',
      content: q,
      quote: submittedQuote?.content,
      quote_source: submittedQuote?.source,
    }])
    setMessages(prev => [...prev, { role: 'assistant', content: '' }])
    onQuoteChange(null)
    setStreaming(true)

    try {
      const formData = new FormData()
      formData.append('question', q)
      if (submittedQuote) {
        formData.append('quote', submittedQuote.content)
        formData.append('quote_source', submittedQuote.source)
      }

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
        const frames = buffer.split('\n\n')
        buffer = frames.pop() || ''

        for (const frame of frames) {
          const lines = frame.split('\n')
          const eventType = lines.find(line => line.startsWith('event: '))?.slice(7).trim()
          const dataLine = lines.find(line => line.startsWith('data: '))
          if (dataLine) {
            const data = JSON.parse(dataLine.slice(6))
            if (eventType === 'chunk' && typeof data.text === 'string') {
              setMessages(prev => {
                const lastIndex = prev.length - 1
                return prev.map((message, index) => (
                  index === lastIndex && message.role === 'assistant'
                    ? { ...message, content: message.content + data.text }
                    : message
                ))
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
        const lastIndex = prev.length - 1
        return prev.map((message, index) => (
          index === lastIndex && message.role === 'assistant' && !message.content
            ? { ...message, content: `❌ 出错了: ${e instanceof Error ? e.message : 'Unknown error'}` }
            : message
        ))
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
    } catch (error) {
      console.error('Failed to clear chat history:', error)
    }
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
              {msg.role === 'user' && msg.quote && (
                <div className="mb-2 rounded-lg border border-white/30 bg-white/15 px-2.5 py-2 text-xs text-violet-50">
                  <div className="mb-1 font-medium opacity-80">
                    引用{msg.quote_source === 'original' ? '原文' : '译文'}
                  </div>
                  <div className="max-h-24 overflow-hidden whitespace-pre-wrap break-words opacity-90">{msg.quote}</div>
                </div>
              )}
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
        {quote && (
          <div className="mb-2 rounded-lg border border-violet-200 bg-violet-50 p-2.5 text-xs text-slate-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-slate-200">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="font-medium text-violet-700 dark:text-violet-300">
                引用{quote.source === 'original' ? '原文' : '译文'}
                {quote.truncated ? '（已截取前 4000 字）' : ''}
              </span>
              <button type="button" onClick={() => onQuoteChange(null)} className="text-slate-400 hover:text-slate-700 dark:hover:text-white" aria-label="移除引用">×</button>
            </div>
            <div className="max-h-20 overflow-y-auto whitespace-pre-wrap break-words text-slate-600 dark:text-slate-300">{quote.content}</div>
          </div>
        )}
        <div className="flex items-center gap-2">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入问题..."
            disabled={streaming}
            className="max-h-40 min-h-9 flex-1 resize-none overflow-y-auto px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-violet-500 focus:border-transparent outline-none disabled:opacity-50"
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
