/** Browser client for the /taskboard host routes: typed fetch wrappers
 * (same origin as the GUI) plus the SSE subscription that keeps the board live. */
import type { BoardState, CreateTaskBody, DeleteTaskBody, TaskDto, UpdateTaskBody } from '../types.ts'

/** Path prefix owning every task-board route. */
const BASE = '/taskboard'

/** Unwrap the `{ok, ...}` envelope, throwing on a transport or payload error. */
async function unwrap<T>(pending: Promise<Response>): Promise<T> {
  const res = await pending
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new Error(`task-board: HTTP ${res.status}`)
  }
  const record = body as { ok?: boolean; error?: string }
  if (!res.ok || record.ok !== true) throw new Error(record.error ?? `task-board: HTTP ${res.status}`)
  return body as T
}

const post = (path: string, body: unknown, signal?: AbortSignal): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })

/** Read the full board snapshot. */
export async function fetchState(signal?: AbortSignal): Promise<BoardState> {
  const body = await unwrap<{ state: BoardState }>(fetch(`${BASE}/api/state`, signal === undefined ? {} : { signal }))
  return body.state
}

/** Create a task. */
export async function createTask(input: CreateTaskBody): Promise<TaskDto> {
  const body = await unwrap<{ task: TaskDto }>(post('/api/create', input))
  return body.task
}

/** Update a task (title/description/priority/status/doneSummary/doneFiles). */
export async function updateTask(input: UpdateTaskBody): Promise<TaskDto> {
  const body = await unwrap<{ task: TaskDto }>(post('/api/update', input))
  return body.task
}

/** Delete a task. */
export async function deleteTask(id: string): Promise<boolean> {
  const body = await unwrap<{ deleted: boolean }>(post('/api/delete', { id } satisfies DeleteTaskBody))
  return body.deleted
}

/** Run a lifecycle action (start/verify/reject/block/unblock) on a task. */
export async function taskAction(id: string, action: NonNullable<UpdateTaskBody['action']>, reason?: string): Promise<TaskDto> {
  const body = await unwrap<{ task: TaskDto }>(post('/api/update', { id, action, ...(reason === undefined ? {} : { blockedReason: reason }) }))
  return body.task
}

/** Archive every done task (optionally scoped to a project); returns the count. */
export async function archiveDone(project?: string): Promise<number> {
  const body = await unwrap<{ archived: number }>(post('/api/archive-done', project === undefined ? {} : { project }))
  return body.archived
}

/** Enable/disable the background auto-claim poller. */
export async function setAutoClaim(enabled: boolean): Promise<boolean> {
  const body = await unwrap<{ autoClaim: boolean }>(post('/api/auto-claim', { enabled }))
  return body.autoClaim
}

/**
 * Subscribe to the board's live state over SSE.
 * @param onState - called with every pushed board state (including the opening one).
 * @returns a function closing the connection.
 */
export function subscribeBoard(onState: (state: BoardState) => void): () => void {
  const source = new EventSource(`${BASE}/events`)
  source.onmessage = (event) => {
    try {
      const frame = JSON.parse(event.data) as { type?: string; state?: BoardState }
      if (frame.type === 'state' && frame.state !== undefined) onState(frame.state)
    } catch { /* ignore malformed frame */ }
  }
  // On error EventSource auto-reconnects; the opening frame resyncs state.
  return () => { source.close() }
}
