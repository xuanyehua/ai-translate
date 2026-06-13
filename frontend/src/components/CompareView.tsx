import { useState, useRef, useCallback, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { ChatDrawer } from './ChatDrawer'

interface Props {
  taskId?: string
  original: string
  translated: string
  isStreaming?: boolean
  translatedCount?: number
  totalChunks?: number
  embeddingStatus?: 'pending' | 'building' | 'ready' | 'failed'
  onTriggerEmbed?: () => void
}

/** Convert HTML <table> to Markdown table, strip <img> tags, cleanup. */
function preprocessMarkdown(md: string): string {
  let result = md.replace(/<table>([\s\S]*?)<\/table>/gi, (_match, content) => {
    const rows = content.match(/<tr[^>]*>([\s\S]*?)<\/tr>/gi) || []
    if (rows.length === 0) return ''
    const mdRows: string[] = []
    let isHeader = true
    for (const row of rows) {
      const cells = row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi) || []
      const values = cells.map((c: string) => c.replace(/<\/?t[dh][^>]*>/gi, '').trim().replace(/\|/g, '\\|'))
      mdRows.push('| ' + values.join(' | ') + ' |')
      if (isHeader) {
        mdRows.push('| ' + values.map(() => '---').join(' | ') + ' |')
        isHeader = false
      }
    }
    return '\n\n' + mdRows.join('\n') + '\n\n'
  })
  return result
}

function splitIntoBlocks(markdown: string): string[] {
  const blocks = markdown.split(/\n\n+/)
  return blocks.filter(b => b.trim()).map(b => b.trim())
}

function preprocessImages(md: string, taskId: string): string {
  return md.replace(/!\[([^\]]*)\]\(images\/([^)]+)\)/g, (_m: string, alt: string, file: string) => {
    return `![${alt}](/api/images/${taskId}/${file})`
  })
}

