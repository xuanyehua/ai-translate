import { createContext, useState, useRef, useCallback, useEffect, useContext } from 'react'
import type { ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { ChatDrawer } from './ChatDrawer'
import type { ChatQuote, QuoteSource } from './ChatDrawer'
import type { TranslationAlignment } from './taskTypes'

const DEFAULT_CHAT_WIDTH = 400
const MIN_CHAT_WIDTH = 320
const CHAT_WIDTH_STORAGE_KEY = 'ai-translate-chat-width'

interface Props {
  taskId?: string
  original: string
  translated: string
  alignment?: TranslationAlignment
  isStreaming?: boolean
  translatedCount?: number
  totalChunks?: number
  embeddingStatus?: 'pending' | 'building' | 'ready' | 'failed'
  onTriggerEmbed?: () => void
}

/** Convert HTML <table> to Markdown table, strip <img> tags, cleanup. */
function preprocessMarkdown(md: string): string {
  const result = md.replace(/<table>([\s\S]*?)<\/table>/gi, (_match, content) => {
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

const ParagraphQuoteContext = createContext<((content: string) => void) | undefined>(undefined)

function QuoteableParagraph({ children }: { children?: ReactNode }) {
  const onQuote = useContext(ParagraphQuoteContext)

  if (!onQuote) return <p>{children}</p>

  return (
    <div className="group/paragraph relative pl-24">
      <button
        type="button"
        aria-label="引用本段"
        title="将整个自然段加入对话"
        onMouseDown={event => event.preventDefault()}
        onClick={event => {
          const text = event.currentTarget.parentElement?.querySelector('.quoteable-text')?.textContent || ''
          onQuote(text)
        }}
        className="pointer-events-none absolute left-0 top-0 inline-flex h-7 items-center rounded-md border border-violet-200 bg-violet-50 px-2 text-xs font-medium text-violet-700 opacity-0 shadow-sm transition-all hover:border-violet-300 hover:bg-violet-100 group-hover/paragraph:pointer-events-auto group-hover/paragraph:opacity-100 focus:pointer-events-auto focus:opacity-100 dark:border-violet-700 dark:bg-violet-950/60 dark:text-violet-300 dark:hover:bg-violet-900/70"
      >
        引用本段
      </button>
      <p className="quoteable-text">{children}</p>
    </div>
  )
}

const QUOTEABLE_MARKDOWN_COMPONENTS = { p: QuoteableParagraph }

function MarkdownBlock({ content, onQuote }: { content: string; onQuote?: (content: string) => void }) {
  return (
    <ParagraphQuoteContext.Provider value={onQuote}>
      <div className="markdown-content text-sm">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={QUOTEABLE_MARKDOWN_COMPONENTS}
        >
          {content}
        </ReactMarkdown>
      </div>
    </ParagraphQuoteContext.Provider>
  )
}

export function CompareView({
  taskId,
  original,
  translated,
  alignment,
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
  const alignedChunks = alignment?.mode !== 'fallback' ? alignment?.chunks : undefined
  const originalBlocks = alignedChunks
    ? alignedChunks.map(chunk => taskId ? preprocessImages(preprocessMarkdown(chunk.original), taskId) : preprocessMarkdown(chunk.original))
    : splitIntoBlocks(processedOriginal)
  const translatedBlocks: Array<string | null> = alignedChunks
    ? alignedChunks.map(chunk => chunk.translated === null
      ? null
      : taskId ? preprocessImages(preprocessMarkdown(chunk.translated), taskId) : preprocessMarkdown(chunk.translated))
    : splitIntoBlocks(processedTranslated)

  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [syncScroll, setSyncScroll] = useState(true)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMounted, setChatMounted] = useState(false)
  const [chatWidth, setChatWidth] = useState(() => {
    const saved = Number(window.localStorage.getItem(CHAT_WIDTH_STORAGE_KEY))
    const requested = Number.isFinite(saved) && saved >= MIN_CHAT_WIDTH ? saved : DEFAULT_CHAT_WIDTH
    const maxWidth = Math.max(MIN_CHAT_WIDTH, Math.min(600, window.innerWidth * 0.45))
    return Math.min(maxWidth, requested)
  })
  const [resizingChat, setResizingChat] = useState(false)
  const [chatQuote, setChatQuote] = useState<ChatQuote | null>(null)
  const [selectionAction, setSelectionAction] = useState<{
    content: string
    source: QuoteSource
    left: number
    top: number
  } | null>(null)

  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const leftBlockRefs = useRef<Array<HTMLDivElement | null>>([])
  const rightBlockRefs = useRef<Array<HTMLDivElement | null>>([])
  const isScrolling = useRef(false)

  const clearPersistentSelection = useCallback(() => {
    const highlights = (CSS as unknown as { highlights?: { delete: (name: string) => void } }).highlights
    highlights?.delete('document-quote-selection')
  }, [])

  const persistSelection = useCallback((range: Range) => {
    const highlights = (CSS as unknown as { highlights?: { set: (name: string, value: unknown) => void } }).highlights
    const HighlightClass = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight
    if (highlights && HighlightClass) {
      if (!document.getElementById('document-quote-highlight-style')) {
        const style = document.createElement('style')
        style.id = 'document-quote-highlight-style'
        style.textContent = '::highlight(document-quote-selection){background-color:rgb(196 181 253 / .75);color:inherit}html.dark ::highlight(document-quote-selection){background-color:rgb(109 40 217 / .7)}'
        document.head.appendChild(style)
      }
      highlights.set('document-quote-selection', new HighlightClass(range.cloneRange()))
    }
  }, [])

  useEffect(() => clearPersistentSelection, [clearPersistentSelection])

  useEffect(() => {
    if (!resizingChat) return
    const handlePointerMove = (event: PointerEvent) => {
      const maxWidth = Math.max(MIN_CHAT_WIDTH, Math.min(600, window.innerWidth * 0.45))
      setChatWidth(Math.min(maxWidth, Math.max(MIN_CHAT_WIDTH, window.innerWidth - event.clientX)))
    }
    const handlePointerUp = () => setResizingChat(false)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [resizingChat])

  useEffect(() => {
    window.localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(Math.round(chatWidth)))
  }, [chatWidth])

  const openChat = () => {
    setChatMounted(true)
    setChatOpen(true)
  }

  const addQuote = (content: string, source: QuoteSource) => {
    const normalized = content.replace(/\s+/g, ' ').trim()
    if (!normalized) return
    setChatQuote({
      content: normalized.slice(0, 4000),
      source,
      truncated: normalized.length > 4000,
    })
    setSelectionAction(null)
    openChat()
  }

  const handleTextSelection = (source: QuoteSource, container: HTMLDivElement | null) => {
    if (embeddingStatus !== 'ready' || !container) return
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      setSelectionAction(null)
      clearPersistentSelection()
      return
    }
    const anchorNode = selection.anchorNode
    const focusNode = selection.focusNode
    if (!anchorNode || !focusNode || !container.contains(anchorNode) || !container.contains(focusNode)) {
      setSelectionAction(null)
      clearPersistentSelection()
      return
    }
    const content = selection.toString().replace(/\s+/g, ' ').trim()
    if (!content) {
      setSelectionAction(null)
      clearPersistentSelection()
      return
    }
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    persistSelection(selection.getRangeAt(0))
    setSelectionAction({
      content,
      source,
      left: Math.min(window.innerWidth - 70, Math.max(70, rect.left + rect.width / 2)),
      top: Math.max(12, rect.top - 44),
    })
  }

  useEffect(() => {
    if (!chatOpen) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setChatOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [chatOpen])

  const handleScroll = useCallback((source: 'left' | 'right') => (e: React.UIEvent<HTMLDivElement>) => {
    setSelectionAction(null)
    if (!syncScroll || isScrolling.current) return
    isScrolling.current = true
    const sourceElement = e.currentTarget
    const target = source === 'left' ? rightRef.current : leftRef.current
    if (target) {
      const sourceBlocks = source === 'left' ? leftBlockRefs.current : rightBlockRefs.current
      const targetBlocks = source === 'left' ? rightBlockRefs.current : leftBlockRefs.current
      let targetScrollTop: number | null = null

      if (alignedChunks?.length) {
        const blockTop = (block: HTMLDivElement, container: HTMLDivElement) => (
          block.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop
        )
        const anchor = sourceElement.scrollTop + sourceElement.clientHeight * 0.2
        let anchorIndex = -1
        for (let index = 0; index < sourceBlocks.length; index += 1) {
          const block = sourceBlocks[index]
          if (block && blockTop(block, sourceElement) <= anchor) anchorIndex = index
          else if (block) break
        }
        const sourceBlock = sourceBlocks[anchorIndex]
        const targetBlock = targetBlocks[anchorIndex]
        if (sourceBlock && targetBlock) {
          const sourceBlockTop = blockTop(sourceBlock, sourceElement)
          const progress = Math.min(1, Math.max(0, (anchor - sourceBlockTop) / Math.max(1, sourceBlock.offsetHeight)))
          targetScrollTop = blockTop(targetBlock, target) + progress * targetBlock.offsetHeight - target.clientHeight * 0.2
        }
      }

      if (targetScrollTop === null) {
        const sourceRange = Math.max(0, sourceElement.scrollHeight - sourceElement.clientHeight)
        const targetRange = Math.max(0, target.scrollHeight - target.clientHeight)
        targetScrollTop = sourceRange ? sourceElement.scrollTop / sourceRange * targetRange : 0
      }
      const targetRange = Math.max(0, target.scrollHeight - target.clientHeight)
      target.scrollTop = Math.min(targetRange, Math.max(0, targetScrollTop))
    }
    requestAnimationFrame(() => { isScrolling.current = false })
  }, [syncScroll, alignedChunks])

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
          onClick={() => {
            if (chatOpen) setChatOpen(false)
            else openChat()
          }}
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

  const canChat = embeddingStatus === 'ready' && !!taskId

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-white dark:bg-slate-800 rounded-xl px-4 py-3 shadow-sm border border-slate-200 dark:border-slate-700">
        <div className="flex flex-wrap items-center gap-4">
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

      {/* Compare Panels + docked Chat Drawer */}
      <div
        className="flex min-h-0 flex-col gap-4 xl:flex-row"
        style={{ height: 'calc(100vh - 200px)' }}
      >
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Original */}
          <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50">
            <span className="text-sm font-medium text-slate-600 dark:text-slate-400">原文</span>
          </div>
          <div
            ref={leftRef}
            className="flex-1 overflow-y-auto p-4 space-y-2"
            onScroll={handleScroll('left')}
            onMouseUp={() => handleTextSelection('original', leftRef.current)}
          >
            {originalBlocks.map((block, i) => (
              <div
                key={i}
                ref={element => { leftBlockRefs.current[i] = element }}
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
                className={`group relative
                  p-3 rounded-lg transition-colors duration-150
                  ${hoveredIndex === i
                    ? 'bg-violet-100 dark:bg-violet-900/40 ring-1 ring-violet-300 dark:ring-violet-700'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
                  }
                `}
              >
                <MarkdownBlock content={block} onQuote={canChat ? content => {
                  clearPersistentSelection()
                  addQuote(content, 'original')
                } : undefined} />
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
            onMouseUp={() => handleTextSelection('translated', rightRef.current)}
          >
            {translatedBlocks.map((block, i) => (
              <div
                key={i}
                ref={element => { rightBlockRefs.current[i] = element }}
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
                className={`group relative
                  p-3 rounded-lg transition-colors duration-150
                  ${hoveredIndex === i
                    ? 'bg-violet-100 dark:bg-violet-900/40 ring-1 ring-violet-300 dark:ring-violet-700'
                    : 'hover:bg-slate-50 dark:hover:bg-slate-700/50'
                  }
                `}
              >
                {block === null ? (
                  <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
                ) : (
                  <MarkdownBlock content={block} onQuote={canChat ? content => {
                    clearPersistentSelection()
                    addQuote(content, 'translated')
                  } : undefined} />
                )}
              </div>
            ))}
            {!alignedChunks && isStreaming && Array.from({ length: Math.max(0, originalBlocks.length - translatedBlocks.length) }).map((_, i) => (
              <div key={`empty-${i}`} className="p-3 rounded-lg">
                <div className="h-4 bg-slate-200 dark:bg-slate-700 rounded animate-pulse" />
              </div>
            ))}
          </div>
          </div>
        </div>

        {canChat && chatMounted && (
          <div
            className={`flex min-h-0 shrink-0 flex-col overflow-hidden transition-[width,max-height,opacity] duration-300 ease-out motion-reduce:transition-none xl:flex-row ${chatOpen ? 'max-h-[60vh] w-full opacity-100 xl:max-h-none xl:w-[var(--chat-width)]' : 'pointer-events-none max-h-0 w-full opacity-0 xl:max-h-none xl:w-0'}`}
            style={chatOpen ? { '--chat-width': `${chatWidth}px` } as React.CSSProperties : undefined}
          >
            <button
              type="button"
              role="separator"
              aria-label="调整 AI 对话宽度"
              aria-orientation="vertical"
              aria-valuemin={MIN_CHAT_WIDTH}
              aria-valuemax={Math.round(Math.max(MIN_CHAT_WIDTH, Math.min(600, window.innerWidth * 0.45)))}
              aria-valuenow={Math.round(chatWidth)}
              onPointerDown={() => setResizingChat(true)}
              onDoubleClick={() => setChatWidth(DEFAULT_CHAT_WIDTH)}
              onKeyDown={event => {
                if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                event.preventDefault()
                const delta = event.key === 'ArrowLeft' ? 20 : -20
                const maxWidth = Math.max(MIN_CHAT_WIDTH, Math.min(600, window.innerWidth * 0.45))
                setChatWidth(width => Math.min(maxWidth, Math.max(MIN_CHAT_WIDTH, width + delta)))
              }}
              className="hidden w-2 shrink-0 cursor-col-resize items-center justify-center xl:flex"
            >
              <span className="h-12 w-1 rounded-full bg-slate-300 transition-colors hover:bg-violet-400 dark:bg-slate-600" />
            </button>
            <aside
              aria-hidden={!chatOpen}
              className="min-h-0 w-full shrink-0 xl:w-[var(--chat-width)]"
            >
              <ChatDrawer
                taskId={taskId!}
                onClose={() => setChatOpen(false)}
                quote={chatQuote}
                onQuoteChange={quote => {
                  setChatQuote(quote)
                  if (!quote) clearPersistentSelection()
                }}
              />
            </aside>
          </div>
        )}
      </div>
      {selectionAction && (
        <button
          type="button"
          onMouseDown={event => event.preventDefault()}
          onClick={() => addQuote(selectionAction.content, selectionAction.source)}
          className="fixed z-50 -translate-x-1/2 rounded-lg bg-violet-600 px-3 py-2 text-xs font-medium text-white shadow-lg hover:bg-violet-700"
          style={{ left: selectionAction.left, top: selectionAction.top }}
        >
          加入对话
        </button>
      )}
    </div>
  )
}
