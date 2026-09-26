# @hxaxd/dsh-ui-projects

hxaxd 项目工作台的 DSH 界面插件:侧栏项目浏览器(`sidebar.workspaces`)、会话空态的项目选择器(`conversation.hero.workspace`)、新建项目对话框、添加材料与打开项目文件夹入口。

基于 [@deepseek-ai/dsh-client-ui-workspace](https://github.com/deepseek-ai/deepseek-harness)(deepseek-harness `477b4f420553e8a52c2fbccc464d7561b239c443`,MIT License,Copyright (c) 2026 DeepSeek)复制改造,保留其 MIT 许可;改动说明:

- 移除目录选择流程(directory picker / directoryFlow 槽位)与首次启动默认工作区初始化;"添加工作区"替换为"新建项目":输入名称 → 工作台后端(`http://127.0.0.1:8642`,可经 `localStorage['hxaxd.backendBaseUrl']` 覆盖)分配托管目录并登记 → 经上游 `ctx.workspaces.create/rename` 注册 DSH 工作区 → 回绑工作区 id。
- 新增项目级材料入口(`POST /api/projects/{id}/materials`)与打开项目文件夹(`POST /api/projects/{id}/reveal`)。
- 会话行操作(置顶/重命名/分叉/归档)、树形分组、视图状态、快捷键等沿用上游实现,文案改为项目语义(zh 为键集来源)。

## 构建

```sh
npm run bundle   # 产出 lib/index.js(node 半)与 lib/client.js(浏览器闭包工厂)
npm run types    # tsc 声明
```

`lib/client.js` 由根目录 profile 层(`frontend/profile/cordis.patch.yml`)装载:禁用上游 `ui-workspace` 行并插入本包;客户端模块系统按 package.json 的 `dsh.client` 声明与 `exports["./client"]` 发现产物。

## 测试

```sh
npm test   # 仓库根目录运行 vitest:projects-api 流程、locale 键集、OpenAPI 契约
```
