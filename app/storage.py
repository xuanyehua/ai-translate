"""Persistent storage for translation results using JSON files."""
import json
import logging
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
