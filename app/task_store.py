"""SQLite-backed task metadata and translated chunk persistence."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DB_PATH = Path("data") / "tasks.sqlite3"
ACTIVE_STATUSES = ("queued", "parsing", "translating", "saving", "indexing", "interrupted")
TERMINAL_STATUSES = ("completed", "failed", "cancelled")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS tasks (
                task_id TEXT PRIMARY KEY,
                filename TEXT NOT NULL,
                ext TEXT NOT NULL,
                target_lang TEXT NOT NULL,
                content_hash TEXT,
                status TEXT NOT NULL,
                stage TEXT NOT NULL,
                current INTEGER NOT NULL DEFAULT 0,
                total INTEGER NOT NULL DEFAULT 0,
                message TEXT NOT NULL DEFAULT '',
                error TEXT,
                cancel_requested INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS task_chunks (
                task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
                chunk_index INTEGER NOT NULL,
                translated_text TEXT NOT NULL,
                PRIMARY KEY (task_id, chunk_index)
            );
            CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
            """
        )
        columns = {row[1] for row in conn.execute("PRAGMA table_info(tasks)").fetchall()}
        if "content_hash" not in columns:
            conn.execute("ALTER TABLE tasks ADD COLUMN content_hash TEXT")
        conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_content_lang "
            "ON tasks(content_hash, target_lang) WHERE content_hash IS NOT NULL"
        )


def create_task(
    task_id: str, filename: str, ext: str, target_lang: str, content_hash: str | None = None,
) -> dict[str, Any]:
    now = _now()
    with _connect() as conn:
        conn.execute(
            """INSERT INTO tasks
            (task_id, filename, ext, target_lang, content_hash, status, stage, message, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, 'queued', 'queued', '等待处理', ?, ?)""",
            (task_id, filename, ext, target_lang, content_hash, now, now),
        )
    return get_task(task_id)  # type: ignore[return-value]


def import_completed_task(meta: dict[str, Any]) -> None:
    task_id = meta.get("task_id")
    if not task_id:
        return
    created = meta.get("created_at") or _now()
    with _connect() as conn:
        conn.execute(
            """INSERT OR IGNORE INTO tasks
            (task_id, filename, ext, target_lang, status, stage, message, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'completed', 'completed', '翻译完成', ?, ?)""",
            (task_id, meta.get("filename", "unknown"), meta.get("ext", "md"),
             meta.get("target_lang", ""), created, created),
        )


def get_task(task_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE task_id = ?", (task_id,)).fetchone()
    return dict(row) if row else None


def get_task_by_content(content_hash: str, target_lang: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM tasks WHERE content_hash = ? AND target_lang = ? LIMIT 1",
            (content_hash, target_lang),
        ).fetchone()
    return dict(row) if row else None


def set_content_hash(task_id: str, content_hash: str) -> bool:
    """Backfill a legacy task hash; keep the first task if duplicates already exist."""
    try:
        with _connect() as conn:
            conn.execute(
                "UPDATE tasks SET content_hash = ? WHERE task_id = ? AND content_hash IS NULL",
                (content_hash, task_id),
            )
        return True
    except sqlite3.IntegrityError:
        return False


def update_task(task_id: str, **changes: Any) -> dict[str, Any] | None:
    allowed = {"status", "stage", "current", "total", "message", "error", "cancel_requested"}
    values = {key: value for key, value in changes.items() if key in allowed}
    if not values:
        return get_task(task_id)
    values["updated_at"] = _now()
    assignments = ", ".join(f"{key} = ?" for key in values)
    with _connect() as conn:
        conn.execute(
            f"UPDATE tasks SET {assignments} WHERE task_id = ?",
            (*values.values(), task_id),
        )
    return get_task(task_id)


def list_tasks(
    search: str = "", limit: int = 20, offset: int = 0, *, exclude_completed: bool = False,
) -> tuple[list[dict], int]:
    conditions: list[str] = []
    params_list: list[Any] = []
    if search:
        conditions.append("filename LIKE ?")
        params_list.append(f"%{search}%")
    if exclude_completed:
        conditions.append("status != 'completed'")
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    params = tuple(params_list)
    with _connect() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM tasks {where}", params).fetchone()[0]
        rows = conn.execute(
            f"SELECT * FROM tasks {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
    return [dict(row) for row in rows], total


def recover_tasks() -> list[str]:
    with _connect() as conn:
        rows = conn.execute(
            f"SELECT task_id FROM tasks WHERE status IN ({','.join('?' for _ in ACTIVE_STATUSES)})",
            ACTIVE_STATUSES,
        ).fetchall()
        ids = [row[0] for row in rows]
        if ids:
            conn.executemany(
                """UPDATE tasks SET status='queued', stage='queued', message='服务重启，等待恢复',
                error=NULL, cancel_requested=0, updated_at=? WHERE task_id=?""",
                [(_now(), task_id) for task_id in ids],
            )
    return ids


def save_chunk(task_id: str, index: int, text: str) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO task_chunks(task_id, chunk_index, translated_text) VALUES (?, ?, ?)",
            (task_id, index, text),
        )


def load_chunks(task_id: str) -> dict[int, str]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT chunk_index, translated_text FROM task_chunks WHERE task_id=? ORDER BY chunk_index",
            (task_id,),
        ).fetchall()
    return {row[0]: row[1] for row in rows}


def clear_chunks(task_id: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM task_chunks WHERE task_id=?", (task_id,))


def request_cancel(task_id: str) -> dict[str, Any] | None:
    task = get_task(task_id)
    if not task or task["status"] in TERMINAL_STATUSES:
        return task
    return update_task(task_id, cancel_requested=1, message="正在取消")


def retry_task(task_id: str) -> dict[str, Any] | None:
    task = get_task(task_id)
    if not task or task["status"] not in ("failed", "cancelled", "interrupted"):
        return None
    return update_task(
        task_id, status="queued", stage="queued", message="等待重试",
        error=None, cancel_requested=0,
    )


def delete_task(task_id: str) -> bool:
    with _connect() as conn:
        cursor = conn.execute("DELETE FROM tasks WHERE task_id = ?", (task_id,))
    return cursor.rowcount > 0


def task_json(task: dict[str, Any]) -> str:
    return json.dumps(task, ensure_ascii=False)
