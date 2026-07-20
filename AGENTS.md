# 学习工作台入口

本仓库只实现论文学习阶段：文献检索与登记、PDF/TeX 资源获取、TeX 编译和用户触发的 PDF 翻译。

服务器是项目、论文、筛选状态、资源和任务的唯一权威。不要建立并行 Markdown 清单，不要直接读写数据库或 `backend/data/`。

## 每次开始

1. 阅读 `API.md`。
2. 请求 `GET /api/health`。
3. 请求 `GET /api/workspace`，了解项目摘要、契约版本和运行时能力。
4. 复用范围相符的项目；只有范围确实不同才创建项目。

字段级契约以 `/openapi.json` 和 `GET /api/schema/paper` 为准。

## 按任务路由

- 检索、核验、登记或筛选论文：读 `docs/workflows/literature-search.md`。
- 获取、上传、编译或翻译资源：读 `docs/workflows/resource-acquisition.md`。
- 不理解 Paper、ProjectPaper、Resource 或 Job 时：读 `docs/domain.md`。

一次任务只读当前需要的工作流，不要读取 `ROUTER.md`。

## 权限边界

- 新候选默认是 `discovered`。
- 只有用户明确决定，才能改为 `included`、`excluded` 或 `archived`。
- “不留”是 `excluded`，不是删除。
- 已有正确资源应复用；新资源不得静默覆盖历史文件。
- TeX 编译是资源补全动作；能力未就绪时只报告，不自动安装工具。
- 翻译必须由用户明确触发。

## 完成任务

写操作后回读具体论文、项目关系、资源或任务。结束前再次请求 `GET /api/workspace`，只报告公开接口已经证明的结果；失败、冲突和缺口必须明确说明。
