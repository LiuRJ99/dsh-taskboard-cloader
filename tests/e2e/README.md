# tests/e2e — dev-server 手工验证脚本

针对运行中的 dev server（默认 `http://127.0.0.1:3177`）做真实环境验证，
不在 `npm test`（vitest）范围内。先启动 server 再运行：

```bash
npm run build
dsh --profile taskboard-dev --patch dev-overlay.yml --port 3177
```

| 脚本 | 验证内容 | 备注 |
|---|---|---|
| `verify-p0.mjs` | P0 挂载：shell 页 + 插件 client bundle 注册包装 | 只读 |
| `verify-p2.mjs` | P2 路由：state / workspaces / 建 卡 / SSE | 会写台账 |
| `verify-p2-final.mjs` | P2 收尾：bundle 含看板代码、路由活、台账持久 | 只读 |
| `verify-p3-e2e.mjs` | P3 执行链路：建卡 → 手动执行 → 轮询结算 | **真实消耗一次 API 回合** |
| `verify-p4-e2e.mjs` | P4 双向协议：真实 agent 认领/评论/移 in_review | **真实消耗 API 额度**；会清理历史验证卡 |
| `probe-ports.mjs` | 探测常见端口上的 web server | 只读 |

host 半边冒烟（不依赖 server，加载 `lib/index.js` 打桩跑 apply）：`node tests/smoke-host.mjs`。

调试开关：`ATB_TRACE=1` 输出工具调用追踪。
