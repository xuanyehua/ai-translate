"""Persistent single-worker document processing queue."""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from app.parser import parse_document
from app.rag import build_chunk_store
from app.storage import (
    load_original,
    save_images,
    save_translation,
    task_dir,
    update_embedding_status,
)
from app.task_store import get_task, load_chunks, save_chunk, update_task
from app.translator import _build_chunks, get_translator

logger = logging.getLogger(__name__)


class TaskManager:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[str] = asyncio.Queue()
        self.worker: asyncio.Task | None = None

    async def start(self, recovered_ids: list[str]) -> None:
        self.worker = asyncio.create_task(self._worker_loop(), name="translation-worker")
        for task_id in recovered_ids:
            await self.enqueue(task_id)

    async def stop(self) -> None:
        if self.worker:
            self.worker.cancel()
            try:
                await self.worker
            except asyncio.CancelledError:
                pass
            self.worker = None

    async def enqueue(self, task_id: str) -> None:
        await self.queue.put(task_id)

    async def _worker_loop(self) -> None:
        while True:
            task_id = await self.queue.get()
            try:
                await self._run(task_id)
            except asyncio.CancelledError:
                update_task(task_id, status="interrupted", stage="interrupted", message="服务停止，任务已中断")
                raise
            except Exception as exc:
                logger.exception("Task %s failed", task_id)
                update_task(task_id, status="failed", stage="failed", message="任务失败", error=str(exc))
            finally:
                self.queue.task_done()

    @staticmethod
    def _cancelled(task_id: str) -> bool:
        task = get_task(task_id)
        if task and task["cancel_requested"]:
            update_task(task_id, status="cancelled", stage="cancelled", message="任务已取消")
            return True
        return False

    async def _run(self, task_id: str) -> None:
        task = get_task(task_id)
        if not task or task["status"] != "queued" or self._cancelled(task_id):
            return

        directory = task_dir(task_id)
        source_path = directory / f"source{task['ext']}"
        original_md = load_original(task_id)
        images: dict[str, str] = {}

        if original_md is None:
            update_task(task_id, status="parsing", stage="parsing", current=0, total=0, message="正在解析文档")
            original_md, doc_ext, images = await asyncio.to_thread(parse_document, source_path)
            if not await asyncio.to_thread(save_images, task_id, images):
                raise RuntimeError("保存解析图片失败")
            (directory / "original.md").write_text(original_md, encoding="utf-8")
            if doc_ext != task["ext"].lstrip("."):
                task["ext"] = "." + doc_ext
        if self._cancelled(task_id):
            return

        source_chunks = _build_chunks(original_md)
        completed = load_chunks(task_id)
        update_task(
            task_id, status="translating", stage="translating", current=len(completed),
            total=len(source_chunks), message=f"正在翻译 {len(completed)}/{len(source_chunks)} 段",
        )
        translator = get_translator()
        for index, chunk in enumerate(source_chunks):
            if index in completed:
                continue
            if self._cancelled(task_id):
                return
            translated = await asyncio.to_thread(translator.translate, chunk, task["target_lang"])
            save_chunk(task_id, index, translated)
            completed[index] = translated
            update_task(
                task_id, current=len(completed), total=len(source_chunks),
                message=f"正在翻译 {len(completed)}/{len(source_chunks)} 段",
            )

        translated_md = "\n\n".join(completed[index] for index in range(len(source_chunks)))
        update_task(task_id, status="saving", stage="saving", message="正在保存翻译结果")
        saved = await asyncio.to_thread(
            save_translation, task_id, task["filename"], task["ext"].lstrip("."),
            task["target_lang"], original_md, translated_md, images,
        )
        if not saved:
            raise RuntimeError("保存翻译结果失败")
        if self._cancelled(task_id):
            return

        update_task(task_id, status="indexing", stage="indexing", message="正在构建文档索引")
        update_embedding_status(task_id, "building")
        try:
            store = await asyncio.to_thread(build_chunk_store, translated_md, directory / "rag")
            update_embedding_status(task_id, "ready" if store else "failed", None if store else "build returned None")
        except Exception as exc:
            logger.exception("RAG build failed for task %s", task_id)
            update_embedding_status(task_id, "failed", str(exc))

        update_task(
            task_id, status="completed", stage="completed", current=len(source_chunks),
            total=len(source_chunks), message="翻译完成", error=None,
        )


task_manager = TaskManager()
