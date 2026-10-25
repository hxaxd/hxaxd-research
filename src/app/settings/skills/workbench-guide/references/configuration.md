# 配置说明

## 全部配置示例

示例逐项注明默认值、类型、范围、枚举及生效时机。任意路径、模型 ID、供应商名称和字典键属于开放输入，不存在需要穷举的固定列表。

| 配置范围 | 完整注释示例 | 实际位置 |
| --- | --- | --- |
| 平台目录、文件限制、超时、重试、事件、OCR、翻译入口 | `config.default.jsonc` | `.runtime/config.jsonc` 或 `APP_CONFIG_FILE` |
| Pi 原生供应商、模型、推理映射、图片限制、价格、缓存、请求头与协议兼容项 | [models.example.jsonc](models.example.jsonc) | `<实际 dataDir>/pi/models.json` |
| 语音选择、ChatGPT 转写模型、自定义语音连接 | [speech.example.jsonc](speech.example.jsonc) | `<实际 dataDir>/speech.json` |

模型和语音示例包含占位连接，按需选取字段，不整份替换已经在用的服务与凭据。`clearKey`、`reset` 是界面保存请求参数；`hasKey`、`recognized`、`automatic` 是响应信息，不是这些文件的配置字段。

## 查找实际文件

`get_workspace_context` 返回 `projectRoot` 和 `configuration`。从项目根目录执行 `configuration.inspectCommand` 可以读取并校验应用配置，输出解析后的路径和配置值；在命令后追加 `--defaults` 输出可配置字段的默认值。命令不修改配置。

| 配置 | 内容与加载入口 |
| --- | --- |
| `configuration.application` | 应用目录、上传与读取限制、超时、重试、事件合并、OCR 环境和翻译命令。定义与实际读取位于 `src/app/config.mjs`。 |
| `configuration.models` | 文字模型连接，沿用 Pi 原生 `models.json`。服务地址、模型定义、接口兼容选项和请求头等以当前安装的 Pi 支持范围为准。 |
| `configuration.speech` | 语音连接、转写方式、模型与当前选择。格式定义位于 `src/app/models/server/speech-connections.ts`，读取时由应用校验。 |
| Pi 目录中的 `auth.json` | SDK 管理的授权凭据。通过模型设置完成授权与断开，不把它作为普通配置编辑或输出其内容。 |

平台默认模板 `projectRoot/config.default.jsonc` 纳入 Git；`npm ci` / `npm install` 自动复制到运行配置位置，已有文件保持原样。可执行 `node src/app/config.mjs --init` 单独完成初始化。模型和语音示例中的占位连接不会自动启用。应用配置默认位于 `.runtime/config.jsonc`；`APP_CONFIG_FILE` 可以指定其他文件。应用配置的相对路径以项目根目录为准，不以当前工作区为准。不要假定 shell 已加载应用启动时的环境变量，优先使用上下文返回的实际路径。

`configFile`、`workspaceDir`、`piDir`、`stagingDir`、`texDir`、`ocrDir`、`translationDir` 是读取命令输出的派生值，不写入配置文件。工作区、Pi 和各环境的子目录随 `dataDir`、`envDir`、`tempDir` 解析。`templateDir` 是独立的运行模板目录，默认 `.runtime/templates/`。

监听地址与端口由 Next 启动命令控制，项目默认 `--hostname 127.0.0.1 --port 8642`，例如 `npm start -- --hostname 127.0.0.1 --port 8642`。平台参数只从配置文件读取；`APP_CONFIG_FILE` 仅在加载前指定文件位置，默认安装无需设置。供应商凭据的环境变量沿用 Pi 原生能力。`NEXT_RUNTIME`、`NEXT_PHASE` 等属于框架执行状态，不是平台用户配置。会话设置由平台配置组装，Pi 命令行自身的 `settings.json` 不属于工作台的配置入口。

