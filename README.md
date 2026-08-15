# dsh-agent-taskboard

DeepSeek Harness（DSH）的**任务看板插件**：人把工作拆成卡片挂上看板，agent 会话通过 `taskboard_*` 工具认领、推进、评论、移交；人最终验收。双向协作，不是单向的 todo 列表。

```
人在 GUI 建卡（选项目/紧急度/模型/执行方式）
        │
        ▼
看板 ◄──SSE 实时刷新──┐
        │              │
   [手动执行/定时触发]  │ agent 会话内：
        │              │ taskboard_get / comment_add / move
        ▼              ▼
在任务项目里新建会话 ──► 卡片 → in_progress →（实现+自验）→ in_review
（指定模型，干净上下文）                    agent 到此为止，永远到不了 done
        │
        ▼
人在看板上确认 → done（唯一入口）
```

## 核心概念

| 概念 | 说明 |
|---|---|
| 项目 | 直接映射 DSH workspace（无新实体）。任务创建时必须选一个 |
| 紧急度 | `urgent` 红 / `normal` 紫 / `relaxed` 蓝，看板列内以色条区分，支持筛选 |
| 状态机 | `backlog → todo → in_progress → in_review → done`，旁路 `canceled` / `archived`；`blocked` 是布尔标记不是状态 |
| 执行方式 | `claim`（项目内会话自动认领）或 `scheduled`（host 侧 cron 定时触发） |
| 模型 | 每任务可固定 `{provider, model}`；执行时应用到新建会话，未指定则用部署默认模型 |
| 乐观并发 | 所有写操作带 `ifVersion`，冲突返回 `version_conflict`（重读再试一次即可） |
| 归因 | 每次变更记录 actor（user / agent+sessionId），评论挂 threadId |

## Agent 工具（8 个）

| 工具 | 作用 |
|---|---|
| `taskboard_list` | 按项目/状态/紧急度过滤列卡（开始工作前先看） |
| `taskboard_get` | 读单卡全文（描述/prompt/评论/版本） |
| `taskboard_create` | 建卡（需要 agent 身份） |
| `taskboard_update` | 改标题/描述/prompt/紧急度/blocked（带 ifVersion） |
| `taskboard_move` | 移动状态（带 ifVersion；**代码级拒绝 agent 移到 done**） |
| `taskboard_comment_add` | 追加进度/报告评论 |
| `taskboard_comments` | 列评论（先读再决定开工） |
| `taskboard_delete` | 软删除（agent 只能标记，人在 GUI 清除） |

代码级硬闸（不靠 prompt 自觉）：
- `move → done` 对 agent 一律 `forbidden`，只有 GUI 用户能验收；
- 认领（`todo → in_progress`）要求调用会话的 cwd 解析到任务所属 workspace（跨项目认领 = `workspace_mismatch`）；
- 任务被某 agent 会话持有（in_progress）期间，其他会话任何移动都是 `forbidden`（不可抢占）。

## 执行链路（P3）

手动「执行」按钮或 cron 到期都会走同一条路：

1. 卡片置 `in_progress`，台账追加 execution 记录（`running`）；
2. `ctx.agents.create()` 在任务项目目录里新建全新会话（干净上下文），带任务固定的模型或部署默认模型；
3. 会话 attach 到 workspace（GUI 项目会话列表可见）；
4. 任务 prompt 作为普通用户消息提交（`followup`），消息头带任务 ID 与状态说明；
5. `whenIdle()` + `turn/end` 事件结算：成功 → `succeeded`；回合错误 → `failed`（错误消息入台账）。

调度器：每分钟 tick；到期任务先顺延 `nextRunAt` 再触发；错过超过 5 分钟的窗口直接跳过不补跑。

## 看板 UI（人这一侧）

- **五列看板**：待规划 / 待办 / 进行中 / 待验收 / 已完成；`blocked` 角标不占列；canceled / archived / 已删除收进「其它任务」标签页
- **筛选栏**：项目（workspace）下拉 + 紧急度三色 chip 多选
- **任务卡片**：紧急度左缘色条、模型 / ⏰ 定时（下次运行时间）/ 受阻 / 最近执行结果角标、评论计数；backlog ↔ todo 支持拖拽
- **详情面板**：状态流转按钮（`done` 需二次确认）、受阻标记、区分用户/agent 的气泡评论流、执行记录时间线（结果/耗时/会话短 id/错误摘要）、危险区（软删除 → 物理清除需确认）

