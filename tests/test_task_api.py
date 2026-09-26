from pathlib import Path

from fastapi.testclient import TestClient

from app import main


def test_submit_task_returns_immediately(tmp_path: Path, monkeypatch):
    task_root = tmp_path / "task"
    enqueued: list[str] = []

    monkeypatch.setattr(main, "task_dir", lambda task_id: task_root)
    monkeypatch.setattr(main, "get_task_by_content", lambda content_hash, target_lang: None)
    monkeypatch.setattr(
        main,
        "create_task",
        lambda task_id, filename, ext, target_lang, content_hash: {
            "task_id": task_id,
            "filename": filename,
            "ext": ext,
            "target_lang": target_lang,
            "status": "queued",
            "content_hash": content_hash,
        },
    )

    async def fake_enqueue(task_id: str) -> None:
        enqueued.append(task_id)

    monkeypatch.setattr(main.task_manager, "enqueue", fake_enqueue)
    client = TestClient(main.app)
    response = client.post(
        "/api/tasks",
        files={"file": ("sample.md", b"Hello", "text/markdown")},
        data={"target_lang": "中文"},
    )

    assert response.status_code == 202
    task_id = response.json()["task_id"]
    assert enqueued == [task_id]
    assert (task_root / "source.md").read_bytes() == b"Hello"
    assert response.json()["duplicate"] is False


def test_unknown_api_returns_404():
    client = TestClient(main.app)
    response = client.get("/api/not-found")
    assert response.status_code == 404


def test_chat_rejects_invalid_quote_source(monkeypatch):
    monkeypatch.setattr(main, "load_meta", lambda task_id: {"embedding_status": "ready"})
    client = TestClient(main.app)

    response = client.post(
        "/api/translate/task-1/chat",
        data={"question": "解释一下", "quote": "引用内容", "quote_source": "unknown"},
    )

    assert response.status_code == 400


def test_chat_rejects_quote_over_limit(monkeypatch):
    monkeypatch.setattr(main, "load_meta", lambda task_id: {"embedding_status": "ready"})
    client = TestClient(main.app)

    response = client.post(
        "/api/translate/task-1/chat",
        data={"question": "解释一下", "quote": "a" * 4001, "quote_source": "original"},
    )

    assert response.status_code == 400


def test_chat_persists_and_passes_quote(monkeypatch):
    captured: dict[str, object] = {}
    main._rag_stores["task-quote"] = object()
    monkeypatch.setattr(main, "load_meta", lambda task_id: {"embedding_status": "ready"})
    monkeypatch.setattr(main, "load_chat_history", lambda task_id, limit=None: [])

    def fake_append(task_id, role, content, **metadata):
        if role == "user":
            captured["persisted"] = (task_id, content, metadata)
        return True

    async def fake_stream(store, question, history=None, quote=None, quote_source=None):
        captured["prompt"] = (question, quote, quote_source)
        yield "chunk", {"text": "回答"}
        yield "done", {}

    monkeypatch.setattr(main, "append_chat_message", fake_append)
    monkeypatch.setattr(main, "generate_answer_stream", fake_stream)
    client = TestClient(main.app)

    response = client.post(
        "/api/translate/task-quote/chat",
        data={"question": "解释一下", "quote": "引用内容", "quote_source": "translated"},
    )

    assert response.status_code == 200
    assert captured["persisted"] == (
        "task-quote",
        "解释一下",
        {"quote": "引用内容", "quote_source": "translated"},
    )
    assert captured["prompt"] == ("解释一下", "引用内容", "translated")
    main._rag_stores.pop("task-quote", None)


def test_worklist_scope_excludes_completed(monkeypatch):
    captured: dict[str, bool] = {}

    def fake_list_tasks(search, limit, offset, *, exclude_completed=False):
        captured["exclude_completed"] = exclude_completed
        return [], 0

    monkeypatch.setattr(main, "list_tasks", fake_list_tasks)
    client = TestClient(main.app)

    response = client.get("/api/tasks?scope=worklist")

    assert response.status_code == 200
    assert response.json() == {"items": [], "total": 0}
    assert captured["exclude_completed"] is True


def test_tasks_rejects_unknown_scope():
    client = TestClient(main.app)
    response = client.get("/api/tasks?scope=unknown")
    assert response.status_code == 400


def test_alignment_uses_exact_saved_sources(monkeypatch):
    monkeypatch.setattr(main, "_build_chunks", lambda original: ["first", "second"])
    task = {"original": "document", "total": 2}
    records = [
        {"chunk_index": 0, "source_text": "first", "translated_text": "一"},
        {"chunk_index": 1, "source_text": "second", "translated_text": "二"},
    ]

    alignment = main._task_alignment(task, records)

    assert alignment["mode"] == "exact"
    assert alignment["chunks"][1] == {
        "index": 1, "original": "second", "translated": "二",
    }


def test_alignment_reconstructs_legacy_chunks(monkeypatch):
    monkeypatch.setattr(main, "_build_chunks", lambda original: ["first", "second"])
    task = {"original": "document", "total": 2}
    records = [
        {"chunk_index": 0, "source_text": None, "translated_text": "一"},
        {"chunk_index": 1, "source_text": None, "translated_text": "二"},
    ]

    alignment = main._task_alignment(task, records)

    assert alignment["mode"] == "reconstructed"


def test_alignment_falls_back_for_inconsistent_history(monkeypatch):
    monkeypatch.setattr(main, "_build_chunks", lambda original: ["first", "second"])
    task = {"original": "document", "total": 2}
    records = [{"chunk_index": 1, "source_text": None, "translated_text": "二"}]

    assert main._task_alignment(task, records) == {"mode": "fallback"}


def test_delete_rejects_active_task(monkeypatch):
    monkeypatch.setattr(main, "get_task", lambda task_id: {"task_id": task_id, "status": "translating"})
    client = TestClient(main.app)

    response = client.delete("/api/tasks/active")

    assert response.status_code == 409


def test_delete_terminal_task_removes_files_and_record(tmp_path, monkeypatch):
    directory = tmp_path / "finished"
    directory.mkdir()
    (directory / "translated.md").write_text("done")
    deleted: list[str] = []
    monkeypatch.setattr(main, "get_task", lambda task_id: {"task_id": task_id, "status": "completed"})
    monkeypatch.setattr(main, "task_dir", lambda task_id: directory)
    monkeypatch.setattr(main, "delete_task", lambda task_id: deleted.append(task_id) or True)
    client = TestClient(main.app)

    response = client.delete("/api/tasks/finished")

    assert response.status_code == 204
    assert not directory.exists()
    assert deleted == ["finished"]
