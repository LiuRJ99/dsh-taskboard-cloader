# dsh-taskboard

DeepSeek Harness（DSH）的 **Agent 任务看板插件**：人把工作拆成卡片挂上看板，agent 会话通过 `taskboard_*` 工具认领、推进、评论、移交，人最终验收。双向协作，不是单向 todo 列表。

```
人在 GUI 建卡（选项目/紧急度/模型/执行方式）
        │
        ▼
看板 ◄──SSE 实时刷新──┐
        │              │ agent 会话内：
   [手动执行/定时触发]  │ taskboard_get / comment_add / move
        │              ▼
        ▼           卡片 → in_progress →（实现+自验）→ in_review
在任务项目里新建会话              agent 到此为止，永远到不了 done
（指定模型，干净上下文）
        │
        ▼
人在看板上确认 → done（唯一入口）
```

## 功能特性

**Host 侧（agent 工具 + 台账 + 调度）**

- **8 个 `taskboard_*` 工具**：任何会话中的 agent 都能查板、建卡、认领、移卡、评论、软删除
- **任务挂项目**：项目直接映射 DSH workspace，零新实体；认领（todo→in_progress）校验调用会话归属，跨项目认领被拒
- **紧急度三色**：urgent 红 / normal 紫 / relaxed 蓝，贯穿卡片、筛选、详情
- **每任务可固定模型**：执行时创建会话即生效；未指定走部署默认模型
- **两种执行方式**：认领制（项目内会话认领）或定时执行（host 侧 cron，关掉浏览器照样跑，错过窗口跳过不补跑）
- **一键真实执行**：手动「执行」在任务项目内新建全新会话（干净上下文）提交任务 prompt，回合结算记入执行记录
- **乐观并发**：所有写操作带 `ifVersion`，冲突返回 `version_conflict`
- **完整归因**：每次变更记录 actor（user / agent+sessionId），评论区分作者
- **host 权威台账**：`~/.dsh/dsh-taskbord.json` 原子持久化，全局 revision 单调递增，SSE 推送 + 断线全量对账

**协议硬闸（代码级强制，不靠 prompt 自觉）**

- agent 移卡到 `done` 一律 `forbidden` —— 完成只能由人在 GUI 确认
- 认领要求会话 cwd 解析到任务所属 workspace（跨项目 = `workspace_mismatch`）
- 任务被某 agent 会话持有期间，其他会话不可抢占（任何移动 `forbidden`）
- agent 不可篡改任务的 model / execution 配置（归创建者/用户所有）

**Client 侧（看板 UI）**

- **五列看板**：待规划 / 待办 / 进行中 / 待验收 / 已完成；blocked 角标不占列；canceled / archived / 已删除收进「其它任务」页
- **筛选栏**：项目下拉 + 紧急度三色 chip 多选
- **任务卡片**：紧急度左缘色条、模型 / ⏰ 定时（下次运行时间）/ 受阻 / 最近执行结果角标、评论计数；backlog ↔ todo 拖拽
- **新建 / 编辑任务弹窗**（`TaskFormModal`，新建与编辑共用）：
  - 头部图标 + 副标题、双列网格表单、底部实时校验提示 + 操作按钮
  - 紧急度色点卡片三选（各带副提示）、执行方式分段选择（认领制 / 定时）
  - Cron 预设 chip 高亮选中，**实时校验**（非法表达式红框）+ **下次运行时间预览**（与 host 调度器同一套纯函数）
  - 模型下拉读运行时已配置目录，「默认模型」为第一项
  - Esc 关闭、自动聚焦标题、保存提示版本变化
- **任务编辑**：详情面板「✎ 编辑」回填全部字段；GUI 作为 owner surface 可改标题 / 描述 / Prompt / 紧急度 / **项目改绑** / 执行方式 / 模型（含清除回默认）
- **详情面板**：状态流转（done 二次确认）、受阻标记、用户/agent 气泡评论流、执行记录时间线（结果/耗时/会话短 id/错误摘要）、危险区（软删除→物理清除需确认）
- **主题适配**：全部颜色走外壳 `--dsw-alias-*` 设计令牌，浅色 / 深色主题与皮肤自动跟随

