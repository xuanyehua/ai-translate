"""RAG engine: chunk translated Markdown, build FAISS index, search and answer."""
import json
import logging
from pathlib import Path
from typing import Optional

import numpy as np

from app.config import config

logger = logging.getLogger(__name__)

# Lazy-loaded singletons
_embed_model = None
_embedding_dim: Optional[int] = None


def _get_embed_model():
    """Lazy-load the embedding model based on config."""
    global _embed_model, _embedding_dim

    if _embed_model is not None:
        return _embed_model

    provider = config.embedding_provider
    model_name = config.embedding_model

    if provider == "local":
        from sentence_transformers import SentenceTransformer
        logger.info(f"Loading local embedding model: {model_name}")
        _embed_model = SentenceTransformer(model_name)
        _embedding_dim = _embed_model.get_sentence_embedding_dimension()
    elif provider == "openai":
        from openai import OpenAI
        kwargs: dict = {}
        if config.translator_base_url:
            kwargs["base_url"] = config.translator_base_url
        if config.translator_api_key:
            kwargs["api_key"] = config.translator_api_key
        _embed_model = OpenAI(**kwargs)
        _embedding_dim = {
            "text-embedding-3-small": 1536,
            "text-embedding-3-large": 3072,
            "text-embedding-ada-002": 1536,
        }.get(model_name, 1536)
    else:
        raise ValueError(f"Unknown embedding provider: {provider}")

    return _embed_model


def _embed(texts: list[str]) -> np.ndarray:
    """Convert list of texts to embedding vectors (float32 numpy array)."""
    model = _get_embed_model()

    if config.embedding_provider == "local":
        return model.encode(texts, convert_to_numpy=True, show_progress_bar=False)

    # OpenAI embedding API
    resp = model.embeddings.create(model=config.embedding_model, input=texts)
    vectors = [d.embedding for d in resp.data]
    return np.array(vectors, dtype=np.float32)


def chunk_document(markdown: str, max_chars: int = 500) -> list[str]:
    """Split translated Markdown into chunks by ## headings, each ≤ max_chars."""
    import re

    sections = re.split(r"\n(?=#{2,6}\s)", markdown)
    chunks: list[str] = []

    for section in sections:
        section = section.strip()
        if not section:
            continue

        if len(section) <= max_chars:
            chunks.append(section)
            continue

        heading_match = re.match(r"^(#{2,6}\s.+)", section)
        heading = heading_match.group(1) if heading_match else ""
        body = section[heading_match.end():].strip() if heading_match else section

        paragraphs = body.split("\n\n")
        current = heading
        for para in paragraphs:
            para = para.strip()
            if not para:
                continue
            if len(current) + len(para) + 2 <= max_chars:
                current += "\n\n" + para if current else para
            else:
                if current.strip():
                    chunks.append(current.strip())
                current = heading + "\n\n" + para if heading else para
        if current.strip():
            chunks.append(current.strip())

    return [c for c in chunks if len(c.strip()) > 10]


