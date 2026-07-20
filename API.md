# 学习工作台 API

默认地址为 `http://127.0.0.1:8000`。交互式文档在 `/docs`，字段级机器契约以 `/openapi.json` 为准。

## 启动顺序

1. `GET /api/health`
2. `GET /api/workspace`
3. 按目标读取项目论文或单篇论文
4. 执行写操作并回读

`GET /api/workspace` 是紧凑入口，只返回项目摘要、契约版本、Schema 版本和 supported/ready 能力，不内嵌全部论文。

## 资源族

| 资源 | 接口 |
| --- | --- |
| 项目 | `GET/POST /api/projects`；`GET/PATCH /api/projects/{id}` |
| 项目论文 | `GET /api/projects/{id}/papers`；`POST /api/projects/{id}/papers/batch` |
| 论文事实 | `GET/PATCH /api/papers/{id}`；`GET /api/papers/{id}/projects` |
| 项目判断 | `PATCH /api/projects/{project_id}/papers/{paper_id}` |
| 论文资源 | `GET/POST /api/papers/{id}/resources` |
| 资源内容 | `GET /api/resources/{id}/content`；加 `?download=true` 下载 |
| 资源属性 | `PATCH /api/resources/{id}` |
| 转换任务 | `POST /api/jobs`；`GET /api/jobs/{id}` |
| 工具 | `GET /api/tools`；`POST /api/tools/{name}/install` |
| 快照 | `GET/POST /api/snapshots`；下载和恢复见 OpenAPI |

论文批量接口接收 `paper` 事实和 `project` 判断。后端规范化公开标识符、全局复用论文并逐项返回 `created`、`reused` 或 `unchanged`；重复提交不产生重复记录。请求结构通过 `GET /api/schema/paper` 获取。

资源上传使用 multipart：`upload`、`format=pdf|tex`、`representation=original|translated|bilingual`、`origin`，以及可选 `source_url`、`preferred`。TeX 是 zip、tar 或 tar.gz 完整源码包。

任务请求示例：

```json
{
  "operation": "compile",
  "input_resource_id": "resource-id",
  "options": {}
}
```

`compile` 接收原始 TeX 并生成原始 PDF；`translate` 接收原始 PDF 并生成中文和双语 PDF。输出资源出现在任务的 `outputs` 中，并保留输入、任务与父资源关系。

预期业务错误包含稳定 `code`、可读 `message` 和可选 `details`。常见 HTTP 状态为 400、404、409 和 422。调用方不得解析自然语言消息来判断错误类型。
