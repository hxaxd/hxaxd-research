# hxaxd-research

一个可以直接在 Codex 中使用的本地计算机科学研究工作区，覆盖领域学习、Idea 审查、
实验、论文写作、审稿和投稿准备。

本项目不是 Codex Skill，也不需要安装或注册为 Skill。仓库中的 Markdown 文档就是
公开、可修改的执行规范；用 Codex 打开仓库并引用 `@AGENTS.md` 即可开始。

## 快速开始

1. 克隆仓库，并用 Codex 打开仓库根目录。
2. 在请求中引用 `@AGENTS.md`。
3. 描述一个新任务，或指定已有的 `workspace/<中文任务名>/`。
4. 根据 Codex 给出的影响说明，确认方向、范围、阶段跳过和首次落盘。

例如：

```text
@AGENTS.md
我想系统学习 Coding Agent Evaluation。请帮我划定范围，
生成一条阅读路线，并逐步维护领域知识地图。
```

```text
@AGENTS.md
我有一个关于长程 Agent 失败恢复的研究想法。先不要替我包装，
请检查本质假设、最相近工作和最强反例，判断是否值得立项。
```

```text
@AGENTS.md
请继续 workspace/长程智能体恢复机制。读取已有文档，
判断当前阶段、状态、已跳过项和未决确认，再开展下一步。
```

```text
@AGENTS.md
请独立审查 workspace/上下文压缩评测 中的论文草稿。
这次只做综合审稿，不要求补齐完整研究生命周期。
```

Codex 会读取 [`WORKFLOW.md`](WORKFLOW.md)，从已有文档判断任务主线，再读取
[`指导/使用说明.md`](指导/使用说明.md) 和对应专项指导。关键输入缺失、方向改变或
到达确认点时，它会先与你对齐；确认后逐步写入真实产物，不会一次创建整套空模板。

## 工作方式

仓库区分两种工作：

- **生命周期阶段**表示任务主线发生了什么变化。推荐路线是学习规划、知识地图、
  Idea 立项、Story、实验、写作和投稿准备。
- **按需能力**像可重复调用的函数，包括文献与全文定位、论文处理、Idea 自动发现、
  知识更新、绘图、翻译、修订、审稿、投稿规则、引用核验、Tex 验收和匿名检查。

阶段之间的箭头是推荐路线，不是门禁。用户可以直接进入任意可执行阶段，也可以明确
跳过阶段。跳过会记录原因和证据影响，但不会伪装成完成。翻译、审稿、引用核验等能力
也可以作为一次性任务独立使用。

所有研究文档和交接材料放在扁平的 `workspace/<中文任务名>/` 中，可能逐步出现：

- `学习目标.md`、`最终论文列表.md`、持续更新的 `领域全景地图.md`；
- `研究想法.md`、`叙事定稿.md`、`核心主张.md`、`文献证据库.md`；
- `实验证明设计.md`、`实验编程计划.md`、`实验记录/`、`结果分析.md`；
- 中文或英文 Tex、图表计划、审稿意见、投稿检查和 `投稿准备记录.md`。

任务状态不保存在隐藏字段或额外状态文件中，而由真实文档、用户确认、跳过记录和未决
问题共同推导。

## 实验仓库

实验代码不放入中文任务目录。需要实验工程时，由用户把独立代码仓库手动准备到
根目录的 `labs/<实际仓库目录>/`，任务文档记录该路径、上游仓库、分支和基线 commit。

`labs/` 被本仓库忽略。Codex 不会替用户创建、初始化或拉取实验仓库，也不会规定独立
仓库内部的代码、日志和结果布局；它只在研究文档中维护实验目标、证据和可追溯交接。

## 可选：论文处理 CLI

只有需要解析、翻译、重排或渲染论文时才需要配置 CLI：

也可以直接让 Agent 主导检查并安装当前机器所需的环境：

```text
@AGENTS.md
请检查并配置本仓库论文处理 CLI 所需的环境，逐项验证 parse、translate、
reflow 和 render；遇到设备选择、大型下载、API 配置或付费服务时先向我确认。
```

```powershell
uv sync
uv run playwright install chromium
uv run python -m src.hxr.cli doctor
```

PaddlePaddle 需要按本机 CPU、GPU 和 CUDA 条件单独安装。主要命令：

```powershell
uv run python -m src.hxr.cli parse <论文.pdf> --out <论文目录>
uv run python -m src.hxr.cli translate <输入> --out <输出> [--format auto|markdown|html|tex]
uv run python -m src.hxr.cli reflow <输入> --out <输出> [--format auto|markdown|html|tex]
uv run python -m src.hxr.cli render <输入> --out <输出.pdf> [--format auto|markdown|html]
```

处理前遵循 [`指导/学习/论文处理工具使用.md`](指导/学习/论文处理工具使用.md)。
翻译会把正文发送到配置的 API，执行前必须得到用户许可。
