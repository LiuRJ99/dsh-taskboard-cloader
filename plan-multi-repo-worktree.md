# dsh-taskboard 0.7.0 规划：并列多仓库工作空间的 Worktree 镜像模式

> 状态：**已实施（0.6.3，typecheck + 254 tests 全绿，未提交）** · 写作时点：0.6.1 发布后
> 目标版本：0.6.3（feature 级）

## 0. 背景与问题

当前 worktree 隔离（0.3.0 引入）建立在「一个项目（workspace）= 一个 git 仓库」的模型上：

- 隔离目录固定为 `<workspace>/.dsh-worktrees/<taskId>/`，它是**工作区根仓库**的一个 worktree，检出任务分支 `task/<标题>+<taskId>`（`host/git.ts` 的 `worktreePathOf` + `prepareWorktree`）。
- 证据采集、合并、清理全部围绕这一个根仓库（`collect` / `merge` / `removeWorktree` / `deleteBranch`）。

但 DSH 的典型用法是**多项目容器工作区**：根目录是一个（轻量）git 仓库，旁边并列着若干**独立嵌套仓库**（如本工作区：根仓库 + `dsh-taskboard/.git` + `dsh-devlaunch/.git`，互相不嵌套跟踪）。此时：

1. 根仓库不跟踪子仓库内容 → 根仓库的 worktree 里**根本没有子仓库代码**；
2. agent 被 framing 引导「全部改动只发生在 worktree 目录内」，但它要改的子仓库代码不在那里 → 只能回主目录直接改子仓库；
3. 改动落在子仓库的当前分支（通常是 main）→ **隔离失效、无提交证据、无法一键合并审查**。

即：对并列多仓库工作空间，现有 worktree 模式形同虚设。

## 1. 目标与非目标

### 目标

- worktree 模式下，把整个工作区**镜像**到 `<workspace>/.dsh-worktrees/<taskId>/`：每个被发现的 git 仓库各自建立一个 worktree，放在其在工作区中的**相对路径位置**，形成结构同构的任务镜像。
- 每个仓库内各自有同名任务分支，提交证据、diff 审查、合并、清理**按仓库进行并聚合展示**。
- **单仓库工作区行为零变化**（向后兼容：老账本、老任务、老 UI 流程全部照旧）。
- 沿用全部既有安全纪律：fail-soft 降级、`.dsh-worktrees` 豁免、scope 校验、per-root 结构锁、证据封顶。

### 非目标（0.7.0 明确不做）

- git submodule / gitlink 形态的嵌套仓库支持（`.git` 为指向父仓库的 file 且属于 submodule 的，跳过并在 note 中说明）。
- 跨仓库原子合并（多仓库合并天然是逐仓库顺序提交，做不到原子；只做清晰的分仓库结果报告）。
- 非 git 目录的镜像（无版本控制可隔离；在 framing 中列为「未镜像、禁改」）。
- per-task 指定仓库子集（留作后续增强，本期自动发现全部仓库）。

## 2. 现状代码事实（设计依据）

| 事实 | 位置 |
|---|---|
| `worktreePathOf(ws, taskId)` → `<ws>/.dsh-worktrees/<taskId>`，taskId 先过 `isValidTaskId` | `host/git.ts` |
| `prepareIsolation`：detect → prepareWorktree(根, path, branch, fresh/reuse)，失败降级 + isolationNote | `host/execution.ts` |
| 会话 cwd 恒为项目根（DSH 会话模型约束：attach 校验 / 侧栏分组 / 沙箱边界），worktree 靠 framing 引导 | `host/execution.ts` 步骤 2 注释 |
| 证据 `collect(worktreePath, baseCommit)` → ExecutionRecord 扁平字段（commits/dirtyFiles/diffStat…，封顶 50/100） | `host/git.ts` + `shared/protocol.ts` |
| merge：per-repo dirty 检查（豁免 `.dsh-worktrees`）→ `--no-ff` → 冲突 `merge --abort` 原样上报；noop 用 `isAncestor` | `host/git.ts` + `host/routes.ts` |
| 清理三口（worktree-remove / purge / worktree-cleanup）都走 `insideWorktreeScope` + `removeWorktree`（dirty 拒删）+ 可选 `deleteBranch` | `host/routes.ts` |
| diff 路由：cwd = `execution.worktreePath ?? ws.path`，worktree 消失后回落主仓库 | `host/routes.ts` |
| per-root 进程内互斥锁串行化结构操作 | `host/git.ts` `withRootLock` |
| `task.branch` 首次成功创建时 pin（改名不改分支）；`ExecutionRecord.branch/worktreePath/baseCommit` 单仓库字段 | `host/execution.ts` + `shared/protocol.ts` |

