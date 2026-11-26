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
import type { TaskDto, TaskStatus } from './types.ts'

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
    description: 'List the tasks an agent can work on for a project: by default the `ready` (confirmed, not yet started) and `in_progress` tasks. Omit `project` to use the current session working directory; a short name like `erp` is matched against known projects. Returns each task id, status, priority, title, and full description.',
    parameters: {
      project: { type: 'string', description: 'Project directory path, or a short project name (matched by suffix). Omit to use the current session working directory.' },
      status: { type: 'string', enum: ['ready', 'in_progress', 'review', 'draft', 'done', 'blocked', 'pending'], description: 'Filter by status. `pending` (default) = ready + in_progress (work an agent may pick up).' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: (args, exec) => {
      const scope = callerScope(ctx, exec)
      const raw = typeof args.project === 'string' && args.project !== '' ? args.project : scope.project
      if (raw === undefined) return Promise.resolve('No project resolved: no working directory is set for this session. Pass `project` explicitly.')
      const project = resolveProject(store, raw)
      const one = args.status
      const statuses: TaskStatus[] = one === undefined || one === 'pending'
        ? ['ready', 'in_progress']
        : one === 'draft' || one === 'ready' || one === 'in_progress' || one === 'review' || one === 'done' || one === 'blocked'
          ? [one]
          : ['ready', 'in_progress']
      const tasks = store.list({ project, statuses })
      if (tasks.length === 0) return Promise.resolve(`No ${statuses.join('/')} tasks for project ${project}.`)
      const lines = tasks.map(task => {
        const owner = task.claimedBy === undefined ? '' : ` [claimed by ${task.claimedBy.sessionId}]`
        const desc = task.description !== undefined && task.description !== ''
          ? `\n    description: ${task.description}`
          : '\n    description: (none)'
        return `- ${task.id} [${task.status}] (${task.priority}) ${task.title}${owner}${desc}`
      })
      return Promise.resolve(`Project ${project} — ${tasks.length} task(s), highest priority first:\n${lines.join('\n')}`)
    },
  }))

  // task_board_claim — start a task (ready|draft → in_progress).
  ctx.tools.register(defineTool({
    name: 'task_board_claim',
    description: 'Claim a ready (or draft) task so the board shows it in progress and records this session as its owner. Call this before starting work on a listed task. Blocked and already-in-review tasks cannot be claimed.',
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

  // task_board_complete — finish the work (→ review, awaiting human verification).
  ctx.tools.register(defineTool({
    name: 'task_board_complete',
    description: 'Mark a task\'s work finished after you have actually done it, recording a concise summary and the files you touched. This moves it to the "review" (pending verification) column — a human still accepts or rejects it; it does not go straight to done.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      summary: { type: 'string', required: true, description: 'A concise summary of what was done.' },
      files: { type: 'array', items: { type: 'string' }, description: 'Files touched (advisory).' },
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === 'string') : undefined
      const task = await store.complete(args.id, { summary: args.summary, ...(files === undefined ? {} : { files }) })
      return `Completed work on ${task.id}, moved to review: ${task.title}\nSummary: ${args.summary}`
    },
  }))

  // task_board_update — move a task between states (block/unblock, verify/reject, etc.).
  ctx.tools.register(defineTool({
    name: 'task_board_update',
    description: 'Change a task\'s status when the standard flow does not fit: set `blocked` (optionally with a reason) to mark a dependency, `ready` from `draft` to confirm a task is actionable, `in_progress` to reject a review back to work, or `done` to accept. Prefer task_board_claim / task_board_complete for the normal start/finish edges.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id.' },
      status: { type: 'string', required: true, enum: ['draft', 'ready', 'in_progress', 'review', 'done', 'blocked'], description: 'Target status.' },
      reason: { type: 'string', description: 'Optional reason, used when setting `blocked`.' },
    },
    output: TEXT_OUTPUT,
    execute: async (args) => {
      const status = args.status as TaskStatus
      let task: TaskDto
      if (status === 'blocked') task = await store.block(args.id, typeof args.reason === 'string' ? args.reason : undefined)
      else if (status === 'done') task = await store.verify(args.id)
      else task = await store.update(args.id, { status })
      return `Updated ${task.id} → ${task.status}: ${task.title}`
    },
  }))

  // Browser routes, registered only where a web server is served.
  ctx.inject(['webServer'], (webCtx: Context) => {
    webCtx.effect(() => registerTaskBoardRoutes(webCtx, store), 'dsh-task-board: routes')
  })

  // Background auto-claim poller: while enabled, periodically pick up every
  // `ready` task and DISPATCH a real agent session to execute it — create a
  // session in the task's project, claim the task for that session, and submit
  // a prompt that drives the claim→work→complete flow. The per-task guard keeps
  // it from spawning duplicates while a dispatch is in flight.
  const dispatching = new Set<string>()
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (!store.autoClaim) return
      void (async () => {
        // Reclaim: release in_progress tasks whose owning session no longer exists
        // (e.g. after a restart the session was removed). Only truly-missing
        // sessions are reclaimed — a live/idle session is left alone, and same-
        // session serialization is handled in dispatch via `occupiedByOther`.
        try {
          const controller = ctx.get('sessionController') as
            | { list(r: Record<string, never>, s: AbortSignal): Promise<{ items: readonly { sessionId: string }[] }> }
            | undefined
          if (controller !== undefined) {
            const live = new Set((await controller.list({}, new AbortController().signal)).items.map(i => i.sessionId))
            for (const task of store.list({ statuses: ['in_progress'] })) {
              const owner = task.claimedBy?.sessionId
              // Reclaim if the owning session is gone, or there is no owner at all
              // (a stranded in_progress task can never be worked by anyone).
              if (owner === undefined || !live.has(owner)) {
                await store.release(task.id).catch(() => {})
              }
            }
          }
        } catch { /* reclaim is best-effort */ }
        // Dispatch: pick up ready tasks (idle-checked per strategy).
        for (const task of store.list({ statuses: ['ready'] })) {
          if (dispatching.has(task.id)) continue
          dispatching.add(task.id)
          void dispatchTask(ctx, store, task).finally(() => { dispatching.delete(task.id) })
        }
      })()
    }, 15_000)
    timer.unref?.()
    return () => { clearInterval(timer) }
  }, 'dsh-task-board: auto-claim poller')
}

