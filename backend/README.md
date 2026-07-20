# Backend

## 启动

```powershell
uv sync --dev
uv run uvicorn app.main:app --reload
```

服务默认监听 `http://127.0.0.1:8000`。完整调用说明见仓库根目录 `API.md`，交互式接口文档位于 `/docs`。

项目、论文、PDF、翻译、本地工具和完整工作区快照均通过公开 HTTP 接口操作。Agent 和前端使用同一契约，不直接读取数据库或数据目录。

## 数据打包与重建

备份、下载和恢复统一在工作台首页执行，也可以调用 `/api/snapshots` 接口。后端负责
串行任务、完整性校验和原子替换；恢复时会保留带 `before-restore` 时间戳的原数据副本。

快照只接受当前程序的精确格式和数据库结构，不导入或转换旧格式。