class ChunkStore:
    """Holds chunks and their FAISS index for a single document."""

    def __init__(self, chunks: list[str], vectors_or_index, dim: Optional[int] = None):
        """Construct from vectors (build index) or from a pre-loaded faiss.Index.

        - If vectors_or_index is a numpy array: build a new IndexFlatL2.
        - If it's a faiss.Index: use directly (load path).
        """
        import faiss
        self.chunks = chunks
        if isinstance(vectors_or_index, np.ndarray):
            d = vectors_or_index.shape[1]
            self.index = faiss.IndexFlatL2(d)
            self.index.add(vectors_or_index.astype(np.float32))
            self.dim = d
        else:
            self.index = vectors_or_index
            self.dim = dim or self.index.d

    def search(self, query: str, top_k: int = 5) -> list[str]:
        """Search for the most relevant chunks to the query."""
        q_vec = _embed([query]).astype(np.float32)
        distances, indices = self.index.search(q_vec, min(top_k, len(self.chunks)))
        results: list[str] = []
        for i in indices[0]:
            if 0 <= i < len(self.chunks):
                results.append(self.chunks[i])
        return results

    def save(self, rag_dir: Path) -> None:
        """Persist chunks + FAISS index + metadata to rag_dir."""
        import faiss
        rag_dir.mkdir(parents=True, exist_ok=True)
        with open(rag_dir / "chunks.json", "w", encoding="utf-8") as f:
            json.dump(self.chunks, f, ensure_ascii=False, indent=2)
        faiss.write_index(self.index, str(rag_dir / "index.faiss"))
        meta = {
            "model": config.embedding_model,
            "provider": config.embedding_provider,
            "dim": self.dim,
            "chunk_count": len(self.chunks),
        }
        with open(rag_dir / "meta.json", "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

    @classmethod
    def load(cls, rag_dir: Path) -> Optional["ChunkStore"]:
        """Load from disk. Returns None if missing or model/provider mismatched."""
        import faiss
        meta_path = rag_dir / "meta.json"
        chunks_path = rag_dir / "chunks.json"
        index_path = rag_dir / "index.faiss"

        if not (meta_path.exists() and chunks_path.exists() and index_path.exists()):
            return None

        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            # Validate model/provider
            if meta.get("model") != config.embedding_model:
                logger.warning(
                    f"Embedding model changed: stored={meta.get('model')} "
                    f"vs current={config.embedding_model}, index needs rebuild"
                )
                return None
            if meta.get("provider") != config.embedding_provider:
                logger.warning(
                    f"Embedding provider changed: stored={meta.get('provider')} "
                    f"vs current={config.embedding_provider}, index needs rebuild"
                )
                return None

            with open(chunks_path, "r", encoding="utf-8") as f:
                chunks = json.load(f)
            index = faiss.read_index(str(index_path))
            return cls(chunks, index, dim=meta.get("dim"))
        except Exception:
            logger.exception(f"Failed to load ChunkStore from {rag_dir}")
            return None


def build_chunk_store(markdown: str, rag_dir: Optional[Path] = None) -> Optional[ChunkStore]:
    """Build a ChunkStore from translated Markdown.

    If rag_dir is provided, persist the store to disk after building.
    Returns None on failure.
    """
    try:
        chunks = chunk_document(markdown)
        if not chunks:
            logger.warning("No chunks generated from document")
            return None

        vectors = _embed(chunks)
        store = ChunkStore(chunks, vectors)

        if rag_dir is not None:
            try:
                store.save(rag_dir)
            except Exception:
                logger.exception(f"Failed to save ChunkStore to {rag_dir}")
                # Still return store; caller decides what to do

        return store
    except Exception:
        logger.exception("Failed to build RAG index")
        return None


async def generate_answer_stream(
    store: ChunkStore,
    question: str,
    history: Optional[list[dict]] = None,
):
    """SSE async generator: search chunks, build prompt with history, stream LLM answer.

    history: list of {"role", "content"} dicts (recent turns).
    Yields (event_type, data_dict) tuples.
    """
    import asyncio
    from app.translator import get_translator

    yield "thinking", {"message": "正在检索相关内容..."}

    loop = asyncio.get_running_loop()
    relevant_chunks = await loop.run_in_executor(
        None, store.search, question, 5
    )

    if not relevant_chunks:
        yield "done", {"message": "未找到相关信息，请尝试换个问法"}
        return

    context = "\n\n---\n\n".join(relevant_chunks)
    user_prompt = f"""文档片段：
{context}

当前问题：{question}"""

    # Build messages: system + history + current question with retrieval
    messages: list[dict] = [
        {
            "role": "system",
            "content": (
                "你是一个专业、友好的文档助手。基于提供的文档片段和对话上下文，用中文回答用户问题。"
                "如果文档片段中没有相关信息，请如实告知用户。"
            ),
        },
    ]

    # Append cleaned history (only role + content, drop ts)
    if history:
        for msg in history:
            role = msg.get("role")
            content = msg.get("content", "")
            if role in ("user", "assistant") and content:
                messages.append({"role": role, "content": content})

    messages.append({"role": "user", "content": user_prompt})

    translator = get_translator()
    try:
        resp = await loop.run_in_executor(
            None,
            lambda: translator.client.chat.completions.create(
                model=translator.model,
                messages=messages,
                temperature=0.5,
                stream=True,
            ),
        )

        for chunk in resp:
            delta = chunk.choices[0].delta.content if chunk.choices else ""
            if delta:
                yield "chunk", {"text": delta}

        yield "done", {}
    except Exception as e:
        logger.exception("LLM chat failed")
        yield "error", {"message": f"回答生成失败: {e}"}
