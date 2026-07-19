# Frontend

## 启动

```powershell
npm install
npm run dev
```

开发服务器默认监听 `http://127.0.0.1:5173`，并把 `/api` 转发至本地后端。

## 质量检查

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

论文阅读页按需加载，不会把 PDF 引擎放入首页代码包。
