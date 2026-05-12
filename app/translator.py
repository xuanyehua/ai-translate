import asyncio
from abc import ABC, abstractmethod

from openai import OpenAI

from app.config import config

SYSTEM_PROMPT = """你是一个专业的翻译助手。请将用户提供的文本翻译为目标语言。
要求：
1. 保留所有 Markdown 标记（标题、列表、代码块、链接、加粗、斜体等）
2. 只翻译文本内容，不要翻译标记
3. 保持段落结构不变
4. 直接输出翻译结果，不要添加额外说明"""


class Translator(ABC):
    @abstractmethod
    def translate(self, text: str, target_lang: str) -> str: ...


class OpenAITranslator(Translator):
    def __init__(self):
        kwargs: dict = {}
        if config.translator_base_url:
            kwargs["base_url"] = config.translator_base_url
        if config.translator_api_key:
            kwargs["api_key"] = config.translator_api_key
        self.client = OpenAI(**kwargs)
        self.model = config.translator_model

    def translate(self, text: str, target_lang: str) -> str:
        resp = self.client.chat.completions.create(
            model=self.model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"请将以下文本翻译为{target_lang}：\n\n{text}"},
            ],
            temperature=0.3,
        )
        return resp.choices[0].message.content or ""


def get_translator() -> Translator:
    t = config.translator_type
    if t == "openai":
        return OpenAITranslator()
    raise ValueError(f"Unknown translator type: {t}")


def _build_chunks(markdown: str) -> list[str]:
    """Split markdown into paragraph-based chunks that fit within chunk_size."""
    paragraphs = markdown.split("\n\n")
    chunk_size = config.chunk_size

    groups: list[list[str]] = [[]]
    current_len = 0
    for p in paragraphs:
        if current_len + len(p) > chunk_size and groups[-1]:
            groups.append([])
            current_len = 0
        groups[-1].append(p)
        current_len += len(p)

    return ["\n\n".join(g) for g in groups if any(p.strip() for p in g)]


def translate_document(markdown: str, target_lang: str) -> str:
    """将 Markdown 文本分块翻译并拼接。"""
    translator = get_translator()
    chunks = _build_chunks(markdown)
    translated_parts = [translator.translate(chunk, target_lang) for chunk in chunks]
    return "\n\n".join(translated_parts)


async def translate_document_stream(markdown: str, target_lang: str):
    """
    Async generator that yields (index, translated_text, total_chunks)
    for each translated chunk. First yield is (-1, '', total_chunks) to signal start.
    """
    translator = get_translator()
    chunks = _build_chunks(markdown)
    loop = asyncio.get_running_loop()

    yield -1, "", len(chunks)

    for i, chunk in enumerate(chunks):
        if chunk.strip():
            translated = await loop.run_in_executor(
                None, translator.translate, chunk, target_lang
            )
        else:
            translated = chunk
        yield i, translated, len(chunks)
