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


def save_images(task_id: str, images: dict[str, str]) -> bool:
    """Persist MinerU image data URIs as files for restart-safe processing."""
    try:
        if not images:
            return True
        img_dir = task_dir(task_id) / "images"
        img_dir.mkdir(parents=True, exist_ok=True)
        for img_name, data_uri in images.items():
            if not data_uri.startswith("data:"):
                continue
            img_bytes, _ext = _decode_data_uri(data_uri)
            (img_dir / Path(img_name).name).write_bytes(img_bytes)
        return True
    except Exception:
        logger.exception("Failed to persist images for task %s", task_id)
        return False


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
        save_images(task_id, images)

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
