# RAG AI 文档对话 - 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AI document chat using RAG (Retrieval-Augmented Generation) — translate a document, then ask questions about its content via a chat interface.

**Architecture:** After translation completes, the translated Markdown is chunked by `##` headings and indexed into a FAISS vector store using configurable embeddings (local or OpenAI). User questions are embedded, matched against the index, and the top 5 chunks are sent as context to the LLM for streaming answer generation via SSE.

**Tech Stack:** sentence-transformers, faiss-cpu, numpy, FastAPI SSE, React + TypeScript

---

### Task 1: Install dependencies

**Files:**
- Modify: `pyproject.toml`

- [ ] **Step 1: Add dependencies to pyproject.toml**

Add `sentence-transformers`, `faiss-cpu`, `numpy` to the dependencies list:

```python
dependencies = [
    "fastapi[standard]>=0.115.0",
    "python-multipart>=0.0.9",
    "openai>=1.0.0",
    "python-docx>=1.1.0",
    "python-pptx>=1.0.0",
    "fpdf2>=2.7.0",
    "mistune>=3.0.0",
    "python-dotenv>=1.0.0",
    "pyyaml>=6.0",
    "httpx>=0.27",
    "sentence-transformers>=3.0.0",
    "faiss-cpu>=1.8.0",
    "numpy>=1.26.0",
]
```

- [ ] **Step 2: Install dependencies**

Run: `cd /Users/xuanyehua/pythonCode/ai-translate && uv sync`
Expected: Successful install of sentence-transformers, faiss-cpu, numpy

- [ ] **Step 3: Commit**

```bash
git add pyproject.toml uv.lock
git commit -m "chore: add RAG dependencies (sentence-transformers, faiss-cpu, numpy)"
```

---

### Task 2: Update `app/config.py` — Add embedding config

**Files:**
- Modify: `app/config.py`

- [ ] **Step 1: Add embedding properties to Config class**

Add these two properties after `chunk_size`:

```python
    @property
    def embedding_provider(self) -> str:
        return self._data.get("embedding", {}).get("provider", "local")

    @property
    def embedding_model(self) -> str:
        return self._data.get("embedding", {}).get("model", "all-MiniLM-L6-v2")
```

- [ ] **Step 2: Verify import**

Run: `cd /Users/xuanyehua/pythonCode/ai-translate && uv run python -c "from app.config import config; print(config.embedding_provider, config.embedding_model)"`
Expected: `local all-MiniLM-L6-v2`

- [ ] **Step 3: Commit**

```bash
git add app/config.py
git commit -m "feat: add embedding config properties (provider + model)"
```

---

### Task 3: Create `app/rag.py` — RAG engine

**Files:**
- Create: `app/rag.py`

- [ ] **Step 1: Write `app/rag.py`**

