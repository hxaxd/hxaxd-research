# Backend

## 启动

```powershell
uv sync --dev
uv run uvicorn app.main:app --reload
```

服务默认监听 `http://127.0.0.1:8000`，接口文档位于 `/docs`。

## Agent 提交论文

先从 `/api/schema/paper` 获取当前字段契约。JSONL 中每一行是一篇完整论文记录，然后运行：

```powershell
uv run python scripts/submit_papers.py papers.jsonl --project-id <project-id>
```

提交脚本只了解 HTTP 契约，不读取数据库结构。

## 论文资源

论文原文、中文译文和双语版本统一通过资源接口上传：

```text
POST /api/papers/{paper_id}/artifacts/{kind}
```

`kind` 可取 `original`、`chinese` 或 `bilingual`，文件字段名为 `upload`。

## 数据打包与重建

在仓库根目录执行：

```powershell
.\scripts\backup-research-data.ps1
.\scripts\restore-research-data.ps1 -Snapshot .\backend\snapshots\research-<时间>.researchpack -Replace
```

快照只接受当前程序的精确格式和数据库结构。`-Replace` 会把原数据目录重命名为带
`before-restore` 时间戳的恢复副本，再原子启用快照数据；不会导入或转换旧格式。
