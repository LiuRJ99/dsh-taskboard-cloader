# 任务详情预览面板 Markdown 显示优化 — 评估

> 评估对象：dsh-taskboard-cloader 插件（当前版本 0.5.1，fork 基线 0.5.0）
> 评估范围：「任务详情预览面板」即点击看板卡片后展开的详情视图（`src/client/board/TaskDetail.tsx`）
> 评估日期：2026-08-26 ｜ 状态：评估完成，方案已实施，待视觉回归

---

## 1. 结论摘要（TL;DR）

- **实施前现状**：详情面板全部 5 处长文本渲染点均为纯文本（`white-space: pre-wrap`），无任何 markdown 解析；仓库与 DSH 宿主均无可复用渲染器。
- **推荐方案**：**方案 A — marked（v18）+ renderer 安全边界 + 局部格式归一化**。单文件 ESM 仅 43.8KB，打进懒加载的 client bundle 后体积增加可控，能力覆盖 GFM 表格/删除线/自动链接；原始 HTML 在 renderer 出口转义，链接与图片使用 scheme 白名单。
- **渲染范围**：评论气泡（最高价值）→ 执行报告摘要/剩余风险 → 描述 → 执行 Prompt（可选）；清单文本/证据、卡片标题保持纯文本。
- **工作量**：约 0.5–1 人日（依赖 + 组件 + 5 处渲染点 + 样式 + 单测 + README），作为 **0.6.0 minor** 发布。

---

## 2. 现状盘点（基于当前仓库代码）

### 2.1 实施前详情面板中的长文本渲染点（全部纯文本）

| # | 内容 | 组件位置（TaskDetail.tsx） | 样式类（styles.ts） |
|---|------|---------------------------|---------------------|
| 1 | 描述 description | 行 522–527，`<div className="dsh-atb-desc">{task.description}</div>`（行 525） | `.dsh-atb-desc`（行 297）：`white-space: pre-wrap; word-break: break-word; font-size: 13px` |
| 2 | 执行 Prompt | 行 529–534，`<div className="dsh-atb-promptbox">{task.prompt}</div>`（行 532） | `.dsh-atb-promptbox`（行 291–293）：`font-size: 12px; white-space: pre-wrap` |
| 3 | 评论气泡正文 | 行 592，`<div className="dsh-atb-bubble-body">{c.body}</div>` | `.dsh-atb-bubble-body`（行 351）：`white-space: pre-wrap; word-break: break-word` |
| 4 | 执行报告·摘要 | 行 170，`<div className="dsh-atb-rpt-summary">{report.summary}</div>` | `.dsh-atb-rpt-summary`（行 631）：`white-space: pre-wrap` |
| 5 | 执行报告·剩余风险 | 行 177，`<div className="dsh-atb-rpt-risk">{report.risk}</div>` | `.dsh-atb-rpt-risk`（行 635–636）：`white-space: pre-wrap` |

其余短文本（标题、清单项、清单证据 note、meta 芯片、执行记录行）均不适合也不建议渲染 markdown。

### 2.2 已核实的事实

