/**
 * DSH Task Board page: a three-column kanban (Todo / In progress / Done) of
 * project tasks. Tasks belong to a project (a workspace directory); the human
 * creates and manages them here, and an agent pulls a project's pending tasks
 * through the task_board_* tools. The board stays live over SSE.
 *
 * All reads/writes go to the Host `/taskboard` routes; this page keeps no
 * durable state of its own beyond the rendered snapshot and the create draft.
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
import { createTask, deleteTask, fetchState, subscribeBoard, updateTask } from './api.ts'
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

/** Root-scoped page props: standard kit, injected services, and copy. */
export type TaskBoardPageProps = PropsRuntime<'main'> & TaskBoardInjected & PropsLocale<'taskBoard'>

/** The three kanban columns in order. */
const COLUMNS: readonly TaskStatus[] = ['todo', 'in_progress', 'done']

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
  // Draft form for creating a task.
  const [drafting, setDrafting] = useState(false)
  const [draftProject, setDraftProject] = useState('')
  const [draftTitle, setDraftTitle] = useState('')
  const [draftDesc, setDraftDesc] = useState('')
  const [draftPriority, setDraftPriority] = useState<TaskPriority>('normal')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | undefined>(undefined)

  // Tick for relative times.
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 30_000)
    return () => { clearInterval(timer) }
  }, [])

  // Initial snapshot + live SSE subscription.
  useEffect(() => {
    let alive = true
    fetchState().then(state => { if (alive) { setBoard(state); setError(undefined) } }).catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
    const close = subscribeBoard(state => { setBoard(state); setError(undefined) })
    return () => { alive = false; close() }
  }, [])

  const refresh = async (): Promise<void> => {
    try { setBoard(await fetchState()); setError(undefined) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const defaultProject = currentProject !== undefined && currentProject !== ''
    ? currentProject
    : (projects[0]?.path ?? '')

  const openDraft = (): void => {
    setDrafting(true)
    setDraftProject(defaultProject)
    setDraftTitle('')
    setDraftDesc('')
    setDraftPriority('normal')
  }

  const submitDraft = async (): Promise<void> => {
    const title = draftTitle.trim()
    if (title === '' || draftProject === '') return
    try {
      await createTask({ project: draftProject, title, ...(draftDesc.trim() === '' ? {} : { description: draftDesc.trim() }), priority: draftPriority })
      setDrafting(false)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const move = async (task: TaskDto, dir: 1 | -1): Promise<void> => {
    const idx = COLUMNS.indexOf(task.status)
    const next = COLUMNS[idx + dir]
    if (next === undefined) return
    try { await updateTask({ id: task.id, status: next }) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const remove = async (id: string): Promise<void> => {
    if (confirmDeleteId !== id) { setConfirmDeleteId(id); return }
    setConfirmDeleteId(undefined)
    try { await deleteTask(id) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const tasks = board?.tasks ?? []
  const visible = projectFilter === 'all' ? tasks : tasks.filter(task => task.project === projectFilter)
  const byStatus = (status: TaskStatus): TaskDto[] =>
    visible.filter(task => task.status === status).sort((a, b) => b.updatedAt - a.updatedAt)

  return (
    <section className={css.page} aria-label={t('page.title')} data-testid="task-board-page">
      <header className={css.header}>
        <div className={css.headerLeft}>
          <h1 className={css.title}>{t('page.title')}</h1>
          <p className={css.subtitle}>{t('page.subtitle')}</p>
        </div>
        <div className={css.headerRight}>
          <label className={css.projectPicker}>
            <span className={css.projectLabel}>{t('project.label')}</span>
            <select className={css.select} value={projectFilter} onChange={e => { setProjectFilter(e.target.value) }}>
              <option value="all">{t('project.all')}</option>
              {projects.map(p => <option key={p.path} value={p.path}>{p.title} · {baseName(p.path)}</option>)}
            </select>
          </label>
          <button type="button" className={css.refresh} aria-label={t('refresh')} onClick={() => { void refresh() }}>
            <IconRefreshOutlineRegular size={13} />
            {t('refresh')}
          </button>
          <button type="button" className={css.newBtn} onClick={openDraft}>
            <IconPlusOutlineRegular size={13} />
            {t('new.action')}
          </button>
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
            <option value="low">{t('priority.low')}</option>
            <option value="normal">{t('priority.normal')}</option>
            <option value="high">{t('priority.high')}</option>
          </select>
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
                  <section key={status} className={clsx(css.column, status === 'done' && css.columnDone)} aria-label={t(`column.${status}` as TaskBoardKey)}>
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
                              <TaskCard
                                key={task.id} task={task} now={now} t={t}
                                confirming={confirmDeleteId === task.id}
                                onMove={dir => { void move(task, dir) }}
                                onDelete={() => { void remove(task.id) }}
                              />
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

/** One task card. */
function TaskCard(props: {
  readonly task: TaskDto
  readonly now: number
  readonly confirming: boolean
  readonly t: (k: TaskBoardKey, p?: Record<string, string | number>) => string
  readonly onMove: (dir: 1 | -1) => void
  readonly onDelete: () => void
}) {
  const { task, now, confirming, t, onMove, onDelete } = props
  const canPrev = task.status !== 'todo'
  const canNext = task.status !== 'done'
  return (
    <li className={clsx(css.card, task.priority === 'high' && css.cardHigh)}>
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
      {task.status === 'done' && (
        <p className={css.doneSummary}>{t('card.doneSummary', { summary: task.doneSummary ?? t('card.noSummary') })}</p>
      )}
      <div className={css.cardActions}>
        <button type="button" className={css.iconBtn} disabled={!canPrev} aria-label={t('card.movePrev')} onClick={() => { onMove(-1) }}>←</button>
        <button type="button" className={css.iconBtn} disabled={!canNext} aria-label={t('card.moveNext')} onClick={() => { onMove(1) }}>→</button>
        <button type="button" className={clsx(css.iconBtn, css.deleteBtn, confirming && css.deleteConfirm)} aria-label={confirming ? t('card.confirmDelete') : t('card.delete')} onClick={onDelete}>
          {confirming ? t('card.confirmDelete') : <IconCloseOutlineRegular size={13} />}
        </button>
      </div>
    </li>
  )
}