function MarkdownBlock({ content }: { content: string }) {
  return (
    <div className="markdown-content text-sm">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

export function CompareView({
  taskId,
  original,
  translated,
  isStreaming,
  translatedCount,
  totalChunks,
  embeddingStatus,
  onTriggerEmbed,
}: Props) {
  const rawOriginal = preprocessMarkdown(original)
  const rawTranslated = preprocessMarkdown(translated)
  const processedOriginal = taskId ? preprocessImages(rawOriginal, taskId) : rawOriginal
  const processedTranslated = taskId ? preprocessImages(rawTranslated, taskId) : rawTranslated
  const originalBlocks = splitIntoBlocks(processedOriginal)
  const translatedBlocks = splitIntoBlocks(processedTranslated)
  const maxLen = Math.max(originalBlocks.length, isStreaming ? originalBlocks.length : translatedBlocks.length)

  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [syncScroll, setSyncScroll] = useState(true)
  const [chatOpen, setChatOpen] = useState(false)

  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const isScrolling = useRef(false)

  const handleScroll = useCallback((source: 'left' | 'right') => (e: React.UIEvent<HTMLDivElement>) => {
    if (!syncScroll || isScrolling.current) return
    isScrolling.current = true
    const target = source === 'left' ? rightRef.current : leftRef.current
    if (target) {
      target.scrollTop = (e.target as HTMLDivElement).scrollTop
    }
    requestAnimationFrame(() => { isScrolling.current = false })
  }, [syncScroll])

  const handleDownload = async () => {
    if (!taskId) return
    const resp = await fetch(`/api/download?task_id=${taskId}`)
    const blob = await resp.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = resp.headers.get('content-disposition')?.split('filename=')[1]?.replace(/"/g, '') || 'translated'
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  useEffect(() => {
    if (leftRef.current) {
      leftRef.current.scrollTop = 0
    }
  }, [])

  // Embedding status badge & action button
  const renderEmbeddingControl = () => {
    if (isStreaming || !taskId) return null
    const status = embeddingStatus

    if (status === 'ready') {
      return (
        <button
          onClick={() => setChatOpen(o => !o)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors"
          title={chatOpen ? '收起对话' : '展开对话'}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
          {chatOpen ? '收起对话' : 'AI 对话'}
        </button>
      )
    }

    if (status === 'building') {
      return (
        <span className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 text-sm font-medium">
          <span className="w-3 h-3 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
          构建索引中...
        </span>
      )
    }

    // pending or failed
    return (
      <button
        onClick={onTriggerEmbed}
        disabled={!onTriggerEmbed}
        className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-300 text-sm font-medium hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors disabled:opacity-50"
        title={status === 'failed' ? '上次构建失败，点击重试' : '构建对话索引'}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
        </svg>
        {status === 'failed' ? '重新构建索引' : '构建索引'}
      </button>
    )
  }

  const showChat = chatOpen && embeddingStatus === 'ready' && !!taskId

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between bg-white dark:bg-slate-800 rounded-xl px-4 py-3 shadow-sm border border-slate-200 dark:border-slate-700">
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">对照查看</span>
          {isStreaming && totalChunks && translatedCount !== undefined && (
            <span className="text-xs text-violet-600 dark:text-violet-400 font-medium">
              翻译中 {translatedCount}/{totalChunks} 段
            </span>
          )}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={syncScroll}
              onChange={e => setSyncScroll(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
            />
            <span className="text-xs text-slate-500">同步滚动</span>
          </label>
        </div>
        <div className="flex items-center gap-2">
          {renderEmbeddingControl()}
          {!isStreaming && taskId && (
            <button
              onClick={handleDownload}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-violet-600 text-white text-sm font-medium hover:bg-violet-700 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              下载翻译文件
            </button>
          )}
        </div>
      </div>

      {/* Compare Panels (+ optional Chat Drawer) */}
      <div
        className={`grid gap-4 ${showChat ? 'grid-cols-[35%_35%_30%]' : 'grid-cols-2'}`}
        style={{ height: 'calc(100vh - 200px)' }}
      >
        {/* Original */}
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
            <span className="text-sm font-medium text-slate-600 dark:text-slate-400">原文</span>
          </div>
          <div
            ref={leftRef}
            className="flex-1 overflow-y-auto p-4 space-y-2"
            onScroll={handleScroll('left')}
          >
            {originalBlocks.map((block, i) => (
              <div
                key={i}
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
                className={`
                  p-3 rounded-lg transition-colors duration-150 cursor-pointer
                  ${hoveredIndex === i
                    ? 'bg-violet-100 dark:bg-violet-900/40 ring-1 ring-violet-300 dark:ring-violet-700'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
                  }
                `}
              >
                <MarkdownBlock content={block} />
              </div>
            ))}
          </div>
        </div>

        {/* Translated */}
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
            <span className="text-sm font-medium text-slate-600 dark:text-slate-400">译文</span>
          </div>
          <div
            ref={rightRef}
            className="flex-1 overflow-y-auto p-4 space-y-2"
            onScroll={handleScroll('right')}
          >
            {translatedBlocks.map((block, i) => (
              <div
                key={i}
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
                className={`
                  p-3 rounded-lg transition-colors duration-150 cursor-pointer
                  ${hoveredIndex === i
                    ? 'bg-violet-100 dark:bg-violet-900/40 ring-1 ring-violet-300 dark:ring-violet-700'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
                  }
                `}
              >
                <MarkdownBlock content={block} />
              </div>
            ))}
            {isStreaming && Array.from({ length: Math.max(0, maxLen - translatedBlocks.length) }).map((_, i) => (
              <div key={`empty-${i}`} className="p-3 rounded-lg">
                <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
              </div>
            ))}
          </div>
        </div>

        {/* Chat Drawer */}
        {showChat && (
          <ChatDrawer taskId={taskId!} onClose={() => setChatOpen(false)} />
        )}
      </div>
    </div>
  )
}
