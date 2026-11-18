/** Shared task model for the DSH task board: durable records and the JSON DTOs
 * the Host routes and the browser client exchange. */
import { z } from 'zod'

/**
 * Lifecycle of one task.
 * Main chain: draft → ready → in_progress → review → done.
 * `blocked` is a side state (waiting on a dependency), plus `blockedFrom`
 * remembers the state to restore.
 */
export type TaskStatus = 'draft' | 'ready' | 'in_progress' | 'review' | 'done' | 'blocked'

/** Relative urgency of a task. */
export type TaskPriority = 'low' | 'normal' | 'high'

/** Who currently owns an in-progress task. */
export interface TaskClaim {
  readonly sessionId: string
  /** Epoch ms when the task was claimed. */
  readonly at: number
}

/** One durable task record. `project` is the normalized workspace path the task
 * belongs to (the owning session's working directory). */
export interface Task {
  readonly id: string
  readonly project: string
  readonly title: string
  readonly description?: string
  readonly status: TaskStatus
  readonly priority: TaskPriority
  readonly createdAt: number
  readonly updatedAt: number
  readonly claimedBy?: TaskClaim
  /** Summary written when the task was completed (usually by the agent). */
  readonly doneSummary?: string
  /** Files the completion touched, advisory. */
  readonly doneFiles?: string[]
  /** When `status` is `blocked`, the state to restore on unblock. */
  readonly blockedFrom?: Exclude<TaskStatus, 'blocked'>
  /** When `status` is `blocked`, an optional reason. */
  readonly blockedReason?: string
  /** Archived tasks are hidden from the board columns and shown in the archive view. */
  readonly archived?: boolean
  /** Whether auto-dispatch should reuse an idle session in the project instead of creating a new one. */
  readonly reuseIdle?: boolean
}

/** Zod schema guarding every durable task record as read/written by the domain. */
export const taskSchema = z.object({
  id: z.string(),
  project: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(['draft', 'ready', 'in_progress', 'review', 'done', 'blocked']),
  priority: z.enum(['low', 'normal', 'high']),
  createdAt: z.number(),
  updatedAt: z.number(),
  claimedBy: z.object({ sessionId: z.string(), at: z.number() }).optional(),
  doneSummary: z.string().optional(),
  doneFiles: z.array(z.string()).optional(),
  blockedFrom: z.enum(['draft', 'ready', 'in_progress', 'review', 'done']).optional(),
  blockedReason: z.string().optional(),
  archived: z.boolean().optional(),
  reuseIdle: z.boolean().optional(),
})

/** Browser-facing task DTO (identical shape to the durable record). */
export type TaskDto = Task

/** One board snapshot pushed to clients and returned by `/taskboard/api/state`. */
export interface BoardState {
  /** Monotonic revision; clients refetch when they detect a gap. */
  readonly rev: number
  readonly tasks: readonly TaskDto[]
  /** Whether the background auto-claim poller is currently enabled. */
  readonly autoClaim: boolean
}

/** Create-task request body. */
export interface CreateTaskBody {
  readonly project: string
  readonly title: string
  readonly description?: string
  readonly priority?: TaskPriority
  /** Initial status; defaults to `draft`. */
  readonly status?: Extract<TaskStatus, 'draft' | 'ready'>
  /** Reuse an idle session in the project on dispatch (default false = new session). */
  readonly reuseIdle?: boolean
}

/** Update-task request body (partial, status changes supported). */
export interface UpdateTaskBody {
  readonly id: string
  readonly title?: string
  readonly description?: string
  readonly priority?: TaskPriority
  readonly status?: TaskStatus
  readonly doneSummary?: string
  readonly doneFiles?: string[]
  readonly blockedReason?: string
  /** Optional lifecycle action that overrides a plain status patch. */
  readonly action?: 'start' | 'claim' | 'verify' | 'reject' | 'block' | 'unblock' | 'archive' | 'unarchive'
}

/** Delete-task request body. */
export interface DeleteTaskBody {
  readonly id: string
}

/** Archive all done request body. */
export interface ArchiveDoneBody {
  readonly project?: string
}

/** Toggle the auto-claim poller request body. */
export interface SetAutoClaimBody {
  readonly enabled: boolean
}

/** All lifecycle states, in board order (blocked is rendered as its own column). */
export const TASK_STATUSES: readonly TaskStatus[] = ['draft', 'ready', 'in_progress', 'review', 'done', 'blocked']

/** The main chain states that participate in the normal forward flow. */
export const MAIN_CHAIN: readonly Exclude<TaskStatus, 'blocked'>[] = ['draft', 'ready', 'in_progress', 'review', 'done']