`translation.modelsCommand` 的自定义命令需实现：`--list --model <供应商/模型ID>` 向标准输出返回 `{ "models": [{ "id": "供应商/模型ID", "contextWindow": 128000, "maxTokens": 16384 }], "issues": [] }`；调用时接受 `--model <ID> --input <请求JSON路径> --output <响应JSON路径>`，从请求读取 `system`、`prompt`、可选 `maxTokens` 和 `thinkingLevel`，将响应文本写入输出文件的 `text` 字段。失败使用非零退出码。已有原生命令支持此约定，无需另行实现。

## 模板的源文件与安装副本

默认配置在项目根目录 `config.default.jsonc`，技能、固定翻译提示词和 HTML 模板的源文件在 `src/` 中，均参与 Git 版本控制。安装入口 `src/app/install.mjs` 将它们按原有相对层次复制到 `templateDir`，例如 `app/translation/skills/paper-translation/assets/paper.html`；Agent 和翻译命令读取安装副本。`configuration.templates` 和 `translation.templates` 返回实际位置。

`npm ci` / `npm install` 以及两个一键安装脚本都会准备这些资源。单独执行 `node src/app/install.mjs` 可以更新模板而不重新安装依赖。个人运行配置仅缺失时创建；模板副本每次安装从 Git 源文件更新。长期修改默认技能、提示词或 HTML 模板时，编辑 `projectRoot/src/` 中对应源文件，再执行资源安装，不只改会被重装覆盖的副本。

## 修改范围

`network.proxy` 为 HTTP/HTTPS 代理 URL，默认 `null`，此时后台使用 `HTTP_PROXY` / `HTTPS_PROXY`（支持小写）；均未设置时直连。Windows 系统代理和浏览器代理不会自动传给 Node。`network.noProxy` 默认为 `localhost,127.0.0.1,::1`，与环境中的 `NO_PROXY` 合并。代理配置用于整个后台与原生模型调用命令，包括授权、令牌刷新、模型和语音请求；修改后重启。排查时保留状态码和错误代码，不输出凭据或完整回调 URL。

先读取实际文件，保留用户没有要求修改的字段。常用连接参数可从设置界面调整，高级参数直接采用原生配置格式。不要把当前 UI 展示的少数字段当成 Pi 配置的全部能力，也不要自创供应商不支持的参数。

应用配置使用 JSONC；Pi 模型和语音配置保留 `.json` 文件名，也支持 JSON 注释。三者均支持 `//` 和 `/* */`，不支持尾随逗号。没有原文件时，根据对应加载器创建最小配置，不把解析后的派生路径和整个默认值输出直接当成用户配置保存。

模型配置可能包含密钥或解析密钥的命令；读取、检查和报错时不要回显秘密值。解释字段时仅展示与任务相关的非敏感内容。

## 验证与生效

- 应用配置：通过 `src/app/config.mjs` 的真实加载入口验证，不能只调用 `JSON.parse`。当前应用在进程创建时读取，修改后需要重启服务；不要在当前会话中未经用户安排直接终止承载该会话的进程。
- 文字模型配置：复用当前项目安装的 Pi `ModelRuntime.create` 加载，并检查 `getError()`。Pi 可能返回一个包含错误的运行环境，而不是抛出异常。检查时关闭网络刷新和初始化可用性探测，避免为格式校验刷新真实授权、执行密钥获取命令或发出模型请求。
- 语音配置：按 `src/app/models/server/speech-connections.ts` 的实际格式加载。语音配置按请求读取；不要求重启服务。

### Pi 原生离线加载检查

在项目根目录使用 Node 的模块模式执行以下代码，替换为上下文中的模型配置路径。可以将代码写为本次任务的临时 `.mjs` 文件后执行，无需增加应用工具或调用模型 API：

