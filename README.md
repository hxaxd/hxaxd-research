# 文献工作台

一个单用户、本地优先的文献索引、筛选与阅读系统。后端管理规范文献记录、项目判断、候选、附件、持久任务、智能体运行和外部集成；前端提供候选收件箱、任务追踪、审批和 PDF 阅读器。

智能体只通过后端提供的领域工具工作，不直接访问数据库或文件。Zotero 迁移、附件派生和状态变更由确定性代码执行并留下审计记录。

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

日常单进程启动（自动构建并由后端提供前端）：

```powershell
cd backend
uv run python -m app serve
```

需要平板访问时必须显式开启局域网模式：

```powershell
uv run python -m app serve --lan `
  --ssl-certfile C:\certs\workspace.pem `
  --ssl-keyfile C:\certs\workspace-key.pem `
  --public-url https://workspace.home:8000
```

电脑与平板必须信任同一份 HTTPS 证书，命令会显示平板访问地址。随后在电脑的“设置 → 局域网与受信任设备”生成一次性配对码；远程设备没有配对会话时无法访问数据或智能体工具端点。只有临时诊断时才使用 `--allow-insecure-http`，该模式不提供安全 Cookie，也不能作为可安装的平板 PWA 使用。

## 代码结构

- `backend/`：领域模型、SQLite 持久化、受控进程、智能体运行时与集成。
- `frontend/`：工作台界面和 PDF 阅读器。

HTTP 字段契约以运行中服务的 `/openapi.json` 为准；前端只在
`frontend/src/shared/api/contracts.ts` 保留一个集中式类型边界，不再维护面向智能体的人工接口文档。

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
