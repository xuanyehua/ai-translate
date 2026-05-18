# 翻译历史持久化 - 设计文档

**日期:** 2025-05-14
**状态:** Approved

## 背景

当前翻译结果只存在内存 `_results` dict 中，服务重启即丢失。需要持久化存储翻译记录，并提供历史记录列表页面供用户查看、搜索、重新展开对照、下载。

## 存储方案

文件系统 + JSON 文件，零依赖。

### 目录结构
```
data/
  translations/
    <task_id>.json
```

### JSON 格式
```json
{
  "task_id": "abc123",
  "filename": "report.pdf",
  "ext": "pdf",
  "target_lang": "中文",
  "original": "原文 Markdown 内容",
  "translated": "译文 Markdown 内容",
  "status": "completed",
  "created_at": "2025-05-14T16:00:00Z"
}
```

## 后端设计

### 1. 新文件 `app/storage.py`

- `save_translation(task_id, data)` — 通过 `asyncio.create_task()` 写入 `data/translations/<task_id>.json`，不阻塞 SSE 流
- `load_translation(task_id)` — 读取单个 JSON，返回 dict 或 None
- `list_translations(search, limit, offset)` — 遍历目录，按 `created_at` 倒序返回摘要列表，支持文件名搜索

### 2. 修改 `app/main.py`

- 翻译 `done` 事件推送后，在后台调用 `save_translation()` 落盘
- `GET /api/translations?q=&page=&limit=` — 返回 `{ items: [...], total: N }`
- `GET /api/download` — 优先读内存缓存，未命中则调 `load_translation()`

### 3. SSE 流程不变
翻译过程中仍通过 SSE 推送，完成后额外持久化。

## 前端设计

### 1. 新文件 `frontend/src/components/HistoryView.tsx`

- 顶部搜索框：按文件名实时过滤
- 列表：每行显示 文件名 + 日期 + 目标语言 + 状态
- 操作按钮：展开（内嵌 CompareView）、下载
- 展开后展示原文/译文对照
- 分页：每页 20 条，底部翻页控件

### 2. 修改 `frontend/src/App.tsx`

- 顶部导航切换：`翻译新文档` / `翻译历史`
- `idle` 状态默认显示上传页面
- 点击历史标签调用 `GET /api/translations` 渲染列表

## 数据流

```
翻译完成 (done)
  → SSE 推送 done 事件
  → 异步写入 data/translations/<task_id>.json
  → 前端显示下载按钮

历史记录页面
  → GET /api/translations?q=xxx&page=1
  → 后端遍历 data/translations/ 过滤+排序
  → 返回摘要列表 + total
  → 前端渲染列表

下载文件
  → 优先内存缓存
  → 未命中 → load_translation() 读 JSON
  → convert() → StreamingResponse
```

## 错误处理

- 写入失败：记录日志但不影响用户流程（翻译已成功推送）
- 文件不存在：`list_translations` 跳过损坏文件，`load_translation` 返回 None → 404
- 目录不存在：首次写入时自动创建
