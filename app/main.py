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
from app.storage import save_translation, load_translation, list_translations
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

_results: dict[str, dict] = {}
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
        record = {
            "original": markdown,
            "translated": full_translated,
            "ext": doc_ext,
            "filename": file.filename,
        }
        _results[task_id].update(record)

        yield _sse_event("done", {
            "task_id": task_id,
            "ext": doc_ext,
            "filename": file.filename,
        })

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

        # Build RAG index in background
        asyncio.create_task(_build_rag(task_id, full_translated))

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
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, save_translation, task_id, data)


async def _build_rag(task_id: str, translated_md: str) -> None:
    """Async wrapper to build RAG index from translated markdown."""
    loop = asyncio.get_running_loop()
    store = await loop.run_in_executor(None, build_chunk_store, translated_md)
    if store is not None:
        _rag_stores[task_id] = store
        logger.info(f"RAG index built for task {task_id} ({len(store.chunks)} chunks)")
    else:
        logger.warning(f"Failed to build RAG index for task {task_id}")


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
    page = max(1, page)
    limit = min(limit, 100)
    offset = (page - 1) * limit
    items, total = list_translations(search=q, limit=limit, offset=offset)
    return {"items": items, "total": total}


@app.get("/api/translations/{task_id}")
async def get_translation_detail(task_id: str):
    result = _results.get(task_id)
    if result:
        return {
            "task_id": task_id,
            "filename": result.get("filename", ""),
            "ext": result.get("ext", "md"),
            "original": result.get("original", ""),
            "translated": result.get("translated", ""),
        }
    record = load_translation(task_id)
    if not record:
        raise HTTPException(404, "Translation result not found")
    return {
        "task_id": task_id,
        "filename": record.get("filename", ""),
        "ext": record.get("ext", "md"),
        "original": record.get("original", ""),
        "translated": record.get("translated", ""),
    }


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


@app.get("/api/download")
async def download(task_id: str):
    result = _results.get(task_id)
    if not result:
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
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(out_name)}"},
    )
