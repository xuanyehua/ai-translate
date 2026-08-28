# AI 文档对话（RAG 模式）- 设计文档

**日期:** 2025-05-14
**状态:** Draft

## 背景

当前项目支持文档解析 + 翻译 + 对照查看 + 下载，但用户无法对文档内容进行深入理解和问答。需要新增 AI 解读和智能问答功能，让用户翻译完文档后能直接提问。

## 核心思路

翻译完成后，对译文做 RAG（检索增强生成），用户提问时先检索相关段落，再发给 LLM 生成回答。

## 架构

```
上传 → MinerU解析 → Markdown → LLM翻译 → 译文 → 对照查看
                                              │
                                         [AI 对话] 按钮
                                              │
                                              ▼
                              ┌───────────────────────────┐
                              │  预处理（翻译后自动触发）     │
                              │                           │
                              │  译文 Markdown             │
                              │     ↓                     │
                              │  按 ## 标题拆块（≤500字）   │
                              │     ↓                     │
                              │  sentence-transformers    │
                              │  all-MiniLM-L6-v2 → 向量   │
                              │     → FAISS 索引存入内存    │
                              └───────────────────────────┘
                                              │
                                              ▼
                              ┌───────────────────────────┐
                              │  问答循环                   │
                              │                           │
                              │  用户提问                   │
                              │     ↓                     │
                              │  问题 → 向量 → FAISS搜索   │
                              │     ↓                     │
                              │  Top 5 段落 + 问题 → LLM   │
                              │     ↓                     │
                              │  SSE 流式返回回答           │
                              └───────────────────────────┘
```

## Embedding 配置（方案 B: 可配置）

```yaml
# config.yaml 新增
embedding:
  provider: "local"              # local | openai
  model: "all-MiniLM-L6-v2"     # local: sentence-transformers 模型名
                                 # openai: text-embedding-3-small 等
```

| provider | 说明 | 需要 |
|:---|:---|:---|
| `local` | 本地 CPU 推理，零 API 成本 | `sentence-transformers`（~200MB 模型下载）|
| `openai` | 远程 API，复用翻译引擎的 base_url + api_key | 翻译引擎的 API key |

## Token 节省

| 模式 | 50页论文每次提问的上下文 |
|------|:---:|
| 全文模式 | ~60k tokens |
| RAG 模式（Top 5 段落） | ~3k tokens |
| **节省** | **95%** |

## 后端设计

### 1. 新文件 `app/rag.py`

```
     ChunkStore (class)
     ├── chunk_document(translated_md) → list[str]
     │     按 ## 标题拆块
     │     每块 ≤500 字
     │     保留标题作为块的前缀
     │
     ├── build_index(chunks) → faiss.Index
     │     用 sentence-transformers 或 OpenAI API
     │     将每个块转成向量
     │     存入 FAISS 索引
     │
     ├── search(query, top_k=5) → list[str]
     │     问题 → 向量 → FAISS 搜索 → 返回最相关块
     │
     └── generate_answer(question, context_chunks) → async generator
           拼接 prompt:
             "你是一个文档助手，基于以下文档片段回答问题。
              如果文档片段中没有相关信息，请如实告知。
              
              文档片段：
              [段落1]
              [段落2]
              ...
              
              用户问题：{question}
              
              回答："
            → LLM SSE 流式返回
```

**分块策略：**

```
输入译文 Markdown:
  ## 第一章 引言
  Lorem ipsum dolor sit amet...
  
  ### 1.1 研究背景
  Consectetur adipiscing elit...
  
  ## 第二章 方法
  Sed do eiusmod tempor...

输出 chunks:
  ["## 第一章 引言\nLorem ipsum dolor sit amet...",
   "### 1.1 研究背景\nConsectetur adipiscing elit...",
   "## 第二章 方法\nSed do eiusmod tempor..."]
```

每个 chunk 的文本保持在 300-500 字，保证上下文完整且检索精准度够高。

**Prompt 设计：**

```
系统: 你是一个文档助手，基于以下文档片段回答问题。如果文档片段中没有相关信息，请如实告知用户。
用户: 文档片段：
[段落1内容]
[段落2内容]
...
用户问题：{question}
回答：
```

