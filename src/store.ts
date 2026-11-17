/** Host-side task store over a `storage-domain` table: schema-validated,
 * durable, synchronous reads, and change-emitting writes. Owns the monotonic
 * board revision that clients use for SSE resume. */
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

/** Normalize a project path so the same workspace always buckets together. */
export function normalizeProject(project: string): string {
  const trimmed = project.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

/** All task operations plus revision tracking over one open domain. */
export class TaskStore {
  private readonly table
  private rev = 0
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
    return { rev: this.rev, tasks: this.all() }
  }

  /** List tasks, optionally filtered by project and/or a set of statuses. */
  list(filter: { project?: string; statuses?: readonly TaskStatus[] } = {}): TaskDto[] {
    const project = filter.project === undefined ? undefined : normalizeProject(filter.project)
    const statuses = filter.statuses
    let out = this.all()
    if (project !== undefined) out = out.filter(task => task.project === project)
    if (statuses !== undefined) out = out.filter(task => statuses.includes(task.status))
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
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

  /** Create one task in `todo`. */
  async create(input: { project: string; title: string; description?: string; priority?: Task['priority'] }, now = Date.now()): Promise<TaskDto> {
    const task: Task = {
      id: nextId(now),
      project: normalizeProject(input.project),
      title: input.title.trim(),
      status: 'todo',
      priority: input.priority ?? 'normal',
      createdAt: now,
      updatedAt: now,
      ...(input.description === undefined || input.description === '' ? {} : { description: input.description }),
    }
    if (task.title === '') throw new Error('task title must not be empty')
    await this.table.put(task.id, task)
    this.emit()
    return task
  }

  /** Patch a task; `status` transitions are free-form (no enforced graph in v1). */
  async update(id: string, patch: Partial<Omit<Task, 'id' | 'project' | 'createdAt'>>, now = Date.now()): Promise<TaskDto> {
    const current = this.get(id)
    if (current === undefined) throw new Error(`task not found: ${id}`)
    const next: Task = {
      ...current,
      ...patch,
      id: current.id,
      project: current.project,
      createdAt: current.createdAt,
      updatedAt: now,
    }
    await this.table.put(id, next)
    this.emit()
    return next
  }

  /** Claim a todo task for one session: `todo → in_progress`. */
  async claim(id: string, sessionId: string, now = Date.now()): Promise<TaskDto> {
    const current = this.get(id)
    if (current === undefined) throw new Error(`task not found: ${id}`)
    if (current.status === 'done') throw new Error(`task already done: ${id}`)
    return this.update(id, { status: 'in_progress', claimedBy: { sessionId, at: now } }, now)
  }

  /** Complete a task and record its summary/files: `* → done`. */
  async complete(id: string, input: { summary: string; files?: readonly string[] }, now = Date.now()): Promise<TaskDto> {
    const current = this.get(id)
    if (current === undefined) throw new Error(`task not found: ${id}`)
    return this.update(id, {
      status: 'done',
      doneSummary: input.summary,
      ...(input.files === undefined ? {} : { doneFiles: [...input.files] }),
    }, now)
  }

  /** Delete a task. */
  async remove(id: string): Promise<boolean> {
    const deleted = await this.table.delete(id)
    if (deleted) this.emit()
    return deleted
  }
}