- 插件依赖中**无任何 markdown 库**（`node_modules` 全量检索无 marked/remark/micromark/react-markdown）。
- **DSH 宿主未暴露可复用渲染器**：`@deepseek-ai/dsh` 安装产物（lib/*.js 打包文件）全文检索无 `markdown` 标识；宿主依赖清单中无 markdown/DOMPurify 相关包；`@deepseek-ai/dsh-client-ui-*` 在本机安装中不提供源码/API。→ **方案 E（复用宿主）排除**。
- 客户端构建（`tsdown.client.config.ts`）：CJS 打包，external 仅 `@deepseek-ai/*`、`react(-dom)`、`schemastery`；**第三方库会被打进 `lib/client.cjs`**（本轮构建后约 288KB，未压缩）。minify: false。
- 测试基建：vitest + jsdom（`tests/client.spec.ts` 已能挂载整个 client 半边），可无缝补 markdown 单测。
- 数据来源：description/prompt 由用户或 agent 创建时填写；comments 由用户与 agent 双方写入（agent 交接协议要求「报告 → 评论 → 移待验收」，评论正文为结构化长文）；report 由 agent 提交。

### 2.3 现状截图式描述

- `**重要**`、`` `file.ts` ``、`- 列表项`、`[链接](url)`、表格分隔线等语法符号**原样裸露**。
- agent 交接评论（数百字、含多级列表与代码路径）在 `pre-wrap` 下是连续文本块，扫读困难；执行报告摘要/风险同理。

---

## 3. 方案对比

> 体积为实测：从 npm 拉取 tgz 后量取实际会进入 bundle 的文件；评估基线 client.cjs 约 224KB（未压缩），增长按未压缩口径估算。

| 方案 | 打入 bundle 体积 | 能力覆盖 | XSS 风险 | 维护成本 | 评价 |
|------|-----------------|----------|----------|----------|------|
| **A. marked v18（推荐）** | **+~44KB（lib/marked.esm.js 实测 43,800B，零依赖）** | GFM 表格、删除线、自动链接、围栏代码、任务列表；`breaks:true` 适配聊天式单换行 | 中→低：原始 HTML 在 `renderer.html` 出口转义，link/image renderer 做 scheme 白名单（见 §4） | 低（API 稳定、无依赖） | **性价比最高，首选** |
| B. markdown-it v15 | +~140KB（dist/markdown-it.mjs 实测 117.5KB + mdurl/linkify-it） | 更全，插件生态（可加 footnote 等） | 低：`html:false` 默认转义原文 HTML，链接需 `validateLink` 白名单 | 低 | 备选；能力冗余、体积约为 A 的 3 倍 |
| C. react-markdown v10 + remark-gfm | +200–300KB（本体 52KB，但 unified/remark-parse/micromark 依赖链重） | 最全；React 树渲染，天然无 `dangerouslySetInnerHTML` | 低（默认不解析 raw HTML） | 中（依赖链版本耦合） | 过重；对本插件「纯文本转展示」场景属于杀鸡用牛刀，**不推荐** |
| D. 自研最小渲染器 | +2–5KB | 仅粗斜/行内代码/链接/列表/标题/围栏代码；无表格、无 GFM 细节 | 低（自产白名单标签） | 中（正则边界 case 需自维护，markdown 方言无穷尽） | 轻量兜底；能力缺口（表格是 agent 报告高频用法）使体验打折 |
| E. 复用宿主渲染器 | 0 | — | — | — | **不可行**：已确认宿主无暴露 API |

### 3.1 关键取舍

- **表格是刚需**：agent 执行报告/评论中「改动文件」「自验情况」常以表格/列表呈现，仅自研渲染器（D）无法覆盖 → 排除 D 为唯一方案。
- **体积敏感度**：client.cjs 为懒加载模块（看板挂载时才拉取），+44KB（A）几乎无感；+140KB（B）、+250KB（C）会显著拖慢首开。
- **marked v18 现状**：`gfm: true` 默认开启（表格/删除线/自动链接）；`breaks: false` 需显式开；零依赖、同步解析、速度快（长评论解析 < 1ms 量级）。

---

## 4. 安全分析（XSS 主风险与缓解）

任务数据（描述/评论/报告）来自 agent 执行会话与用户，属于**半可信内容**——agent 会话可能被注入、历史任务数据含不可信串，必须按不可信输入处理。

1. **原文 HTML 透传**：marked 默认把输入中的原始 HTML 原样输出（`<img onerror=…>`、`<script>`）。缓解：不预先改写整段 Markdown，而是覆写 `renderer.html`，将原始 HTML token 转义成可见文本；这样粗体、列表、表格、链接标题等合法 Markdown 仍按语法解析。
   - 代价：保留了 marked 的 HTML token 解析路径，需要持续覆盖原始 HTML 与属性注入回归用例；这是当前实现相对“整段预转义”的必要复杂度。
2. **危险 URL scheme**：`[x](javascript:alert(1))` 会原样进 `href`。缓解：覆写 `renderer.link`（及 `renderer.image`），仅放行 `http/https/mailto/#`，其余 scheme 丢弃 href 只留文本。
3. **输出注入点**：唯一出口是 `<Markdown>` 组件的 `dangerouslySetInnerHTML`；配合 1+2 后注入内容只剩白名单标签，可控。组件内写明安全契约注释，禁止绕行。
4. **链接行为**：`http/https/mailto` 链接使用 `target="_blank" rel="noopener noreferrer"`；`#fragment` 链接保留当前页跳转，不强制新开页。
5. **样式隔离**：渲染容器统一 `dsh-atb-md` 前缀作用域，嵌套选择器限定在容器内，避免污染宿主/看板其他样式（沿用项目既有 `dsh-atb-` 前缀惯例）。
6. **不做**：不引入 DOMPurify（防线 1 已足够且更简单）、不渲染任务数据里的 iframe/form 等危险标签（marked 不会生成，转义后原文也进不来）。

---

## 5. 渲染范围（按价值排序）

| 优先级 | 渲染点 | 理由 | 建议 |
|--------|--------|------|------|
| P0 | 评论气泡正文（行 592） | agent 交接报告最长、最结构化；用户评论也常带代码/链接 | **渲染** |
| P0 | 执行报告·摘要 + 剩余风险（行 170/177） | agent 结构化产出，验收时扫读刚需 | **渲染** |
| P1 | 描述 description（行 525） | 需求书写天然用 markdown | **渲染** |
| P1 | 执行 Prompt（行 532） | 本质是执行载荷；渲染后可读性略好，但保留等宽/pre-wrap 观感也可接受 | **渲染（或保持代码块风格）**，二选一 |
| — | 清单项文本/证据 note | 短文本，无必要 | 保持纯文本 |
| — | 卡片标题、meta 芯片、执行记录 | 单行短文本 | 保持纯文本 |
| — | ImportModal 预览（JSON/CSV） | 结构化数据预览，非 markdown | 不动 |

> 已实现：详情顶部提供**「原文 vs 渲染」切换**，覆盖本节列出的 5 个长文本字段；原文使用 React 文本节点，不进入 HTML 注入路径。

---

## 6. 实现要点与工作量（若批准实施）

### 6.1 改动清单（已实施）

1. **新增依赖**：`marked@^18` 保持为普通 Markdown runtime；`mermaid@^11` 只进入独立的 `lib/client-mermaid.js` 浏览器 chunk，不进入核心 `client.js`。
2. **新增 `src/client/markdown.tsx`**：
   - `escapeHtml(text)`：转义 `& < > " '`；
   - `renderMarkdown(text)`：对 CRLF、已观察到的列表段落标签和空行分隔的 GFM 表格行做局部归一化，再调用 `marked.parse(normalizedText, { gfm: true, breaks: true, async: false })`；
   - 覆写 `renderer.html`、`renderer.code`、`renderer.codespan`、`renderer.link` / `renderer.image`：原始 HTML/代码内容/属性转义，URL scheme 白名单；外链增加 `target=_blank rel=noopener noreferrer`；
   - `<Markdown text className>` 组件：普通内容继续走受保护的 `dangerouslySetInnerHTML` 出口；检测到 Mermaid fence 时交给详情专用增强器，源码保持可见直到安全 SVG 完成。
3. **`src/client/board/TaskDetail.tsx`** 替换 5 处（§2.1 表格 #1–#5）为 `<Markdown text={…} />`。
4. **`src/client/styles.ts`** 新增 `.dsh-atb-md` 作用域样式：`p / h1–h4 / ul,ol,li / code / pre（围栏代码块底色+横向滚动）/ a / blockquote / table,th,td / hr`；字号继承各自容器（desc 13px、bubble 12.5px 等），配色用 DSH 设计变量（如 `var(--dsw-alias-fill-tertiary)` 作代码底色）。
5. **单测**（`tests/markdown.spec.ts`，vitest 纯函数级）：
   - 转义：`<script>` 原样可见、`&` 正确实体化；
   - XSS：`[x](javascript:alert(1))` 的 href 被丢弃；
   - GFM：表格产出 `<table>`、删除线、裸 URL 自动链接；覆盖空行分隔的多行表格；
   - `breaks: true` 单换行、空字符串/纯文本、链接/图片标题与查询参数、嵌套 blockquote、代码转义、section label 与合法列表续行回归。
6. **README**：changelog 记 0.6.0，说明普通 Markdown 与详情 Mermaid 懒加载范围及安全契约。
7. **验证**：`npm run typecheck`、全量 `npm test`（17 个测试文件、248 个用例）和 `npm run build` 已通过；本地 GUI 已验证含 Mermaid 内容的详情在 chunk route 不可用时保留源码并显示失败提示，Host 重启后仍需完成一次成功 SVG 的视觉回归。
8. **Mermaid 增量**：新增 `src/client/mermaid-blocks.ts`、`mermaid-chunk-loader.ts`、`mermaid-sanitize.ts`、`mermaid.tsx`、`src/host/mermaid-route.ts` 与对应单测；核心 bundle 不包含 Mermaid runtime，独立 chunk 约 6.78 MB（未压缩）。

### 6.2 工作量与节奏

- 原普通 Markdown 预估 **0.5–1 人日**；本次详情 Mermaid 懒加载实际按 **3–4 人日**（含独立 chunk、Host 静态路由、安全清洗、失败回退、测试与 GUI 回归）实施；无协议/存储改动。
- 发布节奏：**0.6.0 minor**（新特性），沿用现有打包/发布流程。
- 风险点：
  - 核心 bundle 相比普通 Markdown 基线增加约 25KB；Mermaid runtime 独立 chunk 约 6.78MB 未压缩，仅在详情命中 Mermaid fence 时加载；若在意首图等待，可后续增加 chunk 压缩/缓存策略（不改变当前回退契约）。
  - 渲染与「复制原文」体验存在差异 — 已提供原文/渲染切换，复制行为仍沿用现有任务配置复制逻辑。
  - 老数据里被转义的 HTML 会显示为实体文本 — 属预期行为（安全优先）。

---

## 7. 结论

**推荐：普通内容继续采用方案 A（marked v18 + 原始 HTML renderer 转义 + 链接白名单），详情中的 Mermaid 采用独立 runtime + strict SVG 清洗 + 失败保留源码；Host 重启后仍需完成一次成功 SVG 的视觉回归。**

理由一句话：普通详情保持低额外加载，只有命中 Mermaid fence 才承担约 6.78MB runtime 的一次性请求；安全边界仍由 Markdown renderer 与 Mermaid SVG 二次清洗共同承担，任何加载/解析/渲染异常都不会丢失原文。

---

## 附：评估过程中的实测事实（可复核）

| 项目 | 数值 | 取证方式 |
|------|------|----------|
| `lib/client.cjs` 普通 Markdown 基线体积 | 288,463 B | 实施前 `wc -c lib/client.cjs` |
| `lib/client.cjs` 当前核心体积 | 约 320,000 B | 实施后构建输出 |
| `lib/client-mermaid.js` 当前体积 | 约 6.78 MB 未压缩 | 实施后构建输出；详情命中 Mermaid 时按需请求 |
| marked@18.0.11 ESM 文件 | 43,800 B（普通 Markdown 依赖） | `npm pack` 后量 `package/lib/marked.esm.js` |
| mermaid@11.16.1 | 仅作为构建输入，runtime 独立打入 lazy chunk | `package.json`、`tsdown.client.config.ts` |
| markdown-it@15.0.0 dist | 117,506 B（+mdurl/linkify-it） | `npm pack` 后量 `package/dist/markdown-it.mjs` |
| react-markdown@10.1.0 本体 | 52,637 B（依赖链另计） | `npm view dist.unpackedSize` |
| 宿主可复用渲染 API | 无 | 检索 `@deepseek-ai/dsh/lib/*.js` 无 markdown 标识；宿主依赖清单无相关包 |
| 插件现有 markdown 依赖 | `marked@18.0.11` + `mermaid@11.16.1`（后者仅 lazy chunk） | `package.json` / `package-lock.json` |
