# TeX 环境配置

## 1. 目标

为 R5 论文写作和 R6 投稿准备提供可重复使用的 TeX 编译环境。选择顺序是:

1. 复用本机已经可工作的 TeX 环境
2. 本机环境不可用时, 在仓库`.tools/tex/`中安装项目内环境

环境是否可用以真实稿件能够编译为 PDF 为准。

## 2. 探测现有环境

先读取现有稿件、官方模板或项目构建说明, 确定需要的编译入口和引擎。随后检查当前终端中可用的`latexmk`、`tectonic`、`xelatex`、`lualatex`和`pdflatex`。

候选命令必须完成一次实际编译测试。测试通过后直接沿用该环境及稿件原有构建命令, 编译产物写入研究项目的`build/`目录。

## 3. 配置项目内环境

现有环境无法完成实际编译时, 默认使用 Tectonic 的官方预编译单文件版本, 安装范围固定为仓库根目录。安装来源使用[Tectonic 官方安装说明](https://tectonic-typesetting.github.io/book/latest/installation/)和[官方发布页](https://github.com/tectonic-typesetting/tectonic/releases/latest):

```text
.tools/
└─ tex/
   ├─ bin/
   │  └─ tectonic(.exe)
   ├─ cache/
   └─ tmp/
```

执行配置时:

1. 从 Tectonic 官方发布页取得适合当前系统的预编译版本, 放入`.tools/tex/bin/`
2. 仅在当前编译进程中把`TECTONIC_CACHE_DIR`设为仓库`.tools/tex/cache/`; 该变量的行为见[官方缓存说明](https://tectonic-typesetting.github.io/book/latest/getting-started/first-document.html#cache)
3. 使用二进制绝对路径执行, 版本检查与真实稿件编译使用同一个文件
4. 临时下载和解压内容使用`.tools/tex/tmp/`
5. 将 PDF 和必要日志输出到当前研究项目的`build/`

Tectonic 无法满足官方模板或特殊工具链要求时, 按[TeX Live 官方便携安装说明](https://tug.org/texlive/doc/install-tl.html)在`.tools/tex/texlive/`中安装便携 TeX Live, 并以其中的`latexmk`作为项目编译入口。二进制、宏包、缓存和配置仍位于`.tools/tex/`。

## 4. 编译

单文件 Tectonic 环境的基本调用形式见[`tectonic -X compile`官方说明](https://tectonic-typesetting.github.io/book/latest/v2cli/compile.html):

```text
<仓库>/.tools/tex/bin/tectonic -X compile --outdir <研究项目>/build --keep-logs <研究项目>/<主入口>.tex
```

使用前为当前进程设置:

```text
TECTONIC_CACHE_DIR=<仓库>/.tools/tex/cache
```

已有 TeX 环境则使用其真实构建命令, 例如以`latexmk`编译官方模板。所有命令都从仓库和研究项目的真实绝对路径解析, 稿件正文中只保留可移植的相对资源路径。

## 5. 验证

环境配置完成需要满足:

- 编译器版本命令成功
- 当前 TeX 主入口能够生成 PDF
- 引用、交叉引用、公式和图件能够解析
- 重复执行使用同一环境并得到稳定产物
- 启用项目内环境时, 编译器、缓存、临时内容和安装的宏包都位于仓库`.tools/tex/`
- R5 或 R6 能够通过绝对命令路径再次调用该环境
