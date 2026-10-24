# 科研工作台

单用户本地科研工作台。工作区组织论文、真实材料和多段 AI 对话；智能体使用 Pi 的原生文件与命令工具完成研究任务。

## 启动

需要 Node.js 24 或更高版本：

```powershell
npm ci
npm run tex:setup
npm run build
npm start
```

打开 http://127.0.0.1:8642 。开发使用 `npm run dev`。应用监听回环地址，同一个数据目录只运行一个实例；其他端口可用 `npm start -- --port 8787`。

## 文件原生工作区

应用不使用数据库。数据默认在 `.runtime/data/`，可用 `APP_DATA_DIR` 指定其他目录：

```text
<APP_DATA_DIR>/
├── workspaces/
│   └── <工作区ID>/
│       ├── workspace.json
│       ├── papers/<论文ID>/
│       ├── 其他文件与目录
│       └── .pi/sessions/<对话ID>.jsonl
├── pi/
│   ├── models.json
│   ├── auth.json
│   └── device-id.json
├── speech.json
└── translation.json
```

上传暂存独立放在项目 `.runtime/temp/`，请求结束后清理，不随用户资料备份。

`workspace.json` 保存工作区的 `id/name/createdAt/updatedAt` 和 `papers` 数组。每篇论文包含 `id/name/path/createdAt/updatedAt`；`path` 是工作区内的相对目录，可以直接编辑。应用读取时校验配置，格式错误会明确报告。

材料直接来自文件系统，不要求登记或固定后缀。文件和配置变化会更新材料列表及相关预览；未知后缀可选择“以文本预览”。对话标题、消息与工具历史保存在 Pi 原生 JSONL 中。工作区整体复制到另一个数据目录的 `workspaces/<同一ID>/` 后，即可继续读取材料和对话。

## 模型配置

对话区模型选择旁的“模型设置”和右上角“设置 → 模型”打开同一个设置窗口；输入区入口直接切到模型分类。窗口尺寸固定，切换分类或展开语音表单时只让内容在窗口内滚动，不改变窗口大小。OpenAI 中选择“用 ChatGPT 登录”，在浏览器完成授权后更新模型；支持取消、刷新后继续查看授权、重新连接和断开。回调未自动完成时，可按面板提示粘贴最终回调地址。

同一面板的“语音输入”可使用 ChatGPT 授权进行实时转写，也可添加独立的 OpenAI 兼容语音服务。每条自定义连接保存名称、接口地址、模型、连接协议和可选 API 密钥；实时转写使用 WebRTC，文件转写在录音结束后上传。密钥保存在本机 `<APP_DATA_DIR>/speech.json`，读取设置时只返回是否已保存。输入区麦克风按钮在点按后申请权限，识别文字先进入可编辑草稿，不自动发送。

