# 学习工作台

一个本地论文学习工作台。目前只稳定实现两条流程：文献检索与登记，以及 PDF/TeX 资源获取。TeX 可以编译为 PDF；用户可以在页面触发 PDF 翻译并阅读中文或双语版本。

服务器是项目、论文、项目判断、资源和任务的唯一数据源。Agent 与前端使用同一组公开 API，不维护平行论文清单，也不直接操作数据库和文件目录。

## 启动

后端：

```powershell
cd backend
uv sync --dev
uv run uvicorn app.main:app --reload
```

前端：

```powershell
cd frontend
npm install
npm run dev
```

后端默认位于 `http://127.0.0.1:8000`，前端位于 `http://127.0.0.1:5173`。前端开发服务器会把 `/api` 转发到后端。

## 当前能力

- 全局论文身份和跨项目复用。
- 渐进式候选登记与用户筛选状态。
- PDF 和 TeX 多版本资源、来源、散列、首选与派生链。
- TeX 安全解包与后台编译。
- 用户触发的 PDF 翻译。
- 连续滚动、文本选择、链接、搜索和缩放的 PDF 阅读器。
- 版本化数据库迁移，以及可升级旧版本的完整快照备份与恢复。

接口概览见 `API.md`，领域语义与工作流位于 `docs/`。字段级契约以运行中服务的 `/openapi.json` 为准。

## 验证

```powershell
cd backend
uv run pytest -q
uv run ruff check app tests

cd ../frontend
npm test
npm run typecheck
npm run lint
npm run build
```
