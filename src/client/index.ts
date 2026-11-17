/**
 * DSH Task Board, browser half: contributes one global page in the root `main`
 * slot plus its sidebar entry. The page is a three-column kanban of project
 * tasks that talks to the Host `/taskboard` routes and stays live over SSE.
 *
 * Tasks are attributed to a project (workspace path); the human creates and
 * manages them, and an agent processes a project's pending tasks via the
 * Host-side `task_board_*` tools (see the package's Host half).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { TaskBoardPage, type TaskBoardInjected, type WorkspaceListView } from './TaskBoardPage.tsx'
import { TaskBoardIcon } from './TaskBoardIcon.tsx'
import { en, NS, zh, type TaskBoardKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Task board copy. */
    'taskBoard': TaskBoardKey
  }
}

export type { TaskBoardPageProps, TaskBoardInjected } from './TaskBoardPage.tsx'

/** Stable main-panel id for the task board page. */
const PANEL_ID = 'taskBoard' as MainPanelId

/** Injected face as returned by the factory (before hooks are synthesized). */
interface TaskBoardInjectedRaw extends Omit<TaskBoardInjected, 'useWorkspaces'> {
  readonly hooks: { readonly workspaces: HostObservable<WorkspaceListView> }
}

/**
 * Required services: the slot registry and dictionaries, the layout that owns
 * the main-panel selection, and the workspace list for the project selector.
 */
export const inject = ['slots', 'locale', 'layout', 'workspaces']

/**
 * Client plugin body: register the dictionaries, the global task board page, and
 * the sidebar entry that selects it.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-task-board: dictionaries')
  const t = ctx.locale.bind(NS)

  // The global page body. Renders whenever the layout selects `taskBoard`.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: (): TaskBoardInjectedRaw => ({
      hooks: { workspaces: ctx.workspaces.list as unknown as HostObservable<WorkspaceListView> },
      // The current session's project is optional; the page falls back to the
      // project picker's first workspace.
      currentProject: undefined,
    }),
  }, TaskBoardPage))

  // Sidebar navigation row selecting the page.
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 6,
    locale: NS,
    label: () => t('panel.label'),
  }, TaskBoardIcon))
}
