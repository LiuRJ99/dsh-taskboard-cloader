[![npm version](https://img.shields.io/npm/v/dsh-taskboard.svg)](https://www.npmjs.com/package/dsh-taskboard)
[![License](https://img.shields.io/npm/l/dsh-taskboard.svg)](https://github.com/cloader/dsh-taskboard/blob/main/LICENSE)

English | [简体中文](./README.md)

# dsh-taskboard

A **task board plugin for DeepSeek Harness**: humans create cards, agents claim and execute them, humans review and accept. Tasks live on projects (= workspaces), support per-task model & preset selection, and can run manually or on a cron schedule — full two-way collaboration from card to sign-off.

- **Closed loop**: human creates a card → agent claims & executes → structured hand-off report → human accepts (✓ done / ✗ send back with a reason)
- **10 `taskboard_*` agent tools** plus code-level protocol gates: agents can never move a task to *done*, held tasks cannot be snatched away, cross-project claims are rejected
- **Execution**: manual or cron-scheduled (host-side scheduling keeps firing with the browser closed); every execution opens a brand-new session inside the task's project, optionally pinned to a model and preset
- **Git worktree isolation**: each run works on its own worktree + dedicated task branch, one-click merge at acceptance; non-git projects fall back automatically
- **Efficient acceptance**: DoD acceptance checklists (agent checks items off with evidence), structured execution reports (summary / changed files / checks / artifacts / risks), in-board diff viewer
- **Live board**: SSE real-time refresh, five-column flow, persisted filters & sorting, JSON import/export, task templates

**Zero configuration**: install and it works — no tokens, no API keys, no extra services or databases.

## Screenshots

<p align="center"><img src="https://raw.githubusercontent.com/cloader/dsh-taskboard/main/img/board.png" alt="Task board" width="880"></p>

<p align="center"><img src="https://raw.githubusercontent.com/cloader/dsh-taskboard/main/img/modal.png" alt="New task dialog" width="440"></p>

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Agent Tool Reference](#agent-tool-reference)
- [Features](#features)
- [Safety](#safety)
- [Configuration & Data](#configuration--data)
- [FAQ](#faq)
- [Development](#development)
- [Changelog](#changelog)

## Prerequisites

| Dependency | Requirement | Notes |
| --- | --- | --- |
| DeepSeek Harness | ≥ 0.1.1 | Requires the `dsh plugin` subcommand and the web profile |
| Node.js | ≥ 20 | Only needed when installing/building from the GitHub source |
| git | optional | Required for worktree isolation; falls back to running in place when missing |

## Installation

```bash
# One-command install from npm (prebuilt, no build approval — recommended)
dsh plugin --profile web add dsh-taskboard

# Or install from the GitHub source
dsh plugin --profile web add github:cloader/dsh-taskboard
```

After installing, **restart `dsh web` and refresh the page**: you should see a "Task Board" entry in the sidebar. No further configuration needed.

<details>
<summary>GitHub-source install stuck on prepare / allowBuilds?</summary>

Plugins installed from a git source go through a prepare script, and pnpm blocks it first — follow the error message and add the exact key to `allowBuilds` in your profile's `pnpm-workspace.yaml`, then retry. The npm package ships prebuilt artifacts and never hits this step.
</details>

<details>
<summary>Developer-mode install (edit code and see changes immediately)</summary>

```bash
git clone https://github.com/cloader/dsh-taskboard.git
cd dsh-taskboard
npm install && npm run build
dsh plugin --profile web add "link:/path/to/dsh-taskboard"
```

With a link install, rebuild via `npm run build` in the repo and refresh the page; host-side changes additionally require restarting `dsh web`.
</details>

Uninstall: `dsh plugin --profile web remove dsh-taskboard` (ledger data stays in the DSH home directory — see [Configuration & Data](#configuration--data)).

> Official `@deepseek-ai/dsh-*` packages belong in the profile's `bundles` list only — do not `plugin add` them into dependencies (avoids shadowed dual SDK instances).

## Quick Start

**Step 1 · Create a card**: click "+ New Task" in the board toolbar — pick a project, urgency, execution mode (claim / scheduled + cron), model and preset, Git isolation toggle, and an acceptance checklist; tick "⚡ Run now" to execute immediately.

**Step 2 · An agent executes it**, triggered any of three ways:

1. GUI "Run now" / "↻ Resume" buttons (detail panel or form)
2. Cron schedule (host-side — no browser required)
3. Ask any agent in any session to claim it with the `taskboard_*` tools: `pick up task t-xxxxx from the board and execute it`

**Step 3 · Human acceptance**: in the *In Review* column, "✓ Done" accepts in one click; "✗ Send back" returns it to *Todo* with an optional reason (agents read it before their next round).

A complete agent workflow (the protocol below is injected automatically by the plugin at execution start):

```text
You: execute board task t-ab12cd
agent:
  taskboard_list                # read the board: todo tasks in this project
  taskboard_get t-ab12cd        # requirements, comments, acceptance checklist
  taskboard_move → in_progress  # claim (code gate: rejects held / cross-project tasks)
  ……code & test……
  taskboard_checklist check     # tick checklist items one by one, with evidence notes
  taskboard_execution_report    # structured report: summary/files/checks/artifacts/risks
  taskboard_comment_add         # hand-off notes
  taskboard_move → in_review    # move to In Review
You: click ✓ Done in the In Review column   # done belongs to humans only — agent calls are rejected by the code gate
```

## Agent Tool Reference

Available in any session. Project boundary: only sessions belonging to the task's project can claim or execute it.

| Tool | Purpose |
| --- | --- |
| `taskboard_list` | Read the board (filter by project / status / urgency; compact summaries) |
| `taskboard_get` | Full single-card read: description, prompt, comment thread, checklist, executions |
| `taskboard_comments` | List a task's comments (treated as the latest requirements — read before acting) |
| `taskboard_create` | Create a card (workspaceId, urgency, checklist, preset, isolation, schedule) |
| `taskboard_update` | Edit title / description / prompt / urgency / checklist (model & execution are read-only) |
| `taskboard_move` | Move a card: todo→in_progress→in_review (**done is unreachable**) |
| `taskboard_comment_add` | Append a comment (hand-offs, risks, progress) |
| `taskboard_delete` | Soft delete (purge available; running executions cannot be deleted) |
| `taskboard_checklist` | Acceptance checklist add / check (with evidence) / uncheck |
| `taskboard_execution_report` | Submit the structured execution report, attached to the current execution |

## Features

**Board collaboration**
- Five-column board (Backlog / Todo / In Progress / In Review / Done) + blocked markers, SSE real-time refresh
- Tasks belong to projects: claiming validates session ownership — no snatching across projects
- Three-color urgency (urgent red / normal purple / relaxed blue) with filtering and color bars; search (title / ID) and in-column sorting; filters and sorting persist
- Status-colored dots on column headers: backlog gray / todo blue / in-progress orange / in-review purple / done green / deleted red
- Create/edit modal: project, model (with reasoning effort), urgency, execution mode, cron with live validation & next-run preview, isolation toggle, checklist editor
- Detail panel: status transitions (*done* is human-only; completing with unchecked items asks for confirmation and shows the count), agent/user comment thread, execution history (newest first; session IDs open the execution session on click; deleted/archived targets get distinct notices), stop execution, worktree isolation block (branch / commits / change stats / merge & cleanup), execution report block, acceptance checklist block
- Quick actions on In Review cards: "✓ Done" one-click accept, "✗ Send back" returns to Todo with an optional reason agents read before starting
- **External session auto-sync (0.5.5)**: with "🔄 auto-capture sessions" enabled in board settings, sessions created directly in a workspace spawn task cards automatically — the project is resolved from the session's cwd and the first user message becomes the title/description; running sessions enter In Progress with the session bound (one-click jump works), successful turns settle into In Review, failures fall back to Todo; off by default
- **One-click session jump (0.5.4)**: task cards get a "🤖 sessionId ↗" button, the detail panel a "🤖 Jump to session" button, and the holder chip is clickable too — straight to the running (or most recent) execution's session (the board collapses over it); archived / deleted / unavailable sessions each get a precise notice
- **Remember the last model (0.5.4)**: the new-task form brings back the last chosen model and reasoning effort (template prefill and editing are unaffected)
- **DoD acceptance checklists (0.4.0)**: define acceptance criteria at creation (≤30 items); agents add/tick items via `taskboard_checklist` (with evidence notes); users tick them directly in the detail panel; unchecked items glow red while In Review and the card shows a "☑ n/m" badge (red until all ticked); checklist editing manages the whole group in the form (tick states and evidence preserved)
- **Structured execution reports (0.4.0)**: agents finish with `taskboard_execution_report` (summary / changed files / checks / artifacts / remaining risks), auto-attached to the current execution; rendered side-by-side in the In Review detail panel; the opening protocol makes the order explicit (report → comment → move to In Review)
- **JSON import (0.4.0)**: "⬆ Import" in the toolbar picks a backup file → dry-run preview (added / overwritten / invalid breakdown) → merge (upsert by id) or full replace (auto-backup of the current ledger first + double confirmation); JSON exports restore directly in the same format
- **Task templates (0.4.0)**: "+ New Task ▼" dropdown (blank / built-in New feature · Bug fix · Release check · Routine inspection / manage templates) pre-fills the form (title / description / prompt / urgency / schedule / isolation / preset / checklist); "⌗ Save as template" in the task detail captures your own presets; templates live in a side file in the DSH home directory, rename/delete in the manager dialog
- **Diff viewer (0.4.0)**: clicking a commit row or an uncommitted modified-file row in the isolation block expands a diff in-board (`git show` for commits, `git diff` for files, capped at 128 KB / 2000 lines with truncation noted); falls back to the main repo when the worktree is gone (commits and baseline-range diffs only)

**Agent tools (`taskboard_*`)**
- 10 tools: board / create / edit / move / comments / soft delete / checklist / execution report — usable from any session
- Code-level protocol gates: agents can never reach *done* (not even with every checklist item ticked); held tasks cannot be preempted; model/execution fields are read-only to agents

**Execution**
- Manual runs or cron schedules: each execution opens a brand-new session in the task's project (clean context, optional model, optional preset); two opening messages arrive in the same turn — the plugin context line carries the task frame and hand-off protocol (including failure fallback guidance), while the card payload (title+description+prompt) arrives as a normal user message
- **Per-task presets (0.3.3)**: an "execution mode (preset)" dropdown in the create/edit form — execution sessions are composed from that preset (tool sets and persona come from it, matching how the GUI composes new sessions); defaults to the deployment default preset, or pick "follow deployment default"; a broken preset fails the execution outright and records why in the execution history (no half-composed sessions); changeable anytime, effective next round
- **Git worktree isolated execution (0.3.0)**: per-task toggle (since 0.5.0 the default for newly created tasks comes from Board Settings; factory default runs in place). Every execution happens on a dedicated worktree at `<project>/.dsh-worktrees/<taskId>`, branch `task/<title>+<taskId>` (fixed after first creation; renaming doesn't rename branches). The executing session stays rooted at the project directory (grouping, tools, and the file sandbox fully available — DSH requires session cwd === workspace root, fixed in 0.3.2), and the worktree path plus boundary rules are spelled out in the opening instructions. Settlement collects commit lists / uncommitted-changes warnings / change stats automatically. Non-git projects or missing git degrade gracefully to in-place execution (the reason is recorded; the ledger and execution flow never fail because of git). At acceptance: one-click `--no-ff` merge into the main working tree (dirty tree / conflicts reported verbatim, never auto-resolved), worktree deletion (refused with uncommitted changes), optional branch deletion. "↻ Resume" continues on the existing worktree/branch (previous commits and edits kept)
- **Board settings (0.5.0)**: "🛠 Settings" in the toolbar — choose how new tasks execute by default (🌿 Worktree isolation / 📁 run in place; factory default is the latter). Saving applies to newly created tasks; later changes never affect existing ones
  > Worktree isolation is a collaboration convention, not a sandbox: execution sessions hold full tool permissions, isolation rests on the branch convention, and it is not suitable for running untrusted code.
- Host-side scheduling: fires with the browser closed; missed windows are skipped, never replayed
- Optimistic concurrency (ifVersion) + full attribution (who changed what, which session executed)
- ⚙ Health diagnostics: ledger sanity checks + orphaned worktrees (present on disk but unowned in the ledger) with one-click cleanup

## Safety

- **Acceptance authority belongs to humans**: agent calls moving a task to *done* are rejected by the code-level protocol gate (a prompt suggestion, not); held tasks cannot be preempted; cross-project claims are rejected.
- **Worktree isolation is a convention, not a sandbox**: execution sessions have full tool permissions; isolation relies on the branch convention and is unsuitable for untrusted code.
- **Local data**: the ledger and templates live entirely in the local DSH home directory; nothing is sent anywhere and no tokens / API keys are required.

## Configuration & Data

Works out of the box. The complete configuration surface:

| Environment variable | Default | Description |
| --- | --- | --- |
| `DSH_TASKBOARD_MAX_CONCURRENT` | `3` | Global cap on concurrently executing sessions |
| `DSH_HOME` | `~/.dsh` | DSH home directory (follows the deployment, plugin data along with it) |
| `ATB_TRACE` | unset | With `ATB_TRACE=1` the host prints tool-call traces (debugging) |

Data files (all under the DSH home directory; uninstalling the plugin keeps them):

| File | Contents |
| --- | --- |
| `dsh-taskboard.json` | Task ledger (all tasks / executions / comments) |
| `dsh-taskboard-templates.json` | Task templates |
| `dsh-taskboard.json.backup-<timestamp>` | Automatic backup taken before a full-replace import |
| `<project>/.dsh-worktrees/<taskId>/` | Per-task execution worktree |

Export a full backup anytime with "⬇ JSON" in the toolbar, or the task list as CSV ("⬇ Export", BOM included, opens straight in Excel).

## FAQ

**No "Task Board" entry in the sidebar?**
Refresh the page. Still nothing? Confirm the plugin is installed in the current profile and restart `dsh web` (the host half loads at process start). All three shell generations are supported: `data-pane` (dev), hashed class names (official layout, since 0.4.2), and the DSH Desktop non-compat extended frame (since 0.5.2).

**Where is task data stored? How do I back it up?**
See [Configuration & Data](#configuration--data). "⬇ JSON" in the GUI exports everything anytime; "⬆ Import" restores it.

**Do scheduled tasks still fire when the browser is closed?**
Yes. Scheduling lives in the host process and is browser-independent; missed windows are skipped, not replayed.

**My project isn't a git repo — does it still work?**
Yes. Worktree isolation degrades automatically to in-place execution with the reason recorded in the execution history; everything else is unaffected.

**How do multiple projects cooperate?**
Tasks attach to projects (= DSH workspaces). Claiming validates session ownership: only sessions inside the task's project can claim/execute it — no cross-project snatching.

**Can an agent mark a task "Done" itself?**
No. That is a code-level protocol gate (not a prompt convention): `taskboard_move` calls targeting *done* are rejected outright; acceptance is always performed by a human on the board.

**GitHub-source install blocked at prepare?**
That's pnpm build authorization — add the key printed in the error to `allowBuilds` in the profile's `pnpm-workspace.yaml` and retry; or install from npm instead (prebuilt, no such step).

## Development

```bash
git clone https://github.com/cloader/dsh-taskboard.git
cd dsh-taskboard
npm install && npm run build    # dual build: host ESM + client CJS
npm test                        # full vitest suite (208 cases)
node tests/manual-git-e2e.mjs   # real-git end-to-end manual test (full worktree chain + resume + diff viewer)
node scripts/screenshot.mjs     # regenerate img/ screenshots (needs local Edge)
```

## Changelog

### 0.5.5

- **Sync external workspace sessions onto the board: [@jw5555555555](https://github.com/jw5555555555) ([#13](https://github.com/cloader/dsh-taskboard/pull/13))**: board settings gain an "auto-sync external sessions" toggle (off by default) — once enabled, sessions created directly in a workspace spawn task cards automatically: the project is resolved from the session's cwd, and the first user message plus the session title become the task's description and title; running sessions enter In Progress with the session ID bound (cards gain one-click jump), successful turns settle into In Review with a system comment, failures return to Todo; the board's own internal execution sessions are filtered out to avoid duplicate cards; multi-turn continuations keep the same card

### 0.5.4

- **One-click session jump from the card & task detail: [@jw5555555555](https://github.com/jw5555555555) ([#11](https://github.com/cloader/dsh-taskboard/pull/11))**: a "🤖 sessionId ↗" button on cards, a "🤖 Jump to session" button on top of the detail panel, and a clickable holder chip — straight to the running (or most recent) execution's session (the board collapses over it); archived / deleted / unavailable sessions each get distinct notices
- **New-task form remembers the last model, with reasoning-effort support: [@jw5555555555](https://github.com/jw5555555555) ([#11](https://github.com/cloader/dsh-taskboard/pull/11))**: create mode brings back the last chosen model and effort (template prefill and editing are unaffected); a model can pin a reasoning effort (e.g. low/medium/high) passed down to the execution session; reasoning-capable models read their available efforts from the DSH model catalog
- **Column sort gains "by title": [@Amoss-1](https://github.com/Amoss-1) ([#4](https://github.com/cloader/dsh-taskboard/pull/4))**: numeric-aware comparison keeps numeric prefixes in true numeric order (`01 < 02 < 10 < 90` — plain string comparison would put `10` before `02`); the choice persists with the rest of the view state
- Interface polish: selects and inputs adapt to light/dark themes (DSH theme variables + color-scheme); template manager dialog layout improvements

> 📜 For the complete history of earlier versions, see [changelog.md](changelog.md) (in Chinese).

License: Apache-2.0
