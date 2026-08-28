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
