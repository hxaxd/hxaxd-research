# Backend

## 启动

```powershell
uv sync --dev
uv run uvicorn app.main:app --reload
```

服务默认监听 `http://127.0.0.1:8000`。交互式接口文档位于 `/docs`，机器契约位于 `/openapi.json`。

内嵌智能体的工作目录默认位于系统本地应用数据目录下的
`HxaxdResearch/agent-runs`，不会位于源码仓库内。需要调整时设置
`RESEARCH_APP_AGENT_RUNTIME_DIR`；后端数据目录仍由 `RESEARCH_APP_DATA_DIR` 控制。

项目、候选、文献版本、附件、任务、智能体运行、Zotero 迁移和快照都由后端领域命令管理。前端和智能体不直接读取数据库或数据目录。

## 数据打包与重建

备份、下载和恢复统一在工作台设置页执行，也可以调用 `/api/snapshots` 接口。后端负责
串行任务、完整性校验和原子替换；恢复时会保留带 `before-restore` 时间戳的原数据副本。

快照记录容器、数据库和应用契约版本。系统只恢复当前格式；内容先在影子目录完成结构、文件与哈希校验，再原子替换，原数据保留为恢复副本。
