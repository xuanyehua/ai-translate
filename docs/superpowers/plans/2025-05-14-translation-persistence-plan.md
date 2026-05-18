# Translation History Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist translation results to disk as JSON files and add a history list page with search, expand, and pagination.

**Architecture:** Each completed translation is saved as `data/translations/<task_id>.json`. Backend exposes a `GET /api/translations` endpoint. Frontend renders a new `HistoryView` component accessible via a top navigation tab.

**Tech Stack:** Python stdlib (json, pathlib, asyncio), FastAPI, React + TypeScript + Tailwind CSS v4

---

### Task 1: Create `app/storage.py` — Backend storage layer

**Files:**
- Create: `app/storage.py`

- [ ] **Step 1: Write `app/storage.py`**

```python
"""Persistent storage for translation results using JSON files."""
import json
import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# Base directory for all translation files
BASE_DIR = Path("data") / "translations"


def _ensure_dir() -> None:
    """Create the translations directory if it doesn't exist."""
    BASE_DIR.mkdir(parents=True, exist_ok=True)


def _task_path(task_id: str) -> Path:
    return BASE_DIR / f"{task_id}.json"


def save_translation(task_id: str, data: dict) -> None:
    """Save translation result to a JSON file. Creates directory if needed."""
    try:
        _ensure_dir()
        path = _task_path(task_id)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        logger.exception(f"Failed to save translation for task {task_id}")


def load_translation(task_id: str) -> Optional[dict]:
    """Load a single translation record. Returns None if not found or corrupt."""
    path = _task_path(task_id)
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        logger.exception(f"Failed to load translation for task {task_id}")
        return None


def list_translations(
    search: str = "",
    limit: int = 20,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """
    List translation records sorted by created_at descending.
    Returns (items, total_count).
    Supports filename prefix search.
    """
    _ensure_dir()
    items: list[dict] = []
    total = 0

    search_lower = search.lower()

    # Read all JSON files in the directory
    json_files = sorted(BASE_DIR.glob("*.json"))

    for path in json_files:
        try:
            with open(path, "r", encoding="utf-8") as f:
                record = json.load(f)
        except Exception:
            continue

        # Filter by search
        if search and search_lower not in record.get("filename", "").lower():
            continue

        total += 1

        # Return only summary fields (not full original/translated)
        items.append({
            "task_id": record.get("task_id", path.stem),
            "filename": record.get("filename", "unknown"),
            "ext": record.get("ext", "md"),
            "target_lang": record.get("target_lang", "未知"),
            "status": record.get("status", "completed"),
            "created_at": record.get("created_at", ""),
        })

    # Sort by created_at descending
    items.sort(key=lambda x: x["created_at"], reverse=True)

    # Paginate
    page = items[offset: offset + limit]
    return page, total
```

- [ ] **Step 2: Verify import**

Run: `uv run python -c "from app.storage import save_translation, load_translation, list_translations; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add app/storage.py
git commit -m "feat: add translation storage layer (JSON file persistence)"
```

---

### Task 2: Modify `app/main.py` — Integrate storage

**Files:**
- Modify: `app/main.py`

- [ ] **Step 1: Update main.py to import storage and add endpoints**

Replace the current `app/main.py` with this updated version:

