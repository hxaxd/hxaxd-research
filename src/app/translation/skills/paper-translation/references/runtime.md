# 翻译运行时

环境位置以 `get_workspace_context` 返回的 `translation.root`、`translation.ocr.root` 和 `tex.root` 为准；表中路径是默认值。项目根目录使用返回的 `projectRoot`，不能根据可配置的环境目录反推。固定提示词和 HTML 模板读取 `translation.templates` 下的安装副本，来源为 Git 中的 `src/app/translation/prompts/` 和 `src/app/translation/skills/`；它们由应用安装流程准备，不依赖 Python 环境安装。

## 按需准备环境

仅准备当前路线需要且缺失的环境，先向用户说明并询问，同意后安装；沿用本任务已有的明确安装授权。直接写入和预览 Markdown／HTML，或通过 `translation.modelsCommand` 调用文本模型，无需下面的 Python 环境。

| 用途 | 上下文安装入口 | 项目内资源目录 |
| --- | --- | --- |
| 翻译 Python 流水线、模板渲染与 PDF 回填 | `translation.setupCommand` | `.runtime/env/translation/` |
| PDF 文档识别 | `translation.ocr.setupCommand` | `.runtime/env/ocr/` |
| TeX 编译与 PDF 行内公式排版 | 见 `document-workbench` 技能 | `.runtime/env/tex/` |

安装入口是完整命令数组，按返回值执行；也可在项目根目录执行 `npm run translation:setup`、`npm run ocr:setup`，按需选择。首次安装需要联网；OCR 会下载模型和运行依赖。安装使用项目锁定依赖，OCR 模型从官方来源下载，不依赖其他项目或全局 PaddleOCR。安装后重新获取 `get_workspace_context`，使用更新的命令完成当前任务，以实际输出确认可用。

翻译安装入口需要 `uv`。若未提供，在用户同意的安装范围内，使用原生命令从官方发布包获取当前平台的 `uv`，放在 `translation.root` 下的 `tools/`，仅在当前进程将该目录加入 PATH，再执行安装入口。独立 Python、依赖、下载、缓存和临时资源都留在 `translation.root`；新增依赖使用该环境的解释器及包管理器，不做全局安装。

OCR 支持 Linux x64 原生运行；Windows 使用 WSL Ubuntu 的 Linux 执行环境，独立 Python 和依赖仍安装在`translation.ocr.root`。安装入口会准备项目内的 `uv`。默认 GPU 版本要求 NVIDIA 驱动支持 CUDA 12.9；按实际设备选择，CPU 版本向安装数组追加 `--device cpu`，或执行 `npm run ocr:setup -- --device cpu`。Windows 可用 `--distro` 指定已有的 WSL 发行版。缺少 WSL、显卡驱动或 Linux 动态库时，说明所需系统变更并取得相应授权，再用原生方法处理。

OCR 的程序、独立解释器、依赖、模型、配置、下载、缓存和临时资源放在 `translation.ocr.root`；TeX 资源放在 `tex.root`。用户材料、识别结果和译稿留在当前工作区。包管理器使用项目内安装与缓存目录，不修改全局 Python 或 PATH。

## 使用与输出

使用 `get_workspace_context` 返回的 `translation.ocr.command`，展开完整命令数组后追加原生参数：

```text
<translation.ocr.command> --input /absolute/path/paper.pdf --save_path /absolute/path/parsed
```

Windows 命令通过 `wsl.exe` 运行，输入输出使用 `/mnt/c/...` 等 WSL 路径。命令本身及模型、缓存参数保存在 `translation.ocr.root` 下的 `installation.json`；可读取该文件直接调用。原生 `--help` 可查看其他参数。

OCR 输出逐页 `*_res.json`，包括 `width`、`height`、`page_index`、`parsing_res_list` 及其中的 `block_id`、`block_order`、`block_label`、`block_content`、`block_bbox`，并保留 Markdown 和图片。流水线默认读取应用 `.runtime/config.jsonc`（或 `APP_CONFIG_FILE` 指定的文件），与工作台和安装脚本使用相同的目录与模型入口。`node src/app/config.mjs --defaults` 显示可覆盖参数，`node src/app/config.mjs` 显示解析后的配置。模型命令通过 Pi SDK 读取与工作台相同的供应商配置和服务端凭据，支持 API Key 与已连接的订阅供应商，不向请求文件或浏览器返回密钥。

OCR 包含模型加载和逐页推理，冷启动可能超过数分钟。按页数留出命令执行时间，例如小文档可设 `timeout: 1200` 秒；超时后先检查输出与实际进程状态，再决定继续执行，不以固定短超时判断环境损坏。

保留版式使用 PyMuPDF 和项目 Tectonic 独立实现。PDFMathTranslate 是功能研究参考，没有调用、复制或修改其实现；这一流水线的识别和译文质量需以实际材料核验。
