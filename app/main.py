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
    # Prefer current-session memory; fetch embedding_status from meta.json (lazy)
    result = _results.get(task_id)
    if result and "translated" in result:
        meta = load_meta(task_id)
        embedding_status = meta.get("embedding_status", "pending") if meta else "pending"
        return {
            "task_id": task_id,
            "filename": result.get("filename", ""),
            "ext": result.get("ext", "md"),
            "original": result.get("original", ""),
            "translated": result.get("translated", ""),
            "embedding_status": embedding_status,
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
