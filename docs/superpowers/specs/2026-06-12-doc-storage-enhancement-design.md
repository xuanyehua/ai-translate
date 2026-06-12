# 文档持久化增强 - 设计文档

**日期:** 2026-06-12
**状态:** Approved

## 背景

当前项目存在四个体验问题：
1. 翻译后的图片只存内存，服务重启即丢失，历史记录里图片显示 404
2. RAG 向量索引每次重启都要重建（首次提问要等 embedding 加载 + 文档分块）
3. AI 对话和对照查看是两个独立页面，对话时看不到原文/译文
4. AI 对话是单轮独立问答（不带历史），对话记录也不持久化（重启或切页就丢）

本设计解决这四个问题。

## 目标

1. **完整持久化**：原文 Markdown、译文 Markdown、图片、RAG 索引、对话记录全部存盘
2. **Embedding 状态可见**：用户能看到状态，并能手动触发构建
3. **侧边对话**：AI 对话改为右侧可收起的抽屉，不离开对照查看
4. **多轮对话**：后端带最近 N 轮历史调用 LLM，支持上下文引用

## 存储结构

每个翻译任务一个目录，目录结构清晰自洽：

```
data/translations/
  abc123/
    original.md          # MinerU 解析的原文 Markdown
    translated.md        # 翻译后的 Markdown
    meta.json            # 元数据
    images/              # MinerU 提取的图片
      img1.jpg
      img2.png
    rag/                 # RAG 索引（embedding 完成后才有）
      chunks.json        # 块文本数组 ["块1内容", "块2内容", ...]
      index.faiss        # FAISS 二进制索引
      meta.json          # embedding 元数据（模型名、维度）
    chat.jsonl           # 多轮对话记录（每行一条消息）
```

**meta.json 格式：**

```json
{
  "task_id": "abc123",
  "filename": "report.pdf",
  "ext": "pdf",
  "target_lang": "中文",
  "status": "completed",
  "created_at": "2026-06-12T13:00:00Z",
  "embedding_status": "ready",
  "embedding_built_at": "2026-06-12T13:05:00Z",
  "embedding_error": null
}
```

`embedding_status` 状态枚举：
- `pending` — 翻译完成但还未构建索引
- `building` — 正在构建（embedding 中）
- `ready` — 已就绪，可以问答
- `failed` — 构建失败（`embedding_error` 含错误信息）

**rag/meta.json 格式：**

```json
{
  "model": "all-MiniLM-L6-v2",
  "provider": "local",
  "dim": 384,
  "chunk_count": 42
}
```

加载索引时校验模型名一致，否则需要重建。

**chat.jsonl 格式（每行一条消息）：**

```jsonl
{"role": "user", "content": "第一章讲了什么", "ts": "2026-06-12T13:00:00Z"}
{"role": "assistant", "content": "第一章讲了 XYZ ...", "ts": "2026-06-12T13:00:05Z"}
{"role": "user", "content": "它的核心结论是什么？", "ts": "2026-06-12T13:01:00Z"}
{"role": "assistant", "content": "结论是 ABC ...", "ts": "2026-06-12T13:01:08Z"}
```

JSONL 选择理由：可追加（无需读取整文件即可写入新消息）、损坏单行不影响其他记录。

## 后端设计

### 1. 重构 `app/storage.py`

新接口（替代当前 JSON 单文件方案）：

```python
def save_translation(task_id, filename, ext, target_lang, original_md, translated_md, images: dict[str, bytes]) -> bool
    # 创建目录 data/translations/{task_id}/
    # 写 original.md / translated.md
    # 解码 base64，把图片存到 images/ 目录
    # 写 meta.json (embedding_status: "pending")

def load_meta(task_id) -> dict | None
    # 读 meta.json

def load_original(task_id) -> str | None
    # 读 original.md

def load_translated(task_id) -> str | None
    # 读 translated.md

def load_image(task_id, filename) -> tuple[bytes, str] | None
    # 读 images/{filename}, 返回 (bytes, mime_type)

def list_translations(search, limit, offset) -> tuple[list, int]
    # 遍历 data/translations/, 读每个目录的 meta.json
    # 摘要列表（不读 md 内容）

def update_embedding_status(task_id, status, error=None) -> bool
    # 修改 meta.json 中的 embedding_status / embedding_error / embedding_built_at
```

### 2. 修改 `app/rag.py`

**新增 ChunkStore 持久化方法：**

