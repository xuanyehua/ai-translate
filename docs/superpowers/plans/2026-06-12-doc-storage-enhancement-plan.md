# 文档持久化增强 - 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把翻译产物（原文/译文 Markdown、图片、RAG 索引、对话记录）全部持久化到目录结构，前端展示 embedding 状态并支持手动触发，AI 对话改为可收起的右侧抽屉，支持多轮上下文。

**Architecture:** 每个翻译任务存到 `data/translations/{task_id}/` 一个目录。原文/译文用纯 `.md` 文件，图片单独存盘，RAG 索引用 FAISS 二进制 + JSON 块文本，对话用 JSONL 追加格式。前端将 ChatView 改为 ChatDrawer（与 CompareView 并排）。

**Tech Stack:** Python (FastAPI, FAISS, sentence-transformers), TypeScript (React)

---

### Task 1: 重构 `app/storage.py` 为目录结构

**Files:**
- Modify: `app/storage.py`

- [ ] **Step 1: 改写整个 `app/storage.py`**

完整替换文件内容：

```python
"""Persistent storage for translation results: directory-based layout.

Layout:
    data/translations/{task_id}/
        original.md           # MinerU-parsed source markdown
        translated.md         # Translated markdown
        meta.json             # Metadata + embedding status
        images/               # Decoded images (jpg/png)
        rag/                  # RAG index (after embedding)
        chat.jsonl            # Multi-turn chat log (appended)
"""
import base64
import json
import logging
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

BASE_DIR = Path("data") / "translations"


def _ensure_dir() -> None:
    BASE_DIR.mkdir(parents=True, exist_ok=True)


def _validate_task_id(task_id: str) -> None:
    if not re.match(r"^[a-zA-Z0-9_-]+$", task_id):
        raise ValueError(f"Invalid task_id: {task_id}")


def task_dir(task_id: str) -> Path:
    _validate_task_id(task_id)
    return BASE_DIR / task_id


def _atomic_write_json(path: Path, data: dict) -> None:
    """Atomic write JSON via tempfile + rename."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def _decode_data_uri(data_uri: str) -> tuple[bytes, str]:
    """Decode 'data:image/jpeg;base64,xxx' → (bytes, ext)."""
    header, b64 = data_uri.split(",", 1)
    mime = header.removeprefix("data:").split(";")[0]
    ext_map = {
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/png": "png",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/bmp": "bmp",
    }
    ext = ext_map.get(mime, "bin")
    return base64.b64decode(b64), ext


def save_translation(
    task_id: str,
    filename: str,
    ext: str,
    target_lang: str,
    original_md: str,
    translated_md: str,
    images: dict[str, str],
) -> bool:
    """Save translation to data/translations/{task_id}/.

    images: dict of {filename: data_uri} from MinerU.
    Returns True on success.
    """
    try:
        _ensure_dir()
        d = task_dir(task_id)
        d.mkdir(parents=True, exist_ok=True)

        (d / "original.md").write_text(original_md, encoding="utf-8")
        (d / "translated.md").write_text(translated_md, encoding="utf-8")

        # Save images
        if images:
            img_dir = d / "images"
            img_dir.mkdir(exist_ok=True)
            for img_name, data_uri in images.items():
                if not data_uri.startswith("data:"):
                    continue
                try:
                    img_bytes, _ext = _decode_data_uri(data_uri)
                    safe_name = Path(img_name).name  # strip path
                    (img_dir / safe_name).write_bytes(img_bytes)
                except Exception:
                    logger.exception(f"Failed to decode image {img_name}")

        meta = {
            "task_id": task_id,
            "filename": filename,
            "ext": ext,
            "target_lang": target_lang,
            "status": "completed",
            "created_at": datetime.now(timezone.utc).isoformat(),
            "embedding_status": "pending",
            "embedding_built_at": None,
            "embedding_error": None,
        }
        _atomic_write_json(d / "meta.json", meta)
        return True
    except Exception:
        logger.exception(f"Failed to save translation for task {task_id}")
        return False


def load_meta(task_id: str) -> Optional[dict]:
    try:
        path = task_dir(task_id) / "meta.json"
    except ValueError:
        return None
    if not path.exists():
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        logger.exception(f"Failed to load meta for task {task_id}")
        return None


def load_original(task_id: str) -> Optional[str]:
    try:
        path = task_dir(task_id) / "original.md"
    except ValueError:
        return None
    if not path.exists():
        return None
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return None


def load_translated(task_id: str) -> Optional[str]:
    try:
        path = task_dir(task_id) / "translated.md"
    except ValueError:
        return None
    if not path.exists():
        return None
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return None


def load_image(task_id: str, filename: str) -> Optional[tuple[bytes, str]]:
    """Return (image_bytes, mime_type) or None."""
    try:
        d = task_dir(task_id)
    except ValueError:
        return None
    safe_name = Path(filename).name
    path = d / "images" / safe_name
    if not path.exists():
        return None
    ext = safe_name.rsplit(".", 1)[-1].lower() if "." in safe_name else "bin"
    mime_map = {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "gif": "image/gif",
        "webp": "image/webp",
        "bmp": "image/bmp",
    }
    mime = mime_map.get(ext, "application/octet-stream")
    try:
        return path.read_bytes(), mime
    except Exception:
        return None


def list_translations(
    search: str = "",
    limit: int = 20,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """List translation summaries from meta.json files."""
    _ensure_dir()
    items: list[dict] = []
    search_lower = search.lower()

    if not BASE_DIR.exists():
        return [], 0

    for entry in sorted(BASE_DIR.iterdir()):
        if not entry.is_dir():
            continue
        meta_path = entry / "meta.json"
        if not meta_path.exists():
            continue
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                record = json.load(f)
        except Exception:
            continue

        if search and search_lower not in record.get("filename", "").lower():
            continue

        items.append({
            "task_id": record.get("task_id", entry.name),
            "filename": record.get("filename", "unknown"),
            "ext": record.get("ext", "md"),
            "target_lang": record.get("target_lang", ""),
            "status": record.get("status", "completed"),
            "created_at": record.get("created_at", ""),
            "embedding_status": record.get("embedding_status", "pending"),
        })

    items.sort(key=lambda x: x["created_at"], reverse=True)
    total = len(items)
    page = items[offset: offset + limit]
    return page, total


def update_embedding_status(
    task_id: str,
    status: str,
    error: Optional[str] = None,
) -> bool:
    """Update embedding_status field in meta.json."""
    meta = load_meta(task_id)
    if meta is None:
        return False
    meta["embedding_status"] = status
    if status == "ready":
        meta["embedding_built_at"] = datetime.now(timezone.utc).isoformat()
        meta["embedding_error"] = None
    elif status == "failed":
        meta["embedding_error"] = error
    try:
        _atomic_write_json(task_dir(task_id) / "meta.json", meta)
        return True
    except Exception:
        logger.exception(f"Failed to update embedding_status for {task_id}")
        return False


# === Chat persistence ===


def _chat_path(task_id: str) -> Path:
    return task_dir(task_id) / "chat.jsonl"


def append_chat_message(task_id: str, role: str, content: str) -> bool:
    """Append a chat message to chat.jsonl."""
    try:
        path = _chat_path(task_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        msg = {
            "role": role,
            "content": content,
            "ts": datetime.now(timezone.utc).isoformat(),
        }
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(msg, ensure_ascii=False) + "\n")
        return True
    except Exception:
        logger.exception(f"Failed to append chat message for {task_id}")
        return False


def load_chat_history(task_id: str, limit: Optional[int] = None) -> list[dict]:
    """Load chat history from chat.jsonl. Skip corrupt lines.

    If limit is set, return last N messages.
    """
    try:
        path = _chat_path(task_id)
    except ValueError:
        return []
    if not path.exists():
        return []
    messages: list[dict] = []
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    messages.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except Exception:
        logger.exception(f"Failed to load chat history for {task_id}")
        return []
    if limit is not None and limit > 0:
        return messages[-limit:]
    return messages


def clear_chat_history(task_id: str) -> bool:
    """Delete chat.jsonl."""
    try:
        path = _chat_path(task_id)
    except ValueError:
        return False
    try:
        if path.exists():
            path.unlink()
        return True
    except Exception:
        logger.exception(f"Failed to clear chat history for {task_id}")
        return False
```

