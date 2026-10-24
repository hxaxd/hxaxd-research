---
name: paper-translation
description: 翻译论文或科研材料；按用户要求选择 TeX、HTML 或 PDF OCR 路线，支持当前助手全文翻译、调用已注册模型，以及保留 PDF 版式的批量块翻译与回填。
---

# 论文翻译

## 先确定谁来翻译

翻译前先检查用户是否选择了执行方。未选择时，回复以下问题并结束本轮，收到回答后再继续：

> 由当前助手直接翻译，还是调用已注册模型翻译？

仅指定模型名称或限定调试可用模型，不能据此选择 API 路线。

已选定执行方时：

- **当前助手直接翻译**：当前对话完成阅读和译稿，不调用额外翻译 API。
- **调用已注册模型翻译**：使用模型命令；模型未指定且未授权你选择时，列出可用模型供用户选择。

目标语言、范围、术语、输出形式和版式要求按用户已给出的选择执行。

当前助手直接翻译时，按章节完成长文：先确认章节、图注、表格、脚注及附录的范围，再逐节读取全文、翻译并写入工作区，最后合并渲染。输出可以分多次文件写入完成，无需在一次回复中容纳整篇译文。保持前后术语一致，不能以摘要代替全文或声称读过未读取的内容。模型调用模式使用工作台已有供应商与凭据，范围不限于当前对话选中的模型。

## 来源选择

用户明确指定的来源、方法或形式优先。选定一个版本作为翻译底稿，其他来源用于核对，不自行拼接它们独有的内容。未指定时，逐层查找，得到可用的完整材料后使用该层：

1. 检查工作区是否已有对应版本的 TeX 工程；没有时，按论文标题、作者、DOI 或预印本 ID 在线查找作者／预印本官方源码。核对论文身份和版本，保留原工程，复制出译稿工程。读取 `document-workbench` 技能，翻译正文并保留公式、标签、引用、图片与工程关系，编译译稿并展示 PDF。
2. 找不到可用 TeX 时，寻找同一论文的官方 HTML。完整读取章节及关联内容，保留图片、表格、公式和来源；可重写为独立 HTML／Markdown，不要求复刻原站结构。重排 HTML 使用本技能的 `assets/paper.html` 基础模板。
3. 在线与本地都没有更合适的材料时，对当前 PDF 使用已登记的 PaddleOCR 文档解析。默认重排为 HTML 和 Markdown；用户的输出选择优先。
4. 需要保留 PDF 原版式时，使用下面的固定块翻译与回填流程。它也是没有更优来源时的版式保留方案。

检索与下载使用原生命令及实际可用的网络能力，不假定存在浏览器或搜索工具。保留来源地址与版本，不能把同名材料或其他版本静默替换进来。

## 运行入口

调用 `get_workspace_context`，读取 `translation.command`、`translation.modelsCommand` 及 `translation.ocr`。命令是完整的程序及参数数组，路径为绝对路径；直接展开整个数组后追加子命令，不从脚本路径重新拼接。`translation.command` 包含独立 Python、脚本、必需的 `--config` 和配置路径。在 PowerShell 使用调用运算符，在 Bash 正确引用参数。下面的 `<translation.command>` 和 `<modelsCommand>` 表示展开整个数组，不是要输入的命令名称。

需要 Python 提取或整理材料时，使用 `translation.command[0]` 的项目独立解释器，标准库可直接使用；不要依赖系统 `python` 别名。新增依赖仍安装在 `.runtime/env/translation/`，不做全局安装。

- `modelsCommand`：通用文本模型调用，TeX、HTML、Markdown 都可直接提交，不要求 OCR 或 `document.json`。
- `translation.command translate`：仅处理 PDF OCR 产生的规范化 `document.json`，执行固定块翻译与回填。

两者复用相同的模型供应商和凭据。模型 ID 均为目录中的完整 `provider/model-id`，例如 `openai/gpt-6-luna`。

## TeX、HTML 与文本翻译

TeX 按 `document-workbench` 处理工程、编译和展示。HTML 优先将论文主体的原始 HTML 片段交给翻译模型，保留表格、数学节点和图像地址，去除网页导航、脚本及样式即可，无需重写解析器。网页源码的字节数不等于待译正文长度；当前助手直接翻译时逐节读、译、写。

