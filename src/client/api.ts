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
