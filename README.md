# Stitch

基于 MinerU + LLM 的文档翻译工具，保留原文档格式。

## 特性

- **多格式支持**：PDF / Word / Markdown 文档翻译，输出还原为原格式
- **本地文档解析**：MinerU 本地部署，无需外部服务
- **SSE 流式翻译**：逐块翻译、实时推送，不会超时
- **多 LLM 后端**：兼容 OpenAI / Claude / DeepSeek 等 OpenAI API 兼容服务
- **对照查看**：左右分栏展示原文与译文，联动高亮、同步滚动
- **Markdown 渲染**：支持表格、LaTeX 公式、代码块、图片

## 快速开始

### 前置要求

- Python >= 3.10 + [uv](https://docs.astral.sh/uv/)
- Node.js + npm
- MinerU 本地模型（从 modelscope 下载）

### 1. 安装依赖

```bash
# Python
uv sync
uv pip install "mineru[core]"

# 前端
cd frontend && npm install
```

### 2. 配置

```bash
cp config.example.yaml config.yaml
```

编辑 `config.yaml`，填入你的 LLM API 配置：

```yaml
translator:
  api_key: "your-api-key"
  base_url: "https://api.deepseek.com"   # 或其他兼容 API
  model: "deepseek-chat"
```

### 3. 启动

```bash
# 终端 1 — 后端
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000

# 终端 2 — 前端
cd frontend && npm run dev
```

访问 `http://127.0.0.1:5173`

## API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/translate` | POST | SSE 流式翻译，接收文件 + target_lang |
| `/api/download?task_id=` | GET | 下载翻译完成的文件 |
| `/api/images/{task_id}/{filename}` | GET | 获取文档内嵌图片 |

### SSE 事件

```
event: original   → 原文 Markdown（解析完成后立即推送）
event: start      → 总块数
event: chunk      → 逐块翻译结果 {index, text, total}
event: done       → 翻译完成 {task_id}
```

## 项目结构

```
├── app/
│   ├── main.py              # FastAPI 入口，SSE 端点
│   ├── config.py            # YAML + 环境变量配置
│   ├── parser.py            # MinerU 文档解析封装
│   ├── mineru_service.py    # MinerU 本地服务生命周期管理
│   ├── translator.py        # 翻译引擎 + 流式分块翻译
│   └── converter.py         # Markdown → .docx/.pdf 格式还原
├── frontend/
│   └── src/
│       ├── App.tsx           # 主页 + SSE 消费
│       └── components/
│           ├── CompareView.tsx  # 左右对照查看器
│           ├── FileUpload.tsx   # 拖拽上传组件
│           └── Progress.tsx     # 进度指示器
├── pyproject.toml
└── config.example.yaml
```

## 技术栈

| 层 | 技术 |
|:---|:---|
| 文档解析 | MinerU (本地 pipeline) |
| 后端 | FastAPI + SSE StreamingResponse |
| 翻译 | OpenAI SDK (兼容多 LLM) |
| 前端 | React + TypeScript + Tailwind CSS v4 |
| Markdown | react-markdown + KaTeX + GFM |
| Python 管理 | uv |