```javascript
import path from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

const modelsPath = '<configuration.models>';
const runtime = await ModelRuntime.create({
  modelsPath,
  authPath: path.join(path.dirname(modelsPath), 'auth.json'),
  allowModelNetwork: false,
  refreshOnCreate: false,
});
const error = runtime.getError();
if (error) {
  console.error(error);
  process.exitCode = 1;
} else {
  console.log('模型配置加载通过');
}
```

使用项目锁定的依赖执行，临时脚本放在项目内才能直接解析该依赖。此检查不请求供应商目录、不刷新 OAuth、不解析动态密钥，也不调用模型。SDK 仍会读取本地凭据文件；不要输出凭据。错误文本可能带有原文件片段，转述给用户时去掉秘密值。

Pi 把缺失的 `models.json` 视为没有自定义模型。检查修改结果时必须指向实际写入的文件，不能把路径错误导致的默认加载当成成功。`getError()` 非空或命令失败都需要修正；可另存候选文件检查后再覆盖目标，不刷新当前会话来试错。

直接改写 `models.json` 不会自动刷新当前进程缓存的模型运行环境；设置界面保存连接时会调用 Pi 刷新。安排在活动任务结束后加载新配置，当前没有通用的外部文件重载入口。不要把“文件已写入”表述为“运行中的模型已切换”。

在修改当前会话使用的连接前说明生效时机。配置检查与连接测试分开：本地加载通过后，只有执行了真实连接测试，才能报告服务、密钥及模型可用。测试调用遵循用户授权；本地预检查不证明网络、额度或远端模型支持情况。

## 浏览器中的全部持久偏好

这些是设备偏好，通过界面调整并保存在当前浏览器，不是平台 JSONC 的字段。以下键名仅用于定位实际保存位置。

| 配置 | 全部取值与默认值 | 保存位置 |
| --- | --- | --- |
| 界面字体大小 | 12..22 px，步长 1，默认 14；常规设置中调整 | `research-font-size` |
| 界面缩放 | 75..150%，步长 5，默认 100%；常规设置中调整 | `research-ui-scale` |
| 外观模式 | `system`、`light`、`dark`；默认 `system` | `research-theme` |
| 浅色预设 | `paper`、`snow`、`latte`；默认 `paper` | `research-light-palette` |
| 暗色预设 | `graphite`、`nord`、`mocha`；默认 `graphite` | `research-palette` |
| 浅/暗色自定义 CSS 开关 | 字符串 `true`、`false`；默认关闭，两种模式独立 | `research-light-custom-active`、`research-custom-active` |
| 浅/暗色自定义 CSS 内容 | CSS 字符串；默认空，两种模式独立 | `research-light-custom-css`、`research-custom-css` |
| 当前文字模型 | 已配置的 `供应商ID/模型ID`；未选择或模型失效时使用列表首项 | `research-model` |
| 各文字模型的推理强度 | 字典，键为完整模型 ID；值全部为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`，实际仅展示模型支持的等级；默认优先 `medium`，否则支持列表首项 | `research-thinking-levels` |
| PDF 阅读方式 | `continuous`（连续）、`page`（逐页）；默认连续 | `research-pdf-mode` |
| PDF 颜色 | `light`、`dark`；未设置时跟随界面明暗模式 | `research-pdf-colors` |
| 两侧栏布局 | `{ "materials": { "open": true, "width": 248 }, "conversation": { "open": true, "width": 384 } }`；`open` 为布尔值，`width` 为像素。材料栏有效宽度 200..320，对话栏至少 300，最大值随可用空间变化；平板默认材料栏关闭、对话栏宽 340 | `research-layout` |
| 上次工作区 | 工作区 URL，包含当前文件与对话查询参数；未保存时进入已有工作区，没有工作区时显示创建入口 | Cookie `research-last-workspace` |

PDF 当前页、缩放、目录展开和当前文件的源码/预览切换属于阅读状态，不是全局持久配置。工作区名称、文件内容及对话记录属于用户材料，也不作为平台配置项。
