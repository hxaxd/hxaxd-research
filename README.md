# hxaxd Research Workbench

单用户本地文献工作台:以项目为入口,基于 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的智能体能力。

用户创建项目,后端自动创建并代管项目文件夹,并将其登记为 DSH 工作区;项目下有多段对话(原生 DSH 会话,工作目录即项目目录);项目文件浏览器与 PDF 预览直接读取真实文件系统。

## 启动

```sh
./scripts/launch.sh
```

脚本会依次:构建 UI 插件 → 准备隔离的 DSH profile → 启动后端(127.0.0.1:8642)→ 启动 DSH Web(127.0.0.1:3080)。首次运行需要网络下载依赖;启动后按打印的 `http://127.0.0.1:3080/?token=…` 打开界面。

- 模型配置:首次进入会提示配置 API key(也可设 `DEEPSEEK_API_KEY` 环境变量)。没有密钥时,创建项目、浏览文件、PDF 预览都可用,但对话需要模型。
- 数据位置:默认全部在 `backend/data/` 下(项目登记 `projects.sqlite3`、托管项目目录 `projects/`、隔离的 DSH 状态 `dsh-home/`),可用 `HXAXD_DATA_DIR`、`HXAXD_DSH_HOME`、`HXAXD_DSH_PORT`、`HXAXD_BACKEND_PORT` 覆盖。该目录与本机其他 DSH 安装(如 `~/.dsh`)完全隔离。

## 结构

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 项目后端 | `backend/` | Python FastAPI。项目登记(sqlite)、托管目录分配、材料添加、文件夹打开;通过 `PATCH /api/projects/{id}/workspace` 保存 DSH 工作区绑定。OpenAPI 即字段契约。 |
| 界面插件 | `frontend/ui-projects/` | `@hxaxd/dsh-ui-projects`,复制自上游 `dsh-client-ui-workspace` 并改造:目录选择全部替换为“新建项目”流程,新增添加材料/打开文件夹入口。 |
| DSH 上游 | npm 锁定 `@deepseek-ai/dsh@0.1.7-rc.2` | 不修改上游;通过 profile patch 层(`frontend/profile/cordis.patch.yml`)禁用被替换的默认工作区界面并插入我们的插件。`frontend/vendor/cordis` 仅用于类型解析,运行时由宿主提供。 |
| 启动脚本 | `scripts/launch.sh` | 组装 profile 到 `$DSH_HOME/profiles/hxaxd` 并拉起两个进程。 |

会话内容、执行历史、工作区登记都由 DSH 保存在 `dsh-home/` 中;本仓库后端只保存项目与工作区的对应关系,不复制聊天记录。

## 开发命令

- 后端:在 `backend/` 运行 `uv run pytest` 与 `uv run ruff check .`。
- 前端:在 `frontend/` 运行 `npm test`、`npm run typecheck`、`npm run lint`、`npm run build`。
- 契约:后端字段变更后运行 `uv run python -m app.openapi` 重新生成 `frontend/src/shared/api/openapi.json`,并在同一次提交中更新 `frontend/src/shared/api/contracts.ts`;两侧的契约测试会互相牵制。

## 上游与许可

- 上游基线:deepseek-harness `477b4f420553e8a52c2fbccc464d7561b239c443`(dsh 0.1.7-rc.2,MIT)。
- `frontend/ui-projects` 与 `frontend/vendor/cordis` 含上游代码,保留 MIT 许可与版权声明(见各目录内说明)。

## 已知限制(V1)

- 项目的“打开项目文件夹”依赖后端执行 `open`/`xdg-open`(仅 macOS/Linux 桌面);DSH 自带的文件级 reveal 在纯 Web 下由其自身能力门控。
- 添加材料走后端接口:同名同内容视为重复跳过,同名不同内容自动另存为 `name (1).ext`;单文件上限 2 GiB。
- 修改项目名(侧栏重命名)只改 DSH 工作区标题,后端登记的 `name` 保持创建时的值;项目删除/搬迁未做(V1 明确不做)。
- 智能体对话依赖模型凭据;未配置密钥时,项目、文件与预览功能不受影响。
- 每次页面加载会出现上游的 Internal Testing Notice,点击 Continue 即可。
