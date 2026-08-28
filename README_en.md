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
- Create/edit modal: project, model, urgency, execution mode, cron with live validation & next-run preview, isolation toggle, checklist editor
- Detail panel: status transitions (*done* is human-only; completing with unchecked items asks for confirmation and shows the count), agent/user comment thread, execution history (newest first; session IDs open the execution session on click; deleted/archived targets get distinct notices), stop execution, worktree isolation block (branch / commits / change stats / merge & cleanup), execution report block, acceptance checklist block
- Quick actions on In Review cards: "✓ Done" one-click accept, "✗ Send back" returns to Todo with an optional reason agents read before starting
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
npm test                        # full vitest suite (~150 cases)
node tests/manual-git-e2e.mjs   # real-git end-to-end manual test (full worktree chain + resume + diff viewer)
node scripts/screenshot.mjs     # regenerate img/ screenshots (needs local Edge)
```

## Changelog

### 0.5.3

- **The execution prompt is now append-style**: a custom prompt no longer replaces the opening instructions wholesale — the session receives "title + description + prompt", so context written in the description is no longer dropped; the create/edit form copy and the `taskboard_create` tool description were updated to match
- **New built-in "New feature" template**: placed before "Bug fix" — title prefix "New:", four steps (clarify requirements → implement → add tests → run suites), with a three-item acceptance checklist
- **"Bug fix" template first line now reads "fix the issues above"**: the description now reaches the session before the prompt, so "above" is the right pointer

### 0.5.2

- **Fixed the missing "Task Board" sidebar entry — and the board that wouldn't open — in DSH Desktop's non-compat mode**: the plugin only recognized the previous two interface generations, and the Desktop's new shell rebuilt the whole layout skeleton, so the entry never found its footing and kept retrying in the background forever. All three shell generations (browser, compatibility mode, non-compat mode) now show the entry and the board properly
- New sidebar icon: a more intuitive three-lane kanban style
- Added regression coverage for non-compat mode (199 cases in total)

### 0.5.1

This release comes mostly from a comprehensive code health pass: the board is harder to misuse and steadier, with a few small behavior changes.

- **Detail panel no longer leaks state across cards**: previously, opening "confirm clear" on task A and then opening task B left B sitting in the pending-confirmation state — one fast click deleted things. Every detail-panel open now starts clean
- **Double-click protection**: "Create task", "Run now", "Copy" and friends gray out while submitting. Previously a quick double-click created duplicate cards or launched two concurrent execution sessions burning tokens
- **Board queries correct immediately after a DSH restart**: during the first seconds after restart, AI agents could see an empty board and dutifully re-create cards; fixed
- **Archived tasks are truly sealed**: archived tasks could still be edited/commented through some entry points; now fully read-only
- **New tasks can only land in Backlog or Todo**: start work by claiming properly — no more owner-less "In Progress" cards appearing out of nowhere
- **Stopping an already-finished execution reports honestly**: clicking "Stop" on a finished run used to claim success while doing nothing; now it tells you the truth
- **Execution reports can be submitted late**: realized the report was forgotten after the session ended? You can still submit (limited to your own most recent successful execution on that task)
- **Duplicating long-titled tasks no longer errors**: over-long titles are truncated with a "(copy)" suffix before creation
- **Editing no longer silently pins settings**: saving the editor used to freeze "follow deployment default preset" into a concrete value; it now stays as-is
- Internal quality: scheduler errors log instead of crashing the process, plus a batch of test and build-hygiene improvements

### 0.5.0

- **Board Settings added**: a "🛠 Settings" button appears in the board toolbar letting you choose the default execution mode for new tasks — isolated in a dedicated branch, or directly in the project folder. Saving applies to all newly created tasks; existing tasks are untouched
- **Default for new tasks changed to "run directly in the project folder"**: new tasks used to default to branch isolation; they now skip branching and work in the project folder. Teams preferring branch isolation can flip it back in "🛠 Settings"
- **Export buttons merged**: "⬇ JSON" and "⬇ CSV" merged into one "⬇ Export" — click and choose the format
- The create form no longer remembers the previous isolation choice; it follows Board Settings uniformly

### 0.4.5

- **Removed the "style check every 2 seconds" mechanism introduced in 0.4.4**: the style ownership marker from the previous release fixed the accidental-deletion problem at its root — other plugins updating no longer remove board styles, making the periodic watchdog redundant insurance. The resident background timer is gone (one less poller on the page); anti-style-loss behavior unchanged (ownership marker remains, and the plugin re-attaches styles after its own hot reload)
- No visible change for users — pure internal subtraction

### 0.4.4

- **Fixed styles occasionally vanishing from the board ([#3](https://github.com/cloader/dsh-taskboard/issues/3))**. Root cause: other plugins hot-reloading in the background perform cleanup by "style ownership," and the board's stylesheet carried no ownership marker, so it was mistaken for someone else's and removed. After this fix:
  - The board stylesheet carries an explicit ownership marker and survives other plugins' updates
  - The board checked its stylesheet every 2 seconds and self-healed instantly even if removed — at worst a flicker, no page refresh needed
- Added regression tests: ownership marker present, auto-recovery within 2s after deletion, no duplicate injection

### 0.4.3

- **Fixed the sidebar entry not collapsing to a bare icon when the sidebar collapses (user report)**: collapsed shells reduce the sidebar to a 36×36 icon rail (`data-sidebar-collapsed` on the layout frame, root node switching to CSS-module `*_collapsed` hashed classes) while the board entry stayed full width — icon, label, and counter crammed into the narrow rail. Fix: under collapse signals the entry mirrors native rail geometry (36×36, centered, same spacing as the native collapsed newSession tile), hiding text and badge and bumping the icon 14→16px for legibility; dual-signal selectors (`[data-sidebar-collapsed]` and `[class*="_collapsed"]`) continue the 0.4.2 dual-selector principle, covering old and new shells; expanded state untouched; `aria-label` retained for accessibility
- Regression tests: both collapse selector groups and the 36px rail geometry verified injected; the shell's actual `hHd-Xa_collapsed` class name matches the selectors (150 cases)
- README restructured around the dsh.market five-dimension rubric: added table of contents / prerequisites / quick start (with a full agent workflow example) / agent tool reference table / safety / configuration & data / FAQ; repository metadata gained homepage and topics

### 0.4.2

- **Fixed the board never appearing on DSH Desktop (user report: entry clickable, backend healthy, center column unchanged)**: the current DSH Desktop web shell (`dsh-client-ui-layout`) dropped `data-pane` attributes entirely, using CSS-module hashed classes instead (`pI_x6G_centerCol`) — while the board's mount selector hardcoded `[data-pane="conversation"]`, so `querySelector` always missed and the container was never created (the sidebar entry worked because it always had a `[class*="sidebarCol"]` fallback). Fix: mount selector and hide rule now accept both `'[data-pane="conversation"], [class*="centerCol"]'` (old and new shells, same fallback strategy as the sidebar entry); `.dsh-atb-view` fills the column with `height:100%`, independent of inner structure
- Regression tests: a Desktop-shell DOM without `data-pane` but with the hashed `centerCol` class — container created inside the column, both hide-rule selectors present

### 0.4.1

- **Fixed a click race on the sidebar entry (user report)**: in some shells the board entry ends up nested inside the container whose class contains `newSession` — clicking it, the board's global capture listener ("yield the view when a session/new-session is clicked") ran `closeBoard` first, then the entry's own `toggleBoard` flipped it back, manifesting as **the board flashing shut on open, or the entry refusing to close it**. Fix: the capture listener exempts the entry subtree wholesale via `closest('[data-dsh-atb-entry]')` (steadier than a `:not()` clause, which only excludes self-matches and can't guard against ancestor nesting); genuine session rows and the new-session button keep their yield semantics. Also hardened `newSessionButton()` anchor scanning to exclude the entry itself, eliminating self-referencing anchors during self-heal re-insertion
- Regression tests: DOM reproducing the "entry nested in a newSession container" shape — open/close toggling normal; genuine new-session clicks still yield

### 0.4.0

**The acceptance-efficiency pack — closing the human-acceptance loop inside the board:**

- **DoD acceptance checklists**: the task model gained `checklist` (≤30 items × 200 chars, with checker / time / evidence note recorded throughout). Whole-group editing in the create/edit form (editing preserves tick states and evidence); new agent tool `taskboard_checklist` (add / check with evidence / uncheck — code gate: checking never completes); the opening frame injects the checklist with the "tick each item as you finish it" discipline; unchecked items highlight red on In Review cards and details, and "✓ Done" double-confirms showing the outstanding count
- **Structured execution reports**: executions gained `report { summary, changedFiles, checks, artifacts, risk }`; agents submit via new tool `taskboard_execution_report` — located by calling session + running execution (no execution id needed; resubmission overwrites); side-by-side rendering in the In Review detail panel; the opening hand-off protocol became three steps: report → comment → move to In Review
- **JSON import**: `validateLedgerImport` pure function classifies every card (added / overwritten / invalid + reason, duplicate ids within one file rejected; schemaVersion mismatch errors clearly; residual `running` executions marked failed on import — their settlement watchers died with the previous host); `POST /import/preview` dry-run + `POST /import` commit (merge upserts by id; full replace auto-writes `ledger.backup-<ts>.json` first); GUI "⬆ Import" dialog visualizes the whole flow with double confirmation for full replacement
- **Task templates**: host-side `templates.json` side file (seeded on first start with Bug fix / Release check / Routine inspection); the "+ New Task ▼" dropdown applies a template to pre-fill the entire form (checklist and preset included); "⌗ Save as template" in task detail; rename/delete/use-now in the management dialog
- **Diff viewer**: the git face gained `showCommit` / `showPathDiff` (fail-soft, capped at 128 KB / 2000 lines with truncation noted); clicking commit rows or uncommitted modified-file rows in the isolation block lazily expands diffs in-board; automatic fallback to the main repo once the worktree is gone
- Tests 116 → 145; `taskboard_get` detail renders checklist and report markers; duplicating a task carries the checklist

### 0.3.3

- **Fixed execution sessions getting no tools (non-standard modes)**: since 0.3.0 deployments gained the preset system, and tools stopped being globally registered — each preset composition mounts tools at session creation (GUI-created sessions go through apiproxy's composeAgent → presets.mount). Our executor called agents.create directly, mounting nothing → tool-less sessions. Now aligned with that path: execution sessions compose from the task's preset, and `agentPreset` is recorded in the session header
- **Per-task preset field**: task creation offers "execution mode (preset)", defaulting to the deployment default preset (standard mode on this deployment); switch to any preset or "follow deployment default" (field omitted, tracks deployment default); editable anytime (each round recomposes, no lock-in); duplicated tasks carry it; `taskboard_create` gains `presetId`; detail panel shows a preset chip
- **Broken-preset guard**: preset resolution failure (missing/corrupt) fails the execution outright, writes the reason to the execution history, and returns the task to Todo — no half-composed sessions (matching apiproxy rollback semantics)
- Preset options come from the `agentPreset.list` connection RPC (dropdown hidden when no roster or offline, falling back to bare composition); tests 111 → 116

### 0.3.2

- **Fixed worktree execution sessions leaving the project group with no tools**: 0.3.0–0.3.1 pointed the executing session's cwd at the worktree subdirectory, but DSH's session model requires cwd === workspace root (strict equality) — subdirectories left the session ungrouped with the file sandbox boundary and relative-path resolution broken (agents couldn't create files). Reverted: session cwd = project root (grouping, tools, sandbox fully functional), while the worktree absolute path and boundary discipline (commands use the worktree as workdir, file I/O via absolute paths, don't touch other files in the main working tree, commit to the task branch) are stated explicitly in the opening frame. Git isolation and evidence collection unaffected

### 0.3.1

- **↻ Resume**: "Resume" in the detail panel keeps the existing worktree and branch intact (last round's commits and uncommitted edits remain) and executes on top of them; the baseline becomes the worktree's current HEAD, and evidence counts only this round's new commits. Plain "Run now" still uses a fresh baseline (branch reset to the main tree's HEAD)
- **Same-repo git mutual exclusion**: worktree creation/removal, merges, and branch deletion on one repository serialize in-process, eliminating index.lock races between concurrent isolated executions
- **Evidence survives failure/cancellation**: on turn errors or user stops, commits already made and uncommitted edits are still collected into the execution history (previously collected only on successful settlement) — interrupted half-done work can be judged from the record for a possible resume
- **Evidence caps in execution history**: at most 50 commits and 100 lines of uncommitted changes per execution (totals recorded), so huge diffs no longer bloat the fully-rewritten-on-every-write ledger
- **Empty-merge detection**: merging a branch with no new commits ahead of the main working tree now says "nothing to merge" instead of producing a fake "merged" system comment
- **Physical purge cascades**: purging a task checks the worktree first — refuses with uncommitted changes and lists the files; on pass, deletes the worktree and task branch too
- **Finer degradation semantics**: reasons distinguish "git unavailable (not installed / not on PATH)" from "current project is not a git repository"; degraded runs warn in the opening prompt that the session works in the main project directory (run git status first, keep changes focused, list changed files when done)
- **Fresh-checkout hint**: openings on a brand-new worktree mention node_modules/build artifacts aren't there and dependencies may need reinstalling before building/testing
- **Diagnostics panel enhanced**: gitignore suggestions list (projects that haven't ignored `.dsh-worktrees/` at a glance; never auto-edited); "dangling in progress" renamed to "executing"
- README notes worktree isolation is a collaboration convention, not a sandbox; tests 97 → 111

### 0.3.0

- **Git worktree isolated execution (flagship)**: concurrent executions never pollute each other's code; acceptance reviews the branch
  - Per-task isolation toggle: "execution isolation" in the create form (default Worktree, remembers last choice; auto-disabled with a notice on non-git projects); `taskboard_create` gains `isolation`; duplicated tasks carry it; changeable until first execution, locked thereafter
  - Execution chain: every run gets a fresh worktree (`git worktree add --force` at the fixed path `.dsh-worktrees/<taskId>`, fixed branch `task/<title>+<taskId>` — sanitized/truncated titles, pure-ID fallback, renames never rename branches); the executing session's cwd pointed at the worktree; the opening frame steers the agent to commit onto that branch
  - Settlement collection: commit list (hash + subject), uncommitted-changes warning, change stats and file counts — "execution ↔ commits association" shipped in this round
  - Acceptance actions (detail panel): ⇥ Merge (`--no-ff`; dirty/conflicted main tree reported verbatim with automatic `merge --abort` restoration), 🗑 Delete worktree (refused with uncommitted changes, optional branch deletion), or keep the branch and send back for more edits
  - Safety rules: explicitly disabled = zero git calls throughout; non-git project / unavailable git / timeouts all degrade to in-place execution (reason in isolationNote, fail-soft: ledger and execution never fail because of git); clean-check exemption for the plugin's own `.dsh-worktrees/`; all git ops carry timeouts (queries 2s / structural ops 15s)
  - New host module `src/host/git.ts`: narrow GitFace interface (detect/prepare/collect/merge/remove/deleteBranch), injectable exec layer (tests use zero real git); workspace routes deliver git detection results (60s cache); startup hints suggest gitignore entries for projects not ignoring `.dsh-worktrees/` (never auto-applied)
- **⚙ Health diagnostics**: ledger basics (revision / task count / dangling executions) + orphaned-worktree list (on disk, unowned in the ledger) with one-click cleanup (unregistered directories cleaned via fs fallback; still refused with uncommitted changes)
- `taskboard_get` detail output includes isolation and branch info; tests 67 → 97

### 0.2.2

- **In Review quick actions**: "✓ Done / ✗ Send back" directly on In Review cards; sending back may attach a reason (optional); return + comment commit atomically (no orphaned comments when the move fails)
- Invalid state transitions now return HTTP 400 instead of 500

### 0.2.1

- Tuned the task-kickoff prompt

### 0.2.0

- **Board efficiency**: toolbar search (title / ID, case-insensitive) and in-column sorting (default / recently updated / urgency / created time); filters and sorting persist via localStorage (search doesn't)
- **Sidebar status strip**: the "Task Board" entry shows `todo|in_progress|in_review` counts on the right (e.g. `0|1|2`), colored blue/orange/purple, with hover tooltips explaining meaning and live values; numbers roll vertically on change (up on increase, down on decrease, respecting prefers-reduced-motion)
- **Settlement closure**: when an execution session ends without protocol hand-off (no comment / not moved to In Review), the system auto-comments and moves it to In Review — tasks no longer hang silently In Progress; failed executions also leave a system comment
- **Claim lease**: tasks claimed over 30 minutes ago show "⏱ Claim timed out" on card and detail; the detail panel adds "🔓 Release claim" returning it to Todo
- **Execution history cap**: the 20 most recent executions per task are kept (detail shows "+N cleared"), so scheduled tasks no longer bloat the ledger forever
- **Global concurrency cap**: 3 concurrent execution sessions by default (`DSH_TASKBOARD_MAX_CONCURRENT` adjustable); a loaded scheduler preserves due windows instead of burning them, retrying next tick
- **Execution prompt template variables**: `{{lastExecution}}` (previous execution result), `{{lastComments}}` (three most recent comments) — inspection-type scheduled tasks can see what last round found
- **Duplicate task**: "⧉ Duplicate" in the detail panel clones the full configuration into a new card
- **Export**: "⬇ JSON" full-ledger backup and "⬇ CSV" task list (BOM included, opens straight in Excel)
- **Status dots**: colored dots before category labels on the five columns and the three "other tasks" columns (backlog gray / todo blue / in-progress orange / in-review purple / done green / deleted red), matching the detail-panel status pill palette
- **Session jump**: clicking a session short-ID in the execution history (newest first) opens that execution session and collapses the board; deleted vs archived targets get distinct notices with short IDs; lazy service resolution with one automatic refresh-and-retry when the session-list mirror lags; short IDs strip the `taskboard-` infix so records stay distinguishable

### 0.1.3

- **Execution race and lock fixes**:
  - "Run now" atomic gate: the in-progress check moved into the serialized write queue — repeated clicks / overlapping schedules open at most one execution session
  - Claims became explicit `claimedBy/claimedAt` fields (previously inferred from updatedBy; user edits accidentally cleared locks); during execution the task is held by the executing session and immovable by others; legacy ledgers migrate automatically on load
  - Failed executions fall back to Todo (previously stuck in in_progress forever); leftover running executions are marked failed and their tasks returned after a host restart; locks release on successful settlement
- **Cancellable executions**: "■ Stop" in the detail panel — stops the execution session, marks the execution cancelled, returns the task to Todo
- **Model validation**: fixed models on create/edit get structural validation + provider-route existence validation (structural only when the host LLM runtime is unreachable)
- **Ledger safety**: `store.snapshot()/get()` return frozen copies; in-place mutation throws, killing version-bypassing data edits
- **Scheduler**: the ledger loads before each tick (fixing post-restart first ticks reading an empty ledger and skipping scheduled tasks); startup compensation timers clean up on dispose
- **Other**: execution-history session IDs copy on click; the detail panel shows the holding session; dead code removed (`store.flush`, routes `taskPath`)

### 0.1.2

- **Board drag & drop**: cards drag between all columns (legal transitions validated by the state machine; illegal drops explain themselves in a dialog); dragging an executing task is intercepted with "this task is being executed by the 【task】 session"
- **Execution session polish**: execution sessions take the task's title (written via `sessionTitle.rename`, immune to auto-renaming); the first message renders as a normal user message (no longer a plugin context line)
- **UX improvements**:
  - Create/edit modal gained a "⚡ Run now" button (executes right after saving)
  - Detail-panel "Run now" moved beside "Edit"
  - "+ New Task" moved next to the board-title stats
  - Transition buttons unified to "Move → {status}"
- **Dialogs**: native `alert()` fully replaced by themed modals (Esc/backdrop closable)

### 0.1.1

- Initial npm release: board collaboration, 8 agent tools, manual/cron execution, SSE live view

License: Apache-2.0