**关键推论**：`GitFace` 全部原语本来就是 per-repo 设计（都显式接收 root），多仓库编排不需要改 git.ts 的接口语义，只需要在上层**按仓库多次调用并聚合**。

## 3. 方案总览：任务镜像（mirror）

```
<workspace>/                        # 真实工作区（根仓库 + 并列子仓库）
├── .dsh-worktrees/
│   └── <taskId>/                   # 任务镜像根 = 根仓库的 worktree（根是仓库时）
│       ├── <根仓库跟踪文件>…
│       ├── dsh-taskboard/          # 子仓库 worktree（挂在其相对路径位置）
│       │   └── <该仓库全部文件>     #   分支 task/<标题>+<taskId>
│       └── dsh-devlaunch/          # 另一子仓库 worktree
├── dsh-taskboard/                  # 真实子仓库（执行期间不被触碰）
└── dsh-devlaunch/
```

- 镜像根路径不变（`worktreePathOf` 原样），scope 校验（R4③）天然覆盖全部子镜像。
- 根仓库若不存在（纯容器目录 + 子仓库）：镜像根退化为普通目录，只挂子仓库 worktree。
- agent 会话 cwd 仍是项目根（DSH 硬约束），framing 给出镜像内各仓库的绝对路径与分支清单。

## 4. 分模块设计

### 4.1 仓库发现 —— 新模块 `host/repos.ts`

- `discoverRepos(workspacePath): Promise<RepoRef[]>`，`RepoRef = { relPath: '' | 'dsh-taskboard' | …, absPath }`（`''` = 根仓库）。
- 有界扫描（深度 ≤ 3），跳过：`.git` 本体、`node_modules`、`.dsh-worktrees`、点开头目录、`lib/dist/build` 等产物目录（忽略清单常量）。
- `.git` 为目录（普通仓库/独立 worktree 的主仓）或为 file（linked worktree）都算发现；submodule 形态（file 指向父仓 `.git/modules/**`）本期跳过。
- 结果按 relPath 排序（`''` 最前）；按 workspace 记 TTL 缓存（对齐 `GIT_DETECT_TTL_MS = 60s`）。
- fail-soft：扫描异常 → 只返回根仓库探测结果（等价现状）。
- **封顶**：`MAX_MIRROR_REPOS = 8`；超过 → 该任务 worktree 模式整体降级原目录，isolationNote 说明「仓库数超上限」（可预测、不产生半吊子镜像）。

### 4.2 数据模型 —— `shared/protocol.ts`

附加式迁移，**不改动任何既有字段的语义**：

```ts
// TaskRecord 新增（首次成功准备时逐仓库 pin，语义同 branch）
branches?: Record<string, string>        // relRepoPath → branch；'' 键不用（根走既有 branch）

// ExecutionRecord 新增（多仓库时填充；根仓库证据继续写既有扁平字段 = 双写）
repos?: Array<{
  repo: string              // 相对路径（'' = 根仓库）
  branch: string
  worktreePath: string
  baseCommit?: string
  headCommit?: string
  commits?: CommitInfo[];  commitsTotal?: number
  dirtyFiles?: string[];   dirtyFilesTotal?: number   // 相对该 worktree 的路径
  diffStat?: string;       changedFiles?: number
}>
```

- 单仓库场景 `repos` 不写，账本、GUI、diff 路由零感知。
- `normalizeExecution` 增补新字段校验（条数封顶 ≤ 8、字符串长度/类型、证据字段复用既有封顶逻辑）。
- 旧账本直接兼容：无新字段即老行为。

### 4.3 隔离编排 —— 新模块 `host/isolation.ts`（从 execution.ts 抽出）

把 `prepareIsolation` 升级为多仓库编排，execution.ts 只消费其结果：