- [ ] **Step 2: 验证导入和基本功能**

```bash
cd /Users/xuanyehua/pythonCode/ai-translate
.venv/bin/python -c "
from app.storage import save_translation, load_meta, load_original, load_translated, load_image, list_translations, update_embedding_status, append_chat_message, load_chat_history, clear_chat_history, task_dir
print('OK')
"
```
Expected: `OK`

- [ ] **Step 3: 提交**

```bash
git add app/storage.py
git commit -m "refactor(storage): use per-task directory layout with separate md/images/rag/chat files"
```

---

### Task 2: 修改 `app/main.py` — 适配新存储

**Files:**
- Modify: `app/main.py`

- [ ] **Step 1: 改写 `/api/translate` 调用 save_translation 新签名 + 图片端点改为读盘**

改动点：
- import 新增 `load_meta`, `load_original`, `load_translated`, `load_image`, `update_embedding_status` from storage
- import 移除 `load_translation` (旧函数已删除)
- `_persist_translation()` 改为调用新签名
- `serve_image()` 改为读磁盘
- `get_translation_detail()` 改为读 `original.md`/`translated.md`
- `get_translations()` items 增加 `embedding_status` 字段（已经在 list_translations 里返回）
- `download()` 改为读磁盘

完整替换 `app/main.py`：

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
from urllib.parse import quote

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response

from app import mineru_service
from app.parser import parse_document
from app.translator import translate_document_stream
from app.converter import convert
from app.storage import (
    save_translation,
    load_meta,
    load_original,
    load_translated,
    load_image,
    list_translations,
    update_embedding_status,
    append_chat_message,
    load_chat_history,
    clear_chat_history,
    task_dir,
)
from app.rag import build_chunk_store, ChunkStore, generate_answer_stream

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