### 新建 / 编辑任务弹窗

新建与编辑共用同一个弹窗（`TaskFormModal`，编辑入口在详情面板右上「✎ 编辑」，回填全部字段）：

- 头部图标 + 副标题、双列网格表单、底部常驻操作栏（实时校验提示 + 按钮）
- **紧急度三选**：色点卡片（紧急/一般/不急，各带一句副提示），选中态主题色描边
- **执行方式**：认领制 / 定时分段卡片选择
- **Cron**：预设 chip 可高亮选中，**实时校验**（非法表达式红框）+ **下次运行时间预览**——与 host 调度器同一套 `parseCron` / `nextCronTime` 纯函数，前端预览即真实计划
- 模型下拉读运行时已配置目录（`llm.models`），「默认模型」为第一项
- 键盘体验：Esc 关闭、打开自动聚焦标题；保存提示版本号变化（v→v+1）

### 任务编辑

GUI 是任务的 owner surface，编辑可改：标题 / 描述 / 执行 Prompt / 紧急度 / **项目改绑（workspaceId）** / 执行方式（claim↔scheduled + cron） / 模型（含清除回默认）。agent 侧 `taskboard_update` 继续禁改 model / execution（协议不变）。

### 主题适配

弹窗与详情面板全部颜色走外壳真实设计令牌 `--dsw-alias-*`（`bg-overlay` / `bg-mask-drop` / `brand-primary` / `label-primary|secondary|tertiary` / `border-l2` / `interactive-bg-hover` / `state-error-primary` / `specific-input-major` / `shadow-lv3` 等），浅色 / 深色主题与皮肤自动跟随，无硬编码主题色。紧急度红/紫/蓝是协议标识色，保留为描边 + 淡染形式。

## 安装

### 正确姿势（bundles 引用 + link）

profile 的 `package.json`：

```json
{
  "dependencies": {
    "dsh-agent-taskboard": "link:D:/path/to/dsh-agent-taskboard"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-agent-taskboard"
      ]
    }
  }
}
```

然后 `dsh plugin --profile <name> add link:D:/path/to/dsh-agent-taskboard`。

插件包根的 `cordis.patch.yml` 声明客户端 bundle 注入（`id: agent-taskboard`），`dsh.bundle.patch` 由 loader 读取。

### ⚠️ 重要教训（真实踩坑）

**绝对不要 `dsh plugin add @deepseek-ai/dsh-web-app`（或任何官方 `@deepseek-ai/dsh-*` SDK 包）到 profile。** 原因：

- 官方包在 npm 上是公开镜像，其依赖闭包会把一份**npm 版 `dsh-tools`** 等平铺进 profile `node_modules`；
- loader 解析 base 层插件时 **profile 目录优先于 CLI 缓存**，于是 `ctx.tools` 变成 npm 版实例；
- `dsh-agent-loop`（CLI 缓存内部版）用私有 symbol 访问工具调度器（`ctx.tools[Symbol(...)].prepare`），两份包的 symbol 不同 → agent 一调工具就炸 `Cannot read properties of undefined (reading 'prepare')`；
- 正确做法：官方包只写进 `bundles` 列表（从 CLI 缓存同源解析），profile `dependencies` 里只放第三方插件。

症状识别：会话创建/prompt 提交都正常，模型一发起工具调用 turn 就报 `reading 'prepare'`。

### 发布卫生：零运行时 SDK import

host 半边**没有任何运行时 `@deepseek-ai` import**。曾经依赖的三个 npm 镜像包（`dsh-home-paths`、`dsh-llm/brand`、`dsh-tools` 的 `defineTool`）由 `src/host/sdk.ts` 的结构兼容纯函数替代（identity brand、home 路径拼接、参数 schema 编译 + 前置校验——行为与官方 `defineTool` 一致，已通过真实 agent loop E2E）。`@deepseek-ai/*` 的其余 import 全部是类型导入，编译后消失。

这样发布副本无论装到哪里，都不会把 npm 镜像 SDK 拉进 profile `node_modules` 触发上述遮蔽；devDependencies 只服务类型与构建。

## 开发

