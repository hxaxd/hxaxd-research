# TODO

## 论文处理管线

- [ ] 评估是否将百度开源的 `Unlimited-OCR` 作为论文处理的 OCR/版面解析候选组件。
    - 检索日期: 2026-06-28
    - 背景: 百度 `Unlimited-OCR` 主打 one-shot long-horizon parsing, 官方仓库称其目标是推进 DeepSeek-OCR 的长文档解析能力；Hugging Face 模型卡显示模型为 `baidu/Unlimited-OCR`, 许可证为 MIT, 支持 Transformers, vLLM 和 SGLang。
    - 可能价值: 对扫描版论文, 多页 PDF, 复杂版面, 表格/公式/阅读顺序抽取做一次独立评估；若效果稳定, 可考虑作为 PDF2zh 之前的文本与版面解析辅助, 或作为 PDF2zh 失败时的候选诊断工具。
    - 注意边界: “无限 OCR”不是字面无限。技术报告说明当前仍受有限上下文长度约束, 例如 32K, 且 prefill 会随页数累积；真正更长上下文或按需取回 prefill KV 仍是未来工作。
    - 待验证:
        - 本地硬件与依赖是否可跑通, 尤其是 NVIDIA GPU, CUDA, `torch`, `transformers`, `pymupdf`, vLLM/SGLang 版本。
        - 是否能稳定处理学术论文 PDF 的公式, 表格, 双栏版面和阅读顺序。
        - 输出结构是否能与现有 `scripts/translate-pdf.ps1` / PDF2zh 流程衔接, 且不破坏论文目录只保留 `原文.pdf`, `中文译文.pdf`, `双语对照.pdf` 的约束。
        - 许可证, 模型权重, 远程代码执行 (`trust_remote_code=True`) 和数据外传风险是否满足本仓库的本地研究工作区边界。
    - 主要来源:
        - GitHub: <https://github.com/baidu/Unlimited-OCR>
        - Hugging Face: <https://huggingface.co/baidu/Unlimited-OCR>
        - arXiv: <https://arxiv.org/abs/2606.23050>
