# V1 到 V2 正式迁移报告

迁移时间：2026-07-20

## 保护与版本

- 迁移前快照：`learning-2026-07-20_090648Z.researchpack`
- 迁移后快照：`learning-2026-07-20_093331Z.researchpack`
- 数据库版本：1 → 2
- 应用契约版本：1.x → 2.0

迁移前快照保留原始 V1 数据；V2 恢复器已经通过自动化测试证明可以校验该格式、升级数据库并恢复文件。

## 数量与文件对账

| 项目 | 迁移前 | 迁移后 |
| --- | ---: | ---: |
| Project | 5 | 5 |
| ProjectPaper | 88 | 88 |
| 全局 Paper | 不适用 | 88 |
| Resource | 264 | 264 |
| 资源总字节 | 1,475,833,646 | 1,475,833,646 |
| 可通过公开 API 读取的资源 | 264 | 264 |

迁移前后按资源 SHA-256 排序后得到的集合摘要均为：

`3577B62203A075F786D0A5AEA8CB8E7C7D52D88F40A87B456E08F83AD7E79BF7`

没有文件缺失、散列变化或未解释的大小差异。

## 旧数据质量处理

- 61 篇论文的旧作者字段包含 `et al.`。原值保留，`authors_complete=false`，没有猜测补全。
- 50 条 `doi:10.48550/arxiv.*` 旧键已规范化为 arXiv 标识符；原键保存在只读 legacy 扩展中。
- 旧 `organization` 和 `relations_text` 保存在只读 legacy 扩展中，不进入新写入契约。
- 旧三类 PDF 已映射为 `pdf + original/translated/bilingual`，路径、大小和散列保持不变。

## 运行验证

- 正式服务报告 `contract_version=2.0`、`schema_version=2`。
- 工作区响应由约 214 KB 缩小到 2,955 字节。
- TeX 编译受支持且已就绪，latexmk 版本为 4.88。
- PDF 翻译受支持，但 PDF2zh 当前未安装；页面明确显示“工具未就绪”。
