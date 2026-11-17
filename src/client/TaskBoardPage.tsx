/**
 * DSH Task Board page: a kanban of project tasks across the full lifecycle —
 * Draft · Ready · In progress · Review · Done · Blocked. The human creates and
 * moves tasks; an agent processes a project's ready/in-progress tasks via the
 * `task_board_*` tools; the board stays live over SSE.
 */
import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import {
  IconCloseOutlineRegular,
  IconPlusOutlineRegular,
  IconRefreshOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { BoardState, TaskDto, TaskPriority, TaskStatus } from '../types.ts'
import { createTask, deleteTask, fetchState, setAutoClaim, subscribeBoard, taskAction, updateTask } from './api.ts'
import type { TaskBoardKey } from './locales.ts'
import css from './TaskBoardPage.module.css'

/** Minimal workspace-list snapshot the page reads (paths + titles). */
export interface WorkspaceListView {
  readonly items: readonly { readonly path: string; readonly title: string }[]
}

/** Injected services the page uses. */
export interface TaskBoardInjected {
  /** Workspace list, for the project selector and default project. */
  readonly useWorkspaces: SnapshotSelectorHook<WorkspaceListView>
  /** The current session's working directory (its project), when known. */
  readonly currentProject?: string | undefined
}

/** Root-scoped page props. */
export type TaskBoardPageProps = PropsRuntime<'main'> & TaskBoardInjected & PropsLocale<'taskBoard'>

/** Columns in board order. */
const COLUMNS: readonly TaskStatus[] = ['draft', 'ready', 'in_progress', 'review', 'done', 'blocked']

/** Last path segment of a directory. */
function baseName(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

/** Relative "updated" label. */
function ageLabel(updatedAt: number, now: number, t: (k: TaskBoardKey, p?: Record<string, string | number>) => string): string {
  const diff = Math.max(0, now - updatedAt)
  const min = 60_000
  if (diff < min) return t('time.now')
  if (diff < 60 * min) return t('time.minutes', { n: Math.floor(diff / min) })
  if (diff < 24 * 60 * min) return t('time.hours', { n: Math.floor(diff / (60 * min)) })
  return t('time.days', { n: Math.floor(diff / (24 * 60 * min)) })
}

/**
 * Render the task board.
 * @param props - injected services and copy.
 * @returns the global task-board page.
 */
export function TaskBoardPage(props: TaskBoardPageProps) {
  const { useWorkspaces, currentProject, t } = props
  const workspaceSnapshot = useWorkspaces(state => state)
  const projects = useMemo(() => {
    const seen = new Set<string>()
    const out: { path: string; title: string }[] = []
    for (const item of workspaceSnapshot.items) {
      if (item.path === '' || seen.has(item.path)) continue
      seen.add(item.path)
      out.push({ path: item.path, title: item.title })
    }
    return out
  }, [workspaceSnapshot])

  const [board, setBoard] = useState<BoardState | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [now, setNow] = useState(() => Date.now())
  const [projectFilter, setProjectFilter] = useState<string>('all')
  const [priorityFilter, setPriorityFilter] = useState<'all' | TaskPriority>('all')
  const [drafting, setDrafting] = useState(false)
  const [draftProject, setDraftProject] = useState('')
  const [draftTitle, setDraftTitle] = useState('')
  const [draftDesc, setDraftDesc] = useState('')
  const [draftPriority, setDraftPriority] = useState<TaskPriority>('normal')
  const [draftReady, setDraftReady] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | undefined>(undefined)

  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => { clearInterval(timer) }
  }, [])

  useEffect(() => {
    let alive = true
    fetchState().then(state => { if (alive) { setBoard(state); setError(undefined) } }).catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    const close = subscribeBoard(state => { setBoard(state); setError(undefined) })
    return () => { alive = false; close() }
  }, [])

  const refresh = async (): Promise<void> => {
    try { setBoard(await fetchState()); setError(undefined) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const run = async (op: () => Promise<unknown>): Promise<void> => {
    try { await op() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const defaultProject = currentProject !== undefined && currentProject !== '' ? currentProject : (projects[0]?.path ?? '')
  const openDraft = (): void => {
    setDrafting(true); setDraftProject(defaultProject); setDraftTitle(''); setDraftDesc(''); setDraftPriority('normal'); setDraftReady(false)
  }
  const submitDraft = async (): Promise<void> => {
    const title = draftTitle.trim()
    if (title === '' || draftProject === '') return
    await run(async () => {
      await createTask({ project: draftProject, title, ...(draftDesc.trim() === '' ? {} : { description: draftDesc.trim() }), priority: draftPriority, status: draftReady ? 'ready' : 'draft' })
      setDrafting(false)
    })
  }
  const remove = async (id: string): Promise<void> => {
    if (confirmDeleteId !== id) { setConfirmDeleteId(id); return }
    setConfirmDeleteId(undefined)
    await run(() => deleteTask(id))
  }

  const tasks = board?.tasks ?? []
  const visible = tasks
    .filter(task => projectFilter === 'all' || task.project === projectFilter)
    .filter(task => priorityFilter === 'all' || task.priority === priorityFilter)
  const rank = (p: TaskPriority): number => (p === 'high' ? 2 : p === 'normal' ? 1 : 0)
  // Highest priority first within each column, then most recently updated.
  const byStatus = (status: TaskStatus): TaskDto[] =>
    visible.filter(task => task.status === status)
      .sort((a, b) => (rank(b.priority) - rank(a.priority)) || (b.updatedAt - a.updatedAt))
  const autoClaim = board?.autoClaim === true

  return (
    <section className={css.page} aria-label={t('page.title')} data-testid="task-board-page">
      <header className={css.header}>
        <div className={css.headerLeft}>
          <h1 className={css.title}>{t('page.title')}</h1>
          <p className={css.subtitle}>{t('page.subtitle')}</p>
        </div>
        <div className={css.headerRight}>
          <label className={css.autoToggle} title={t('auto.hint')}>
            <input type="checkbox" className={css.autoInput} checked={autoClaim} onChange={e => { void run(() => setAutoClaim(e.target.checked)) }} />
            <span className={css.autoSwitch} aria-hidden="true" />
            <span className={css.autoLabel}>{t('auto.label')}</span>
          </label>
          <label className={css.projectPicker}>
            <span className={css.projectLabel}>{t('priority.label')}</span>
            <select className={css.select} value={priorityFilter} onChange={e => { setPriorityFilter(e.target.value as 'all' | TaskPriority) }}>
              <option value="all">{t('priority.all')}</option>
              <option value="high">{t('priority.high')}</option>
              <option value="normal">{t('priority.normal')}</option>
              <option value="low">{t('priority.low')}</option>
            </select>
          </label>
          <label className={css.projectPicker}>
            <span className={css.projectLabel}>{t('project.label')}</span>
            <select className={css.select} value={projectFilter} onChange={e => { setProjectFilter(e.target.value) }}>
              <option value="all">{t('project.all')}</option>
              {projects.map(p => <option key={p.path} value={p.path}>{p.title} · {baseName(p.path)}</option>)}
            </select>
          </label>
          <button type="button" className={css.refresh} aria-label={t('refresh')} onClick={() => { void refresh() }}>
            <IconRefreshOutlineRegular size={13} />{t('refresh')}
          </button>
          <button type="button" className={css.newBtn} onClick={openDraft}><IconPlusOutlineRegular size={13} />{t('new.action')}</button>
        </div>
      </header>

      {error !== undefined && <div className={css.error} role="alert">{t('error.load', { message: error })}</div>}

      {drafting && (
        <div className={css.draft}>
          <select className={css.select} value={draftProject} onChange={e => { setDraftProject(e.target.value) }} aria-label={t('new.projectPrompt')}>
            {projects.length === 0 && <option value="">{t('new.projectPrompt')}</option>}
            {projects.map(p => <option key={p.path} value={p.path}>{p.title} · {baseName(p.path)}</option>)}
          </select>
          <input className={css.input} placeholder={t('new.placeholder.title')} value={draftTitle} onChange={e => { setDraftTitle(e.target.value) }} />
          <input className={css.input} placeholder={t('new.placeholder.description')} value={draftDesc} onChange={e => { setDraftDesc(e.target.value) }} />
          <select className={css.select} value={draftPriority} onChange={e => { setDraftPriority(e.target.value as TaskPriority) }} aria-label="priority">
            <option value="low">{t('priority.low')}</option><option value="normal">{t('priority.normal')}</option><option value="high">{t('priority.high')}</option>
          </select>
          <label className={css.readyToggle}>
            <input type="checkbox" checked={draftReady} onChange={e => { setDraftReady(e.target.checked) }} />
            <span>{t('new.readyNow')}</span>
          </label>
          <button type="button" className={css.newBtn} disabled={draftTitle.trim() === '' || draftProject === ''} onClick={() => { void submitDraft() }}>{t('new.submit')}</button>
          <button type="button" className={css.ghostBtn} onClick={() => { setDrafting(false) }}>{t('new.cancel')}</button>
        </div>
      )}

      {board === undefined && error === undefined
        ? <div className={css.loading}>{t('loading')}</div>
        : (
            <div className={css.board}>
              {COLUMNS.map(status => {
                const items = byStatus(status)
                return (
                  <section key={status} className={clsx(css.column, status === 'blocked' && css.columnBlocked, status === 'done' && css.columnDone)} aria-label={t(`column.${status}` as TaskBoardKey)}>
                    <header className={css.columnHeader}>
                      <span className={css.columnDot} data-status={status} aria-hidden="true" />
                      <h2 className={css.columnTitle}>{t(`column.${status}` as TaskBoardKey)}</h2>
                      <span className={css.columnCount}>{items.length}</span>
                    </header>
                    {items.length === 0
                      ? <p className={css.columnEmpty}>{t(`column.empty.${status}` as TaskBoardKey)}</p>
                      : (
                          <ul className={css.cardList}>
                            {items.map(task => (
                              <TaskCard key={task.id} task={task} now={now} t={t} confirming={confirmDeleteId === task.id}
                                onAction={action => { void run(() => taskAction(task.id, action)) }}
                                onStatus={status2 => { void run(() => updateTask({ id: task.id, status: status2 })) }}
                                onDelete={() => { void remove(task.id) }} />
                            ))}
                          </ul>
                        )}
                  </section>
                )
              })}
            </div>
          )}
    </section>
  )
}

/** One task card with lifecycle-appropriate actions. */
function TaskCard(props: {
  readonly task: TaskDto
  readonly now: number
  readonly confirming: boolean
  readonly t: (k: TaskBoardKey, p?: Record<string, string | number>) => string
  readonly onAction: (action: 'start' | 'verify' | 'reject' | 'block' | 'unblock') => void
  readonly onStatus: (status: TaskStatus) => void
  readonly onDelete: () => void
}) {
  const { task, now, confirming, t, onAction, onStatus, onDelete } = props
  const btn = (label: string, onClick: () => void, cls?: string): JSX.Element => (
    <button type="button" className={clsx(css.actionBtn, cls)} onClick={onClick}>{label}</button>
  )
  let actions: JSX.Element[]
  switch (task.status) {
    case 'draft':
      actions = [btn(t('act.confirmReady'), () => { onStatus('ready') }, css.actionPrimary)]
      break
    case 'ready':
      actions = [btn(t('act.start'), () => { onAction('start') }, css.actionPrimary)]
      break
    case 'in_progress':
      actions = [btn(t('act.complete'), () => { onStatus('review') }, css.actionPrimary)]
      break
    case 'review':
      actions = [btn(t('act.verify'), () => { onAction('verify') }, css.actionPrimary), btn(t('act.reject'), () => { onAction('reject') })]
      break
    case 'done':
      actions = []
      break
    case 'blocked':
      actions = [btn(t('act.unblock'), () => { onAction('unblock') }, css.actionPrimary)]
      break
  }
  return (
    <li className={clsx(css.card, task.priority === 'high' && css.cardHigh, task.status === 'blocked' && css.cardBlocked)}>
      <div className={css.cardTop}>
        <span className={css.cardTitle}>{task.title}</span>
        <span className={css.cardAge}>{ageLabel(task.updatedAt, now, t)}</span>
      </div>
      {task.description !== undefined && task.description !== '' && <p className={css.cardDesc}>{task.description}</p>}
      <div className={css.cardMeta}>
        <span className={css.projectBadge} title={task.project}>{baseName(task.project)}</span>
        {task.priority !== 'normal' && <span className={css.priorityBadge} data-p={task.priority}>{t(`priority.${task.priority}` as TaskBoardKey)}</span>}
        {task.claimedBy !== undefined && <span className={css.claimed}>{t('card.claimedBy', { session: task.claimedBy.sessionId.slice(0, 12) })}</span>}
      </div>
      {task.status === 'blocked' && task.blockedReason !== undefined && <p className={css.blockReason}>{t('card.blockedReason', { reason: task.blockedReason })}</p>}
      {(task.status === 'review' || task.status === 'done') && (
        <p className={css.doneSummary}>{t('card.doneSummary', { summary: task.doneSummary ?? t('card.noSummary') })}</p>
      )}
      <div className={css.cardActions}>
        {actions}
        {task.status !== 'done' && task.status !== 'blocked' && btn(t('act.block'), () => { onAction('block') }, css.actionGhost)}
        <button type="button" className={clsx(css.iconBtn, confirming && css.deleteConfirm)} aria-label={confirming ? t('card.confirmDelete') : t('card.delete')} onClick={onDelete}>
          {confirming ? t('card.confirmDelete') : <IconCloseOutlineRegular size={12} />}
        </button>
      </div>
    </li>
  )
}