/**
 * Create a session in the task's project, claim the task for it, and submit the
 * prompt that makes the agent execute and complete it.
 * @param ctx - host context (to reach `sessionController`).
 * @param store - the task store.
 * @param task - the ready task to dispatch.
 */
async function dispatchTask(ctx: Context, store: TaskStore, task: TaskDto): Promise<void> {
  const controller = ctx.get('sessionController') as
    | {
      create(request: { cwd?: string; workspaceId?: string }): Promise<{ agent?: { id?: string } } & { sessionId?: string } & { value?: { sessionId?: string } }>
      list(request: Record<string, never>, signal: AbortSignal): Promise<{ items: readonly { sessionId: string; cwd?: string; running?: boolean; blank?: boolean; parentSessionId?: string }[] }>
      prompt(request: { requestId: string; sessionId: string; mode: 'queue'; content: { type: 'text'; text: string }[] }, signal: AbortSignal): Promise<unknown>
    }
    | undefined
  if (controller === undefined) return
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const wanted = norm(task.project)
  // A session is "busy" when another in_progress task already owns it — same session
  // runs one task at a time (serial), so other tasks wait instead of queueing prompts.
  const occupiedByOther = (sid: string): boolean =>
    store.list({ statuses: ['in_progress'] }).some(t => t.id !== task.id && t.claimedBy?.sessionId === sid)
  try {
    let sessionId: string | undefined
    // Only claim/dispatch when we have an IDLE session — a busy session would just
    // queue the prompt. When the chosen session is busy we defer (return without
    // claiming) so the task stays `ready` and the next poll retries.
    if (task.sessionMode === 'reuse' && task.reuseSessionId !== undefined && task.reuseSessionId !== '') {
      const listed = await controller.list({}, new AbortController().signal)
      const target = listed.items.find(item => item.sessionId === task.reuseSessionId)
      if (target === undefined) {
        // Reused session no longer exists — fall back to a fresh session.
      } else if (target.running === true || occupiedByOther(task.reuseSessionId)) {
        return // busy (running or already running another task): defer, don't queue
      } else {
        sessionId = task.reuseSessionId
      }
    } else if (task.reuseIdle === true) {
      const listed = await controller.list({}, new AbortController().signal)
      const candidate = listed.items
        .filter(item => item.blank !== true && item.running !== true && item.parentSessionId === undefined && item.cwd !== undefined && norm(item.cwd) === wanted && !occupiedByOther(item.sessionId))
        .at(0)
      if (candidate === undefined) {
        // No idle session in the project right now — defer, don't spawn a new one
        // (reuseIdle means "only reuse an idle session"), so the task stays ready.
        return
      }
      sessionId = candidate.sessionId
    }
    if (sessionId === undefined) {
      const registry = ctx.get('workspaceRegistry') as { list(): { id: string; path: string }[] } | undefined
      const workspace = registry?.list().find(ws => norm(ws.path) === wanted)
      const created = await controller.create(workspace !== undefined ? { workspaceId: workspace.id } : { cwd: task.project })
      sessionId = created.agent?.id ?? created.sessionId ?? created.value?.sessionId
    }
    if (sessionId === undefined) return
    await store.claim(task.id, sessionId)
    const prompt = `Automatically dispatched: please complete task ${task.id} ("${task.title}") on the task board. Use task_board_list to confirm it, keep it claimed, do the described work, then task_board_complete with a concise summary and the files you touched.`
    await controller.prompt({
      requestId: `task-board-auto-${task.id}-${Date.now()}`,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: prompt }],
    }, new AbortController().signal)
  } catch {
    // A failed dispatch leaves the task ready for a later tick or a manual start.
  }
}
