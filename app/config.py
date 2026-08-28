import os
from pathlib import Path

import yaml
from dotenv import load_dotenv

load_dotenv()

DEFAULT_CONFIG_PATH = Path(__file__).parent.parent / "config.yaml"


class Config:
    def __init__(self, config_path: Path | None = None):
        path = config_path or DEFAULT_CONFIG_PATH
        self._data = {}
        if path.exists():
            with open(path) as f:
                self._data = yaml.safe_load(f) or {}

    @property
    def mineru_api_url(self) -> str:
        return self._data.get("mineru_api_url", os.getenv("MINERU_API_URL", "http://127.0.0.1:3000"))

    @property
    def mineru_backend(self) -> str:
        # MinerU 解析后端：pipeline（传统流水线，CPU 友好）、
        # vlm-transformers / vlm-vllm-engine（纯 VLM）、
        # hybrid-auto-engine（pipeline + VLM 混合，按页面自动择优）
        return self._data.get("mineru_backend", os.getenv("MINERU_BACKEND", "pipeline"))

    @property
    def mineru_timeout(self) -> int:
        # MinerU /file_parse 读取超时（秒）。大 PDF / 带公式表格的论文解析较慢，
        # 默认 600s。连接超时固定 10s（本地服务）。
        return int(self._data.get("mineru_timeout", os.getenv("MINERU_TIMEOUT", "600")))

    @property
    def translator_type(self) -> str:
        return self._data.get("translator", {}).get("type", os.getenv("TRANSLATOR_TYPE", "openai"))

    @property
    def translator_api_key(self) -> str:
        return self._data.get("translator", {}).get("api_key", os.getenv("TRANSLATOR_API_KEY", ""))

    @property
    def translator_base_url(self) -> str:
        return self._data.get("translator", {}).get("base_url", os.getenv("TRANSLATOR_BASE_URL", ""))

    @property
    def translator_model(self) -> str:
        return self._data.get("translator", {}).get("model", os.getenv("TRANSLATOR_MODEL", "gpt-4o"))

    @property
    def chunk_size(self) -> int:
        return int(os.getenv("TRANSLATOR_CHUNK_SIZE", self._data.get("translator", {}).get("chunk_size", 2000)))

    @property
    def embedding_provider(self) -> str:
        return os.getenv("EMBEDDING_PROVIDER", self._data.get("embedding", {}).get("provider", "local"))

    @property
    def embedding_model(self) -> str:
        return os.getenv("EMBEDDING_MODEL", self._data.get("embedding", {}).get("model", "all-MiniLM-L6-v2"))


config = Config()
