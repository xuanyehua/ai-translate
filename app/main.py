import asyncio
import base64
import hashlib
import json
import logging
import os
import shutil
import sqlite3
import uuid
import tempfile
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse, Response
from fastapi.staticfiles import StaticFiles

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
from app.task_manager import task_manager
from app.task_store import (
    TERMINAL_STATUSES,
    create_task,
    delete_task,
    get_task,
    get_task_by_content,
    import_completed_task,
    init_db,
    list_tasks,
    load_chunks,
    recover_tasks,
    request_cancel,
    retry_task,
    set_content_hash,
    task_json,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


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


def _import_completed_tasks() -> None:
    """Register existing directory-based translations in the task database."""
    from app.storage import BASE_DIR

    if not BASE_DIR.exists():
        return
    for entry in BASE_DIR.iterdir():
        if not entry.is_dir():
            continue
        meta = load_meta(entry.name)
        if meta:
            import_completed_task(meta)


def _backfill_content_hashes() -> None:
    """Hash source files from tasks created before content-based deduplication."""
    items, _ = list_tasks("", 100000, 0)
    for item in reversed(items):
        if item.get("content_hash"):
            continue
        source_path = task_dir(item["task_id"]) / f"source{item['ext']}"
        if not source_path.is_file():
            continue
        digest = hashlib.sha256()
        with source_path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
        set_content_hash(item["task_id"], digest.hexdigest())


@asynccontextmanager
async def lifespan(app: FastAPI):
    _migrate_legacy_storage()
    init_db()
    _import_completed_tasks()
    _backfill_content_hashes()
    recovered_ids = recover_tasks()
    await asyncio.to_thread(mineru_service.start)
    logger.info(f"MinerU API ready at {mineru_service.get_base_url()}")
    await task_manager.start(recovered_ids)
    try:
        yield
    finally:
        await task_manager.stop()
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


def _task_payload(task_id: str, include_content: bool = True) -> dict:
    task = get_task(task_id)
    if task is None:
        raise HTTPException(404, "Task not found")
    payload = dict(task)
    payload["ext"] = payload["ext"].lstrip(".")
    payload["cancel_requested"] = bool(payload["cancel_requested"])
    meta = load_meta(task_id)
    payload["embedding_status"] = meta.get("embedding_status", "pending") if meta else "pending"
    if include_content:
        payload["original"] = load_original(task_id) or ""
        chunks = load_chunks(task_id)
        payload["translated"] = "\n\n".join(chunks[index] for index in sorted(chunks))
        if not payload["translated"]:
            payload["translated"] = load_translated(task_id) or ""
    return payload


@app.post("/api/tasks", status_code=202)
async def submit_task(file: UploadFile = File(...), target_lang: str = Form("中文")):
    if not file.filename:
        raise HTTPException(400, "No filename provided")
    ext = Path(file.filename).suffix.lower()
    if not ext:
        raise HTTPException(400, "File extension is required")

    task_id = uuid.uuid4().hex[:12]
    directory = task_dir(task_id)
    directory.mkdir(parents=True, exist_ok=False)
    source_path = directory / f"source{ext}"
    try:
        digest = hashlib.sha256()
        with source_path.open("wb") as target:
            while chunk := await file.read(1024 * 1024):
                target.write(chunk)
                digest.update(chunk)
        content_hash = digest.hexdigest()
        existing = get_task_by_content(content_hash, target_lang)
        if existing is not None:
            source_path.unlink(missing_ok=True)
            directory.rmdir()
            payload = _task_payload(existing["task_id"], False)
            payload["duplicate"] = True
            return payload
        try:
            task = create_task(task_id, file.filename, ext, target_lang, content_hash)
        except sqlite3.IntegrityError:
            existing = get_task_by_content(content_hash, target_lang)
            if existing is None:
                raise
            source_path.unlink(missing_ok=True)
            directory.rmdir()
            payload = _task_payload(existing["task_id"], False)
            payload["duplicate"] = True
            return payload
        await task_manager.enqueue(task_id)
    except Exception:
        logger.exception("Failed to create task %s", task_id)
        raise HTTPException(500, "创建任务失败")
    payload = dict(task)
    payload["ext"] = payload["ext"].lstrip(".")
    payload["duplicate"] = False
    return payload


@app.get("/api/tasks")
async def get_tasks(q: str = "", page: int = 1, limit: int = 20, scope: str = "all"):
    page = max(1, page)
    limit = min(max(1, limit), 100)
    if scope not in ("all", "worklist"):
        raise HTTPException(400, "Invalid task scope")
    items, total = list_tasks(
        q, limit, (page - 1) * limit, exclude_completed=scope == "worklist",
    )
    return {"items": [_task_payload(item["task_id"], False) for item in items], "total": total}


@app.get("/api/tasks/events")
async def all_task_events():
    """Stream lightweight changes for every task through one browser connection."""
    async def event_stream():
        previous: dict[str, str] = {}
        previous_status: dict[str, str] = {}
        initialized = False
        heartbeat_ticks = 0
        while True:
            items, _ = await asyncio.to_thread(
                lambda: list_tasks("", 1000, 0, exclude_completed=False)
            )
            current: dict[str, str] = {}
            current_status: dict[str, str] = {}
            for item in items:
                payload = _task_payload(item["task_id"], False)
                task_id = payload["task_id"]
                encoded = task_json(payload)
                current[task_id] = encoded
                current_status[task_id] = payload["status"]
                if task_id in previous and encoded != previous[task_id]:
                    event = (
                        "completed"
                        if payload["status"] == "completed"
                        and previous_status.get(task_id) != "completed"
                        else "task"
                    )
                    yield _sse_event(event, payload)
                elif initialized and task_id not in previous:
                    yield _sse_event("task", payload)
            previous = current
            previous_status = current_status
            initialized = True
            heartbeat_ticks += 1
            if heartbeat_ticks >= 20:
                yield _sse_event("heartbeat", {"ok": True})
                heartbeat_ticks = 0
            await asyncio.sleep(0.75)

    return StreamingResponse(
        event_stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.get("/api/tasks/{task_id}")
async def get_task_detail(task_id: str):
    return _task_payload(task_id)


@app.get("/api/tasks/{task_id}/events")
async def task_events(task_id: str):
    if get_task(task_id) is None:
        raise HTTPException(404, "Task not found")

    async def event_stream():
        previous = ""
        while True:
            payload = _task_payload(task_id)
            encoded = task_json(payload)
            if encoded != previous:
                yield _sse_event("status", payload)
                previous = encoded
            if payload["status"] in TERMINAL_STATUSES:
                yield _sse_event("done", payload)
                return
            await asyncio.sleep(0.75)

    return StreamingResponse(
        event_stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no"},
    )


@app.post("/api/tasks/{task_id}/retry", status_code=202)
async def retry_processing_task(task_id: str):
    if get_task(task_id) is None:
        raise HTTPException(404, "Task not found")
    task = retry_task(task_id)
    if task is None:
        raise HTTPException(409, "Task cannot be retried in its current state")
    await task_manager.enqueue(task_id)
    return _task_payload(task_id, False)


@app.post("/api/tasks/{task_id}/cancel", status_code=202)
async def cancel_processing_task(task_id: str):
    task = request_cancel(task_id)
    if task is None:
        raise HTTPException(404, "Task not found")
    if task["status"] in TERMINAL_STATUSES:
        raise HTTPException(409, "Task is already finished")
    return _task_payload(task_id, False)


@app.delete("/api/tasks/{task_id}", status_code=204)
async def delete_processing_task(task_id: str):
    task = get_task(task_id)
    if task is None:
        raise HTTPException(404, "Task not found")
    if task["status"] not in TERMINAL_STATUSES:
        raise HTTPException(409, "请先取消正在处理的任务")

    directory = task_dir(task_id)
    if directory.exists():
        await asyncio.to_thread(shutil.rmtree, directory)
    delete_task(task_id)
    _results.pop(task_id, None)
    _rag_stores.pop(task_id, None)
    return Response(status_code=204)


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
        logger.exception("Document parse failed for %s", file.filename)
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


@app.get("/health")
async def health():
    return {"status": "ok"}


# In the production image FastAPI serves the Vite build. Development keeps
# using Vite's dev server and proxy because frontend/dist does not normally exist.
FRONTEND_DIST = Path(os.getenv("FRONTEND_DIST", "frontend/dist"))
if FRONTEND_DIST.exists():
    assets_dir = FRONTEND_DIST / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def frontend_app(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(404, "API endpoint not found")
        candidate = (FRONTEND_DIST / full_path).resolve()
        root = FRONTEND_DIST.resolve()
        if full_path and candidate.is_relative_to(root) and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(root / "index.html")
