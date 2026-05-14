import base64
import json
import logging
import uuid
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, Response

from app import mineru_service
from app.parser import parse_document
from app.translator import translate_document_stream
from app.converter import convert

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
        # Send original markdown
        yield _sse_event("original", {
            "markdown": markdown,
            "ext": doc_ext,
            "filename": file.filename,
            "task_id": task_id,
        })

        # Stream translated chunks
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

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/images/{task_id}/{filename}")
async def serve_image(task_id: str, filename: str):
    result = _results.get(task_id)
    if not result:
        raise HTTPException(404, "Task not found")

    images: dict[str, str] = result.get("images", {})
    data_uri = images.get(filename)
    if not data_uri:
        raise HTTPException(404, "Image not found")

    # data_uri format: "data:image/jpeg;base64,xxx"
    try:
        header, base64_data = data_uri.split(",", 1)
        mime_type = header.removeprefix("data:").split(";")[0]
        return Response(content=base64.b64decode(base64_data), media_type=mime_type)
    except (ValueError, KeyError):
        raise HTTPException(500, "Invalid image data")


@app.get("/api/download")
async def download(task_id: str):
    result = _results.get(task_id)
    if not result:
        raise HTTPException(404, "Translation result not found")

    file_bytes, mime_type, out_ext = convert(result["translated"], result["ext"])
    base_name = Path(result["filename"]).stem
    out_name = f"{base_name}_translated.{out_ext}"

    return StreamingResponse(
        iter([file_bytes]),
        media_type=mime_type,
        headers={"Content-Disposition": f"attachment; filename={out_name}"},
    )