# In-memory cache for current session: {task_id: {"images": {filename: data_uri}}}
# Used during translation streaming before disk write completes.
_results: dict[str, dict] = {}
# In-memory cache for ChunkStore (lazy-loaded from disk on first chat)
_rag_stores: dict[str, ChunkStore] = {}


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
    except Exception:
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
        _results[task_id].update({
            "original": markdown,
            "translated": full_translated,
            "ext": doc_ext,
            "filename": file.filename,
        })

        yield _sse_event("done", {
            "task_id": task_id,
            "ext": doc_ext,
            "filename": file.filename,
        })

        # Persist to disk in background
        asyncio.create_task(_persist_then_build_rag(
            task_id=task_id,
            filename=file.filename,
            ext=doc_ext,
            target_lang=target_lang,
            original_md=markdown,
            translated_md=full_translated,
            images=images,
        ))

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def _persist_then_build_rag(
    task_id: str,
    filename: str,
    ext: str,
    target_lang: str,
    original_md: str,
    translated_md: str,
    images: dict,
) -> None:
    """Save to disk, then trigger RAG build."""
    loop = asyncio.get_running_loop()

    saved = await loop.run_in_executor(
        None,
        save_translation,
        task_id, filename, ext, target_lang, original_md, translated_md, images,
    )
    if not saved:
        logger.error(f"Failed to persist translation for {task_id}")
        return

    await _build_rag(task_id, translated_md)


async def _build_rag(task_id: str, translated_md: str) -> None:
    """Build RAG index, save to disk, update meta status."""
    loop = asyncio.get_running_loop()

    # Mark building
    await loop.run_in_executor(None, update_embedding_status, task_id, "building", None)

    try:
        rag_dir = task_dir(task_id) / "rag"
        store = await loop.run_in_executor(None, build_chunk_store, translated_md, rag_dir)
        if store is None:
            await loop.run_in_executor(
                None, update_embedding_status, task_id, "failed", "build returned None",
            )
            return
        _rag_stores[task_id] = store
        await loop.run_in_executor(None, update_embedding_status, task_id, "ready", None)
        logger.info(f"RAG index built for task {task_id} ({len(store.chunks)} chunks)")
    except Exception as e:
        logger.exception(f"RAG build failed for {task_id}")
        await loop.run_in_executor(None, update_embedding_status, task_id, "failed", str(e))


@app.get("/api/images/{task_id}/{filename}")
async def serve_image(task_id: str, filename: str):
    # Prefer in-memory cache (during current translate)
    result = _results.get(task_id)
    if result and "images" in result:
        data_uri = result["images"].get(filename)
        if data_uri:
            try:
                header, b64 = data_uri.split(",", 1)
                mime = header.removeprefix("data:").split(";")[0]
                return Response(content=base64.b64decode(b64), media_type=mime)
            except Exception:
                pass

    # Fall back to disk
    res = load_image(task_id, filename)
    if res is None:
        raise HTTPException(404, "Image not found")
    img_bytes, mime = res
    return Response(content=img_bytes, media_type=mime)


@app.get("/api/translations")
async def get_translations(q: str = "", page: int = 1, limit: int = 20):
    page = max(1, page)
    limit = min(limit, 100)
    offset = (page - 1) * limit
    items, total = list_translations(search=q, limit=limit, offset=offset)
    return {"items": items, "total": total}


@app.get("/api/translations/{task_id}")
async def get_translation_detail(task_id: str):
    # Prefer current-session memory
    result = _results.get(task_id)
    if result and "translated" in result:
        return {
            "task_id": task_id,
            "filename": result.get("filename", ""),
            "ext": result.get("ext", "md"),
            "original": result.get("original", ""),
            "translated": result.get("translated", ""),
        }

    meta = load_meta(task_id)
    if meta is None:
        raise HTTPException(404, "Translation not found")
    original = load_original(task_id) or ""
    translated = load_translated(task_id) or ""
    return {
        "task_id": task_id,
        "filename": meta.get("filename", ""),
        "ext": meta.get("ext", "md"),
        "original": original,
        "translated": translated,
        "embedding_status": meta.get("embedding_status", "pending"),
    }


@app.post("/api/translations/{task_id}/embed")
async def trigger_embedding(task_id: str):
    """Manually trigger RAG index build."""
    meta = load_meta(task_id)
    if meta is None:
        raise HTTPException(404, "Translation not found")

    if meta.get("embedding_status") == "building":
        raise HTTPException(409, "Already building")

    translated_md = load_translated(task_id)
    if translated_md is None:
        raise HTTPException(500, "Translated content not found on disk")

    asyncio.create_task(_build_rag(task_id, translated_md))
    return Response(status_code=202, content=json.dumps({"embedding_status": "building"}), media_type="application/json")