```python
import asyncio
import base64
import json
import logging
import uuid
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response

from app import mineru_service
from app.parser import parse_document
from app.translator import translate_document_stream
from app.converter import convert
from app.storage import save_translation, load_translation, list_translations

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    mineru_service.start()
    logger.info(f"MinerU API ready at {mineru_service.get_base_url()}")
    yield
    mineru_service.stop()


app = FastAPI(title="AI Translate", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_results: dict[str, dict] = {}


def _sse_event(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.post("/api/translate")
async def translate(file: UploadFile = File(...), target_lang: str = Form("中文")):
    if not file.filename:
        raise HTTPException(400, "No filename provided")

    ext = Path(file.filename).suffix.lower()
    with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as tmp:
        content = await file.read()
        tmp.write(content)
        tmp.flush()
        tmp_path = Path(tmp.name)

    try:
        markdown, doc_ext, images = parse_document(tmp_path)
    except Exception as e:
        tmp_path.unlink(missing_ok=True)
        raise HTTPException(500, "解析失败")

    tmp_path.unlink(missing_ok=True)

    task_id = uuid.uuid4().hex[:12]
    _results[task_id] = {"images": images}

    async def event_stream():
        yield _sse_event("original", {
            "markdown": markdown,
            "ext": doc_ext,
            "filename": file.filename,
            "task_id": task_id,
        })

        translated_parts: list[str] = []
        async for i, text, total in translate_document_stream(markdown, target_lang):
            if i == -1:
                yield _sse_event("start", {"total": total})
            else:
                translated_parts.append(text)
                yield _sse_event("chunk", {"index": i, "text": text, "total": total})

        full_translated = "\n\n".join(translated_parts)
        record = {
            "original": markdown,
            "translated": full_translated,
            "ext": doc_ext,
            "filename": file.filename,
        }
        _results[task_id].update(record)

        # Async persist to disk
        asyncio.create_task(_persist_translation(task_id, {
            "task_id": task_id,
            "filename": file.filename,
            "ext": doc_ext,
            "target_lang": target_lang,
            "original": markdown,
            "translated": full_translated,
            "status": "completed",
            "created_at": datetime.now(timezone.utc).isoformat(),
        }))

        yield _sse_event("done", {
            "task_id": task_id,
            "ext": doc_ext,
            "filename": file.filename,
        })

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _persist_translation(task_id: str, data: dict) -> None:
    """Async wrapper to persist translation to disk."""
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, save_translation, task_id, data)


@app.get("/api/images/{task_id}/{filename}")
async def serve_image(task_id: str, filename: str):
    result = _results.get(task_id)
    if not result:
        raise HTTPException(404, "Task not found")

    images: dict[str, str] = result.get("images", {})
    data_uri = images.get(filename)
    if not data_uri:
        raise HTTPException(404, "Image not found")

    try:
        header, base64_data = data_uri.split(",", 1)
        mime_type = header.removeprefix("data:").split(";")[0]
        return Response(content=base64.b64decode(base64_data), media_type=mime_type)
    except (ValueError, KeyError):
        raise HTTPException(500, "Invalid image data")


@app.get("/api/translations")
async def get_translations(q: str = "", page: int = 1, limit: int = 20):
    offset = (page - 1) * limit
    items, total = list_translations(search=q, limit=limit, offset=offset)
    return {"items": items, "total": total}


@app.get("/api/download")
async def download(task_id: str):
    result = _results.get(task_id)
    if not result:
        # Fallback: load from disk
        record = load_translation(task_id)
        if not record:
            raise HTTPException(404, "Translation result not found")
        translated = record.get("translated", "")
        ext = record.get("ext", "md")
        filename = record.get("filename", task_id)
    else:
        translated = result["translated"]
        ext = result["ext"]
        filename = result["filename"]

    file_bytes, mime_type, out_ext = convert(translated, ext)
    base_name = Path(filename).stem
    out_name = f"{base_name}_translated.{out_ext}"

    return StreamingResponse(
        iter([file_bytes]),
        media_type=mime_type,
        headers={"Content-Disposition": f"attachment; filename={out_name}"},
    )
```

- [ ] **Step 2: Verify imports**

Run: `uv run python -c "from app.main import app; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add app/main.py
git commit -m "feat: integrate storage layer + translations list endpoint"
```

---

### Task 3: Create `frontend/src/components/HistoryView.tsx`

**Files:**
- Create: `frontend/src/components/HistoryView.tsx`

- [ ] **Step 1: Write `frontend/src/components/HistoryView.tsx`**

