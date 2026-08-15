[![npm version](https://img.shields.io/npm/v/dsh-taskboard.svg)](https://www.npmjs.com/package/dsh-taskboard)
[![License](https://img.shields.io/npm/l/dsh-taskboard.svg)](https://github.com/cloader/dsh-taskboard/blob/main/LICENSE)

# dsh-taskboard

DeepSeek Harness 的**任务看板插件**：人建卡、agent 认领执行、人验收。任务挂项目（workspace）、可指定模型、支持手动与定时执行，全流程双向协作。

## 界面

<p align="center"><img src="https://raw.githubusercontent.com/cloader/dsh-taskboard/main/img/board.png" alt="任务看板" width="880"></p>

<p align="center"><img src="https://raw.githubusercontent.com/cloader/dsh-taskboard/main/img/modal.png" alt="新建任务" width="440"></p>

## 核心功能

**看板协作**
- 五列看板（待规划 / 待办 / 进行中 / 待验收 / 已完成）+ 受阻标记，SSE 实时刷新
- 任务挂项目：认领校验会话归属，跨项目不可抢
- 紧急度三色（紧急/一般/不急）筛选与色条
- 新建/编辑弹窗：项目、模型、紧急度、执行方式、cron 实时校验与下次运行预览
- 详情面板：状态流转（done 仅限人工）、agent/用户评论流、执行记录回链会话

**Agent 工具（taskboard_\*）**
- 8 个工具：查板 / 建卡 / 改卡 / 移卡 / 评论 / 软删除，任何会话可用
- 代码级协议闸：agent 永远移不到 done；任务被持有时不可抢占；model/execution 对 agent 只读

**执行**
- 手动执行或 cron 定时：每次执行在任务项目内新建全新会话（干净上下文、可指定模型）
- host 侧调度：关掉浏览器照常触发；错过窗口跳过不补跑
- 乐观并发（ifVersion）+ 完整归因（谁改的、哪个会话执行的）

## 安装

```bash
dsh plugin --profile <name> add dsh-taskboard          # npm（推荐，预构建免授权）
dsh plugin --profile <name> add github:cloader/dsh-taskboard   # GitHub 源
```

> 官方 `@deepseek-ai/dsh-*` 包只写进 profile 的 `bundles` 列表，不要 `plugin add` 进 dependencies（避免 SDK 双实例遮蔽）。

## 开发

```bash
npm install && npm run build    # host ESM + client CJS 双构建
npm test                        # vitest 41 项
node scripts/screenshot.mjs     # 重新生成 img/ 截图（需本机 Edge）
```

## 升级日志

### 0.1.2

- **看板拖拽**：所有列的卡片可互相拖动（按状态机校验合法流转，非法拖放弹窗提示）；正在执行的任务拖动会被拦截，提示「该任务正在由【任务名】会话执行，不能拖动」
- **执行会话体验**：执行会话标题固定为任务名（经 `sessionTitle.rename` 写入，不会被自动重命名覆盖）；首条消息以正常用户消息呈现（不再是插件上下文行）
- **交互优化**：
  - 新建/编辑弹框新增「⚡ 立即执行」按钮（保存后直接发起执行）
  - 详情页「立即执行」移至「编辑」按钮旁
  - 「+ 新建任务」移至看板标题统计旁
  - 状态流转按钮文案统一为「移至→{状态}」
- **弹窗**：原生 `alert()` 全部替换为主题化模态弹窗（Esc/遮罩可关）

### 0.1.1

- 初始 npm 发布：看板协作、8 个 agent 工具、手动/cron 执行、SSE 实时视图

License: Apache-2.0
