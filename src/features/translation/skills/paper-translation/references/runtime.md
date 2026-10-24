# 翻译运行时

在项目目录执行 `npm run ocr:setup` 和 `npm run translation:setup`。OCR 的独立解释器、依赖、模型、配置和缓存保存在 `.runtime/env/ocr/`；翻译渲染的独立环境位于 `.runtime/env/translation/`，TeX 位于 `.runtime/env/tex/`。安装使用项目锁定依赖，OCR 模型由官方来源下载。无需预装其他项目或全局 PaddleOCR。

Windows 使用 WSL Ubuntu 的 Linux 执行环境，独立 Python 和依赖仍安装在本项目 `.runtime/env/ocr/`；Linux x64 原生运行。默认 NVIDIA CUDA 12.9 GPU；`npm run ocr:setup -- --device cpu` 可安装 CPU 版本，Windows 可用 `--distro` 指定 WSL 发行版。操作系统、适配的显卡驱动及 Linux 动态库属于运行前提，安装程序不会修改全局 Python。

使用 `get_workspace_context` 返回的 `translation.ocr.command`，展开完整命令数组后追加原生参数：

```text
<translation.ocr.command> --input /absolute/path/paper.pdf --save_path /absolute/path/parsed
```

Windows 命令通过 `wsl.exe` 运行，输入输出使用 `/mnt/c/...` 等 WSL 路径。命令本身及模型、缓存参数保存在 `.runtime/env/ocr/installation.json`；可读取该文件直接调用。原生 `--help` 可查看其他参数。

OCR 输出逐页 `*_res.json`，包括 `width`、`height`、`page_index`、`parsing_res_list` 及其中的 `block_id`、`block_order`、`block_label`、`block_content`、`block_bbox`，并保留 Markdown 和图片。应用数据目录的 `translation.json` 登记 OCR 运行目录、翻译资源和模型入口，不提交机器路径或凭据。模型命令通过 Pi SDK 读取与工作台相同的供应商配置和服务端凭据，支持 API Key 与已连接的订阅供应商，不向请求文件或浏览器返回密钥。

OCR 包含模型加载和逐页推理，冷启动可能超过数分钟。按页数留出命令执行时间，例如小文档可设 `timeout: 1200` 秒；超时后先检查输出与实际进程状态，再决定继续执行，不以固定短超时判断环境损坏。

保留版式使用 PyMuPDF 和项目 Tectonic 独立实现。PDFMathTranslate 是功能研究参考，没有调用、复制或修改其实现；这一流水线的识别和译文质量需以实际材料核验。
