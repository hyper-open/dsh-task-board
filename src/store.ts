/** Host-side task store over a `storage-domain` table: schema-validated,
 * durable, synchronous reads, and change-emitting writes. Owns the monotonic
 * board revision that clients use for SSE resume, and the auto-claim flag. */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { taskSchema } from './types.ts'
import type { BoardState, Task, TaskDto, TaskStatus } from './types.ts'

/** The durable task domain: one `tasks` table keyed by task id. */
export const taskBoardDomain = defineDomain({
  name: 'dsh_task_board',
  version: 1,
  tables: { tasks: domainTable(taskSchema) },
})

/** Open handle type for the task domain. */
export type TaskDomain = Domain<typeof taskBoardDomain>

/** Generate a short, sortable-ish task id. */
let counter = 0
function nextId(now: number): string {
  counter = (counter + 1) % 1_000_000
  return `t-${now.toString(36)}-${counter.toString(36)}`
}

/** Rank a priority for sorting (higher = more urgent). */
export function priorityRank(priority: Task['priority']): number {
  return priority === 'high' ? 2 : priority === 'normal' ? 1 : 0
}

/** Order tasks by priority (high first), then most-recently updated. */
export function byPriorityThenUpdated(a: TaskDto, b: TaskDto): number {
  const r = priorityRank(b.priority) - priorityRank(a.priority)
  return r !== 0 ? r : b.updatedAt - a.updatedAt
}