### 2. 修改 `app/config.py`

新增 embedding 配置读取：

```python
@property
def embedding_provider(self) -> str:
    return self._get("embedding", "provider", default="local")

@property
def embedding_model(self) -> str:
    return self._get("embedding", "model", default="all-MiniLM-L6-v2")
```

### 3. 修改 `app/main.py`

**3.1 翻译完成后触发预处理**

在 `/api/translate` SSE 流的 `done` 事件后，异步触发 RAG 索引构建：

```python
# 翻译完成后
asyncio.create_task(_build_rag_index(task_id, translated_markdown))
```

**3.2 新增对话端点**

```python
@app.post("/api/translate/{task_id}/chat")
async def chat(task_id: str, question: str = Form(...)):
    # 1. 从内存获取 RAG 索引
    # 2. 检索相关段落
    # 3. 构建 prompt
    # 4. SSE 流式返回 LLM 回答
```

**SSE 事件：**

```
event: thinking → "正在检索相关内容..."
event: chunk    → { "text": "这篇论文的主要贡献..." }
event: done     → {}
```

## 前端设计

### 1. 新文件 `frontend/src/components/ChatView.tsx`

```
┌──────────────────────────────────────┐
│  💬 AI 解读                   [返回]  │
├──────────────────────────────────────┤
│                                      │
│  🤖 我是文档助手，可以回答关于        │
│     这篇文档的任何问题               │
│                                      │
│  💡 试试问我:                        │
│     · 这篇文档的核心观点是什么？      │
│     · 第三章的主要结论？             │
│     · 解释一下这个表格的数据         │
│                                      │
│  ┌──────────────────────────────┐    │
│  │ 你: 这篇论文的贡献是什么？     │    │
│  └──────────────────────────────┘    │
│  ┌──────────────────────────────┐    │
│  │ 🤖: 这篇论文的主要贡献包括...  │    │
│  └──────────────────────────────┘    │
│                                      │
│  ┌──────────────────────────────┐    │
│  │ [输入问题...]      [发送]     │    │
│  └──────────────────────────────┘    │
└──────────────────────────────────────┘
```

**特性：**
- SSE 流式接收 AI 回答，实时渲染（Markdown）
- 首次进入自动显示一条欢迎消息 + 3 个建议问题
- 回答流式显示，类似 ChatGPT 的打字效果
- 对话历史在当前会话中保留，切回翻译页即清空
- 输入框支持 Enter 发送

### 2. 修改 `frontend/src/App.tsx`

- 在翻译 done 状态时，CompareView 工具栏里显示「AI 对话」按钮
- 点击后切换到 ChatView（传入 taskId 和原文/译文）
- ChatView 里提供「返回对照查看」按钮

## 内存管理

- RAG 索引存在内存中（`_rag_indexes: dict[str, ChunkStore]`）
- 与翻译结果的 `_results` 生命周期一致
- 服务重启后索引丢失，但翻译结果可从磁盘 `load_translation` 恢复后重建

## 依赖新增

```
sentence-transformers  # embedding 模型（provider=local 时需要）
faiss-cpu              # 向量搜索
numpy                  # 向量计算
```

## 数据流总结

```
翻译完成
  │
  ├─→ 前端：显示对照查看 + [AI 对话] 按钮
  │
  └─→ 后端：异步构建 RAG 索引
    
用户点击 [AI 对话]
  │
  └─→ ChatView 组件
    
用户提问
  │
  ├─→ POST /api/translate/{task_id}/chat
  ├─→ FAISS 检索 Top 5 段落
  ├─→ 拼接 prompt
  ├─→ LLM SSE 流式返回
  └─→ 前端实时渲染 Markdown 回答
```

## 错误处理

- RAG 索引未就绪 → 返回 "AI 助手正在准备中，请稍后重试"
- FAISS 搜索无结果 → 返回 "未找到相关信息，请尝试换个问法"
- LLM 调用失败 → 返回错误提示，继续对话
- 索引构建失败 → 日志记录，对话功能不可用但不影响翻译下载
