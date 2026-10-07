# 科研工作台 V1 设计稿

状态：已批准并落地的 V1 架构。当前实现及验收记录见 `TODO.md`；外部模型连接仍待配置凭据后核验。

## 1. 产品目标

做一个单用户、本地运行的科研工作台：用户围绕工作区整理论文和真实文件，在同一界面阅读材料，并通过 Pi 对话理解材料、整理内容和修改文本文件。

第一版的完整使用链路：

1. 创建工作区，应用建立对应的本地目录。
2. 在工作区创建论文条目，导入 PDF、TeX 工程或其他材料。
3. 浏览实际目录，预览 PDF、文本和图片，下载其他文件。
4. 创建多个对话，选择材料作为上下文，接收流式回答并查看工具执行情况。
5. AI 可以读取材料、创建和修改工作区中的文本文件。
6. 用户可以停止回答；刷新页面、切换对话和重启应用后，已经保存的材料与对话仍可使用。

论文条目同时适用于阅读别人的论文和写自己的论文，不增加用途分类。工作区也可以存放没有归属于某篇论文的公共材料。

本稿采用以下 V1 范围决策，供整体评审：提供受工作区范围约束的文件工具；暂不提供任意命令执行、TeX 编译、OCR、网页搜索、Zotero 同步、独立笔记系统、全局文献库、自动后台任务和对话分支界面。它们不影响第一版模型成立，也不为它们预建目录或接口。

## 2. 固定假设决定实现

| 已知假设 | 直接采用的实现 | 不需要建立的抽象 |
| --- | --- | --- |
| 单用户本地使用 | 一个本地应用实例，监听回环地址 | 用户体系、租户隔离、角色权限平台 |
| Windows 是当前使用环境 | 首先验证 Windows 文件路径和启动方式 | 通用桌面宿主、跨平台命令调度层 |
| 前后端都是 TypeScript | 一个 Next.js 应用 | 独立后端框架、前后端工作区包 |
| AI 内核就是 Pi | 直接使用 Pi SDK | AgentProvider、引擎适配器、智能体基类 |
| 数据库就是 SQLite | 具体 SQL 和事务 | Repository 接口、多数据库适配器 |
| 材料就是本地文件 | Node 文件操作 | StorageProvider、对象存储接口 |
| 部署是持久 Node 进程 | 进程内保存正在运行的 Pi 会话 | 分布式锁、消息队列、调度集群 |
| 对话历史由 Pi 保存 | SQLite 只登记关联与请求执行结果 | 第二份消息数据库、通用事件存储 |
| 当前项目处于重建阶段 | 一套当前接口和当前实现 | 兼容适配、双写、协议版本后缀 |

这些是当前产品成立的前提，不是需要随时替换的策略。以后如果前提改变，针对真实需求修改代码，不为假想变化提前付费。

真正允许自然增长的部分只有：论文中的文件、具体预览组件、具体 AI 工具和业务功能。新增文件格式可以增加一个预览分支；新增工具可以向 Pi 注册一个具体工具。均不需要插件框架。

## 3. 技术栈

| 依赖 | 用途与选用理由 |
| --- | --- |
| Next.js App Router + React + TypeScript | 页面、服务端读取、HTTP 接口集中在一个应用；采用框架原生路由约定 |
| `@earendil-works/pi-coding-agent` 1.0.0 | 模型调用、工具执行、对话持久化、上下文压缩及取消 |
| `better-sqlite3` | 少量具体 SQL；同步事务适合本地登记数据，数据库调用保持短小 |
| Zod | 校验请求、定义响应结构并推导共享类型 |
| `@asteasolutions/zod-to-openapi` | 从同一套结构生成 OpenAPI，核验 HTTP 契约，不维护手写副本 |
| `typebox` | 仅用于 Pi 1.0.0 SDK 要求的工具参数声明，版本与 Pi 匹配；不扩散到应用 HTTP 契约 |
| `pdfjs-dist` | PDF 显示、文字层和按页提取文字，共用一个 PDF 实现 |
| Tailwind CSS + 自有样式 + Radix Dialog | 工作台布局、基础按钮和可访问对话框；只安装实际使用的依赖 |
| `react-markdown` + `remark-gfm` | 显示 AI 回答中的 Markdown、代码块和表格 |
| `busboy` | 流式接收文件，避免整批材料进入服务器内存 |
| Vitest + Playwright | 业务与接口测试，以及真实浏览器使用链路 |