@app.post("/api/translate/{task_id}/chat")
async def chat_with_document(task_id: str, question: str = Form(...)):
    if not question.strip():
        raise HTTPException(400, "Question cannot be empty")

    meta = load_meta(task_id)
    if meta is None:
        raise HTTPException(404, "Translation not found")
    if meta.get("embedding_status") != "ready":
        raise HTTPException(503, "AI 助手正在准备中，请稍后重试")

    # Load store: prefer cache, fall back to disk
    store = _rag_stores.get(task_id)
    if store is None:
        loop = asyncio.get_running_loop()
        rag_dir = task_dir(task_id) / "rag"
        store = await loop.run_in_executor(None, ChunkStore.load, rag_dir)
        if store is None:
            raise HTTPException(503, "索引未就绪，请重新构建")
        _rag_stores[task_id] = store

    # Append user message before generating
    q = question.strip()
    append_chat_message(task_id, "user", q)

    # Get history (excluding the just-appended user message; we'll add fresh in prompt)
    history = load_chat_history(task_id, limit=11)
    # Drop trailing user we just appended (will pass current question separately)
    if history and history[-1].get("role") == "user" and history[-1].get("content") == q:
        history = history[:-1]
    # Keep last 10
    history = history[-10:]

    async def event_stream():
        full_answer_parts: list[str] = []
        async for event, data in generate_answer_stream(store, q, history=history):
            yield _sse_event(event, data)
            if event == "chunk":
                full_answer_parts.append(data.get("text", ""))

        full_answer = "".join(full_answer_parts).strip()
        if full_answer:
            append_chat_message(task_id, "assistant", full_answer)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/translate/{task_id}/chat/history")
async def get_chat_history(task_id: str):
    if load_meta(task_id) is None:
        raise HTTPException(404, "Translation not found")
    messages = load_chat_history(task_id)
    return {"messages": messages}


@app.delete("/api/translate/{task_id}/chat/history")
async def delete_chat_history(task_id: str):
    if load_meta(task_id) is None:
        raise HTTPException(404, "Translation not found")
    if not clear_chat_history(task_id):
        raise HTTPException(500, "Failed to clear chat history")
    return {"ok": True}


@app.get("/api/download")
async def download(task_id: str):
    # Prefer current-session memory
    result = _results.get(task_id)
    if result and "translated" in result:
        translated = result["translated"]
        ext = result["ext"]
        filename = result["filename"]
    else:
        meta = load_meta(task_id)
        if meta is None:
            raise HTTPException(404, "Translation result not found")
        translated = load_translated(task_id) or ""
        ext = meta.get("ext", "md")
        filename = meta.get("filename", task_id)

    file_bytes, mime_type, out_ext = convert(translated, ext)
    base_name = Path(filename).stem
    out_name = f"{base_name}_translated.{out_ext}"

    return StreamingResponse(
        iter([file_bytes]),
        media_type=mime_type,
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(out_name)}"},
    )
