import { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface Message {
  role: 'user' | 'assistant' | 'system'
  content: string
}

interface Props {
  taskId: string
  onBack: () => void
}

const SUGGESTIONS = [
  '这篇文档的核心观点是什么？',
  '请总结一下文档的主要内容',
  '文档中提到了哪些关键数据或结论？',
]

export function ChatView({ taskId, onBack }: Props) {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'system',
      content: '我是文档助手，可以回答关于这篇文档的任何问题。试试问我:',
    },
  ])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="max-w-3xl mx-auto flex flex-col" style={{ height: 'calc(100vh - 120px)' }}>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900 dark:text-white">AI 文档对话</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">基于文档内容提问，AI 帮你理解和分析</p>
        </div>
        <button
          onClick={onBack}
          className="px-4 py-2 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
        >
          ← 返回对照查看
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-4 mb-4">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-xl px-4 py-3 ${
              msg.role === 'user'
                ? 'bg-violet-600 text-white'
                : msg.role === 'system'
                  ? 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700'
                  : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700'
            }`}>
              {msg.role === 'system' ? (
                <div className="text-sm text-slate-700 dark:text-slate-300">
                  <p className="mb-2">{msg.content}</p>
                  <div className="flex flex-wrap gap-2">
                    {SUGGESTIONS.map((s, j) => (
                      <button
                        key={j}
                        onClick={() => handleSend(s)}
                        disabled={streaming}
                        className="px-3 py-1.5 rounded-lg text-xs text-violet-600 dark:text-violet-400 bg-violet-50 dark:bg-violet-900/30 hover:bg-violet-100 dark:hover:bg-violet-900/50 transition-colors disabled:opacity-50"
                      >
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ) : msg.role === 'user' ? (
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
              ) : (
                <div className="prose prose-sm max-w-none dark:prose-invert text-slate-700 dark:text-slate-300">
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
      <div className="flex items-center gap-2">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入你的问题..."
          disabled={streaming}
          className="flex-1 px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:ring-2 focus:ring-violet-500 focus:border-transparent outline-none disabled:opacity-50"
        />
        <button
          onClick={() => handleSend()}
          disabled={streaming || !input.trim()}
          className="px-5 py-3 rounded-xl bg-violet-600 text-white font-medium hover:bg-violet-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
          </svg>
        </button>
      </div>
    </div>
  )
}