不增加 ORM、全局状态库、AI SDK、通用服务容器或独立构建编排。浏览器普通请求使用 `fetch`；界面状态使用 React；流式对话使用 SSE。

工具参数遵循 Pi 的 TypeBox 契约，应用接口使用 Zod。两者对应不同外部边界，不为统一它们建立转换框架，也不对同一个输入重复执行两套校验。[Pi 1.0.0 工具定义](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/src/core/extensions/types.ts)、[Zod OpenAPI 生成说明](https://github.com/asteasolutions/zod-to-openapi)

Pi 包固定为项目依赖，不调用用户全局安装的 `pi`。其 1.0.0 包要求 Node >=22.19.0；当前环境的 Node 24.16.0 满足此条件。其他依赖在开工时选择经安装及构建验证的稳定版本，由锁文件固定，不把未经安装验证的版本号写成既成事实。[Pi 1.0.0 包定义](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/package.json)

## 4. 系统结构

```text
浏览器：工作区导航 / 文件阅读 / 对话
                 │ HTTP、SSE
                 ▼
Next.js：页面与 route.ts
                 │ 调用具体业务函数
                 ▼
工作区功能 / 论文功能 / 文件功能 / 对话功能
       │                 │                 │
       ▼                 ▼                 ▼
    SQLite            本地目录           Pi SDK
登记与执行结果        真实材料         模型、工具、历史
```

`app/` 负责 URL、页面组装、请求和响应。`features/` 按业务归属组织界面与服务端实现。`server/` 只放启动配置、数据库连接和 Pi 进程资源的接线。`shared/` 只放已经被不同功能使用的基础界面与 HTTP 辅助代码。

服务端页面直接调用具体查询函数，不请求自己的 HTTP 接口。浏览器交互通过 Route Handlers；不同时再实现一套 Server Actions。文件、数据库和 Pi 模块使用 `server-only`，防止进入浏览器包。

所有相关路由使用 Node runtime。生产方式是 `next build` 后由一个本地 `next start` 进程持续运行。工作区读取不使用持久页面缓存，确保外部新增文件可以通过刷新看到。该部署选择符合本地文件及长对话的需求；不采用无服务器函数部署。[Next.js 服务端接口说明](https://nextjs.org/docs/app/guides/backend-for-frontend)、[自行托管说明](https://nextjs.org/docs/app/guides/self-hosting)

## 5. 业务模型

```text
Workspace
├── Paper[]
│   └── 实际目录中的文件与子目录
├── Conversation[]
│   └── Pi 保存的消息与工具执行历史
└── 工作区根目录中的其他材料
```

### 工作区

一个工作区代表一个研究主题或项目。只有稳定 ID、显示名称和创建时间等必要登记字段。工作区名称可以修改，目录身份不随名称变化。

### 论文

一篇论文是工作区中的材料集合，有稳定 ID、名称和专属目录。可以先建立空论文，也可以包含多个 PDF、一套 TeX 源码、图片、数据和补充材料。

不要求 DOI、作者、年份、发表状态、主 PDF 或主 TeX。论文名称是用户给这个集合的名称，不从文件名强制推导。

### 资源

资源不设独立数据库表，不设 `PdfResource`、`TexResource` 等领域类型。资源的身份是“工作区 ID + 相对路径”。浏览目录时读取文件系统，返回文件名、相对路径、文件或目录、大小和修改时间。

扩展名和内容检测只帮助选择预览方式，不限制保存什么文件。论文下的 TeX 工程保留完整目录结构。资源路径可以变化；历史消息保存当时的路径和内容哈希，不承诺外部改名后自动追踪。

### 对话

对话属于工作区，不属于某篇论文。每次消息可以附带零个或多个材料引用，因此一个对话可以讨论多篇论文。每个对话对应一个 Pi 会话。

对话名称由用户输入，默认“新对话”；不为自动命名额外调用模型。提供改名与切换。第一版不提供工作区、论文或对话的破坏性删除入口。

### SQLite 表

| 表 | 字段 |
| --- | --- |
| `workspaces` | `id`, `name`, `created_at`, `updated_at` |
| `papers` | `id`, `workspace_id`, `name`, `created_at`, `updated_at` |
| `conversations` | `id`, `workspace_id`, `name`, `pi_session_file`, `created_at`, `updated_at` |
| `conversation_runs` | `id`, `conversation_id`, `request_hash`, `status`, `started_at`, `finished_at`, `error_code` |

前三张表是业务登记。第四张表只解决一个实际问题：发送响应丢失或重启后，不能把同一次请求再次交给模型。它只保存提交身份和执行结果，不保存消息、令牌流、工具历史或调度队列。

`conversation_runs.id` 是浏览器生成的请求 ID；状态限于 `accepted / running / completed / cancelled / failed / interrupted`。没有重试次数、优先级、执行器类型等通用任务字段。

为每段对话的 `accepted / running` 记录建立部分唯一索引，数据库直接保证同一对话只有一个未结束执行。终态更新使用条件更新，已经完成的结果不会被晚到的停止请求改成取消。

外键保持归属关系，ID 唯一约束处理重复创建，SQL 事务处理数据库内部的一致性。论文目录由工作区和论文 ID 推导，不增加可编辑目录字段。接口访问论文或对话时校验它属于 URL 中的工作区。

## 6. 本地数据布局

```text
<APP_DATA_DIR>/
├── app.sqlite
├── workspaces/
│   └── <workspace-id>/
│       ├── papers/
│       │   └── <paper-id>/
│       │       ├── article.pdf
│       │       ├── source/
│       │       │   ├── main.tex
│       │       │   └── figures/
│       │       └── supplement.csv
│       └── shared-materials/
├── pi/
│   ├── auth.json
│   ├── models.json
│   └── sessions/
│       └── <conversation-id>/
├── imports/
│   └── <request-id>.json
└── staging/
```

默认 `APP_DATA_DIR` 是仓库根目录下的 `.local/`，整个目录忽略提交；也可以由环境变量指定绝对路径。名字只存在登记与界面中，目录使用稳定 ID，避免改名搬动大量文件。

`papers/` 下的登记根目录由应用创建；论文根目录内部和工作区其他目录允许用户自由添加普通文件。用户通过文件管理器加入的文件刷新即见；直接搬走已登记论文的根目录，会显示“目录不存在”，不会偷偷重建为空目录并掩盖问题。

`imports/` 中的记录仅保存一次导入的目标、文件相对路径、哈希及结果，用于重复请求核验和导入恢复，不充当资源索引。数据库、认证信息、Pi 会话和导入临时文件均在工作区之外，AI 文件工具只能访问工作区材料。

## 7. 文件导入与阅读

### 导入

提供文件选择和目录选择。文件可以导入工作区公共目录或指定论文；目录上传保留相对路径。单文件可以直接进入目标目录；多文件导入作为一个命名材料目录整体加入，避免逐个提交造成半完成状态。

流程固定为：校验路径与目标 → 流式写入同一数据盘的暂存目录 → 计算 SHA-256 → 核验完整性并保存提交计划 → 重命名提交 → 保存导入结果。

同一个请求 ID 重复提交时，核验请求和最终目录，返回同一个结果；内容不一致则报冲突。已有文件不静默覆盖。目录同名时使用新的顶层目录名，保留内部相对引用；整批内容相同则提示已经存在。初始限制为单文件 256 MiB、单批 1 GiB，超限给出明确错误，不尝试读入全部内存。

目录提交和 SQLite 不构成跨系统事务。这里选择可核验的文件提交：导入记录写明预定目标与哈希，崩溃恢复时检查最终目录；完整且匹配才确认成功，未提交的暂存目录才允许清理。不给“跨文件系统绝对原子”承诺，不自动删除有用户内容的目录。

新建工作区和论文同样使用稳定创建 ID：建立新目录并登记，失败只回收本次创建且仍为空的目录；启动时核验未登记目录，不把遗留目录冒充成功创建。并发创建和导入只需该进程中对应目标的短临界区，不建设通用锁服务。

### 阅读

| 内容 | V1 行为 |
| --- | --- |
| PDF | 页码、缩放、文字层、浏览器文字选择；按需加载页面 |
| TeX、Markdown、代码、普通文本 | 只读文本预览；过大文件明确截断并提供下载 |
| 常见图片 | 图片预览 |
| 目录 | 展开真实子目录 |
| 其他或无法解析的文件 | 显示名称、大小及下载入口 |

PDF 路由支持字节范围请求，不把大型 PDF 转成 Base64。预览失败只影响该文件，并显示具体错误。第一版不引入富文本编辑器；文本修改由 AI 文件工具或用户已有编辑器完成。[PDF.js 官方说明](https://mozilla.github.io/pdf.js/getting_started/)

## 8. Pi 对话与工具

### 会话归属和持久化

`create-pi-session.ts` 直接调用 Pi SDK，明确指定工作区 `cwd`、应用自己的 `agentDir`、会话存储目录、模型、资源加载及工具集。会话文件路径由 Pi 返回后登记，不自行生成或解析其内部文件格式。

应用拥有自己的资源配置，不自动执行材料目录中的扩展代码，也不隐式加载用户全局 Pi 扩展。只传入本工作台需要的系统说明、工具和上下文；不构建可配置资源加载平台。

消息和工具历史从 Pi 的 `SessionManager` 恢复，不把界面缓存写成第二份历史。压缩沿用 Pi 的实现；第一版没有分支操作，所以一段对话保持一个活动分支。[Pi SDK 会话说明](https://pi.dev/docs/latest/sdk)、[完整控制示例](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/examples/sdk/12-full-control.ts)

### 单次发送

1. 浏览器提交请求 ID、文字、模型 ID 和材料引用。
2. 服务端校验请求和工作区归属；相同 ID 与相同内容直接返回已有执行，相同 ID 与不同内容报冲突。
3. 对新执行检查模型可用性、材料路径与哈希。该对话已经运行时，新请求返回忙碌，不隐式排队。
4. 登记执行，取得这个对话的 Pi 会话，先订阅事件，再调用 `prompt()`。
5. 发给模型的用户消息包含原始提问和材料路径；所附材料版本以实际读取的字节哈希为准。默认不把整个目录和所有 PDF 塞进上下文。
6. 完成、取消或失败后登记实际结果；Pi 保存它自己的历史。

“正在执行”由服务端进程管理，不能由一个 HTTP 请求或页面组件持有。进程资源入口通过一个进程级实例复用数据库连接与会话 Map，避免路由打包和开发热更新重复创建；实施时用生产构建的发送、停止和重连链路核验这一点。

消息接口接受后返回，执行 Promise 由进程会话记录持有并负责错误收尾。会话创建中的 Promise 也按对话复用，避免同时初始化两份会话。运行结束且没有订阅者时释放会话，下次从 Pi 历史恢复；不引入定时淘汰或缓存框架。

不同对话可以分别运行；同一对话一次只运行一个请求。不建立全局任务队列，也不提供自动驾驶循环。

### 流式显示、停止和恢复

SSE 连接先在同一同步临界区订阅该对话并取得当前快照，然后发送快照与后续增量。浏览器每次重连以新快照替换旧状态，序号只在本进程内用于丢弃重复事件，不保存通用事件日志。

Pi 事件转换集中在一个文件：文字、思考摘要、工具开始与结果、错误及结束。不会把 Pi 的所有内部对象直接暴露给界面，也不实现另一套模型协议。运行结束依据 `prompt()` 的完成及 Pi 的 settled 语义，不把低层 `agent_end` 当成整个请求完成。[Pi SDK 生命周期](https://pi.dev/docs/latest/sdk)

关闭 SSE 只解除该连接的订阅，不取消 AI。停止按钮调用独立接口，等待 `abort()` 结束后更新状态。重复停止返回当前状态。工具接收取消信号；文件提交一旦完成就保留，取消不假装撤销已写入的成果。

若停止发生在会话尚未创建完时，先记住该执行的取消信号；创建完成后禁止进入 `prompt()`。每次终态转换核验执行 ID，旧执行的结束通知不能覆盖新执行的状态。

重启后恢复 Pi 已保存的历史，把数据库中未结束的执行标为 `interrupted`，清楚显示执行中断。不会自动重新发送，也不承诺恢复崩溃前尚未保存的逐字增量。已有请求 ID 的重试只返回中断记录；用户明确再次发送时才生成新 ID。

### V1 具体工具

| 工具 | 能力 |
| --- | --- |
| `list_workspace_files` | 列出指定相对目录 |
| `read_workspace_text` | 分段读取文本，返回路径与内容哈希 |
| `read_pdf_pages` | 按页提取 PDF 文字，返回页码、路径与哈希 |
| `write_workspace_text` | 创建文本；覆盖已有文本必须带预期哈希 |
| `edit_workspace_text` | 在预期版本上执行明确文本替换 |

工具是具体函数注册到 Pi，不建 `ToolRegistry` 或工具基类。它们复用文件功能里的路径解析、读取和原子写入函数；HTTP 与 AI 不各写一份文件逻辑。PDF 提取直接复用 PDF.js，扫描 PDF 明确报告缺少可提取文字。

文件工具没有任意命令执行入口。`cwd` 本身不是隔离边界；代码核验相对路径、真实父目录、符号链接和 Windows junction，拒绝跳出工作区。应用登记、Pi 状态及凭据因此不能通过这些工具写入。第一版不执行材料中的代码，但并不把这层路径校验宣传为操作系统沙箱。

文本写入采用临时文件和替换，编辑前核验哈希。同一应用中的写入按目标串行；外部编辑器仍可能并发修改，检测到版本差异即报冲突，不声称可以锁住外部进程。多文件工具暂不提供，因此不存在模型调用一次写半套工程的隐式行为。

### 模型配置

服务端通过应用独立的 Pi `auth.json`、`models.json` 和环境变量读取配置。界面只显示已经配置可用的模型，并允许每次发送选择模型；运行期间禁止切换该运行的模型。凭据不返回浏览器。

第一版不做凭据管理界面或 OAuth 登录流程。没有可用模型时，材料功能仍可用，对话显示准确的配置提示。兼容端点交给 Pi 原有模型配置，不写自己的供应商适配器。

## 9. 页面与交互

路由只有首页 `/` 和工作区 `/workspaces/[workspaceId]`。活动论文、文件相对路径与对话使用查询参数表达，方便刷新和直接打开；文件路径需要编码。

桌面工作区采用三栏：

```text
┌────────────────┬───────────────────────┬──────────────────────┐
│ 工作区切换      │ 文件名 / 阅读工具栏    │ 对话切换 / 模型选择   │
│ 新建论文        │                       │                      │
│ 论文列表        │ PDF / 文本 / 图片     │ 消息与工具执行       │
│ 当前论文文件树  │                       │                      │
│ 公共材料        │                       │ 材料引用 / 输入 / 停止│
└────────────────┴───────────────────────┴──────────────────────┘
```

左侧管理材料，中央保持当前阅读位置，右侧切换对话。选择材料后通过“加入对话”形成引用标签，不把选择文件等同于立即发给模型。多篇论文可同时引用；移除标签只改变当前待发送内容。

新建工作区、论文和对话用小对话框，只要求名称。文件树提供导入和刷新。较窄窗口通过按钮切换材料、阅读和对话面板，不另做移动端应用。

服务端页面提供初始登记数据；客户端只保存当前展开节点、阅读位置、输入框和当前流式状态。初期不引入全局 Store；需要共享的同一工作区交互状态放在工作台父组件。

## 10. HTTP 接口和契约

所有接口位于 `/api`，JSON 输入、输出定义放在对应功能的 `*-schema.ts`。浏览器类型从这些结构推导；OpenAPI 从相同结构生成并测试，禁止再手写平行字段定义。Pi 事件的界面结构也在对话结构文件中定义。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /api/workspaces` | 工作区列表 |
| `POST /api/workspaces` | 创建，传入稳定 ID 和名称 |
| `PATCH /api/workspaces/:workspaceId` | 改名 |
| `GET /api/workspaces/:workspaceId/papers` | 论文列表 |
| `POST /api/workspaces/:workspaceId/papers` | 创建论文 |
| `PATCH /api/workspaces/:workspaceId/papers/:paperId` | 论文改名 |
| `GET /api/workspaces/:workspaceId/files?path=…` | 列出目录 |
| `GET /api/workspaces/:workspaceId/file?path=…` | 文件流或下载，支持 Range |
| `POST /api/workspaces/:workspaceId/imports` | 流式导入，包含请求 ID 和相对目标 |
| `GET /api/workspaces/:workspaceId/conversations` | 对话列表 |
| `POST /api/workspaces/:workspaceId/conversations` | 创建对话 |
| `PATCH /api/workspaces/:workspaceId/conversations/:conversationId` | 对话改名 |
| `GET /api/workspaces/:workspaceId/conversations/:conversationId` | 历史与当前执行状态 |
| `POST /api/workspaces/:workspaceId/conversations/:conversationId/messages` | 接受消息，返回执行 ID |
| `GET /api/workspaces/:workspaceId/conversations/:conversationId/events` | SSE 快照与增量 |
| `POST /api/workspaces/:workspaceId/conversations/:conversationId/stop` | 停止当前执行 |
| `GET /api/models` | 已配置模型的公开信息 |
| `GET /api/openapi` | 生成的接口契约 |

路由只做解析、调用和响应映射；业务函数也供服务端页面及工具直接调用。HTTP 入口拒绝异源写请求，不开启宽泛 CORS。文件路由校验路径，并对非预览类型使用下载响应，避免把上传 HTML 当应用页面执行。

预期错误使用少量明确代码：输入无效、对象不存在、冲突、对话忙碌、材料已变化、模型不可用。未知异常统一返回请求标识并记录原始错误。没有统一 `Result<T>`、异常基类树或全系统错误工厂。

## 11. 目录和文件职责

采用 Next.js 原生路由文件名，业务文件直接表达功能。下面是计划目录；实际实现按需要建立文件，不生成空文件来填满模板。

```text
/
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   ├── globals.css
│   │   ├── workspaces/[workspaceId]/
│   │   │   ├── page.tsx
│   │   │   ├── loading.tsx
│   │   │   └── error.tsx
│   │   └── api/                         # 与接口表对应的 route.ts
│   ├── features/
│   │   ├── workspaces/
│   │   │   ├── workspace-schema.ts
│   │   │   ├── components/
│   │   │   │   ├── WorkspaceList.tsx
│   │   │   │   ├── CreateWorkspaceDialog.tsx
│   │   │   │   └── ResearchWorkbench.tsx
│   │   │   └── server/
│   │   │       ├── workspace-store.ts
│   │   │       └── create-workspace.ts
│   │   ├── papers/
│   │   │   ├── paper-schema.ts
│   │   │   ├── components/
│   │   │   │   ├── PaperList.tsx
│   │   │   │   └── CreatePaperDialog.tsx
│   │   │   └── server/
│   │   │       ├── paper-store.ts
│   │   │       └── create-paper.ts
│   │   ├── files/
│   │   │   ├── file-schema.ts
│   │   │   ├── components/
│   │   │   │   ├── WorkspaceFileTree.tsx
│   │   │   │   ├── ImportFilesDialog.tsx
│   │   │   │   ├── ResourcePreview.tsx
│   │   │   │   ├── PdfViewer.tsx
│   │   │   │   └── TextFilePreview.tsx
│   │   │   └── server/
│   │   │       ├── resolve-workspace-path.ts
│   │   │       ├── list-workspace-files.ts
│   │   │       ├── read-workspace-file.ts
│   │   │       ├── import-workspace-files.ts
│   │   │       ├── recover-file-imports.ts
│   │   │       ├── write-workspace-text.ts
│   │   │       └── extract-pdf-text.ts
│   │   └── conversations/
│   │       ├── conversation-schema.ts
│   │       ├── components/
│   │       │   ├── ConversationPanel.tsx
│   │       │   ├── ConversationList.tsx
│   │       │   ├── CreateConversationDialog.tsx
│   │       │   ├── ConversationMessages.tsx
│   │       │   ├── ConversationComposer.tsx
│   │       │   └── ToolExecutionMessage.tsx
│   │       ├── hooks/
│   │       │   └── use-conversation-stream.ts
│   │       └── server/
│   │           ├── conversation-store.ts
│   │           ├── conversation-run-store.ts
│   │           ├── create-conversation.ts
│   │           ├── create-pi-session.ts
│   │           ├── create-pi-resources.ts
│   │           ├── read-conversation-history.ts
│   │           ├── send-conversation-message.ts
│   │           ├── stop-conversation-run.ts
│   │           ├── build-material-context.ts
│   │           ├── map-pi-event.ts
│   │           └── tools/
│   │               ├── list-workspace-files-tool.ts
│   │               ├── read-workspace-text-tool.ts
│   │               ├── read-pdf-pages-tool.ts
│   │               ├── write-workspace-text-tool.ts
│   │               └── edit-workspace-text-tool.ts
│   ├── server/
│   │   ├── read-app-config.ts
│   │   ├── open-app-database.ts
│   │   ├── initialize-app-database.ts
│   │   ├── app-runtime.ts
│   │   └── pi-session-registry.ts
│   ├── shared/
│   │   ├── ui/                         # 实际使用的基础界面组件
│   │   └── http/
│   │       ├── api-error.ts
│   │       └── generate-openapi.ts
│   └── instrumentation.ts
├── tests/
│   └── e2e/
├── docs/
│   └── v1-design.md
├── public/
├── package.json
├── package-lock.json
├── next.config.ts
├── tsconfig.json
├── vitest.config.ts
├── playwright.config.ts
├── .env.example
├── .gitignore
├── AGENTS.md
└── README.md
```

数据库建表 SQL 与初始化放在 `initialize-app-database.ts`，不做迁移框架。开工使用独立新数据目录；V1 发布后的数据结构变更再按真实需要增加明确迁移。

`*-store.ts` 是具体 SQL 文件，相关读取、更新可以共存。只有带独立流程的操作才单独成文件，例如目录加登记、流式导入、发送消息。文件不能只是把参数原样转发给下一层。

功能间允许直接依赖明确函数，例如对话功能调用文件读取；文件功能不反向依赖对话。工作台组件可以组合所有功能。服务端运行资源只负责接线和生命周期，不负责论文规则。没有 `domain/application/infrastructure` 的逐功能复制，没有 `common/utils` 杂物目录，没有各功能的统一导出桶。

Next.js 官方允许按功能组织业务代码；框架真正规定的是路由文件约定。本稿的 `features/` 是项目选择，不冒充框架强制哲学。[Next.js 目录说明](https://nextjs.org/docs/app/getting-started/project-structure)

## 12. SOLID 与代码复杂度约束

| 原则 | 本项目的具体执行方式 |
| --- | --- |
| 单一职责 | 路由处理传输，SQL 文件处理登记，Pi 文件处理会话，预览组件处理显示 |
| 开闭原则 | 对已经出现的变化通过增加具体预览组件或工具扩充；固定依赖允许直接修改 |
| 里氏替换 | 不人为建立实现继承树；遵守 React、Pi 等实际接入契约 |
| 接口隔离 | 具体函数接收所需参数，组件获得所需数据，不传入万能 AppContext |
| 依赖倒置 | 业务代码不依赖 HTTP 请求对象；使用框架与 Pi 已有边界，不为单一 SQLite 实现制造端口 |

SOLID 用来检查职责和耦合，不要求每个原则都生成一个接口。一个清楚的具体函数，可以比三层接口更符合当前项目。

实施和评审遵守以下规则：

- 新抽象必须指出当前存在的多种实现或重复业务规则；“将来可能需要”不能作为唯一依据。
- 类只在需要持有生命周期状态时考虑。大部分业务用普通函数；不建立 BaseService、Manager 层级。
- 不为了文件数量拆开同一条短流程；只有独立职责、独立状态或可单独验证的行为才拆分。
- 只在外部边界校验输入。通过校验的内部数据不再层层做相同检查。
- 缺失必需配置、坏数据库和错误会话要明确失败；不使用默认空对象、空数组或静默 catch 把它们伪装成成功。
- 只捕获能转成业务结果、完成清理或增加诊断的错误。不要每层 catch、包装后再抛出。
- 对未知异常保留原始原因；不能把错误一律变成“未知错误”，再用日志输出多个包装副本。
- 类型表达已知状态；避免 `any`、宽泛可选字段、万能 metadata 和不必要的非空断言。
- 只对暂存目录、取消、订阅、数据库事务等真实资源使用清理逻辑；不为纯函数加入恢复框架。
- 文档、测试和代码描述当前设计，不为已经不存在的产品方向保留分支。

## 13. 验证与完成标准

测试覆盖会产生实际损失或错误状态的行为。业务测试用临时 SQLite 和临时目录；接口测试验证结构与归属；浏览器测试验证真实页面。模拟模型输出来稳定验证流式时序，不为测试创建生产引擎接口；另做一次真实 Pi 与已配置模型的验证。

| 验收场景 | 必须观察到的结果 |
| --- | --- |
| 工作区、论文、对话的创建与改名 | 稳定 ID、正确归属；改名不移动材料 |
| 重复创建请求 | 同一请求返回同一对象，内容不同报冲突 |
| 导入 PDF 和含子目录的 TeX 工程 | 文件哈希匹配，相对引用及目录结构保留 |
| 中途导入失败及进程重启 | 不出现半批材料；已完成目录可以核验恢复 |
| 同名和重复导入 | 不覆盖现有材料，重复请求不重复生成材料 |
| 文件管理器加入材料 | 刷新后真实可见 |
| 非法路径、链接及 junction | 不能读取或写入工作区外文件 |
| AI 阅读 PDF 和文本 | 工具返回实际路径、页码与内容哈希 |
| AI 修改文本 | 正常原子写入，过期哈希报冲突 |
| 两个页面同时发送同一对话 | 只有一个运行，新请求明确忙碌 |
| 重复发送、发送响应丢失 | 相同请求不再次调用模型 |
| SSE 断开与重连 | AI 继续，界面恢复快照，不重复拼接回答 |
| 停止工具调用及重复停止 | 等待实际取消，保持已完成文件与真实终态 |
| 应用重启 | 恢复已保存历史，未结束运行显示中断，不自动重发 |
| 失败和审计核验 | 登记数据、导入记录、执行记录与 Pi 工具历史能解释实际结果 |
| 生产构建在 Windows 启动 | SQLite 原生依赖、PDF worker、Pi、SSE 均在生产进程正常工作 |

标准命令：`npm run typecheck`、`npm run lint`、`npm test`、`npm run test:e2e`、`npm run build`。通过检查后还要在生产启动方式下完成一轮真实使用，不把开发服务器正常当作生产运行正常。

没有可用模型凭据时，可以完成材料和模拟时序验证，但必须明确注明真实模型调用未验证，不能宣称全部完成。

## 14. 实施顺序与现有仓库处理

批准实施后按以下顺序落地：

1. 先核验 Next.js、Pi 1.0.0、SQLite 和 PDF.js 在当前 Windows 环境能安装、构建和运行；尤其验证跨路由的会话实例复用。发现阻断先解决，不建设业务空架子。
2. 建立应用入口、真实数据目录和工作区／论文登记，完成创建、改名、刷新文件树。
3. 完成目录导入、PDF／文本预览和下载，验证完整性及失败恢复。
4. 接入 Pi 持久化对话、材料引用、流式显示、文件工具与停止。
5. 完成重连、重启和重复请求验证，再整理目录、依赖、启动文档与仓库指南。

源码切换前保存当前可恢复的 Git 状态，保留许可证；确认源码新入口可运行后删除被替换的实现。产品源码最终集中在 `src/`，移除旧启动链和无用依赖，不保留两套应用。

当前克隆的新建资料不能因历史上的旧数据清理授权而删除。新应用默认使用独立 `.local/`，不覆盖已有后端或 DSH 数据。第一版不开发旧接口兼容或自动数据迁移；已有材料可以作为普通文件导入。若实施确实需要处置现有数据，先核实并获得明确范围授权。

`AGENTS.md`、`README.md` 与实际功能清单随实现同步维护，源码目录、契约来源、Pi 归属和检查命令保持一致。

若采用一个小时的集中迭代，先保证“工作区 → 论文材料 → 读取 → Pi 对话”的可运行链路，再补齐本稿约定的其他行为和验证。时间到达不降低完成标准；按实际完成与验证状态交付，未完成项明确列出，不承诺本稿所有功能必然在一个小时内完成。

## 15. 最终复杂度预算

第一版是一个 Next.js 应用、四个业务功能目录、一个 SQLite 文件、一套真实材料目录和 Pi 会话。增加的持久记录只有材料导入结果和对话执行结果，分别对应文件完整性与重复发送两个实际问题。

代码增长围绕具体行为：新增预览组件、新增工具、新增业务函数。没有存储替换平台、智能体替换平台、领域框架、通用任务系统或通用插件系统。判断一个设计是否该进入 V1 的依据是：它是否直接服务本稿中的某条使用链路或可验证的失败场景。
