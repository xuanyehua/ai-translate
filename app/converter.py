import io
import re
from pathlib import Path

import mistune


def _parse_md_blocks(markdown: str) -> list[dict]:
    """将 Markdown 按段落拆分为带类型的 block 列表。"""
    blocks = markdown.split("\n\n")
    result = []
    for b in blocks:
        b = b.strip()
        if not b:
            continue
        if b.startswith("#"):
            result.append({"type": "heading", "text": b})
        elif b.startswith("- ") or b.startswith("* "):
            result.append({"type": "list", "text": b})
        elif b.startswith("```"):
            result.append({"type": "code", "text": b})
        elif b.startswith(">"):
            result.append({"type": "quote", "text": b})
        elif re.match(r"!\[.*\]\(.*\)", b):
            result.append({"type": "image", "text": b})
        else:
            result.append({"type": "paragraph", "text": b})
    return result


def convert_to_docx(markdown: str) -> bytes:
    """将翻译后的 Markdown 转为 .docx 文件字节流。"""
    from docx import Document
    from docx.shared import Pt

    doc = Document()
    blocks = _parse_md_blocks(markdown)
    for block in blocks:
        text = re.sub(r"[#*>`\-\[\]!()]", "", block["text"]).strip()
        if not text:
            continue
        if block["type"] == "heading":
            level = len(block["text"]) - len(block["text"].lstrip("#"))
            doc.add_heading(text, level=min(level, 3))
        elif block["type"] in ("list",):
            p = doc.add_paragraph(text, style="List Bullet")
        elif block["type"] == "code":
            p = doc.add_paragraph()
            run = p.add_run(text)
            run.font.name = "Courier New"
            run.font.size = Pt(9)
        else:
            doc.add_paragraph(text)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def convert_to_pdf(markdown: str) -> bytes:
    """将翻译后的 Markdown 转为 .pdf 文件字节流（基础版本）。"""
    from fpdf import FPDF

    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", size=12)

    blocks = _parse_md_blocks(markdown)
    for block in blocks:
        text = re.sub(r"[#*>`\-\[\]!()]", "", block["text"]).strip()
        if not text:
            continue
        if block["type"] == "heading":
            level = len(block["text"]) - len(block["text"].lstrip("#"))
            pdf.set_font("Helvetica", style="B", size=18 - level * 2)
            pdf.multi_cell(0, 10, text)
            pdf.ln(2)
        else:
            pdf.set_font("Helvetica", size=12)
            pdf.multi_cell(0, 7, text)
            pdf.ln(2)

    return pdf.output()


def convert(markdown: str, ext: str) -> tuple[bytes, str]:
    """
    将翻译后的 Markdown 转为原文档格式。
    返回 (文件字节流, MIME type)。
    """
    if ext == "md":
        return markdown.encode("utf-8"), "text/markdown"
    elif ext == "docx":
        return convert_to_docx(markdown), "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    elif ext == "pdf":
        return convert_to_pdf(markdown), "application/pdf"
    else:
        return markdown.encode("utf-8"), "text/markdown"
