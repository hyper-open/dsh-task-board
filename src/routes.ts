/** Host HTTP routes for the task board: JSON endpoints under `/taskboard/api`
 * and an SSE channel at `/taskboard/events`. The browser half calls these
 * same-origin (the page and this server share an origin). */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ArchiveDoneBody, BoardState, CreateTaskBody, DeleteTaskBody, SetAutoClaimBody, UpdateTaskBody } from './types.ts'
import type { TaskStore } from './store.ts'

/** SSE frame for one board change. */
function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** Read a small JSON request body. */
async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (raw === '') return {} as T
  return JSON.parse(raw) as T
}

/** Write a JSON response. */
function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/** Uniform error envelope the client unwraps. */
function fail(res: ServerResponse, status: number, message: string): void {
  json(res, status, { ok: false, error: message })
}

/**
 * Same-origin guard for state-changing routes. DSH gates only `/api` with
 * browser auth; custom routes are trusted at the server boundary (as the HMR
 * events route is). As defense-in-depth against a cross-site page driving this
 * endpoint, reject a write whose `Origin` names a different host than the
 * request's `Host`. A missing Origin (curl, same-origin fetch) is allowed.
 * @param req - the incoming request.
 * @returns true when the request may proceed.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

/**
 * Register the task-board routes on the web server.
 * @param ctx - context carrying `webServer` and the event bus.
 * @param store - the task store.
 * @returns disposer removing all routes and closing SSE connections.
 */
export function registerTaskBoardRoutes(ctx: Context, store: TaskStore): () => void {
  const connections = new Set<ServerResponse>()
  const publish = (state: BoardState): void => {
    const line = sseData({ type: 'state', state })
    for (const res of connections) {
      try { res.write(line) } catch { /* dropped peer; cleaned on close */ }
    }
  }
  const unsubscribe = store.subscribe(publish)

  const disposers: Array<() => void> = []
  const route = (path: string, handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): void => {
    disposers.push(ctx.webServer.register({ kind: 'exact', path, handler }))
  }

  // GET /taskboard/api/state — full board snapshot.
  route('/taskboard/api/state', (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed')
    json(res, 200, { ok: true, state: store.state() })
  })

  // POST /taskboard/api/create — body CreateTaskBody.
  route('/taskboard/api/create', async (req, res) => {
    if (req.method !== 'POST') return fail(res, 405, 'method not allowed')
    if (!sameOrigin(req)) return fail(res, 403, 'cross-origin request refused')
    try {
      const body = await readJson<CreateTaskBody>(req)
      if (typeof body.project !== 'string' || typeof body.title !== 'string') return fail(res, 400, 'project and title are required')
      const task = await store.create({
        project: body.project,
        title: body.title,
        ...(body.description === undefined ? {} : { description: body.description }),
        ...(body.priority === undefined ? {} : { priority: body.priority }),
        ...(body.status === 'ready' ? { status: 'ready' as const } : {}),
        ...(body.reuseIdle === true ? { reuseIdle: true } : {}),
        ...(body.sessionMode === 'new' || body.sessionMode === 'reuse' ? { sessionMode: body.sessionMode } : {}),
        ...(body.reuseSessionId === undefined || body.reuseSessionId === '' ? {} : { reuseSessionId: body.reuseSessionId }),
      })
      json(res, 200, { ok: true, task })
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : String(error))
    }
  })

  // POST /taskboard/api/update — body UpdateTaskBody.
  route('/taskboard/api/update', async (req, res) => {
    if (req.method !== 'POST') return fail(res, 405, 'method not allowed')
    if (!sameOrigin(req)) return fail(res, 403, 'cross-origin request refused')
    try {
      const body = await readJson<UpdateTaskBody>(req)
      if (typeof body.id !== 'string') return fail(res, 400, 'id is required')
      const { id, action, blockedReason, ...patch } = body
      let task
      if (action === 'start' || action === 'claim') task = await store.claim(id, 'board')
      else if (action === 'verify') task = await store.verify(id)
      else if (action === 'reject') task = await store.reject(id)
      else if (action === 'block') task = await store.block(id, blockedReason)
      else if (action === 'archive') task = await store.archive(id)
      else if (action === 'unarchive') task = await store.unarchive(id)
      else if (action === 'unblock') task = await store.unblock(id)
      else task = await store.update(id, patch)
      json(res, 200, { ok: true, task })
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : String(error))
    }
  })

  // POST /taskboard/api/auto-claim — body SetAutoClaimBody.
  route('/taskboard/api/auto-claim', async (req, res) => {
    if (req.method !== 'POST') return fail(res, 405, 'method not allowed')
    if (!sameOrigin(req)) return fail(res, 403, 'cross-origin request refused')
    try {
      const body = await readJson<SetAutoClaimBody>(req)
      store.setAutoClaim(body.enabled === true)
      json(res, 200, { ok: true, autoClaim: store.state().autoClaim })
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : String(error))
    }
  })

  // POST /taskboard/api/archive-done — body ArchiveDoneBody (optional project).
  route('/taskboard/api/archive-done', async (req, res) => {
    if (req.method !== 'POST') return fail(res, 405, 'method not allowed')
    if (!sameOrigin(req)) return fail(res, 403, 'cross-origin request refused')
    try {
      const body = await readJson<ArchiveDoneBody>(req)
      const archived = await store.archiveAllDone(typeof body.project === 'string' && body.project !== '' ? body.project : undefined)
      json(res, 200, { ok: true, archived })
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : String(error))
    }
  })

  // POST /taskboard/api/delete — body DeleteTaskBody.
  route('/taskboard/api/delete', async (req, res) => {
    if (req.method !== 'POST') return fail(res, 405, 'method not allowed')
    if (!sameOrigin(req)) return fail(res, 403, 'cross-origin request refused')
    try {
      const body = await readJson<DeleteTaskBody>(req)
      if (typeof body.id !== 'string') return fail(res, 400, 'id is required')
      const deleted = await store.remove(body.id)
      json(res, 200, { ok: true, deleted })
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : String(error))
    }
  })

  // GET /taskboard/events — SSE board changes.
  route('/taskboard/events', (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed')
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    })
    res.write(': connected\n\n')
    connections.add(res)
    // Opening snapshot so a fresh subscriber is immediately current.
    res.write(sseData({ type: 'state', state: store.state() }))
    req.on('close', () => { connections.delete(res) })
    res.on('close', () => { connections.delete(res) })
  })

  return () => {
    unsubscribe()
    for (const dispose of disposers) dispose()
    for (const res of connections) { try { res.destroy() } catch { /* ignore */ } }
    connections.clear()
  }
}