```python
class ChunkStore:
    def save(self, rag_dir: Path):
        # 写 chunks.json (块文本)
        # faiss.write_index(self.index, rag_dir/index.faiss)
        # 写 meta.json (model, provider, dim, chunk_count)

    @classmethod
    def load(cls, rag_dir: Path) -> Optional[ChunkStore]:
        # 读 meta.json, 校验 model/provider 与当前配置一致
        # 不一致返回 None（触发重建）
        # faiss.read_index, 读 chunks.json
        # 返回 ChunkStore 实例
```

**修改 `build_chunk_store(translated_md)`：**
- 构建完成后调用 `store.save(rag_dir)` 持久化

### 3. 修改 `app/main.py`

**3.1 启动时不再预加载内存**
- `_results` 字典只缓存当前会话产生的图片（base64 in-memory）
- `_rag_stores` 改为按需加载：第一次访问时从磁盘 `ChunkStore.load()` 读取

**3.2 翻译流程调整**
- 翻译完成 → 调用 `save_translation()` 写盘（含图片解码）
- 异步触发 `_build_rag()`：
  - 状态 `pending` → 更新为 `building`
  - 调用 `build_chunk_store()`（内部会调 `store.save()`）
  - 成功 → 更新为 `ready`，失败 → `failed`

**3.3 新增手动触发端点**

```python
POST /api/translations/{task_id}/embed
```

逻辑：
- 检查 meta.json 存在
- 如果 `embedding_status == "building"` 返回 409 (避免并发)
- 否则启动后台任务 `_build_rag()`
- 立即返回 202 + `embedding_status: "building"`

**3.4 修改 `/api/translations` 返回**

每条记录增加 `embedding_status` 字段：

```json
{
  "items": [
    { "task_id": "...", "filename": "...", "embedding_status": "ready", ... }
  ]
}
```

**3.5 修改 `/api/images/{task_id}/{filename}`**

不再读内存，改为读磁盘 `data/translations/{task_id}/images/{filename}`。

**3.6 修改 chat 端点（支持多轮对话）**

```python
POST /api/translate/{task_id}/chat
```

逻辑：
- 检查 meta.json 中 `embedding_status == "ready"`，否则返回 503
- 读取 `chat.jsonl` 最近 N 轮（N=10）作为对话历史
- 把当前问题追加写入 `chat.jsonl`（user 消息）
- RAG 检索 → 拼接 prompt → LLM 调用（messages 包含历史 + 当前问题）
- 流式返回；回答完整收尾后追加写入 `chat.jsonl`（assistant 消息）

LLM messages 拼接：

```python
messages = [
    {"role": "system", "content": "你是文档助手。基于文档片段和对话上下文回答用户问题。"},
    *recent_history,  # chat.jsonl 最近 10 条
    {"role": "user", "content": f"""文档片段：
{retrieved_chunks}

当前问题：{question}"""},
]
```

**3.7 新增对话历史端点**

```python
GET /api/translate/{task_id}/chat/history
```
返回完整对话记录（前端进入抽屉时加载）：
```json
{ "messages": [{"role": "user", "content": "...", "ts": "..."}, ...] }
```

```python
DELETE /api/translate/{task_id}/chat/history
```
清空对话记录（删除 chat.jsonl）。

## 前端设计

### 1. `HistoryView.tsx` 修改

每条记录右侧增加状态徽章 + 操作：

```
┌──────────────────────────────────────────────────────────┐
│ report.pdf                   2026-06-12 21:00 · 中文      │
│                          🟢 索引就绪   [查看] [下载]       │
└──────────────────────────────────────────────────────────┘

或：
┌──────────────────────────────────────────────────────────┐
│ paper.pdf                    2026-06-12 20:00 · 中文      │
│                       🔴 未构建  [构建索引] [查看] [下载]  │
└──────────────────────────────────────────────────────────┘
```

状态映射：
- `ready` → 🟢 索引就绪
- `building` → 🟡 构建中（旋转图标）
- `pending` / `failed` → 🔴 未构建（显示「构建索引」按钮）

「构建索引」按钮：
- 点击 → POST `/api/translations/{task_id}/embed`
- 成功 → 状态变 `building`，每 3 秒轮询一次 `/api/translations`
- 完成 → 状态变 `ready`

### 2. `CompareView.tsx` 修改

工具栏右侧改造：

```
┌────────────────────────────────────────────────┐
│ 对照查看  翻译完成  🟢 索引就绪    [对话 》] [下载] │
└────────────────────────────────────────────────┘
```