/** Normalize a project path so the same workspace always buckets together. */
export function normalizeProject(project: string): string {
  const trimmed = project.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/** All task operations plus revision tracking over one open domain. */
export class TaskStore {
  private readonly table
  private rev = 0
  private autoClaimFlag = true
  private listeners = new Set<(state: BoardState) => void>()

  /** @param domain - an opened task-board domain. */
  constructor(domain: TaskDomain) {
    this.table = domain.table('tasks')
  }

  /** Snapshot every task (synchronous from the validated in-memory state). */
  all(): TaskDto[] {
    const out: TaskDto[] = []
    for (const [, value] of this.table.entries()) out.push(value as TaskDto)
    return out
  }

  /** Current board state with the current revision. */
  state(): BoardState {
    return { rev: this.rev, tasks: this.all(), autoClaim: this.autoClaimFlag }
  }

  /** Whether the background auto-claim poller is enabled. */
  get autoClaim(): boolean { return this.autoClaimFlag }

  /** Enable/disable the background auto-claim poller. */
  setAutoClaim(enabled: boolean): void {
    if (this.autoClaimFlag === enabled) return
    this.autoClaimFlag = enabled
    this.emit()
  }

  /** List tasks, optionally filtered by project and/or a set of statuses. */
  list(filter: { project?: string; statuses?: readonly TaskStatus[]; includeArchived?: boolean } = {}): TaskDto[] {
    const project = filter.project === undefined ? undefined : normalizeProject(filter.project)
    const statuses = filter.statuses
    let out = this.all()
    // Default: exclude archived tasks (the agent only ever works live tasks).
    if (filter.includeArchived !== true) out = out.filter(task => task.archived !== true)
    if (project !== undefined) out = out.filter(task => task.project === project)
    if (statuses !== undefined) out = out.filter(task => statuses.includes(task.status))
    return out.sort(byPriorityThenUpdated)
  }

  /** Archive one task (hidden from the live board, kept in the archive view). */
  async archive(id: string, now = Date.now()): Promise<TaskDto> {
    return this.update(id, { archived: true }, now)
  }

  /** Restore one archived task to the board. */
  async unarchive(id: string, now = Date.now()): Promise<TaskDto> {
    return this.update(id, { archived: false }, now)
  }

  /** Archive every done task (optionally scoped to a project); returns the count. */
  async archiveAllDone(project?: string, now = Date.now()): Promise<number> {
    const done = this.all().filter(task => task.status === 'done' && task.archived !== true
      && (project === undefined || task.project === normalizeProject(project)))
    for (const task of done) await this.update(task.id, { archived: true }, now)
    return done.length
  }

  /** Read one task by id. */
  get(id: string): TaskDto | undefined {
    return this.table.get(id) as TaskDto | undefined
  }

  /** Subscribe to board-state changes (called after each durable write). */
  subscribe(listener: (state: BoardState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(): void {
    this.rev += 1
    const state = this.state()
    for (const listener of this.listeners) {
      try { listener(state) } catch { /* a bad listener must not break writes */ }
    }
  }

  /** Create one task; defaults to `draft` (not yet finalized). */
  async create(input: { project: string; title: string; description?: string; priority?: Task['priority']; status?: Extract<TaskStatus, 'draft' | 'ready'>; reuseIdle?: boolean }, now = Date.now()): Promise<TaskDto> {
    const task: Task = {
      id: nextId(now),
      project: normalizeProject(input.project),
      title: input.title.trim(),
      status: input.status ?? 'draft',
      priority: input.priority ?? 'normal',
      createdAt: now,
      updatedAt: now,
      ...(input.description === undefined || input.description === '' ? {} : { description: input.description }),
      ...(input.reuseIdle === true ? { reuseIdle: true } : {}),
    }
    if (task.title === '') throw new Error('task title must not be empty')
    await this.table.put(task.id, task)
    this.emit()
    return task
  }

  /** Patch a task; status is free-form (the store does not enforce a graph). */
  async update(id: string, patch: Partial<Omit<Task, 'id' | 'project' | 'createdAt'>> & Record<string, unknown>, now = Date.now()): Promise<TaskDto> {
    const current = this.get(id)
    if (current === undefined) throw new Error(`task not found: ${id}`)
    // Leaving a blocked state clears the block bookkeeping unless re-blocking.
    const clearingBlock = patch.status !== undefined && patch.status !== 'blocked' && current.status === 'blocked'
    // Drop keys explicitly set to undefined so the durable record never stores
    // an `undefined` for an optional field (matches exactOptionalPropertyTypes).
    const clean: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) clean[key] = value
    const merged: Record<string, unknown> = {
      ...current,
      ...clean,
      id: current.id,
      project: current.project,
      createdAt: current.createdAt,
      updatedAt: now,
    }
    if (clearingBlock) { delete merged['blockedFrom']; delete merged['blockedReason'] }
    const next = merged as unknown as Task
    await this.table.put(id, next)
    this.emit()
    return next
  }

  /**
   * Move a task into in_progress and record its owner. Accepts `draft`, `ready`
   * (and re-claims `in_progress` for a new owner). This is the "start"/claim edge.
   */
  async claim(id: string, sessionId: string, now = Date.now()): Promise<TaskDto> {
    const current = this.get(id)
    if (current === undefined) throw new Error(`task not found: ${id}`)
    if (current.status === 'done') throw new Error(`task already done: ${id}`)
    if (current.status === 'blocked') throw new Error(`task is blocked: ${id}`)
    if (current.status === 'review') throw new Error(`task is awaiting verification: ${id}`)
    return this.update(id, { status: 'in_progress', claimedBy: { sessionId, at: now } }, now)
  }

  /** Complete a task's work: `in_progress → review`, recording summary/files. */
  async complete(id: string, input: { summary: string; files?: readonly string[] }, now = Date.now()): Promise<TaskDto> {
    const current = this.get(id)
    if (current === undefined) throw new Error(`task not found: ${id}`)
    return this.update(id, {
      status: 'review',
      doneSummary: input.summary,
      ...(input.files === undefined ? {} : { doneFiles: [...input.files] }),
    }, now)
  }

  /** Human acceptance: `review → done`. */
  async verify(id: string, now = Date.now()): Promise<TaskDto> {
    return this.update(id, { status: 'done' }, now)
  }

  /** Human rejection of a review: back to `in_progress` (clears the claim owner). */
  async reject(id: string, now = Date.now()): Promise<TaskDto> {
    return this.update(id, { status: 'in_progress', claimedBy: undefined } as Record<string, unknown>, now)
  }

  /** Block a task, remembering the state to restore. */
  async block(id: string, reason?: string, now = Date.now()): Promise<TaskDto> {
    const current = this.get(id)
    if (current === undefined) throw new Error(`task not found: ${id}`)
    if (current.status === 'blocked') return current
    const from: Exclude<TaskStatus, 'blocked'> = current.status === 'done' ? 'ready' : current.status
    return this.update(id, { status: 'blocked', blockedFrom: from, ...(reason === undefined ? {} : { blockedReason: reason }) }, now)
  }

  /** Unblock a task, restoring the state it was blocked from. */
  async unblock(id: string, now = Date.now()): Promise<TaskDto> {
    const current = this.get(id)
    if (current === undefined) throw new Error(`task not found: ${id}`)
    if (current.status !== 'blocked') return current
    return this.update(id, { status: current.blockedFrom ?? 'ready' }, now)
  }

  /** Delete a task. */
  async remove(id: string): Promise<boolean> {
    const deleted = await this.table.delete(id)
    if (deleted) this.emit()
    return deleted
  }
}