授权用于连接模型服务，工作台直接打开。符合条件的 ChatGPT 账号能否使用订阅额度，以实际授权和返回模型为准；仅列出账号允许且 Pi 支持的模型。[OpenAI 接入说明](https://developers.openai.com/siwc/token-sharing-open-source)

其他供应商可使用 Pi 的环境变量，例如：

```powershell
$env:OPENAI_API_KEY = '你的密钥'
npm start
```

也可写入未提交的 `.env.local`。兼容接口在 `<APP_DATA_DIR>/pi/models.json` 中配置：

```json
{
  "providers": {
    "research-model": {
      "baseUrl": "https://your-provider.example/v1",
      "api": "openai-completions",
      "apiKey": "$RESEARCH_MODEL_API_KEY",
      "models": [{ "id": "your-model-id", "name": "研究模型" }]
    }
  }
}
```

修改配置后重启应用。模型连接在本机各工作区间共用，每个供应商保存一份 Pi 凭据；某个供应商的目录失败会单独显示错误，其他供应商仍可使用。没有工作区专属模型白名单。[Pi 配置说明](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/models.md)

## 使用与工具

- 创建工作区、论文和多段对话，支持改名；改名保留目录身份。
- 导入文件或完整目录，保留 TeX 相对引用。同名另存，导入不比较文件内容。
- 阅读 PDF、文本和图片；PDF 支持连续滚动、单页、目录、缩放、反色和文字选择。
- Markdown 和 HTML 可切换源码／预览；Markdown 支持公式与表格，HTML 支持同目录样式、脚本和图片。
- 当前文件与 PDF 页码自动进入对话上下文，支持模型选择、流式回答、工具结果和停止回答。
- 输入区语音按钮把说话转成可编辑草稿，支持实时与结束后两种转写、取消和错误恢复，不自动发送。录音、连接、整理等状态由按钮本身呈现，不额外占用一行。
- 使用 Pi 原生 `read/write/edit` 和命令执行。Windows 使用 PowerShell，其他系统使用 Bash。
- 额外提供 `get_workspace_context` 读取论文目录与项目 TeX 环境路径、`read_pdf_pages` 按页读取 PDF，以及 `open_document` 控制中间阅读区。

## 项目独立 TeX

`npm run tex:setup` 在项目 `.runtime/env/tex/` 安装固定版本 Tectonic 0.17.0、中文字体及基础资源缓存，首次安装需要联网。支持 Windows x64、Linux x64/arm64 和 macOS x64/arm64。运行文件不提交 Git，换机器后重新执行安装命令。项目不要求安装系统 TeX，不使用系统宏包或中文字体。

```powershell
$tex = (Resolve-Path '.runtime/env/tex').Path
$env:TECTONIC_CACHE_DIR = "$tex/cache"
$env:FONTCONFIG_FILE = "$tex/fonts.conf"
Set-Location 'path/to/project'
New-Item -ItemType Directory -Force build | Out-Null
& "$tex/tectonic.exe" -b 'https://data1b.fullyjustified.net/tlextras-2022.0r0.tar' -Z "search-path=$tex/fonts" --keep-logs --synctex --outdir build main.tex
```

直接调用原生 Tectonic，在主文件目录编译，保留 PDF、日志和 SyncTeX。Linux 和 macOS 使用同目录下的 `tectonic`。未缓存宏包从固定资源库按需获取，`--only-cached` 仅使用项目缓存。预装引擎兼容 XeTeX，不附带 LuaLaTeX、Biber 或其他外部程序；AI 可以按工程需要补充环境。

Pi 会话显式加载 `src/features/latex/skills/document-workbench/SKILL.md`，其中包含源码翻译、原生编译、包管理、中文字体、错误日志及展示产物的方法。AI 通过工作区上下文取得运行目录和程序的绝对路径，自行使用原生命令及包管理器，不强制特定引擎或脚本。技能要求所有新增程序、依赖、配置、下载及缓存放在 `.runtime/env/tex/`，源文件和编译产物保存在工作区；应用不增加命令路径拦截或专用编译工具。生成后可用 `open_document` 请求展示工作区文件，Markdown／HTML 可选 `source` 或 `preview`，PDF 可指定页码。

HTML 预览在与工作台同源的 iframe 中运行，开放普通网页脚本、相对资源、存储、表单、下载、弹窗与全屏能力，不设置额外 sandbox。页面与工作台之间不构成权限隔离；网络、设备授权及弹窗仍遵循浏览器规则。Agent 的文档技能说明文件打开方式、客户端网络位置、接口访问与重载边界。当前入口展示工作区文件，不提供通用代理、页面消息桥接或服务进程托管；切换文件会重新加载页面。

Markdown 超链接和直接输出的 HTTP／HTTPS 地址均可点击，请求在浏览器新标签页打开，实际行为由客户端决定。远程设备使用的服务地址必须能从该设备访问，不能把服务端的 localhost 当作远程入口。

PDF 工具栏提供“框选提问”：触屏或鼠标拖动选区，也可依次点按两个对角，确认后加入当前对话的输入区。截图可放大预览、移除，与问题一起发送；未创建对话时自动创建。每次最多发送六张，文件名和页码随图进入模型上下文。截图按 PDF 原色重新渲染，不受阅读反色影响；仅支持图片的模型可发送。发送失败保留草稿，已发送图片保存在 Pi 原生历史中，刷新后可查看。

## 论文翻译

Pi 显式加载 `paper-translation` 技能。用户要求优先；默认依次查找同版本 TeX 工程、官方 HTML，最后对 PDF 使用 PaddleOCR-VL-1.6。执行翻译前确认由当前助手阅读全文翻译，还是调用用户选定的已注册模型。OCR 默认输出重排 HTML 和 Markdown，也可生成保留版式及原译交替的 PDF。

```powershell
npm run ocr:setup
npm run translation:setup
```

OCR 的独立 Python、依赖、模型和缓存位于 `.runtime/env/ocr/`，翻译渲染环境位于 `.runtime/env/translation/`，TeX 位于 `.runtime/env/tex/`。三者不依赖其他项目或全局 Python 环境。OCR 安装当前支持 Linux x64 和 Windows WSL Ubuntu；默认 CUDA 12.9 GPU，CPU 使用 `npm run ocr:setup -- --device cpu`。需要对应显卡驱动和 Linux 运行库；OCR 安装使用项目内 uv、独立 Python 及锁文件，首次下载包含较大的 GPU 运行库与模型。翻译环境通过 uv 初始化，解释器和缓存同样安装在项目 Runtime 内。

`get_workspace_context` 返回翻译、OCR 和模型调用命令。OCR 直接使用原生 `python -m paddleocr doc_parser`，安装程序将模型、缓存及设备参数写入 `.runtime/env/ocr/installation.json`；命令后追加 `--input` 和 `--save_path`，Windows 输入输出使用 WSL 路径。固定 Python 流程负责调用 OCR、转换路径、归一化坐标及阅读顺序、全文块翻译、结果校验、HTML／Markdown 渲染和 PDF 回填。模型调用通过 Pi SDK 复用供应商配置与服务端凭据；整篇容量足够时一次发送全部块，否则按连续块分批并携带上下文和术语。保存请求、原始响应及已完成译块，主助手可修复外部结果后直接继续渲染。

HTML 模板提供目录、本地公式渲染、原文对照、明暗外观和打印。PDF 使用 PyMuPDF 保留原图和独立公式，以项目 TeX 排版译文并按原坐标回填，输出缩放报告。PDFMathTranslate 仅作功能研究参考；没有使用其翻译内核，复杂论文的识别、版式和译文质量需要实际核验。

## 工作区界面与执行

界面支持桌面和横屏平板，启动恢复上次的工作区与阅读位置。左上角切换或新建工作区，点击名称直接改名；右上角切换明暗主题。侧栏在栏内收起，也可拖动分隔线调整宽度、继续向边缘拖动后松开收起；主题及布局会在浏览器记住。工作区是智能体的默认目录；命令及文件访问权限由运行账号和部署环境决定。应用没有智能体沙盒，隔离需求应在部署环境中实现。

右上角“设置”包含“外观”和“模型”两个分类。窗口使用固定尺寸，分类内容在窗口内滚动。“外观”提供跟随系统、浅色与暗色模式。浅色和暗色分别保存三个预设与一份自定义 CSS：浅色为纸白、Nord Snow、Catppuccin Latte，暗色为石墨灰、Nord、Catppuccin Mocha。选择“自定义 CSS”后可编辑、导入和导出，选择预设后保留 CSS 内容并使用预设样式。切换明暗或跟随系统时恢复对应模式的选择，互不覆盖。这些偏好保存在当前浏览器，不写入工作区文件。“模型”分类与对话区的模型设置入口共用同一个窗口和同一份对话模型、语音输入配置。

配色参考 [GitHub Primer](https://primer.style/product/primitives/color/)、[Nord](https://www.nordtheme.com/docs/colors-and-palettes/) 和 [Catppuccin](https://github.com/catppuccin/catppuccin/blob/main/docs/style-guide.md)，按工作台界面映射颜色角色。自定义 CSS 可使用 `:root { --accent: #a5b4fc; }` 覆盖强调色，也可调整字体、圆角和间距。

应用不维护材料内容哈希或原子写入协议。元数据直接写入配置文件，普通材料由文件系统和原生工具管理。浏览器接口仍校验路径、来源和上传大小。

同一对话只运行一个请求。刷新页面可以恢复当前进程中的回答状态；页面断开不停止回答。停止等待实际取消。运行状态和最近请求的去重信息保存在内存中，重启后读取已有历史，不自动继续或重发；跨重启再次发送会作为新执行处理。

## 代码与验证

日常开发查看 `src/`，测试集中在 `tests/`，使用说明与当前边界在本文件：

```text
src/
├── app/        页面、工作台和 HTTP 路由
├── features/   按业务组织的界面与服务端代码
├── server/     应用配置与进程接线
└── shared/     跨业务复用的基础代码
tests/         接口、命令行与浏览器测试
```

本机运行内容集中在 `.runtime/`：

```text
.runtime/
├── env/
│   ├── tex/           TeX 程序、字体和缓存
│   ├── ocr/           OCR 解释器、依赖、模型和缓存
│   └── translation/   翻译渲染解释器、依赖和缓存
├── data/              用户材料、对话、凭据与配置
├── temp/              上传暂存
└── dev/               测试数据、截图和调试产物
```

`env/` 可通过安装命令重建，`data/` 保存持久资料，应单独备份。`dev/` 保存独立测试工作区、浏览器截图、报告和人工验收材料，正式应用默认运行不依赖它；自动化测试的数据与产物可重新生成，真实模型验收记录按需留存。浏览器测试产物位于 `.runtime/dev/playwright/`。`.next/` 和 `node_modules/` 分别是构建缓存与依赖，TypeScript 增量缓存位于 `.next/cache/`。

`src/features/files/copy-pdf-assets.mjs` 在开发启动和生产构建前，把当前安装的 PDF.js 后台解析程序、字符映射、字体和图像解码资源发布到 `public/pdf-assets/`，供浏览器按 URL 加载。资源自动生成并忽略提交；安装依赖时不复制。

`app/api/` 的目录对应接口 URL，层级由 Next.js 文件路由决定。业务模块仅按实际职责拆文件：简单元数据操作集中存放，界面与服务端代码分开；技能、固定提示词和运行脚本随对应功能保存。

产品源码在 `src/`：

| 目录 | 职责 |
| --- | --- |
| `app/` | 页面、工作台组合、HTTP 和 OpenAPI |
| `features/workspaces/`、`papers/` | 工作区配置与论文元数据 |
| `features/files/` | 浏览、预览、上传及文件变化事件 |
| `features/latex/` | 项目 TeX 安装、编译入口与文档技能 |
| `features/ocr/` | 项目独立 PaddleOCR 安装、模型与识别命令 |
| `features/translation/` | 翻译技能、固定提示词、HTML 模板及翻译渲染流程 |
| `features/conversations/` | Pi 会话、工具、执行、取消、历史和流式事件 |
| `features/models/` | 模型运行环境、供应商连接和授权 |
| `features/speech/` | 语音来源、凭据边界、实时 SDP 与文件转写 |
| `features/settings/` | 外观预设、模型设置入口与浏览器偏好 |
| `server/` | 配置与进程接线 |
| `shared/` | 共享结构、HTTP 辅助和基础界面 |

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

测试以 HTTP 或命令行接口为最小粒度，集中在 `tests/api/`、`tests/commands/` 和 `tests/e2e/`。`npm test` 通过 Route Handlers 的 Request／Response 接口验证业务行为，并实际启动模型调用命令；浏览器测试使用生产服务验证完整交互。测试使用独立的 `.runtime/dev/` 数据、真实 Pi SDK 和模拟外部服务，不直接测试内部辅助函数、类或事件映射。已安装翻译环境时，可使用该环境的 Python 执行 `tests/commands/test_translation.py`，验证翻译命令的输入、产物和外部响应错误。

`tests/manual/` 保存按需执行的人工验收脚本：`agent-workflow.mjs` 使用真实模型验证技能流程，`speech-auth.mjs` 验证当前授权的语音接口，`translation-preview.mjs` 检查翻译 HTML 的浏览器渲染。它们不加入默认测试，输出写入 `.runtime/dev/`；真实服务调用仅在明确需要对应验收时执行。

ChatGPT 授权通过系统分配的可用回环端口自动返回，也可粘贴完整回调地址。真实账号授权及模型目录读取已核验；真实平板麦克风、其他账号权限、外部模型回答质量、凭据续期和真实自定义实时服务仍需实测。接口契约通过 `GET /api/openapi` 获取。

## 当前边界

- 长文翻译的完整性、HTML 数学内容与图片保真、PDF 表格公式及缩放后的可读性尚未通过完整质量验收。
- 上传单文件 256 MiB，每批 1 GiB，最多 1,000 个文件。复制阶段失败可能留下部分文件，不提供导入事务或内容去重账本。
- 网页文本预览上限 16 MiB，先显示前 100,000 字节。PDF 文字工具每次最多读取 20 页，只提取已有文字层；扫描件通过独立 PaddleOCR 命令解析。
- 实验管理、Zotero、批注、搜索与删除界面尚未实现。项目已提供文档与翻译技能、TeX 和 OCR 环境；Pi 技能及扩展的默认自动发现保持关闭。
- 语音输入只把说话转成草稿，不提供语音回答、通话、自动发送或录音存档。自定义实时服务需支持 OpenAI 兼容的 `/realtime/calls` SDP 接入；自定义文件服务需返回 `{ "text": "..." }`。麦克风需要 `127.0.0.1`、localhost 或 HTTPS 安全上下文。
- 已有资料应先备份再修改；应用不提供文件版本库或全局写入事务。

旧源码标签为 `pre-pi-rewrite-20261003`。运行数据、凭据及构建产物忽略提交，许可见 [LICENSE](LICENSE)。