转换 HTML 表示时，数学节点只取一份语义表达：优先保留 TeX 注释；不要把 MathML 的显示树和注释文本一起拼接，否则数字和公式会重复。保留表格单元格及跨行、跨列关系。图片用标准 URL 解析（如 `urljoin` 或 `new URL`），以原始页面 URL 为基准，下载后核验实际文件可读再引用；不以字符串拼接路径或仅留下占位符代替插图。

选择 API 翻译时，将完整要求和内容写成请求 JSON：`{"system":"翻译要求","prompt":"待翻译全文","maxTokens":...}`，然后调用：

```text
<modelsCommand> --model provider/model-id --input request.json --output response.json
```

读取 `response.json` 中的 `text`，保存为译稿。长工程按实际容量组织章节，保留术语与引用一致性；不能截断输入或忽略输出上限。

重排阅读默认先完成 Markdown，再用 `<translation.command> render-markdown --input translated.md --output translated.html --title "论文标题" --target zh-CN` 生成 HTML，复用基础模板和本地数学渲染资源。模板支持目录、明暗外观、原文对照及打印。用户要求定制页面时，可读取并修改 `assets/paper.html`。

## PDF OCR 与块翻译

环境未安装时，按实际需要执行 `translation.setupCommand` 或 `translation.ocr.setupCommand`。`translation.ocr.command` 是已配置好模型和缓存的原生 PaddleOCR 命令，追加 `--input` 和 `--save_path` 输出原始结果；Windows 的输入输出参数使用 WSL 的 `/mnt/<盘符>/...` 路径。需要规范化 `document.json`、图片资源和坐标回填时，使用 `translation.command ocr`，由流水线处理路径转换。TeX／HTML 路线无需先安装或加载 OCR。项目安装命令及目录约定见 [运行说明](references/runtime.md)。

```text
<modelsCommand> --list
<translation.command> ocr --input paper.pdf --output translation --title "论文标题"
<translation.command> prepare --document translation/document.json --target zh-CN --output translation/request.json
```

`ocr` 调用登记的 PaddleOCR-VL，保留原始 JSON、Markdown、页面尺寸、阅读顺序及块坐标，并提取插图。`document.json` 是全文块与定位数据；`prepare` 将全文及固定提示词写入请求文件。

当前助手直接翻译：读取完整 `document.json` 或 `request.json`，按其中的系统提示词输出 `translations.json`，格式为 `{"blocks":[{"id":"...","text":"..."}]}`。每个源块对应一个译块，保留块原样复制；定位始终由原文数据保存。

调用已选模型翻译：

```text
<translation.command> translate --document translation/document.json --target zh-CN --model provider/model-id --output translation
<translation.command> render --document translation/document.json --translations translation/translations.json --output translation --target zh-CN
```

模型 ID 来自 `--list`，保留完整供应商前缀。默认把所有块一次发送；只有所选模型的上下文或输出容量不足时才按连续块分批，带相邻上下文并保留统一术语表。`--instructions` 和 `--glossary` 可指定用户要求、术语文件。

`translate` 使用 [固定提示词](../../prompts/blocks.md)，记录每批请求和原始响应，验证外部结果的块 ID 完整性。响应损坏时读取报错所指文件，由当前助手修复格式或映射并写成完整 `translations.json`；缺少的译文需补译，不能用原文填充后宣称成功。修复后直接运行 `render`，不重复 OCR。

```text
<translation.command> render --document translation/document.json --translations translation/translations.json --output translation --target zh-CN --layout
```

`--layout` 额外生成原版式 PDF 和原译交替 PDF，原 PDF 不被覆盖。文字按源坐标回填，图片与独立公式保留，含行内公式的文字使用项目 TeX 排版。读取 `layout-report.json`，核对实际缩放、表格及异常，渲染检查页边、双栏、公式、遮盖和溢出。不能仅凭命令成功就保证复杂论文达到原稿质量。

需要一次执行 OCR、模型翻译和渲染时，使用 `pdf --input ... --output ... --target ... --model provider/model-id`，可加 `--layout`。这只适用于用户已选定模型调用模式。

## 展示与报告

完成后调用 `open_document` 展示实际产物，HTML 使用 `mode: "preview"`，PDF 可指定页码。HTML 的浏览器运行与网络边界见 `document-workbench`。报告采用的来源、执行方式、成果路径和实际核验范围。当前助手直接翻译时，说明“由当前助手完成，未调用额外翻译 API”，不写“未使用模型”。