```tsx
import { useState, useEffect, useCallback } from 'react'
import { CompareView } from './CompareView'

interface TranslationSummary {
  task_id: string
  filename: string
  ext: string
  target_lang: string
  status: string
  created_at: string
}

interface TranslationRecord {
  task_id: string
  filename: string
  ext: string
  original: string
  translated: string
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    })
  } catch {
    return iso
  }
}

export function HistoryView() {
  const [items, setItems] = useState<TranslationSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  const [expanded, setExpanded] = useState<TranslationRecord | null>(null)

  const limit = 20

  const fetchList = useCallback(async () => {
    setLoading(true)
    setExpanded(null)
    try {
      const resp = await fetch(
        `/api/translations?q=${encodeURIComponent(search)}&page=${page}&limit=${limit}`
      )
      const data = await resp.json()
      setItems(data.items)
      setTotal(data.total)
    } catch (err) {
      console.error('Failed to fetch translations:', err)
    } finally {
      setLoading(false)
    }
  }, [search, page])

  useEffect(() => { fetchList() }, [fetchList])

  const handleExpand = async (task_id: string) => {
    try {
      const resp = await fetch(`/api/translations/${task_id}`)
      if (!resp.ok) return
      const data: TranslationRecord = await resp.json()
      setExpanded(data)
    } catch {}
  }

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-3xl font-bold text-slate-900 dark:text-white">翻译历史</h2>
        <p className="text-slate-500 dark:text-slate-400">查看、搜索和下载过往翻译记录</p>
      </div>

      {/* Search */}
      <div className="flex items-center gap-3">
        <input
          type="text"
          placeholder="搜索文件名..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1) }}
          className="flex-1 px-4 py-3 rounded-xl border border-slate-200 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:ring-2 focus:ring-violet-500 focus:border-transparent outline-none"
        />
        {items.length > 0 && (
          <span className="text-xs text-slate-500">共 {total} 条</span>
        )}
      </div>

      {/* List */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 bg-slate-100 dark:bg-slate-800 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-slate-500 dark:text-slate-400">暂无翻译记录</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <div
              key={item.task_id}
              className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-3 flex items-center gap-4 hover:bg-slate-50 dark:hover:bg-slate-700/50 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-slate-900 dark:text-white truncate">
                  {item.filename}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  {formatDate(item.created_at)} · {item.target_lang}
                </p>
              </div>

              <div className="flex items-center gap-2">
                {expanded?.task_id === item.task_id ? (
                  <button
                    onClick={() => setExpanded(null)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                  >
                    收起
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => handleExpand(item.task_id)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium text-violet-600 dark:text-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/30"
                    >
                      查看
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          const resp = await fetch(`/api/download?task_id=${item.task_id}`)
                          const blob = await resp.blob()
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url
                          a.download = item.filename.replace(/\.[^.]+$/, '') + `_translated.${item.ext}`
                          document.body.appendChild(a)
                          a.click()
                          document.body.removeChild(a)
                          URL.revokeObjectURL(url)
                        } catch {}
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                    >
                      下载
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}

          {/* Expanded comparison */}
          {expanded && (
            <CompareView
              taskId={expanded.task_id}
              original={expanded.original}
              translated={expanded.translated}
            />
          )}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-3 py-1.5 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 disabled:opacity-40 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            上一页
          </button>
          <span className="text-sm text-slate-500">
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-3 py-1.5 rounded-lg text-sm font-medium text-slate-600 dark:text-slate-300 disabled:opacity-40 hover:bg-slate-100 dark:hover:bg-slate-700"
          >
            下一页
          </button>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/HistoryView.tsx
git commit -m "feat: add translation history view component"
```

---

### Task 4: Modify `frontend/src/App.tsx` — Add navigation

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add navigation tabs and HistoryView import**

```tsx
import { useState, useRef, useCallback } from 'react'
import { FileUpload } from './components/FileUpload'
import { CompareView } from './components/CompareView'
import { HistoryView } from './components/HistoryView'

type AppStatus = 'idle' | 'uploading' | 'translating' | 'done' | 'error'
type AppView = 'translate' | 'history'

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
        {view === 'history' && <HistoryView />}
      </main>
    </div>
  )
}
```

- [ ] **Step 2: Verify TypeScript**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: No errors

- [ ] **Step 3: Build**

Run: `cd frontend && npm run build`
Expected: Build successful

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat: add translate/history navigation tabs to App"
```

---

### Task 5: Add `.gitignore` entry for data directory

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Add data directory to .gitignore**

Add to `.gitignore`:

```
# Translation data
data/
```

- [ ] **Step 2: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore data/ directory in git"
```

---

### Task 6: Update README with new endpoint

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the new endpoint to the API table**

Replace the API table in README.md:

```markdown
| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/translate` | POST | SSE 流式翻译，接收文件 + target_lang |
| `/api/translations` | GET | 翻译历史列表，支持 `?q=搜索&page=1&limit=20` |
| `/api/translations/{task_id}` | GET | 获取单个翻译详情（原文 + 译文） |
| `/api/download?task_id=` | GET | 下载翻译完成的文件 |
| `/api/images/{task_id}/{filename}` | GET | 获取文档内嵌图片 |
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: update README with new translation history endpoints"
```

---

## Verification

After all tasks are complete:

1. **Start backend:** `uv run uvicorn app.main:app --host 127.0.0.1 --port 8000`
2. **Start frontend:** `cd frontend && npm run dev`
3. **Test flow:**
   - Upload a file and complete a translation
   - Check `data/translations/` for the JSON file
   - Restart the backend service
   - Navigate to "翻译历史" tab
   - Search by filename
   - Click "查看" to expand and see original/translated comparison
   - Click "下载" to download the translated file
   - Verify download works after server restart (tests disk persistence)
4. **TypeScript check:** `cd frontend && npx tsc -b --noEmit` — no errors
