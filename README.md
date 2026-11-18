# dsh-project-tasks — a project task board for DSH

English | [中文](README.zh.md)

A [DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) bundle
plugin that adds a **Task board**: a multi-column kanban of tasks that **belong to a
project (a workspace directory)**. You create and manage tasks on the board; an
**agent pulls a project's pending tasks, executes them, and moves them to review**
through `task_board_*` tools — a host-authoritative task ledger the model and the
board share.

- **Project-scoped**: every task is owned by a project path; the agent works "the
  tasks of the project it is running in" by default.
- **Full lifecycle**: `draft → ready → in_progress → review → done`, plus a `blocked`
  side state. A human accepts a review (→ done) or rejects it (→ in_progress).
- **Priorities**: low / normal / high, sorted high-first, with a priority filter.
- **Agent round-trip**: `task_board_list` → `task_board_claim` →
  `task_board_complete` (→ review), plus `task_board_update` for out-of-band moves.
  A system-prompt section teaches the model the flow.
- **Auto-dispatch**: an optional poller claims `ready` tasks and dispatches a real
  agent session to execute each one.
- **Archive**: done tasks can be archived (hidden from the board, restorable); the
  Done column collapses with a "show more".
- **Host-authoritative, durable**: tasks persist in the Host (`storage-domain`); the
  board updates live over SSE as the agent works.
- **No setup**: install, and the board appears in the sidebar.

## Screenshot

![Task board](docs/screenshot-light.png)

## Board columns

| Column | State | Meaning |
|---|---|---|
| 待定 / Draft | `draft` | Not yet finalized. |
| 待处理 / Ready | `ready` | Confirmed and actionable (an agent may pick it up). |
| 进行中 / In progress | `in_progress` | Being worked on (owned by a session). |
| 待验证 / Review | `review` | Work done, awaiting human verification. |
| 已完成 / Done | `done` | Verified complete. |
| 阻断 / Blocked | `blocked` | Waiting on a dependency; remembers the state to restore. |

## Install

```sh
dsh plugin --profile web add dsh-project-tasks
```

Restart `dsh web` (or reopen the GUI) and refresh the page: a **Task board** entry
appears in the sidebar. It is a **bundle** (`dsh.bundle`), so `dsh plugin add`
inserts its loader row automatically.

## Using it

- **Create a task**: header **New task** → project (workspace), title, optional
  description, priority (low / normal / high), optional "mark ready now", and an
  optional **reuse idle session** toggle (off by default; when on, auto-dispatch
  continues in an idle session of the same project instead of creating a new one).
- **Move**: each card has status-appropriate actions — Draft → **Confirm ready**;
  Ready → **▶ Start**; In progress → **Complete for review**; Review → **Accept** /
  **Reject**; any → **Block** / **Unblock**.
- **Edit / delete**: the ✏️ button edits title, description, and priority inline;
  the × button deletes (click twice to confirm).
- **Prioritize**: tasks are ordered high → normal → low within each column; a
  priority filter narrows the board.
- **Archive**: Done cards offer **Archive**; the Done column header offers
  **Archive all**; the header **Archived** toggle opens the archive view (with
  restore). The Done column shows the latest 10 with a "show more".
- **Filter**: the project selector narrows the board to one project or all.
- **Auto-claim / dispatch**: the header **Auto-claim** toggle (on by default) makes a
  background poller claim `ready` tasks and **dispatch a real agent session** in the
  task's workspace to execute each one; it moves to Review when done.
- **Let the agent do it**: in any session, say e.g. *"处理 erp 项目的待办任务"* — the
  agent calls `task_board_list` (a short project name like `erp` matches by suffix),
  `task_board_claim`s each task, does the work, then `task_board_complete`s it with a
  summary. The board reflects it live.

## Agent tools

| Tool | Purpose |
|---|---|
| `task_board_list({ project?, status? })` | List a project's `ready` + `in_progress` tasks (default `pending`). Omit `project` to use the current session working directory; a short name matches a known project by suffix. Returns id, status, priority, title, and full description, highest priority first. |
| `task_board_claim({ id })` | Claim a `draft`/`ready` task (`→ in_progress`), recording the calling session as owner. Blocked and in-review tasks cannot be claimed. |
| `task_board_complete({ id, summary, files? })` | Mark the work finished (`→ review`) with a concise summary and optional touched files. A human still accepts or rejects it. |
| `task_board_update({ id, status, reason? })` | Out-of-band moves: set `blocked` (with a reason), `ready` from `draft`, `in_progress` (reject a review), or `done` (accept). |

Plus a system-prompt **section** that instructs the model how to pull and process a
project's tasks (process one at a time, prefer higher priority, never fabricate a
completion).

## How it works

- **Host half** (`src/index.ts`): owns the task domain (`storage-domain`, a
  `dsh_task_board` unit), registers the tools + the prompt section, and registers
  `/taskboard` HTTP + SSE routes on `ctx.webServer`. Task ownership derives from the
  calling session's working directory. The auto-claim poller creates a session in the
  task's workspace and prompts it to run the task.
- **Browser half** (`src/client/`): the kanban page. It reads/writes
  `/taskboard/api/*` same-origin and subscribes to `/taskboard/events` (SSE) for live
  updates.
- **Bundle patch** (`cordis.patch.yml`): inserts the plugin row; the node half runs in
  the host, the `dsh.client` half loads in the web GUI.

Data is stored on the host (not per-project files), so the board is consistent across
sessions and frontends.

## Develop / build

```sh
npm run link-deps   # link the DSH source checkout's packages into ./node_modules
npm run build       # tsc -> lib/types, tsdown -> lib/index.js (host) + lib/client.js (web)
```

Default checkout path is `../../../source/deepseek-harness`; override with
`DSH_CHECKOUT=/path/to/deepseek-harness`.

## Security note

DSH gates only `/api` with browser auth. Custom routes such as `/taskboard` are
trusted at the server boundary (as the built-in HMR events route is). The write
routes additionally refuse a cross-origin `Origin`. Run the GUI on loopback or behind
a trusted reverse proxy, as you would the rest of DSH.

## Contact

- Technical questions / bug reports: please open an [Issue](https://github.com/hyper-open/dsh-task-board/issues).
- Chat / collaboration: add me on WeChat (scan the QR, note "GitHub").

<p align="center"><img src="docs/images/wechat-qrcode.jpg" width="220" alt="Author WeChat"></p>

## License

[MIT](LICENSE)
