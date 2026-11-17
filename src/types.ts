/** Shared task model for the DSH task board: durable records and the JSON DTOs
 * the Host routes and the browser client exchange. */
import { z } from 'zod'

/** Lifecycle of one task. */
export type TaskStatus = 'todo' | 'in_progress' | 'done'

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
}

/** Zod schema guarding every durable task record as read/written by the domain. */
export const taskSchema = z.object({
  id: z.string(),
  project: z.string(),
  title: z.string(),
  description: z.string().optional(),
  status: z.enum(['todo', 'in_progress', 'done']),
  priority: z.enum(['low', 'normal', 'high']),
  createdAt: z.number(),
  updatedAt: z.number(),
  claimedBy: z.object({ sessionId: z.string(), at: z.number() }).optional(),
  doneSummary: z.string().optional(),
  doneFiles: z.array(z.string()).optional(),
})

/** Browser-facing task DTO (identical shape to the durable record). */
export type TaskDto = Task

/** One board snapshot pushed to clients and returned by `/taskboard/api/state`. */
export interface BoardState {
  /** Monotonic revision; clients refetch when they detect a gap. */
  readonly rev: number
  readonly tasks: readonly TaskDto[]
}

/** Create-task request body. */
export interface CreateTaskBody {
  readonly project: string
  readonly title: string
  readonly description?: string
  readonly priority?: TaskPriority
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
}

/** Delete-task request body. */
export interface DeleteTaskBody {
  readonly id: string
}

/** Reversible status keys the store exposes for validation. */
export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'in_progress', 'done']