状态：
- `ready` → 显示「对话 》」按钮（点击展开右侧抽屉）
- `building` → 「构建中...」灰色禁用
- `pending` / `failed` → 「构建索引」按钮，点击触发

### 3. 新组件 `ChatDrawer.tsx`（替代当前 `ChatView.tsx`）

**布局变化：**

```
未展开（默认）：
┌─────────────────────┬─────────────────────┐
│ 原文                │ 译文                │
│ 50%                 │ 50%                 │
└─────────────────────┴─────────────────────┘

展开后：
┌──────────────┬──────────────┬─────────────┐
│ 原文          │ 译文          │ AI 对话      │
│ 35%          │ 35%          │ 30%         │
│              │              │ [对话历史]    │
│              │              │ [输入框]     │
│              │              │              │
│              │              │ 《 收起      │
└──────────────┴──────────────┴─────────────┘
```

**特性：**
- 与 ChatView 功能一致（SSE、Markdown 渲染、建议问题）
- 顶部 [《 收起] 按钮关闭抽屉
- 顶部 [清空对话] 按钮（调用 DELETE /chat/history）
- 抽屉首次展开时调用 GET /chat/history 加载持久化历史
- 抽屉关闭时对话历史保留（前端 state 保留，再次展开不需要重新拉取）
- 多轮对话：用户输入"它"、"上面那个"等代词时，AI 能基于历史理解
- 抽屉宽度固定（适合宽屏，窄屏可考虑响应式后续优化）

### 4. `App.tsx` 修改

- 移除 `view === 'chat'` 模式
- ChatView 不再作为独立页面
- CompareView 内部管理 ChatDrawer 的展开/收起状态

## 数据流

### 翻译完成

```
SSE 推 done 事件
       │
       ├─→ 写盘:
       │     data/translations/{task_id}/
       │       ├── original.md
       │       ├── translated.md
       │       ├── meta.json (embedding_status: "pending")
       │       └── images/*.jpg
       │
       └─→ 异步 _build_rag():
             1. 更新 meta.json (embedding_status: "building")
             2. chunk_document() + _embed()
             3. ChunkStore.save() → rag/index.faiss + chunks.json + meta.json
             4. 更新 meta.json (embedding_status: "ready")
```

### 用户提问

```
点击 [对话 》] 按钮 → 检查 embedding_status
       │
       ├─ ready → 展开 ChatDrawer
       │
       └─ pending/failed → 触发 POST /api/translations/{task_id}/embed
                              ↓
                          按钮变 [构建中...]
                              ↓
                          每 3 秒轮询状态
                              ↓
                          ready → 自动展开 ChatDrawer

输入问题 → POST /api/translate/{task_id}/chat
       │
       ├─ 查 _rag_stores 内存缓存
       │
       └─ miss → ChunkStore.load(rag_dir) → 缓存到内存
       │
       ▼
SSE 流式返回回答
```

### 重启服务

```
启动时不预加载任何东西
       │
       ▼
首次访问历史页 → list_translations() 遍历 meta.json
       │
       ▼
首次提问某文档 → 按需加载 ChunkStore → 缓存到内存
```

## 错误处理

| 场景 | 处理 |
|------|------|
| 翻译完成但写盘失败 | 日志记录，前端仍能从内存看到结果（当前会话），重启后丢失 |
| 图片解码失败 | 跳过该图片，其他图片正常存盘 |
| Embedding 构建失败 | meta.json 标记 `failed`，存错误信息，前端显示「构建索引」按钮可重试 |
| 索引文件损坏 | `ChunkStore.load()` 返回 None，前端显示「构建索引」 |
| 模型变更后旧索引不可用 | meta.json 校验失败，触发重建 |
| 手动触发时正在构建 | 返回 409，前端提示「正在构建中」 |
| chat.jsonl 损坏（某行 JSON 非法）| 跳过损坏行，其余记录仍可用 |
| chat.jsonl 不存在 | 视为空对话记录，正常返回 |

## 迁移路径

旧的 `data/translations/{task_id}.json` 单文件格式需要迁移：

启动时检测旧格式 → 自动转换为新目录结构（一次性）：
- 读旧 JSON
- 创建新目录
- 写 original.md / translated.md / meta.json
- 旧 JSON 重命名为 `.bak`

迁移失败的记录跳过并记录日志。

## 不在范围

- 多用户隔离（仍然全局可见）
- 索引压缩（FAISS Flat 索引，文档少时不需要）
- 跨语言重新构建索引（仅当 `embedding_model` 改变才触发重建）
- 对话历史搜索（多轮存盘，但不提供搜索功能）
