import httpx
from pathlib import Path

from app.mineru_service import get_base_url


def parse_document(file_path: Path) -> tuple[str, str, dict[str, str]]:
    """
    Use local MinerU API to parse document to Markdown.
    Returns (markdown_content, original_extension, images_dict).
    images_dict maps filename -> data:image/...;base64,...
    """
    ext = file_path.suffix.lower().lstrip(".")

    if ext == "md":
        return file_path.read_text(encoding="utf-8"), ext, {}

    base_url = get_base_url()

    with open(file_path, "rb") as f:
        files = {"files": (file_path.name, f, "application/octet-stream")}
        data = {
            "lang_list": ["ch"],
            "backend": "pipeline",
            "parse_method": "auto",
            "formula_enable": "true",
            "table_enable": "true",
            "return_md": "true",
            "return_middle_json": "false",
            "return_model_output": "false",
            "return_content_list": "false",
            "return_images": "false",
            "response_format_zip": "false",
            "return_original_file": "false",
            "start_page_id": "0",
            "end_page_id": "99999",
        }
        resp = httpx.post(
            f"{base_url}/file_parse",
            files=files,
            data=data,
            timeout=300,
        )
        resp.raise_for_status()
        result = resp.json()

    results = result.get("results", {})
    if not results:
        raise ValueError("MinerU returned no results")

    first_result = next(iter(results.values()))
    markdown = first_result.get("md_content", "")
    if not markdown:
        raise ValueError("MinerU returned no markdown content")

    images = first_result.get("images", {})

    return markdown, ext, images