```python
"""RAG engine: chunk translated Markdown, build FAISS index, search and answer."""
import logging
from typing import Optional

import numpy as np

from app.config import config

logger = logging.getLogger(__name__)

# Lazy-loaded singletons
_embed_model = None
_embedding_dim: Optional[int] = None


def _get_embed_model():
    """Lazy-load the embedding model based on config."""
    global _embed_model, _embedding_dim

    if _embed_model is not None:
        return _embed_model

    provider = config.embedding_provider
    model_name = config.embedding_model

    if provider == "local":
        from sentence_transformers import SentenceTransformer
        logger.info(f"Loading local embedding model: {model_name}")
        _embed_model = SentenceTransformer(model_name)
        _embedding_dim = _embed_model.get_sentence_embedding_dimension()
    elif provider == "openai":
        from openai import OpenAI
        kwargs: dict = {}
        if config.translator_base_url:
            kwargs["base_url"] = config.translator_base_url
        if config.translator_api_key:
            kwargs["api_key"] = config.translator_api_key
        _embed_model = OpenAI(**kwargs)
        _embedding_dim = {
            "text-embedding-3-small": 1536,
            "text-embedding-3-large": 3072,
            "text-embedding-ada-002": 1536,
        }.get(model_name, 1536)
    else:
        raise ValueError(f"Unknown embedding provider: {provider}")

    return _embed_model


def _embed(texts: list[str]) -> np.ndarray:
    """Convert list of texts to embedding vectors (float32 numpy array)."""
    model = _get_embed_model()

    if config.embedding_provider == "local":
        return model.encode(texts, convert_to_numpy=True, show_progress_bar=False)

    # OpenAI embedding API
    resp = model.embeddings.create(model=config.embedding_model, input=texts)
    vectors = [d.embedding for d in resp.data]
    return np.array(vectors, dtype=np.float32)


def chunk_document(markdown: str, max_chars: int = 500) -> list[str]:
    """Split translated Markdown into chunks by ## headings, each ≤ max_chars."""
    import re

    # Split on ## headings (h2+)
    sections = re.split(r"\n(?=#{2,6}\s)", markdown)
    chunks: list[str] = []

    for section in sections:
        section = section.strip()
        if not section:
            continue

        # If section is short enough, keep as-is
        if len(section) <= max_chars:
            chunks.append(section)
            continue

        # Split long sections by paragraphs
        heading_match = re.match(r"^(#{2,6}\s.+)", section)
        heading = heading_match.group(1) if heading_match else ""
        body = section[heading_match.end():].strip() if heading_match else section

        paragraphs = body.split("\n\n")
        current = heading
        for para in paragraphs:
            para = para.strip()
            if not para:
                continue
            if len(current) + len(para) + 2 <= max_chars:
                current += "\n\n" + para if current else para
            else:
                if current.strip():
                    chunks.append(current.strip())
                current = heading + "\n\n" + para if heading else para
        if current.strip():
            chunks.append(current.strip())

    return [c for c in chunks if len(c.strip()) > 10]


class ChunkStore:
    """Holds chunks and their FAISS index for a single document."""

    def __init__(self, chunks: list[str], vectors: np.ndarray):
        import faiss
        self.chunks = chunks
        dim = vectors.shape[1]
        self.index = faiss.IndexFlatL2(dim)
        self.index.add(vectors.astype(np.float32))

    def search(self, query: str, top_k: int = 5) -> list[str]:
        """Search for the most relevant chunks to the query."""
        q_vec = _embed([query]).astype(np.float32)
        distances, indices = self.index.search(q_vec, min(top_k, len(self.chunks)))
        results: list[str] = []
        for i in indices[0]:
            if 0 <= i < len(self.chunks):
                results.append(self.chunks[i])
        return results


def build_chunk_store(markdown: str) -> Optional[ChunkStore]:
    """Build a ChunkStore from translated Markdown. Returns None on failure."""
    try:
        chunks = chunk_document(markdown)
        if not chunks:
            logger.warning("No chunks generated from document")
            return None

        vectors = _embed(chunks)
        return ChunkStore(chunks, vectors)
    except Exception:
        logger.exception("Failed to build RAG index")
        return None


async def generate_answer_stream(store: ChunkStore, question: str):
    """SSE async generator: search chunks, build prompt, stream LLM answer.

    Yields (event_type, data_dict) tuples.
    """
    from app.translator import get_translator

    # 1. Search for relevant chunks
    yield "thinking", {"message": "正在检索相关内容..."}

    loop = __import__("asyncio").get_running_loop()
    relevant_chunks = await loop.run_in_executor(
        None, store.search, question, 5
    )

    if not relevant_chunks:
        yield "done", {"message": "未找到相关信息，请尝试换个问法"}
        return

    # 2. Build prompt
    context = "\n\n---\n\n".join(relevant_chunks)
    prompt = f"""你是一个文档助手，基于以下文档片段回答问题。如果文档片段中没有相关信息，请如实告知用户。

文档片段：
{context}

用户问题：{question}

回答："""

    # 3. Stream LLM answer
    translator = get_translator()
    try:
        resp = await loop.run_in_executor(
            None,
            lambda: translator.client.chat.completions.create(
                model=translator.model,
                messages=[
                    {"role": "system", "content": "你是一个专业、友好的文档助手。请用中文回答。"},
                    {"role": "user", "content": prompt},
                ],
                temperature=0.5,
                stream=True,
            ),
        )

        for chunk in resp:
            delta = chunk.choices[0].delta.content if chunk.choices else ""
            if delta:
                yield "chunk", {"text": delta}

        yield "done", {}
    except Exception as e:
        logger.exception("LLM chat failed")
        yield "error", {"message": f"回答生成失败: {e}"}
```

- [ ] **Step 2: Verify import**

Run: `cd /Users/xuanyehua/pythonCode/ai-translate && uv run python -c "from app.rag import chunk_document, build_chunk_store; print('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add app/rag.py
git commit -m "feat: add RAG engine (chunking, embedding, FAISS search, streaming answer)"
```

---

### Task 4: Update `app/main.py` — Integrate RAG

**Files:**
- Modify: `app/main.py`

- [ ] **Step 1: Add RAG import and storage**

Add import at top:

```python
from app.rag import build_chunk_store, ChunkStore, generate_answer_stream
```

Add RAG index storage next to `_results`:

```python
_results: dict[str, dict] = {}
_rag_stores: dict[str, ChunkStore] = {}
```

- [ ] **Step 2: Trigger RAG index build after translation**

In the `/api/translate` endpoint, after the `_persist_translation` create_task, add:

```python
        asyncio.create_task(_persist_translation(task_id, { ... }))

        # Build RAG index in background
        asyncio.create_task(_build_rag(task_id, full_translated))
```

Add the helper function after `_persist_translation`:

```python
async def _build_rag(task_id: str, translated_md: str) -> None:
    """Async wrapper to build RAG index from translated markdown."""
    loop = asyncio.get_running_loop()
    store = await loop.run_in_executor(None, build_chunk_store, translated_md)
    if store is not None:
        _rag_stores[task_id] = store
        logger.info(f"RAG index built for task {task_id} ({len(store.chunks)} chunks)")
    else:
        logger.warning(f"Failed to build RAG index for task {task_id}")
```

- [ ] **Step 3: Add chat endpoint**

Add before `/api/download`:

```python
@app.post("/api/translate/{task_id}/chat")
async def chat_with_document(task_id: str, question: str = Form(...)):
    if not question.strip():
        raise HTTPException(400, "Question cannot be empty")

    store = _rag_stores.get(task_id)
    if store is None:
        raise HTTPException(503, "AI 助手正在准备中，请稍后重试")

    async def event_stream():
        async for event, data in generate_answer_stream(store, question.strip()):
            yield _sse_event(event, data)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
```

- [ ] **Step 4: Verify import**

Run: `cd /Users/xuanyehua/pythonCode/ai-translate && uv run python -c "from app.main import app; print('OK')"`
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add app/main.py
git commit -m "feat: integrate RAG index build + chat endpoint"
```

---

### Task 5: Create `frontend/src/components/ChatView.tsx`

**Files:**
- Create: `frontend/src/components/ChatView.tsx`

- [ ] **Step 1: Write `frontend/src/components/ChatView.tsx`**

```tsx
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

    // Add empty assistant message for streaming
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
              // Remove empty assistant message if nothing was generated
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
```

- [ ] **Step 2: Verify TypeScript**

Run: `cd /Users/xuanyehua/pythonCode/ai-translate/frontend && npx tsc -b --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/ChatView.tsx
git commit -m "feat: add AI document chat view component"
```

---

### Task 6: Update `frontend/src/App.tsx` — Add ChatView entry point

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Import ChatView**

Add import:

```tsx
import { ChatView } from './components/ChatView'
```

Add `chatView` to AppView type:

```tsx
type AppView = 'translate' | 'history' | 'chat'
```

- [ ] **Step 2: Add chat state**

```tsx
  const [chatTaskId, setChatTaskId] = useState<string>('')
```

- [ ] **Step 3: Add chat view rendering**

After the `{view === 'history' && <HistoryView />}` line, add:

```tsx
        {/* Chat View */}
        {view === 'chat' && chatTaskId && (
          <ChatView
            taskId={chatTaskId}
            onBack={() => setView('translate')}
          />
        )}
```

- [ ] **Step 4: Add "AI 对话" button to CompareView toolbar**

The CompareView currently has a toolbar with download button. We need to add an "AI 对话" button there. The easiest way: pass an `onChatClick` prop from App.tsx.

In App.tsx, add to the CompareView render:

```tsx
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
```

- [ ] **Step 5: Update CompareView to accept onChatClick prop**

In CompareView.tsx, add to Props interface:

```tsx
  onChatClick?: () => void
```

Add a button in the toolbar next to the download button:

```tsx
        {onChatClick && (
          <button
            onClick={onChatClick}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
            </svg>
            AI 对话
          </button>
        )}
```

- [ ] **Step 6: Verify TypeScript and build**

Run: `cd /Users/xuanyehua/pythonCode/ai-translate/frontend && npx tsc -b --noEmit`
Expected: No errors

Run: `cd /Users/xuanyehua/pythonCode/ai-translate/frontend && npm run build`
Expected: Build successful

- [ ] **Step 7: Commit**

```bash
git add frontend/src/App.tsx frontend/src/components/CompareView.tsx
git commit -m "feat: add AI chat entry point in CompareView toolbar"
```

---

### Task 7: Update `config.example.yaml`

**Files:**
- Modify: `config.example.yaml`

- [ ] **Step 1: Add embedding section**

Add after the translator section:

```yaml
# Embedding 配置（用于 RAG 文档对话）
embedding:
  # provider: local（本地模型）或 openai（远程 API）
  provider: "local"
  # 模型名称
  # local: all-MiniLM-L6-v2（推荐，轻量快速）
  # openai: text-embedding-3-small, text-embedding-3-large, text-embedding-ada-002
  model: "all-MiniLM-L6-v2"
```

- [ ] **Step 2: Commit**

```bash
git add config.example.yaml
git commit -m "docs: add embedding config example"
```

---

### Task 8: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add chat endpoint to API table**

Replace the API table:

```markdown
| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/translate` | POST | SSE 流式翻译，接收文件 + target_lang |
| `/api/translate/{task_id}/chat` | POST | SSE RAG 文档对话，接收 question |
| `/api/translations` | GET | 翻译历史列表，支持 `?q=搜索&page=1&limit=20` |
| `/api/translations/{task_id}` | GET | 获取单个翻译详情（原文 + 译文） |
| `/api/download?task_id=` | GET | 下载翻译完成的文件 |
| `/api/images/{task_id}/{filename}` | GET | 获取文档内嵌图片 |
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add RAG chat endpoint to README"
```

---

## Verification

After all tasks are complete:

1. **Start backend:** `uv run uvicorn app.main:app --host 127.0.0.1 --port 8000`
2. **Start frontend:** `cd frontend && npm run dev`
3. **Test flow:**
   - Upload a document and complete translation
   - Click "AI 对话" button in the toolbar
   - See welcome message with 3 suggested questions
   - Click a suggested question or type your own
   - Verify streaming answer appears in real-time
   - Send follow-up questions
   - Click "← 返回对照查看" to go back
4. **TypeScript check:** `cd frontend && npx tsc -b --noEmit` — no errors
5. **Build:** `cd frontend && npm run build` — successful