1. `discoverRepos` → 逐仓库 `git.prepareWorktree(repoAbs, mirrorRepoPath, branch, mode)`（分支名统一 `sanitizeBranchName`，跨仓库同名合法）。
2. **部分失败策略（关键决策，见 §8-D1）**：某仓库准备失败 → 先 prune 重试一次；仍失败则**该仓库不镜像**，framing 明确「X 未镜像，本任务禁改它」；**根仓库（首个仓库）失败仍整体降级**（维持现状语义）。边界纪律不破：镜像内=可改，未镜像=禁改。
3. `reuse`（续跑）逐仓库 `'reuse'` 模式：活着的保留（各仓库 reused 标志聚合，全部 reused 才按续跑文案引导）。
4. 成功后逐仓库补 pin：`task.branch`（根，首次）+ `task.branches[rel]`（各仓库，首次）。
5. 返回 `PreparedMirror { root?, repos: PreparedWorktree[], skipped: Array<{repo, reason}> }`。

### 4.4 证据聚合与 diff viewer

- settle 时逐仓库 `collect`：根仓库写既有扁平字段（**双写**，兼容现 GUI/路由），全部仓库写入 `execution.repos`。
- dirtyFiles/commits 保持「相对各自 worktree」，由 client 按仓库分组渲染并加仓库名标签。
- diff 路由加可选 `?repo=<relPath>`：cwd 解析链 = 该仓库镜像 worktree → 该仓库主检出（`ws.path/<rel>`，提交在分支 ref 里仍在对象库）→ 报错。缺省 `repo` = 根仓库（现行为）。

### 4.5 合并编排 —— `routes.ts` merge action

- 有 `task.branches` 或最近执行带 `repos` → 多仓库合并：逐仓库 `isAncestor`（noop 记录）→ `merge`；聚合响应：
  `{ results: [{ repo, branch, merged|noop|failed, error? }] }`。
- 顺序执行、失败不阻断后续仓库（`--no-ff` 合并无法安全回滚，部分成功如实报告）；系统评论写分仓库结果摘要。
- 无 `branches`（老任务）→ 现行为原样。

### 4.6 清理流 —— worktree-remove / purge / worktree-cleanup

- **删除顺序：先子后根**。子镜像不先删，根 worktree 会因嵌套仓库目录呈现 untracked 被 dirty 拒删（`removeWorktree` 的 status 检查不豁免 `.dsh-worktrees` 以外路径——这是嵌套布局的必然要求）。
- dirty 检查聚合所有仓库的未提交清单一次性报出（分仓库前缀）。
- orphan 清理：孤儿目录内先探测仓库（读 `.git` file/dir），逐个从各自主仓 remove，最后 fs rm 残余；`insideWorktreeScope` 校验不变。

### 4.7 会话引导 —— `pluginFraming`

- 多仓库镜像追加一段：镜像根 + 每仓库「相对路径 → worktree 绝对路径（分支 X）」清单；未镜像仓库列出并标禁改；提交纪律改为「改动发生在哪个仓库镜像内，就 commit 到那个仓库的任务分支」。
- 单仓库/续跑/降级文案全部保留不变。

### 4.8 client 与 i18n

- 任务详情：合并按钮展示分仓库结果（每仓库 merged/noop/failed）；worktree 区块按仓库列路径与分支；执行证据 commits/dirtyFiles 按仓库分组。
- `client/api.ts` / `controller.ts`：merge 返回结构、diff 请求带 `repo` 参数。
- i18n `zh.ts`/`en.ts` 补齐新文案；**改客户端必须重跑 client 构建**（`npm run build`）才在 GUI 生效。

### 4.9 设置项

- 本期**不加新开关**：自动检测——单仓库 → 现行为；多仓库 → 镜像模式。行为可预测、无学习成本；`BoardSettings` 预留 `worktreeMode?: 'auto'` 字段不实现 UI。

## 5. 兼容性矩阵

| 场景 | 行为 |
|---|---|
| 单仓库工作区 + 旧任务/旧账本 | 完全不变（`repos` 不产生） |
| 多仓库工作区 + 旧任务（仅 `branch` pin） | 根仓库沿用 `branch`，子仓库首次准备时补 pin 到 `branches` |
| 根不是仓库、子仓库存在 | 镜像根 = 普通目录，仅挂子仓库 worktree（现状这种工作区本来就直接降级，属增强） |
| git 未装 / 所有仓库探测失败 | 现状降级路径不变 |
| 仓库数 > 8 | 整体降级 + note |
| submodule | 跳过 + note（不支持） |

## 6. 测试计划（vitest，沿用可注入 ExecFn 模式）

