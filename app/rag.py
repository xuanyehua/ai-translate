"""RAG engine: chunk translated Markdown, build FAISS index, search and answer."""
import logging
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

    # Split on ## headings (h2+)
    sections = re.split(r"\n(?=#{2,6}\s)", markdown)
    chunks: list[str] = []

    for section in sections:
        section = section.strip()
        if not section:
            continue

        # If section is short enough, keep as-is
        if len(section) <= max_chars:
            chunks.append(section)
            continue

        # Split long sections by paragraphs
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

    def __init__(self, chunks: list[str], vectors: np.ndarray):
        import faiss
        self.chunks = chunks
        dim = vectors.shape[1]
        self.index = faiss.IndexFlatL2(dim)
        self.index.add(vectors.astype(np.float32))

    def search(self, query: str, top_k: int = 5) -> list[str]:
        """Search for the most relevant chunks to the query."""
        q_vec = _embed([query]).astype(np.float32)
        distances, indices = self.index.search(q_vec, min(top_k, len(self.chunks)))
        results: list[str] = []
        for i in indices[0]:
            if 0 <= i < len(self.chunks):
                results.append(self.chunks[i])
        return results


def build_chunk_store(markdown: str) -> Optional[ChunkStore]:
    """Build a ChunkStore from translated Markdown. Returns None on failure."""
    try:
        chunks = chunk_document(markdown)
        if not chunks:
            logger.warning("No chunks generated from document")
            return None

        vectors = _embed(chunks)
        return ChunkStore(chunks, vectors)
    except Exception:
        logger.exception("Failed to build RAG index")
        return None


async def generate_answer_stream(store: ChunkStore, question: str):
    """SSE async generator: search chunks, build prompt, stream LLM answer.

    Yields (event_type, data_dict) tuples.
    """
    import asyncio
    from app.translator import get_translator

    # 1. Search for relevant chunks
    yield "thinking", {"message": "正在检索相关内容..."}

    loop = asyncio.get_running_loop()
    relevant_chunks = await loop.run_in_executor(
        None, store.search, question, 5
    )

    if not relevant_chunks:
        yield "done", {"message": "未找到相关信息，请尝试换个问法"}
        return

    # 2. Build prompt
    context = "\n\n---\n\n".join(relevant_chunks)
    prompt = f"""你是一个文档助手，基于以下文档片段回答问题。如果文档片段中没有相关信息，请如实告知用户。

文档片段：
{context}

用户问题：{question}

回答："""

    # 3. Stream LLM answer
    translator = get_translator()
    try:
        resp = await loop.run_in_executor(
            None,
            lambda: translator.client.chat.completions.create(
                model=translator.model,
                messages=[
                    {"role": "system", "content": "你是一个专业、友好的文档助手。请用中文回答。"},
                    {"role": "user", "content": prompt},
                ],
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