```

- [ ] **Step 2: 验证导入**

```bash
cd /Users/xuanyehua/pythonCode/ai-translate
.venv/bin/python -c "from app.main import app; print('OK')"
```
Expected: `OK`

- [ ] **Step 3: 提交**

```bash
git add app/main.py
git commit -m "feat(api): switch to dir storage, add embed/chat-history endpoints, multi-turn chat"
```

---

### Task 3: 修改 `app/rag.py` — ChunkStore 持久化 + 多轮对话支持

**Files:**
- Modify: `app/rag.py`

- [ ] **Step 1: 改写 `app/rag.py`**

完整替换：

```python
"""RAG engine: chunk translated Markdown, build FAISS index, search and answer."""
import json
import logging
from pathlib import Path
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

    sections = re.split(r"\n(?=#{2,6}\s)", markdown)
    chunks: list[str] = []

    for section in sections:
        section = section.strip()
        if not section:
            continue

        if len(section) <= max_chars:
            chunks.append(section)
            continue

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

    def __init__(self, chunks: list[str], vectors_or_index, dim: Optional[int] = None):
        """Construct from vectors (build index) or from a pre-loaded faiss.Index.

        - If vectors_or_index is a numpy array: build a new IndexFlatL2.
        - If it's a faiss.Index: use directly (load path).
        """
        import faiss
        self.chunks = chunks
        if isinstance(vectors_or_index, np.ndarray):
            d = vectors_or_index.shape[1]
            self.index = faiss.IndexFlatL2(d)
            self.index.add(vectors_or_index.astype(np.float32))
            self.dim = d
        else:
            self.index = vectors_or_index
            self.dim = dim or self.index.d

    def search(self, query: str, top_k: int = 5) -> list[str]:
        """Search for the most relevant chunks to the query."""
        q_vec = _embed([query]).astype(np.float32)
        distances, indices = self.index.search(q_vec, min(top_k, len(self.chunks)))
        results: list[str] = []
        for i in indices[0]:
            if 0 <= i < len(self.chunks):
                results.append(self.chunks[i])
        return results

    def save(self, rag_dir: Path) -> None:
        """Persist chunks + FAISS index + metadata to rag_dir."""
        import faiss
        rag_dir.mkdir(parents=True, exist_ok=True)
        with open(rag_dir / "chunks.json", "w", encoding="utf-8") as f:
            json.dump(self.chunks, f, ensure_ascii=False, indent=2)
        faiss.write_index(self.index, str(rag_dir / "index.faiss"))
        meta = {
            "model": config.embedding_model,
            "provider": config.embedding_provider,
            "dim": self.dim,
            "chunk_count": len(self.chunks),
        }
        with open(rag_dir / "meta.json", "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

    @classmethod
    def load(cls, rag_dir: Path) -> Optional["ChunkStore"]:
        """Load from disk. Returns None if missing or model/provider mismatched."""
        import faiss
        meta_path = rag_dir / "meta.json"
        chunks_path = rag_dir / "chunks.json"
        index_path = rag_dir / "index.faiss"

        if not (meta_path.exists() and chunks_path.exists() and index_path.exists()):
            return None

        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            # Validate model/provider
            if meta.get("model") != config.embedding_model:
                logger.warning(
                    f"Embedding model changed: stored={meta.get('model')} "
                    f"vs current={config.embedding_model}, index needs rebuild"
                )
                return None
            if meta.get("provider") != config.embedding_provider:
                logger.warning(
                    f"Embedding provider changed: stored={meta.get('provider')} "
                    f"vs current={config.embedding_provider}, index needs rebuild"
                )
                return None

            with open(chunks_path, "r", encoding="utf-8") as f:
                chunks = json.load(f)
            index = faiss.read_index(str(index_path))
            return cls(chunks, index, dim=meta.get("dim"))
        except Exception:
            logger.exception(f"Failed to load ChunkStore from {rag_dir}")
            return None


def build_chunk_store(markdown: str, rag_dir: Optional[Path] = None) -> Optional[ChunkStore]:
    """Build a ChunkStore from translated Markdown.

    If rag_dir is provided, persist the store to disk after building.
    Returns None on failure.
    """
    try:
        chunks = chunk_document(markdown)
        if not chunks:
            logger.warning("No chunks generated from document")
            return None

        vectors = _embed(chunks)
        store = ChunkStore(chunks, vectors)

        if rag_dir is not None:
            try:
                store.save(rag_dir)
            except Exception:
                logger.exception(f"Failed to save ChunkStore to {rag_dir}")
                # Still return store; caller decides what to do

        return store
    except Exception:
        logger.exception("Failed to build RAG index")
        return None


async def generate_answer_stream(
    store: ChunkStore,
    question: str,
    history: Optional[list[dict]] = None,
):
    """SSE async generator: search chunks, build prompt with history, stream LLM answer.

    history: list of {"role", "content"} dicts (recent turns).
    Yields (event_type, data_dict) tuples.
    """
    import asyncio
    from app.translator import get_translator

    yield "thinking", {"message": "正在检索相关内容..."}

    loop = asyncio.get_running_loop()
    relevant_chunks = await loop.run_in_executor(
        None, store.search, question, 5
    )

    if not relevant_chunks:
        yield "done", {"message": "未找到相关信息，请尝试换个问法"}
        return

    context = "\n\n---\n\n".join(relevant_chunks)
    user_prompt = f"""文档片段：
{context}

当前问题：{question}"""

    # Build messages: system + history + current question with retrieval
    messages: list[dict] = [
        {
            "role": "system",
            "content": (
                "你是一个专业、友好的文档助手。基于提供的文档片段和对话上下文，用中文回答用户问题。"
                "如果文档片段中没有相关信息，请如实告知用户。"
            ),
        },
    ]

    # Append cleaned history (only role + content, drop ts)
    if history:
        for msg in history:
            role = msg.get("role")
            content = msg.get("content", "")
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": user_prompt})

    translator = get_translator()
    try:
        resp = await loop.run_in_executor(
            None,
            lambda: translator.client.chat.completions.create(
                model=translator.model,
                messages=messages,
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

- [ ] **Step 2: 验证**

```bash
cd /Users/xuanyehua/pythonCode/ai-translate
.venv/bin/python -c "
from app.rag import ChunkStore, build_chunk_store, generate_answer_stream
print('OK')
"
```
Expected: `OK`

- [ ] **Step 3: 提交**

```bash
git add app/rag.py
git commit -m "feat(rag): persist ChunkStore to disk, support multi-turn chat history"
```

---

### Task 4: 启动时迁移旧的单文件存储

**Files:**
- Modify: `app/main.py` (lifespan 函数)

- [ ] **Step 1: 加迁移函数**

在 `app/main.py` 的 `lifespan` 之前添加：

```python
def _migrate_legacy_storage() -> None:
    """One-shot migration: convert old data/translations/{task_id}.json to dir layout."""
    from app.storage import BASE_DIR, save_translation
    if not BASE_DIR.exists():
        return

    for entry in BASE_DIR.iterdir():
        if not entry.is_file() or entry.suffix != ".json":
            continue
        task_id = entry.stem
        try:
            with open(entry, "r", encoding="utf-8") as f:
                old = json.load(f)
        except Exception:
            logger.exception(f"Failed to read legacy file {entry}, skipping")
            continue

        new_dir = BASE_DIR / task_id
        if new_dir.exists() and new_dir.is_dir():
            # Already migrated; just rename old file to .bak
            entry.rename(entry.with_suffix(".json.bak"))
            continue

        try:
            ok = save_translation(
                task_id=task_id,
                filename=old.get("filename", "unknown"),
                ext=old.get("ext", "md"),
                target_lang=old.get("target_lang", ""),
                original_md=old.get("original", ""),
                translated_md=old.get("translated", ""),
                images={},  # legacy didn't persist images
            )
            if ok:
                entry.rename(entry.with_suffix(".json.bak"))
                logger.info(f"Migrated legacy translation: {task_id}")
        except Exception:
            logger.exception(f"Failed to migrate {task_id}, skipping")
```

修改 `lifespan`：

```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    _migrate_legacy_storage()
    mineru_service.start()
    logger.info(f"MinerU API ready at {mineru_service.get_base_url()}")
    yield
    mineru_service.stop()
```

需要在 `app/storage.py` 中导出 `BASE_DIR`（已经定义过，只需保留为模块顶层）。

- [ ] **Step 2: 验证**

```bash
cd /Users/xuanyehua/pythonCode/ai-translate
.venv/bin/python -c "from app.main import app; print('OK')"
```
Expected: `OK`

- [ ] **Step 3: 提交**

```bash
git add app/main.py
git commit -m "feat(storage): migrate legacy single-file translations to dir layout on startup"
```

---

### Task 5: 创建 `frontend/src/components/ChatDrawer.tsx`

**Files:**
- Create: `frontend/src/components/ChatDrawer.tsx`

- [ ] **Step 1: 写组件**

写入 `/Users/xuanyehua/pythonCode/ai-translate/frontend/src/components/ChatDrawer.tsx`：

```tsx
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
```

- [ ] **Step 2: TypeScript 检查**

```bash
cd /Users/xuanyehua/pythonCode/ai-translate/frontend
npx tsc -b --noEmit
```
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add frontend/src/components/ChatDrawer.tsx
git commit -m "feat(frontend): add ChatDrawer side panel with multi-turn history"
```

---

### Task 6: 修改 `CompareView.tsx` — 三栏布局 + 嵌入抽屉 + 状态显示

**Files:**
- Modify: `frontend/src/components/CompareView.tsx`

- [ ] **Step 1: 改写工具栏 + 抽屉容器**

修改 `frontend/src/components/CompareView.tsx`，改动点：
1. 替换 `onChatClick?` 为 `embeddingStatus?` + `onTriggerEmbed?`
2. 内部管理抽屉展开/收起 state
3. 工具栏按钮根据 `embeddingStatus` 改变行为
4. compare panels 容器改为 grid 三列响应式

完整替换文件：

```tsx
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
```

- [ ] **Step 2: TypeScript 检查**

```bash
cd /Users/xuanyehua/pythonCode/ai-translate/frontend
npx tsc -b --noEmit
```
Expected: 无错误

- [ ] **Step 3: 提交**

```bash
git add frontend/src/components/CompareView.tsx
git commit -m "feat(frontend): add 3-col layout with chat drawer and embedding status control"
```

---

### Task 7: 修改 `App.tsx` — 移除 chat 视图，添加 embedding 触发 + 状态轮询

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: 改写 App.tsx**

完整替换：

```tsx
import { useState, useRef, useCallback, useEffect } from 'react'
import { FileUpload } from './components/FileUpload'
import { CompareView } from './components/CompareView'
import { HistoryView } from './components/HistoryView'

type AppStatus = 'idle' | 'uploading' | 'translating' | 'done' | 'error'
type AppView = 'translate' | 'history'
type EmbeddingStatus = 'pending' | 'building' | 'ready' | 'failed'

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
  const [embeddingStatus, setEmbeddingStatus] = useState<EmbeddingStatus>('pending')

  const fileInputRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const pollRef = useRef<number | null>(null)

  // Poll embedding status while building or after done
  const pollEmbeddingStatus = useCallback((tid: string) => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current)
    }
    const tick = async () => {
      try {
        const resp = await fetch(`/api/translations/${tid}`)
        if (!resp.ok) return
        const data = await resp.json()
        const s = (data.embedding_status || 'pending') as EmbeddingStatus
        setEmbeddingStatus(s)
        if (s === 'ready' || s === 'failed') {
          if (pollRef.current) {
            window.clearInterval(pollRef.current)
            pollRef.current = null
          }
        }
      } catch {}
    }
    tick()
    pollRef.current = window.setInterval(tick, 3000)
  }, [])

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current)
    }
  }, [])

  const handleTranslate = useCallback(async (file: File) => {
    setView('translate')
    setStatus('uploading')
    setErrorMsg('')
    setOriginalMarkdown('')
    setTranslatedChunks([])
    setTotalChunks(0)
    setTaskId(undefined)
    setEmbeddingStatus('pending')

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
      let finalTaskId: string | undefined

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
                finalTaskId = data.task_id
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
                finalTaskId = data.task_id
                setStatus('done')
                break
              case 'error':
                throw new Error(data.message || 'Translation error')
            }
          }
        }
      }

      // Start polling embedding status after translation completes
      if (finalTaskId) {
        pollEmbeddingStatus(finalTaskId)
      }
    } catch (e: unknown) {
      if (e instanceof DOMException && e.name === 'AbortError') return
      setStatus('error')
      setErrorMsg(e instanceof Error ? e.message : 'Unknown error')
    }
  }, [targetLang, pollEmbeddingStatus])

  const handleReset = () => {
    abortRef.current?.abort()
    if (pollRef.current) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
    setStatus('idle')
    setOriginalMarkdown('')
    setTranslatedChunks([])
    setTotalChunks(0)
    setTaskId(undefined)
    setErrorMsg('')
    setEmbeddingStatus('pending')
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleTriggerEmbed = useCallback(async () => {
    if (!taskId) return
    try {
      const resp = await fetch(`/api/translations/${taskId}/embed`, { method: 'POST' })
      if (resp.status === 202 || resp.ok) {
        setEmbeddingStatus('building')
        pollEmbeddingStatus(taskId)
      }
    } catch {}
  }, [taskId, pollEmbeddingStatus])

  const translatedMarkdown = translatedChunks.filter(Boolean).join('\n\n')
  const translatedCount = translatedChunks.filter(Boolean).length

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800">
      <header className="border-b border-slate-200 dark:border-slate-700 bg-white/80 dark:bg-slate-900/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-[1600px] mx-auto px-6 py-4 flex items-center justify-between">
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

      <main className="max-w-[1600px] mx-auto px-6 py-8">
        {view === 'translate' && (
          <>
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

            {status === 'uploading' && (
              <div className="max-w-md mx-auto text-center space-y-6 pt-20">
                <div className="relative w-16 h-16 mx-auto">
                  <div className="absolute inset-0 border-4 border-slate-200 dark:border-slate-700 rounded-full" />
                  <div className="absolute inset-0 border-4 border-violet-600 rounded-full border-t-transparent animate-spin" />
                </div>
                <p className="text-slate-600 dark:text-slate-400 text-sm">正在解析文档...</p>
              </div>
            )}

            {(status === 'translating' || status === 'done') && originalMarkdown && (
              <CompareView
                taskId={taskId}
                original={originalMarkdown}
                translated={translatedMarkdown}
                isStreaming={status === 'translating'}
                translatedCount={translatedCount}
                totalChunks={totalChunks}
                embeddingStatus={embeddingStatus}
                onTriggerEmbed={status === 'done' ? handleTriggerEmbed : undefined}
              />
            )}

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

        {view === 'history' && <HistoryView />}
      </main>
    </div>
  )
}
```

- [ ] **Step 2: TypeScript 检查 + 构建**

```bash
cd /Users/xuanyehua/pythonCode/ai-translate/frontend
npx tsc -b --noEmit
npm run build
```
Expected: 无错误，构建成功

- [ ] **Step 3: 提交**

```bash
git add frontend/src/App.tsx
git commit -m "feat(frontend): poll embedding status, manual trigger, remove chat fullscreen view"
```

---

### Task 8: 修改 `HistoryView.tsx` — 显示 embedding 状态徽章 + 构建按钮

**Files:**
- Modify: `frontend/src/components/HistoryView.tsx`

- [ ] **Step 1: 改写 HistoryView**

完整替换：

```tsx
import { useState, useEffect, useCallback, useRef } from 'react'
import { CompareView } from './CompareView'

type EmbeddingStatus = 'pending' | 'building' | 'ready' | 'failed'

interface TranslationSummary {
  task_id: string
  filename: string
  ext: string
  target_lang: string
  status: string
  created_at: string
  embedding_status: EmbeddingStatus
}

interface TranslationRecord {
  task_id: string
  filename: string
  ext: string
  original: string
  translated: string
  embedding_status?: EmbeddingStatus
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

function StatusBadge({ status }: { status: EmbeddingStatus }) {
  if (status === 'ready') {
    return <span className="text-xs text-emerald-600 dark:text-emerald-400">🟢 索引就绪</span>
  }
  if (status === 'building') {
    return (
      <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
        <span className="w-2.5 h-2.5 border-2 border-amber-500 border-t-transparent rounded-full animate-spin" />
        构建中
      </span>
    )
  }
  if (status === 'failed') {
    return <span className="text-xs text-red-600 dark:text-red-400">⚠️ 构建失败</span>
  }
  return <span className="text-xs text-slate-500">🔴 未构建</span>
}

export function HistoryView() {
  const [items, setItems] = useState<TranslationSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  const [expanded, setExpanded] = useState<TranslationRecord | null>(null)

  const limit = 20
  const pollRef = useRef<number | null>(null)

  const fetchList = useCallback(async () => {
    setLoading(true)
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

  // Auto-poll while any item is "building"
  useEffect(() => {
    const anyBuilding = items.some(i => i.embedding_status === 'building')
    if (anyBuilding) {
      if (!pollRef.current) {
        pollRef.current = window.setInterval(fetchList, 3000)
      }
    } else if (pollRef.current) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
    return () => {
      if (pollRef.current) {
        window.clearInterval(pollRef.current)
        pollRef.current = null
      }
    }
  }, [items, fetchList])

  const handleExpand = async (task_id: string) => {
    try {
      const resp = await fetch(`/api/translations/${task_id}`)
      if (!resp.ok) return
      const data: TranslationRecord = await resp.json()
      setExpanded(data)
    } catch {}
  }

  const handleTriggerEmbed = async (task_id: string) => {
    try {
      await fetch(`/api/translations/${task_id}/embed`, { method: 'POST' })
      // Optimistic update
      setItems(prev => prev.map(i => i.task_id === task_id ? { ...i, embedding_status: 'building' } : i))
    } catch {}
  }

  const handleDownload = async (item: TranslationSummary) => {
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
  }

  const totalPages = Math.ceil(total / limit)

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="text-center space-y-2">
        <h2 className="text-3xl font-bold text-slate-900 dark:text-white">翻译历史</h2>
        <p className="text-slate-500 dark:text-slate-400">查看、搜索和下载过往翻译记录</p>
      </div>

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
                <div className="flex items-center gap-3 mt-0.5">
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {formatDate(item.created_at)} · {item.target_lang}
                  </p>
                  <StatusBadge status={item.embedding_status} />
                </div>
              </div>

              <div className="flex items-center gap-2">
                {(item.embedding_status === 'pending' || item.embedding_status === 'failed') && (
                  <button
                    onClick={() => handleTriggerEmbed(item.task_id)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/30"
                  >
                    构建索引
                  </button>
                )}
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
                      onClick={() => handleDownload(item)}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700"
                    >
                      下载
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}

          {expanded && (
            <CompareView
              taskId={expanded.task_id}
              original={expanded.original}
              translated={expanded.translated}
              embeddingStatus={expanded.embedding_status || items.find(i => i.task_id === expanded.task_id)?.embedding_status}
              onTriggerEmbed={() => handleTriggerEmbed(expanded.task_id)}
            />
          )}
        </div>
      )}

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

- [ ] **Step 2: TypeScript 检查 + 构建**

```bash
cd /Users/xuanyehua/pythonCode/ai-translate/frontend
npx tsc -b --noEmit
npm run build
```
Expected: 无错误，构建成功

- [ ] **Step 3: 提交**

```bash
git add frontend/src/components/HistoryView.tsx
git commit -m "feat(frontend): show embedding status badges and build button in history"
```

---

### Task 9: 删除旧的 `ChatView.tsx`（已被 ChatDrawer 替代）

**Files:**
- Delete: `frontend/src/components/ChatView.tsx`

- [ ] **Step 1: 删除文件**

```bash
cd /Users/xuanyehua/pythonCode/ai-translate
git rm frontend/src/components/ChatView.tsx
```

- [ ] **Step 2: 确认无引用**

```bash
grep -r "ChatView" frontend/src/ 2>/dev/null
```
Expected: 无输出（无残留引用）

- [ ] **Step 3: 提交**

```bash
git commit -m "chore: remove obsolete ChatView (replaced by ChatDrawer)"
```

---

### Task 10: 更新 README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新 API 表格**

把 README.md 里 API 表格替换为：

```markdown
| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/translate` | POST | SSE 流式翻译，接收文件 + target_lang |
| `/api/translate/{task_id}/chat` | POST | SSE 多轮 RAG 对话，接收 question |
| `/api/translate/{task_id}/chat/history` | GET | 获取该文档的对话记录 |
| `/api/translate/{task_id}/chat/history` | DELETE | 清空对话记录 |
| `/api/translations` | GET | 翻译历史列表，含 embedding_status |
| `/api/translations/{task_id}` | GET | 获取单个翻译详情（原文 + 译文） |
| `/api/translations/{task_id}/embed` | POST | 手动触发 RAG 索引构建 |
| `/api/download?task_id=` | GET | 下载翻译完成的文件 |
| `/api/images/{task_id}/{filename}` | GET | 获取文档内嵌图片 |
```

- [ ] **Step 2: 提交**

```bash
git add README.md
git commit -m "docs: update API table for chat history + manual embedding endpoints"
```

---

## Verification (after all tasks complete)

1. **后端导入：** `.venv/bin/python -c "from app.main import app; print('OK')"`
2. **前端构建：** `cd frontend && npm run build`
3. **启动服务：**
   ```bash
   .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 &
   cd frontend && npm run dev
   ```
4. **端到端测试：**
   - 上传文档 → 翻译完成 → 检查 `data/translations/{task_id}/` 目录结构
   - 工具栏看到 "构建索引中..." → 等待变成 "AI 对话"
   - 点击 AI 对话 → 抽屉展开
   - 提问 → 验证多轮（"它"指代）
   - 收起抽屉 → 再展开 → 历史还在
   - 「清空」按钮 → 历史清空
   - 历史页 → 看到状态徽章
   - 重启服务 → 历史还在 → 提问仍能从磁盘加载索引
   - 删 `data/translations/{task_id}/rag/` → 历史页显示「构建索引」按钮 → 点击 → 状态变 building → ready