## 核心概念

| 概念 | 说明 |
|---|---|
| 项目 | 直接映射 DSH workspace（无新实体）。任务创建时必须选一个 |
| 紧急度 | `urgent` 红 / `normal` 紫 / `relaxed` 蓝，看板列内以色条区分，支持筛选 |
| 状态机 | `backlog → todo → in_progress → in_review → done`，旁路 `canceled` / `archived`；`blocked` 是布尔标记不是状态 |
| 执行方式 | `claim`（项目内会话认领）或 `scheduled`（host 侧 cron 定时触发） |
| 模型 | 每任务可固定 `{provider, model}`；执行时应用到新建会话，未指定用部署默认模型 |
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

Agent 工作流协议（随插件注入 system prompt）：开工先查板 → 先读后动 → 先认领再干活 → 冲突只重试一次 → 自验后移 in_review 留评论 → `done` 永远由人确认 → backlog 未授权不执行 → model/execution 只读。

## 执行链路

手动「执行」按钮或 cron 到期都走同一条路：

1. 卡片置 `in_progress`，台账追加 execution 记录（`running`）；
2. 在任务项目目录里新建全新会话（干净上下文），带任务固定模型或部署默认模型；
3. 会话 attach 到 workspace（GUI 项目会话列表可见、可回链）；
4. 任务 prompt 作为普通用户消息提交，消息头带任务 ID 与状态说明；
5. 回合结算：成功 → `succeeded`；回合错误 → `failed`（错误入台账）。

调度器每分钟 tick；到期任务先顺延 `nextRunAt` 再触发；错过超过 5 分钟的窗口跳过不补跑。

## 安装

从 GitHub 安装（推荐）：

```bash
dsh plugin --profile <name> add github:cloader/dsh-taskboard
```

本地 link 开发（包名与仓库名均为 `dsh-taskboard`）：profile 的 `package.json`：

```json
{
  "dependencies": {
    "dsh-taskboard": "link:D:/path/to/dsh-taskboard"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-taskboard"
      ]
    }
  }
}
```

然后 `dsh plugin --profile <name> add link:D:/path/to/dsh-taskboard`。

> ⚠️ 官方 `@deepseek-ai/dsh-*` 包只写进 `bundles` 列表，**不要** `plugin add` 进 profile dependencies（会引发 SDK 双实例遮蔽，详见项目根 README 的踩坑记录）。

host 侧改动需重启 `dsh web`；client 侧改动 rebuild 后刷新页面。

## 开发

```bash
npm install
npm run build        # tsdown 双构建：host ESM + client CJS（wrap-client.mjs 包装）
npm test             # vitest 41 项（protocol/tools/execution/routes/client）
npm run typecheck
```

## 架构

```
src/
  shared/protocol.ts     # 状态机/紧急度/cron/记录类型（host+client 共享）
  shared/api.ts          # HTTP/SSE 线上契约
  host/
    store.ts             # 台账：串行 mutate、原子持久化、订阅
    tools.ts             # 8 个 taskboard_* 工具 + 代码级协议闸
    sdk.ts               # SDK 兼容层（零运行时官方包 import）
    protocol-text.ts     # agent 工作流协议 systemPrompt section
    execution.ts         # 执行服务（新会话/模型/结算）
    scheduler.ts         # host 侧 cron tick
    routes.ts            # JSON + SSE HTTP 面
  client/
    index.ts             # 注入入口（connection）
    api.ts controller.ts # fetch/SSE + useSyncExternalStore 状态源
    board/*.tsx          # 看板视图（五列/筛选/卡片/详情/新建·编辑弹窗 TaskFormModal）
    sidebar-entry.ts board-mount.tsx styles.ts
tests/                   # vitest：protocol/tools/execution/routes/client + smoke-host
  e2e/                  # dev-server 手工验证脚本（P0–P4，见 tests/e2e/README.md）
```

License: Apache-2.0