- `tests/repos.spec.ts`（新）：临时目录 fixture——根仓 + 嵌套仓 + `node_modules` 内假仓 + 深层仓 + submodule 形态；断言发现/排除/排序/封顶/TTL。
- `tests/execution.spec.ts` 增：多仓库 prepare 成功/部分失败（skipped 清单 + 禁改引导）/根失败整体降级/超上限降级；续跑聚合 reused；双写断言（扁平字段 = 根仓库证据）。
- `tests/git.spec.ts`：现有用例不动；补嵌套布局下「先子后根」删除顺序的编排测试（脚本化 exec 断言调用序列）。
- `tests/routes.spec.ts` 增：merge 聚合结果（一仓冲突不阻断它仓）、worktree-remove/purge 聚合 dirty 拒删、diff `?repo=` 回落链、cleanup 多仓孤儿。
- `tests/protocol.spec.ts`：`normalizeExecution` 新字段校验 + 旧账本无损加载。
- `tests/client.spec.ts` / `tests/i18n.spec.ts`：分组渲染与文案键。
- `tests/manual-git-e2e.mjs` 增多仓库手跑场景（真实 git）。

## 7. 实施阶段与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| M1 | `repos.ts` + 数据模型 + `isolation.ts` 编排 + framing + 单测（§4.1–4.3、4.7） | `npm run typecheck` + `npm test` 绿；单仓库回归零 diff |
| M2 | 证据双写 + diff `?repo=` + client 分组展示（§4.4、4.8） | client 构建重跑；GUI 手验多仓库任务详情 |
| M3 | merge/清理编排（§4.5、4.6）+ routes/client | routes.spec 绿；本工作区（根 + dsh-taskboard + dsh-devlaunch）真实演练一轮：跑任务 → 镜像内提交 → 分仓库合并 |
| M4 | README / README_en / changelog / 版本 0.6.3 | 发布卫生检查；子仓库内提交（不进根仓库） |

## 8. 风险与决策记录（评审落定：按建议执行，版本号 0.6.3）

- **D1（已落定）部分失败策略**：未镜像仓库「禁改」而非整体降级——保住隔离边界，避免单仓库占用拖垮整任务。若评审倾向「全有或全无」，改动点仅在 isolation.ts 编排一处。
- **D2（已落定）仓库发现广度**：深度 ≤3；忽略清单为本期常量，不做配置。
- **Windows 细节**：镜像内嵌套删除的句柄占用（node_modules 不镜像，风险小）；路径大小写对齐 `removeWorktree` 既有 toLowerCase 比对。
- **性能**：每任务 N 个 worktree 的创建耗时（N 通常 ≤3）；TTL 缓存 + per-root 锁已防抖。
- **纪律**：改动全部发生在 `dsh-taskboard/` 子仓库内提交；根仓库只增本规划文档。

## 9. 复审补充（2026-09-02）

- **§4.1 偏差更正**：实现阶段将 `.git` 为 file 的形态（linked worktree 与 submodule）**全部跳过**，仅发现 `.git` 目录——linked worktree 的 refs 位于其它仓库的对象库，按独立仓库注册会双重登记同一对象库。README/changelog 已按实际实现记录；根仓库本身仍经 `git detect` 探测，不受此偏差影响。
- **§4.9 落地补记**：仍不加隔离开关（按 §4.9 自动检测），但表单补了镜像可见性——workspaces 路由新增 `repoCount`，新建任务表单在多仓库工作区显示「将自动整区镜像 N 个仓库」提示；同时修复纯容器工作区（根非仓库、只有并列子仓）被 `gitAvailable`（仅探测根目录）误禁 worktree 选项的 gating 缺陷；`worktreeMode` 预留字段未实现（保持无字段）。
- **评审修复（镜像结构性噪声）**：嵌套子镜像在根镜像 status 中呈现 `?? 子仓/`（untracked）或 `M 子仓`（gitlink 漂移），此前使镜像删除预检、证据采集、合并 clean 检查全部误判（已全部提交的镜像仍被永久拒删/拒并、证据出现幻影脏）。修复：`statusLineUnder` 形状感知豁免统一接入 `collect` / `merge` / `removeWorktree`；镜像删除修正为真正的「先子后根」（原 reverse 循环实为根先删，与文档矛盾）；`removeMirror` 拆除前 `clearCache` 重新发现。新增 `tests/isolation.spec.ts`（脚本化编排回归）与 `tests/mirror-real-git.spec.ts`（真实 git 端到端，未跟踪 + gitlink 两形态）锁定。
