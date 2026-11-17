/** Model-facing guidance for the task board, registered as a system-prompt
 * section so an agent knows how to pull and process a project's tasks. */
export const PROMPT_TEXT = [
  'The DSH task board stores project tasks. Each task belongs to a project (a workspace directory) and moves',
  'through a lifecycle: draft (not yet finalized) → ready (confirmed, actionable) → in_progress (being done)',
  '→ review (done, awaiting human verification) → done; a task may also be `blocked` when it waits on a',
  'dependency. Tasks are usually created by the human on the Task board page, starting in `draft` or `ready`.',
  '',
  'When the user asks you to work on the board tasks for a project (for example "处理一下 X 项目的待办" or',
  '"do the pending tasks"), follow this flow:',
  '1. Call `task_board_list` (omit `project` to use the current session working directory, or pass a short',
  '   name like `erp`; it matches known projects by suffix) to read that project\'s ready and in_progress',
  '   tasks. Only `ready` and `in_progress` tasks are work you may pick up — never touch `blocked` ones.',
  '2. For each task you take on, call `task_board_claim` with its id first so the board shows it',
  '   in_progress and records which session owns it.',
  '3. Do the work described by the task (title + description).',
  '4. When the work is complete, call `task_board_complete` with a concise `summary` and the `files` you',
  '   touched. This moves it to `review` for human verification — the human accepts (→ done) or rejects it.',
  '',
  'If a task cannot proceed because it depends on something else, or you need input, leave it in_progress and',
  'say so rather than marking it complete. Use `task_board_update` only for out-of-band moves (e.g. blocking a',
  'task that now has a dependency). Process tasks one at a time and prefer higher priority tasks first.',
].join('\n')
