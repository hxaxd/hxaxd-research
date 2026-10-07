# 科研工作台

单用户本地科研工作台。一个工作区包含多篇论文、真实材料目录和多段 AI 对话。论文是材料的组织入口，可以包含 PDF、TeX 工程、图片和普通文件。

## 启动

需要 Node.js 24 或更高版本，命令在仓库根目录运行：

```powershell
npm ci
npm run build
npm start
```

打开 http://127.0.0.1:8642 。开发时运行 `npm run dev`。应用只监听回环地址；同一个数据目录只运行一个应用进程。其他端口可用 `npm start -- --port 8787`。

## 模型配置

没有模型凭据时，创建工作区、导入和阅读仍可用。对话使用项目依赖中的 Pi 1.0.0，菜单列出已经配置凭据的模型。

在启动应用的 PowerShell 中设置 Pi 支持的提供商环境变量，例如：

```powershell
$env:OPENAI_API_KEY = '你的密钥'
npm start
```

也可以写入未提交的 `.env.local`。自定义兼容接口在 `.local/pi/models.json` 中配置；端点和模型名替换成服务实际提供的值：

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

设置 `RESEARCH_MODEL_API_KEY` 后启动应用。修改配置后重启服务。凭据和会话均使用应用自己的 Pi 目录。格式说明见 [Pi 模型配置](https://github.com/earendil-works/pi/blob/v1.0.0/packages/coding-agent/docs/models.md)。

## 使用

1. 新建工作区，应用自动创建独立目录。
2. 新建论文，导入文件或整个目录；TeX 工程的子目录和相对引用保持原样。
3. 点击文件阅读。PDF 支持翻页、缩放和文字选择；文本及图片可以预览，其他材料可下载。
4. 新建对话、选择模型、将材料加入对话并提问。
5. 助手可以列出文件、读取文本、按页读取 PDF、创建或修改文本。已有文本的修改使用内容哈希防止覆盖外部改动。
6. 可以停止回答、切换对话或刷新。页面断开不会停止回答；服务退出后的未完成回答显示为中断，不会自动重发。

通过文件管理器直接添加材料后，点击“刷新文件”即可看到，无需资源登记。改名不改变底层目录身份。

## 数据与源码

数据默认在 `.local/`，可通过 `APP_DATA_DIR` 指定其他路径。停服务后备份整个数据目录，可以保留完整工作台。

| 路径 | 内容 |
| --- | --- |
| `.local/app.sqlite` | 工作区、论文、对话关联和运行结果 |
| `.local/workspaces/<工作区ID>/` | 真实材料；论文位于 `papers/<论文ID>/` |
| `.local/pi/sessions/<对话ID>/` | Pi 的消息和工具历史 |
| `.local/pi/models.json`、`auth.json` | 模型配置及凭据 |
| `.local/imports/`、`staging/` | 导入结果、恢复记录和暂存文件 |

源码集中在 `src/`。页面与 HTTP 接口位于 `src/app/`；四个业务功能位于 `src/features/`；进程接线和数据库初始化位于 `src/server/`；共享请求与对话框位于 `src/shared/`。服务端页面直接调用业务函数。

技术栈为 Next.js、React、TypeScript、SQLite、Pi 和 PDF.js。使用具体 SQL、文件函数及五个具体 Pi 工具；持有会话生命周期的注册表使用类。架构见 [V1 设计](docs/v1-design.md)。OpenAPI 从实际 Zod 结构生成，通过 `GET /api/openapi` 获取。

## 验证

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

测试覆盖归属、文件越界、哈希冲突、导入原子提交与恢复、重复发送、取消、模型失败及流式重连。浏览器测试使用生产服务，覆盖 PDF、TeX、真实 Pi 工具修改、多段对话及进程重启。

测试通过真实 Pi SDK 连接本地确定性模型接口，数据写入忽略的 `.tools/`。外部模型的回答质量、凭据及服务商连接需要配置后实际验收。

## 当前边界

- 导入：单文件 256 MiB、每批 1 GiB、最多 1,000 个文件。同名同内容复用，同名不同内容自动另存。
- 文本读取上限 16 MiB，界面先显示前 100,000 字节；单次文本写入上限 2 MiB。
- PDF 文字工具每次最多读取 20 页；扫描件可显示，尚未实现文字识别。
- 任意命令执行、TeX 编译、自动任务、网页搜索、Zotero、专用批注、全局文献库及删除界面不在本版范围。
- Pi 1.0.0 的发布收缩锁文件固定了 `brace-expansion@5.0.9`，依赖审计报告一个高危依赖项（递归展开导致拒绝服务）。应用不开放模式搜索工具或项目扩展加载；上游锁定问题仍需修复，本地测试通过不代表依赖审计通过。

旧源码保存在 Git 标签 `pre-pi-rewrite-20261003`。新应用使用独立数据目录，不读取或迁移其他应用的资料。运行数据、凭据和构建产物不提交。许可见 [LICENSE](LICENSE)。

