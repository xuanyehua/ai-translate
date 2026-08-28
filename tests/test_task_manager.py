import asyncio
from pathlib import Path

import pytest

from app import storage, task_manager, task_store


class FakeTranslator:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def translate(self, text: str, target_lang: str) -> str:
        self.calls.append(text)
        return f"translated:{text}"


@pytest.fixture
def task_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    translations = tmp_path / "translations"
    monkeypatch.setattr(task_store, "DB_PATH", tmp_path / "tasks.sqlite3")
    monkeypatch.setattr(storage, "BASE_DIR", translations)
    monkeypatch.setattr(task_manager, "update_embedding_status", lambda *args, **kwargs: True)
    monkeypatch.setattr(task_manager, "build_chunk_store", lambda *args, **kwargs: object())
    task_store.init_db()
    return translations


def create_source(task_id: str, content: str) -> None:
    directory = storage.task_dir(task_id)
    directory.mkdir(parents=True)
    (directory / "source.md").write_text(content, encoding="utf-8")


def test_manager_processes_markdown_to_completion(task_environment, monkeypatch):
    translator = FakeTranslator()
    monkeypatch.setattr(task_manager, "get_translator", lambda: translator)
    task_store.create_task("task1", "sample.md", ".md", "中文")
    create_source("task1", "Hello")

    asyncio.run(task_manager.TaskManager()._run("task1"))

    task = task_store.get_task("task1")
    assert task is not None
    assert task["status"] == "completed"
    assert storage.load_original("task1") == "Hello"
    assert storage.load_translated("task1") == "translated:Hello"


def test_manager_resumes_after_completed_chunk(task_environment, monkeypatch):
    translator = FakeTranslator()
    monkeypatch.setattr(task_manager, "get_translator", lambda: translator)
    monkeypatch.setattr(task_manager, "_build_chunks", lambda markdown: ["first", "second"])
    task_store.create_task("task1", "sample.md", ".md", "中文")
    create_source("task1", "first\n\nsecond")
    directory = storage.task_dir("task1")
    (directory / "original.md").write_text("first\n\nsecond", encoding="utf-8")
    task_store.save_chunk("task1", 0, "already translated")

    asyncio.run(task_manager.TaskManager()._run("task1"))

    assert translator.calls == ["second"]
    assert storage.load_translated("task1") == "already translated\n\ntranslated:second"


def test_manager_honors_cancel_before_work(task_environment, monkeypatch):
    translator = FakeTranslator()
    monkeypatch.setattr(task_manager, "get_translator", lambda: translator)
    task_store.create_task("task1", "sample.md", ".md", "中文")
    create_source("task1", "Hello")
    task_store.request_cancel("task1")

    asyncio.run(task_manager.TaskManager()._run("task1"))

    assert task_store.get_task("task1")["status"] == "cancelled"
    assert translator.calls == []
