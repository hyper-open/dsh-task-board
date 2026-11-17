/** Model-facing guidance for the task board, registered as a system-prompt
 * section so an agent knows how to pull and process a project's pending tasks. */
export const PROMPT_TEXT = [
  'The DSH task board stores project tasks. Each task belongs to a project (a workspace directory) and is',
  'in one of three states: todo, in_progress, or done. Tasks are usually created by the human in the',
  'Task board page.',
  '',
  'When the user asks you to work on the board tasks for a project (for example "处理一下 X 项目的待办" or',
  '"do the pending tasks"), follow this flow:',
  '1. Call `task_board_list` (omit `project` to use the current session working directory, or pass an',
  '   explicit `project` path) to read that project\'s pending tasks (todo and in_progress).',
  '2. For each task you take on, call `task_board_claim` with its id first so the board shows it as',
  '   in_progress and records which session owns it.',
  '3. Do the work described by the task (title + description).',
  '4. When the task is complete, call `task_board_complete` with a concise `summary` of what you did and',
  '   the `files` you touched (advisory). This moves it to done and records the summary.',
  '',
  'Process tasks one at a time and prefer higher priority tasks first. Do not mark a task done that you did',
  'not actually complete; if you cannot finish one, leave it in_progress (or ask the user) rather than',
  'fabricating a completion.',
].join('\n')
