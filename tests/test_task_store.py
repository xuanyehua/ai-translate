from pathlib import Path
import sqlite3

import pytest

from app import task_store


@pytest.fixture(autouse=True)
def temporary_database(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(task_store, "DB_PATH", tmp_path / "tasks.sqlite3")
    task_store.init_db()


def test_task_lifecycle_and_chunks():
    created = task_store.create_task("task1", "paper.pdf", ".pdf", "中文")
    assert created["status"] == "queued"

    task_store.update_task("task1", status="translating", stage="translating", current=1, total=2)
    task_store.save_chunk("task1", 0, "第一段")
    assert task_store.load_chunks("task1") == {0: "第一段"}

    current = task_store.get_task("task1")
    assert current is not None
    assert current["current"] == 1
    assert current["total"] == 2


def test_recover_requeues_non_terminal_tasks():
    task_store.create_task("queued", "a.md", ".md", "中文")
    task_store.create_task("running", "b.md", ".md", "中文")
    task_store.create_task("done", "c.md", ".md", "中文")
    task_store.update_task("running", status="translating", stage="translating")
    task_store.update_task("done", status="completed", stage="completed")

    recovered = set(task_store.recover_tasks())
    assert recovered == {"queued", "running"}
    assert task_store.get_task("running")["status"] == "queued"
    assert task_store.get_task("done")["status"] == "completed"


def test_cancel_and_retry():
    task_store.create_task("task1", "paper.pdf", ".pdf", "中文")
    cancelled = task_store.request_cancel("task1")
    assert cancelled is not None
    assert cancelled["cancel_requested"] == 1

    task_store.update_task("task1", status="cancelled", stage="cancelled")
    retried = task_store.retry_task("task1")
    assert retried is not None
    assert retried["status"] == "queued"
    assert retried["cancel_requested"] == 0


def test_import_completed_task_is_idempotent():
    meta = {
        "task_id": "legacy",
        "filename": "legacy.pdf",
        "ext": "pdf",
        "target_lang": "中文",
        "created_at": "2026-01-01T00:00:00+00:00",
    }
    task_store.import_completed_task(meta)
    task_store.import_completed_task(meta)
    tasks, total = task_store.list_tasks()
    assert total == 1
    assert tasks[0]["status"] == "completed"


def test_list_tasks_can_exclude_completed():
    task_store.create_task("active", "active.md", ".md", "中文")
    task_store.create_task("failed", "failed.md", ".md", "中文")
    task_store.create_task("done", "done.md", ".md", "中文")
    task_store.update_task("failed", status="failed", stage="failed")
    task_store.update_task("done", status="completed", stage="completed")

    tasks, total = task_store.list_tasks(exclude_completed=True)

    assert total == 2
    assert {task["task_id"] for task in tasks} == {"active", "failed"}


def test_content_hash_is_unique_per_target_language():
    task_store.create_task("zh", "first.pdf", ".pdf", "中文", "same-hash")
    task_store.create_task("en", "first.pdf", ".pdf", "English", "same-hash")

    existing = task_store.get_task_by_content("same-hash", "中文")

    assert existing is not None
    assert existing["task_id"] == "zh"
    with pytest.raises(sqlite3.IntegrityError):
        task_store.create_task("duplicate", "renamed.pdf", ".pdf", "中文", "same-hash")


def test_legacy_content_hash_backfill_keeps_first_duplicate():
    task_store.create_task("first", "first.pdf", ".pdf", "中文")
    task_store.create_task("second", "second.pdf", ".pdf", "中文")

    assert task_store.set_content_hash("first", "same-hash") is True
    assert task_store.set_content_hash("second", "same-hash") is False
    assert task_store.get_task_by_content("same-hash", "中文")["task_id"] == "first"


def test_delete_task_cascades_chunks():
    task_store.create_task("delete-me", "file.md", ".md", "中文")
    task_store.save_chunk("delete-me", 0, "translated")

    assert task_store.delete_task("delete-me") is True
    assert task_store.get_task("delete-me") is None
    assert task_store.load_chunks("delete-me") == {}