```bash
npm install
npm run build        # tsdown 双构建：host ESM + client CJS（wrap-client.mjs 包装）
npm test             # vitest：protocol 21 + tools 4 + execution 6 + routes 8 + client 2（共 41）
npm run typecheck    # tsc --noEmit

# dev server（host 改动需重启；client 改动需 rebuild + 页面刷新）
dsh --profile taskboard-dev --patch dev-overlay.yml --port 3177
# 工具调用追踪（协议 E2E 取证）
$env:ATB_TRACE = '1'
```

- 台账文件：`~/.dsh/agent-taskboard.json`（原子写、revision 全局递增、损坏自动隔离）；
- HTTP 面：`/agent-taskboard/state|workspaces|tasks/:id`，POST `tasks`、`tasks/:id/{update,move,comment,delete,run}`，SSE `/agent-taskboard/events`；
- 调试脚本：`.verify-p3-e2e.mjs`（执行链路）、`.verify-p4-e2e.mjs`（协议闭环，真实消耗 API 额度）。

## 验证记录（真实 E2E）

| 阶段 | 验证 | 结果 |
|---|---|---|
| P1 host 核心 | 21 项协议单测 + 真实宿主冒烟（8 工具 + 协议 section） | ✓ |
| P2 通道+看板 | 30 项测试；dev server 实测 client bundle 200、state/workspaces 真实数据、SSE | ✓ |
| P3 执行链路 | 真实 `agents.create` + prompt 提交 + `whenIdle` 结算 `succeeded` | ✓ |
| P4 双向协议 | 真实 agent：get → 评论 → move 遇 `version_conflict` → 重读 → `in_review`；归因 `updatedBy: agent`；**lossless 输出修复后单条干净评论** | ✓ |

P4 发现并修复的真实 bug：
1. **npm 版 SDK 遮蔽**（见上文教训）——清理 profile dependencies；
2. **工具输出非 lossless JSON**——`summarize()` 的 undefined 值字段触发 loop 输出校验失败（`taskboard_get` 因过 `json()` 深拷贝而幸免）；修复为全部工具输出统一 `json()`，并加回归测试；
3. **执行会话不知道任务 ID**——prompt 让 agent「找 todo 状态的本任务」但执行服务已置 in_progress；修复为消息头带任务 ID + 状态说明；
4. **发布依赖卫生**——自实现 SDK 兼容层替代运行时官方包 import（见上文「发布卫生」）；
5. **render() 是模型可见输出**——registry 的 `createSuccessResult` 把 `output.render(args, value)` 的产物作为 `result.content`，loop 正是把这个 content 喂给模型（raw JSON `value` 永远不达模型）。P1 曾把 render 当「UI 摘要」写成一行（`Task board: N task(s).`），导致 agent 拿不到 id/version，只能从报错文本反推状态（P4 E2E 里 agent 首次 move 瞎猜 ifVersion=1 正是这个症状）。修复：全部 render 输出完整事实（get 全量详情、list 逐条 id+version、写操作回显 id+新 version），回归测试锁死该契约。

## 架构

```
src/
  shared/protocol.ts     # 状态机/紧急度/cron/记录类型（host+client 共享）
  host/
    store.ts             # 台账：串行 mutate、原子持久化、订阅
    tools.ts             # 8 个 taskboard_* 工具 + 代码级协议闸
    sdk.ts               # SDK 兼容层：defineTool/dshHomePath/MessageId（零运行时官方包 import）
    protocol-text.ts     # agent 工作流协议 systemPrompt section
    execution.ts         # 执行服务（新会话/模型/结算）
    scheduler.ts         # host 侧 cron tick
    routes.ts            # JSON + SSE HTTP 面
  client/
    index.ts             # 注入入口（connection）
    api.ts controller.ts # fetch/SSE + useSyncExternalStore 状态源
    board/*.tsx          # 看板视图（五列/筛选/卡片/详情/新建·编辑弹窗 TaskFormModal）
    sidebar-entry.ts board-mount.tsx styles.ts
tests/                   # vitest：protocol/tools/execution/routes/client
```

状态：P0–P4 完成；看板 UI 打磨（新建/编辑合一弹窗、任务编辑与项目改绑、`--dsw-alias-*` 主题令牌适配）已完成；未做：zh/en i18n、设置卡（`web-ui.plugin.item` slot）、npm 发布。
