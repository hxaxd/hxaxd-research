# 学习工作台 API

本文档面向 Agent 和开发者，说明当前公开接口的用途、调用顺序和数据语义。字段级机器契约以运行中服务器的 OpenAPI 为准。

## 入口

- 默认服务地址：`http://127.0.0.1:8000`
- 交互式文档：`GET /docs`
- OpenAPI 契约：`GET /openapi.json`
- 健康检查：`GET /api/health`

所有业务接口使用 `/api` 前缀。除 PDF 上传外，请求和响应均为 JSON。当前服务仅供本机工作台使用，不包含用户认证；不要暴露到公网。

## 推荐调用顺序

1. `GET /api/health` 确认后端可用。
2. `GET /api/workspace` 读取完整学习状态，不要先扫描数据库或服务器目录。
3. 根据快照复用项目和论文；需要创建记录时先读取 `GET /api/schema/paper`。
4. 完成创建、更新、上传或翻译操作。
5. 回读具体资源，并在任务结束前重新读取工作区快照。

## 工作区状态

### `GET /api/workspace`

一次返回：

- `generated_at`：快照生成时间
- `projects`：全部项目
- `projects[].status_counts`：项目内各筛选状态数量
- `projects[].papers`：论文的全部字段
- `projects[].papers[].artifacts`：该论文已有的原文、中文和双语 PDF
- `tools`：PDF2zh 与 TeX 的安装状态、版本和固定路径

这是 Agent 理解当前学习区状态的首选接口。只有需要刷新单项或执行写操作时，才调用下列细分接口。

## 项目

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/projects` | 列出项目及论文数量 |
| `POST` | `/api/projects` | 创建项目 |
| `GET` | `/api/projects/{project_id}` | 读取项目 |

创建请求：

```json
{
  "name": "中文项目名",
  "description": "项目范围和边界"
}
```

创建前必须从工作区快照检查已有名称和范围。当前没有项目删除、旧格式导入或兼容迁移接口。

## 论文记录

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/schema/paper` | 获取当前论文创建契约 |
| `GET` | `/api/projects/{project_id}/papers` | 列出项目论文 |
| `POST` | `/api/projects/{project_id}/papers/batch` | 一次创建 1–100 篇论文 |
| `GET` | `/api/papers/{paper_id}` | 读取单篇论文 |
| `PATCH` | `/api/papers/{paper_id}` | 更新允许修改的字段和状态 |

批量创建请求：

```json
{
  "papers": [
    {
      "stable_key": "doi:10.xxxx/example",
      "status": "discovered",
      "title_en": "Official English Title",
      "title_zh": "准确的中文标题",
      "authors": ["First Author", "Second Author"],
      "organization": null,
      "publication_year": 2026,
      "publication_status": "Conference 2026",
      "paper_type": "方法",
      "main_method": "主要方法的一句话说明",
      "contribution": "核心贡献",
      "selection_reason": "不可替代的选入理由",
      "reading_focus": "需要重点阅读的章节或实验",
      "relations": "与项目内其他工作的关系",
      "stable_url": "https://doi.org/10.xxxx/example",
      "code_url": null,
      "website_url": null
    }
  ]
}
```

批量创建是整批事务：任何记录校验失败或稳定键冲突时，整批均不写入。允许的 `paper_type` 和必填规则必须从实时 Schema 获取。

筛选状态：

- `discovered`：字段完整，等待用户判断
- `included`：用户决定保留
- `excluded`：用户决定不保留，但记录继续用于去重
- `archived`：曾有价值，当前不参与主要学习流程

状态更新示例：

```json
PATCH /api/papers/{paper_id}
{
  "status": "included"
}
```

## PDF 资源

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/papers/{paper_id}/artifacts` | 列出论文已有资源 |
| `POST` | `/api/papers/{paper_id}/artifacts/{kind}` | 上传或替换一种 PDF |
| `GET` | `/api/papers/{paper_id}/artifacts/{kind}` | 浏览器内读取 PDF |
| `GET` | `/api/papers/{paper_id}/artifacts/{kind}?download=true` | 下载 PDF |

`kind` 取值：

- `original`：原文
- `chinese`：中文译文
- `bilingual`：双语对照

上传使用 `multipart/form-data`，文件字段名固定为 `upload`，内容必须是有效 PDF。示例：

```bash
curl -X POST \
  -F "upload=@paper.pdf;type=application/pdf" \
  http://127.0.0.1:8000/api/papers/{paper_id}/artifacts/original
```

Agent 获取论文时只上传 `original`。后端负责校验、散列、固定存储和数据库登记；不要绕过接口复制到 `backend/data/`。

## 翻译任务

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `POST` | `/api/papers/{paper_id}/translate` | 创建后台翻译任务 |
| `GET` | `/api/jobs/{job_id}` | 查询任务进度和错误 |

创建请求可以为空对象，也可以指定并发参数：

```json
{
  "qps": 4,
  "workers": 4
}
```

启动翻译前必须已有 `original`，PDF2zh 必须就绪，并且后端进程可读取 `PDF2ZH_DEEPSEEK_API_KEY`。同一论文同时只允许一个活动翻译任务。任务状态为 `queued`、`running`、`succeeded` 或 `failed`；成功后重新读取论文资源即可取得 `chinese` 和 `bilingual`。

通常由用户在页面启动翻译。Agent 只有在用户明确要求时才调用该接口。

## 本地工具

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/tools` | 查询全部工具 |
| `GET` | `/api/tools/{name}` | 查询单个工具 |
| `POST` | `/api/tools/{name}/install` | 启动后台安装 |

`name` 为 `pdf2zh` 或 `tex`。状态为 `missing`、`installing`、`installed` 或 `failed`。安装接口立即返回；状态为 `installing` 时轮询查询接口，直到成功或失败。

固定路径：

- PDF2zh：`.tools/pdf2zh`
- TeX Live：`.tools/tex/texlive`

服务不会搜索或调用系统全局安装。首页直接使用这些接口展示状态和“下载并安装”按钮。

## 数据备份与恢复

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/api/snapshots` | 读取服务器备份列表和当前操作状态 |
| `POST` | `/api/snapshots` | 启动完整数据备份 |
| `GET` | `/api/snapshots/{filename}/download` | 下载备份文件 |
| `POST` | `/api/snapshots/{filename}/restore` | 用服务器已有备份恢复全部数据 |

备份与恢复是串行后台操作。操作状态为 `running`、`succeeded` 或 `failed`；运行中轮询
`GET /api/snapshots`。有翻译任务运行时，后端拒绝创建或恢复备份。

恢复请求必须显式确认文件名：

```json
{
  "confirmation": "learning-2026-07-20_120000Z.researchpack"
}
```

恢复前会验证快照格式、数据库结构、文件大小与散列；成功切换后，原数据目录保留为带
`before-restore` 时间戳的恢复副本。当前没有快照上传、旧格式导入或兼容迁移接口。

## 错误与回读

- `400`：上传内容或请求数据无效
- `404`：项目、论文、资源或任务不存在
- `409`：名称、稳定键或活动任务冲突
- `422`：请求不满足字段契约
- `500`：翻译执行等后端任务失败

错误体使用 `{"detail": "..."}`。写操作成功只说明该次接口完成；Agent 仍需回读具体资源或 `GET /api/workspace`，再向用户报告最终状态。
