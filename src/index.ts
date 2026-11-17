/**
 * DSH Task Board — Host half.
 *
 * Provides a project-scoped task ledger (durable via `storage-domain`), three
 * agent tools (`task_board_list` / `task_board_claim` / `task_board_complete`),
 * a system-prompt section that teaches the model the pull→claim→complete flow,
 * and the `/taskboard` HTTP + SSE routes the browser half reads.
 *
 * Task ownership is derived from the calling session's working directory, so an
 * agent "processes the tasks of the project it is running in" by default.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-session'
import { TaskStore, normalizeProject, taskBoardDomain } from './store.ts'
import { registerTaskBoardRoutes } from './routes.ts'
import { PROMPT_TEXT } from './prompt.ts'

/** Tools, prompt, and the services this plugin reads lazily. */
export const inject = ['tools', 'systemPrompt', 'storageDomain']

/** Locate the `task_board_list` / claim / complete tools' shared output renderer. */
const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/**
 * Resolve the current task project from an agent's working directory.
 * @param ctx - host context (to reach `workingDirectory`).
 * @param exec - the tool run context carrying the calling agent.
 * @returns `{ project, sessionId }` for the caller.
 */
function callerScope(ctx: Context, exec: { agent?: { session: unknown } }): { project: string | undefined; sessionId: string | undefined } {
  const agent = exec.agent as { session?: { id?: string } } | undefined
  if (agent?.session === undefined) return { project: undefined, sessionId: undefined }
  const wd = ctx.get('workingDirectory') as { get(session: unknown): string } | undefined
  const project = wd === undefined ? undefined : wd.get(agent.session)
  return { project: project, sessionId: agent.session.id }
}

/**
 * Register the host half: open the task domain, expose the tools, the prompt
 * section, and the web routes.
 * @param ctx - host root context.
 */
export async function apply(ctx: Context): Promise<void> {
  const domain = await ctx.storageDomain.open(taskBoardDomain)
  ctx.effect(() => () => { void domain.close() }, 'dsh-task-board: close domain')
  const store = new TaskStore(domain)

  // Model guidance: how to pull and process a project's tasks.
  ctx.systemPrompt.section({
    name: 'tool:task-board',
    order: 450,
    text: PROMPT_TEXT,
  })

/**
 * Resolve an explicit project argument against the known projects, so an agent
 * can pass a short name like `erp` and still match `/Users/…/project/erp`.
 * Order: exact normalized match, then suffix (`/<arg>`), then basename.
 * @param store - the task store (to enumerate known projects).
 * @param arg - the caller-supplied project hint.
 * @returns the canonical project path, or the normalized arg when nothing matches.
 */
function resolveProject(store: TaskStore, arg: string): string {
  const norm = normalizeProject(arg)
  const known = new Set(store.all().map(task => task.project))
  if (known.has(norm)) return norm
  const suffix = `/${norm.replace(/^\/+/, '')}`
  const matches = [...known].filter(p => p === norm || p.endsWith(suffix) || p.split('/').pop() === norm.replace(/^\/+/, ''))
  // Only a single unambiguous match is auto-resolved; otherwise keep the arg.
  return matches.length === 1 ? (matches[0] as string) : norm
}

  // task_board_list — list a project's pending tasks.
  ctx.tools.register(defineTool({
    name: 'task_board_list',
    description: 'List pending tasks (todo and in_progress) for a project on the DSH task board. Omit `project` to use the current session working directory; a short name like `erp` is matched against known projects. Returns each task id, status, priority, title, and its full description.',
    parameters: {
      project: { type: 'string', description: 'Project directory path, or a short project name (matched by suffix). Omit to use the current session working directory.' },
      status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'pending'], description: 'Filter by status; `pending` = todo + in_progress (default). Omit to list pending tasks.' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args, exec) => {
      const scope = callerScope(ctx, exec)
      const raw = typeof args.project === 'string' && args.project !== '' ? args.project : scope.project
      if (raw === undefined) return Promise.resolve('No project resolved: no working directory is set for this session. Pass `project` explicitly.')
      const project = resolveProject(store, raw)
      const statuses = args.status === undefined || args.status === 'pending'
        ? (['todo', 'in_progress'] as const)
        : args.status === 'done' || args.status === 'todo' || args.status === 'in_progress'
          ? ([args.status] as const)
          : (['todo', 'in_progress'] as const)
      const tasks = store.list({ project, statuses: [...statuses] })
      if (tasks.length === 0) return Promise.resolve(`No ${statuses.join('/')} tasks for project ${project}.`)
      const lines = tasks.map(task => {
        const owner = task.claimedBy === undefined ? '' : ` [claimed by ${task.claimedBy.sessionId}]`
        const desc = task.description !== undefined && task.description !== ''
          ? `\n    description: ${task.description}`
          : '\n    description: (none)'
        return `- ${task.id} [${task.status}] (${task.priority}) ${task.title}${owner}${desc}`
      })
      return Promise.resolve(`Project ${project} — ${tasks.length} pending task(s):\n${lines.join('\n')}`)
    },
  }))

  // task_board_claim — take a task (todo → in_progress).
  ctx.tools.register(defineTool({
    name: 'task_board_claim',
    description: 'Claim a task so the board shows it in progress and records this session as its owner. Call this before starting work on a listed task.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id (from task_board_list).' },
    },
    output: TEXT_OUTPUT,
    execute: async (args, exec) => {
      const scope = callerScope(ctx, exec)
      const task = await store.claim(args.id, scope.sessionId ?? 'unknown')
      return `Claimed ${task.id} (${task.status}): ${task.title}`
    },
  }))

  // task_board_complete — finish a task (→ done) with a summary.
  ctx.tools.register(defineTool({
    name: 'task_board_complete',
    description: 'Mark a task done after you have actually finished it, recording a concise summary of what you did and the files you touched. This moves it to the Done column.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      summary: { type: 'string', required: true, description: 'A concise summary of what was done.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Files touched (advisory).' },
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === 'string') : undefined
      const task = await store.complete(args.id, { summary: args.summary, ...(files === undefined ? {} : { files }) })
      return `Completed ${task.id}: ${task.title}\nSummary: ${args.summary}`
    },
  }))

  // Browser routes, registered only where a web server is served.
  ctx.inject(['webServer'], (webCtx: Context) => {
    webCtx.effect(() => registerTaskBoardRoutes(webCtx, store), 'dsh-task-board: routes')
  })
}
