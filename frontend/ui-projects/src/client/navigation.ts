/** Workspace navigation and session-archive UI capability. */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  ISessions,
  SessionCreateError,
  SessionReference,
  SessionTarget,
  SessionListState,
} from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import type {
  IWorkspaces, WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { RowToast } from './contract/slots.ts'
import { pinOrderAccounts, pinOrderSource } from './pin-order.ts'
import type { WorkspaceViewStoreActions } from './stores.ts'

interface MainSelection {
  readonly sessionId?: SessionId
  readonly subagentAddress?: SubagentAddress
}

/** Workspace navigation and session-archive operations consumed by Client UI domains. */
export interface UiWorkspace {
  /**
   * Select a Session and show its Conversation as one UI navigation action.
   * @param target - known Session identity or durable direct-parent subagent address to display.
   */
  openSession(target: SessionTarget): void
  /**
   * Connect a Workspace and open its Session unless a later navigation supersedes it.
   * @param workspaceId - target Workspace.
   * @param beforeOpen - optional synchronous preparation for the selected Session,
   * skipped after supersession; a throw aborts the open and releases the retained reference.
   * @returns completion; a superseded request may create a Session but does not open it.
   * @throws on failure; a refused creation is also shown through the Workspace
   * notice unless a later navigation or disposal superseded the request.
   */
  openWorkspace(workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void>
  /**
   * Fork a Session without changing the current selection.
   * @param sessionId - source Session.
   * @returns completion after child creation and inherited-title increment.
   */
  forkSession(sessionId: SessionId): Promise<void>
  /**
   * Resolve the reusable or newly created blank Session for a Workspace.
   * @param workspaceId - target Workspace.
   * @returns a Session already addressable through the Session Controller.
   */
  connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId>
  /**
   * Start a New Session flow and navigate to its Session; a creation the Host
   * refuses is shown through the Workspace notice and leaves the selection as it was.
   * @param workspaceId - explicit target; absent inherits the current or most recent Workspace.
   */
  startSession(workspaceId?: WorkspaceId): void
  /**
   * Archive a Session and clear it when it is the current selection.
   * @param sessionId - Session to archive.
   * @param options - `stopActivity` asks the Host to stop the Session's running work instead of refusing.
   */
  archiveSession(sessionId: SessionId, options?: { readonly stopActivity?: boolean }): Promise<void>
  /**
   * Unarchive a Session, restoring it to its recorded Workspace position.
   * @param sessionId - Session to unarchive.
   */
  unarchiveSession(sessionId: SessionId): Promise<void>
  /**
   * Pin a Session on the Host, then lead it in its accounts' saved orders
   * (its Workspace group or Ungrouped, and the flat list). The order write
   * reads the memberships current at completion, so reorders that landed
   * while the Host call was pending keep their positions.
   * @param sessionId - Session to pin.
   */
  pinSession(sessionId: SessionId): Promise<void>
  /**
   * Unpin a Session on the Host; saved positions stay as they are.
   * @param sessionId - Session to unpin.
   */
  unpinSession(sessionId: SessionId): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-Controller Workspace navigation capability. */
    uiWorkspace: UiWorkspace
  }
}

/** Implements Workspace navigation and session-archive UI operations. */
class UiWorkspaceService extends Service implements UiWorkspace {
  private readonly connecting = new Map<WorkspaceId, Promise<SessionId>>()
  private readonly lifetime = new AbortController()
  private readonly selection = createSnapshotStore<MainSelection>(
    {}, { persist: { name: 'dsh.sessions.current' } },
  )
  private mainReference: SessionReference | undefined

  /**
   * @param ctx - Client root Context.
   * @param workspaces - pure Workspace Controller.
   * @param sessions - pure Session Controller.
   * @param view - the browser's viewing-store write set (one instance shared with its registration).
   * @param notify - show one notice through the Workspace notice channel.
   */
  constructor(
    ctx: Context,
    private readonly workspaces: IWorkspaces,
    private readonly sessions: ISessions,
    private readonly view: Pick<WorkspaceViewStoreActions, 'pinSessionOrder'>,
    private readonly notify: (toast: RowToast) => void,
  ) {
    super(ctx, 'uiWorkspace')
    ctx.effect(() => {
      const stop = this.watchNavigation()
      return () => {
        stop()
        this.lifetime.abort()
        const reference = this.mainReference
        this.mainReference = undefined
        reference?.release()
      }
    }, 'ui-workspace: Workspace navigation policy')
  }

  async connectWorkspace(workspaceId: WorkspaceId): Promise<SessionId> {
    const workspace = this.workspaces.list.getSnapshot().items
      .find(item => item.workspaceId === workspaceId)
    if (workspace === undefined) {
      throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`)
    }
    const inflight = this.connecting.get(workspaceId)
    if (inflight !== undefined) return inflight

    const attempt = this.reuseOrCreateBlank(workspace)
      .finally(() => { this.connecting.delete(workspaceId) })
    this.connecting.set(workspaceId, attempt)
    return attempt
  }

  private reuseOrCreateBlank(workspace: WorkspaceView): Promise<SessionId> {
    const archived = this.workspaces.list.getSnapshot().archivedSessionIds
    const sessions = this.sessions.list.getSnapshot()
    for (const id of sessions.ids) {
      const summary = sessions.byId[id]
      if (summary === undefined || !summary.blank || summary.cwd !== workspace.path
        || !workspace.sessionIds.includes(id) || archived.includes(id)) continue
      return this.reuseBlank(workspace.workspaceId, id)
    }
    return this.sessions.create({ workspaceId: workspace.workspaceId })
  }

  private async reuseBlank(workspaceId: WorkspaceId, sessionId: SessionId): Promise<SessionId> {
    try {
      return await this.sessions.create({ workspaceId, sessionId })
    } catch (error: unknown) {
      if (sessionCreateErrorOf(error)?.rpcError.code !== 'session/writer-held') throw error
      return this.sessions.create({ workspaceId })
    }
  }

  openSession(target: SessionTarget): void {
    this.replaceMain(target, this.lifetime.signal, 'reveal')
  }

  async openWorkspace(workspaceId: WorkspaceId, beforeOpen?: (sessionId: SessionId) => void): Promise<void> {
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    let sessionId: SessionId
    try {
      sessionId = await this.connectWorkspace(workspaceId)
    } catch (error: unknown) {
      // Reported here, not in connectWorkspace: startup restoration calls that
      // directly and stays console-only.
      if (!navigation.aborted) this.notify({ kind: 'createFailed', message: creationFailureMessage(error) })
      throw error
    }
    if (navigation.aborted) return
    this.replaceMain(sessionId, navigation, 'reveal', beforeOpen)
  }

  async forkSession(sessionId: SessionId): Promise<void> {
    await this.sessions.fork({ sessionId, increaseTitle: true })
  }

  startSession(workspaceId?: WorkspaceId): void {
    const workspace = this.workspaces.list.getSnapshot()
    const sessions = this.sessions.list.getSnapshot()
    const current = this.mainReference?.sessionId
    const currentWorkspaceId = current === undefined
      ? undefined
      : workspace.items.find(item => item.sessionIds.includes(current))?.workspaceId
    const recent = workspace.phase === 'ready' && sessions.phase === 'ready'
      ? recentWorkspace(workspace.items, sessions.byId)
      : undefined
    const target = workspaceId ?? currentWorkspaceId ?? recent
    if (target === undefined) {
      this.clearMain()
      return
    }
    void this.openWorkspace(target).catch(
      (reason: unknown) => { console.warn('new session failed:', reason) },
    )
  }

  async archiveSession(sessionId: SessionId, options: { readonly stopActivity?: boolean } = {}): Promise<void> {
    await this.workspaces.archiveSession(sessionId, options)
    if (this.mainReference?.sessionId === sessionId) this.clearMain()
  }

  async unarchiveSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.unarchiveSession(sessionId)
  }

  async pinSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.pinSession(sessionId)
    const { items, pinnedSessionIds, archivedSessionIds } = this.workspaces.list.getSnapshot()
    this.view.pinSessionOrder(
      sessionId,
      pinOrderAccounts(items, sessionId),
      pinOrderSource(items, this.sessions.list.getSnapshot(), { pinnedSessionIds, archivedSessionIds }),
    )
  }

  async unpinSession(sessionId: SessionId): Promise<void> {
    await this.workspaces.unpinSession(sessionId)
  }

  private watchNavigation(): () => void {
    let initial: 'waiting' | 'connecting' | 'done' = 'waiting'
    const reconcile = (): void => {
      if (this.lifetime.signal.aborted) return
      if (this.clearArchivedCurrent()) return
      if (initial !== 'waiting') return
      const workspace = this.workspaces.list.getSnapshot()
      const sessions = this.sessions.list.getSnapshot()
      if (workspace.phase !== 'ready' || sessions.phase !== 'ready') return
      if (this.mainReference !== undefined) {
        initial = 'done'
        return
      }
      initial = 'connecting'
      void this.restoreSelection(workspace, sessions).then(
        () => { initial = 'done' },
        (reason: unknown) => {
          if (this.lifetime.signal.aborted) return
          initial = 'waiting'
          console.warn('initial Session restoration failed:', reason)
        },
      )
    }

    const disposeWorkspaces = this.workspaces.list.subscribe(reconcile)
    const disposeSessions = this.sessions.list.subscribe(reconcile)
    reconcile()
    return () => {
      this.lifetime.abort()
      disposeSessions()
      disposeWorkspaces()
    }
  }

  private async restoreSelection(workspaces: WorkspaceSnapshot, sessions: SessionListState): Promise<void> {
    const saved = this.selection.getSnapshot()
    if (saved.subagentAddress !== undefined) {
      this.replaceMain(saved.subagentAddress, this.lifetime.signal, 'preserve')
      return
    }
    const summary = saved.sessionId === undefined ? undefined : sessions.byId[saved.sessionId]
    const workspace = summary === undefined ? undefined
      : workspaces.items.find(item => item.sessionIds.includes(summary.id))
    if (summary !== undefined && (!summary.blank || workspace === undefined)) {
      this.replaceMain(summary.id, this.lifetime.signal, 'preserve')
      return
    }
    const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal])
    let sessionId: SessionId | undefined
    if (summary !== undefined && workspace !== undefined && summary.cwd === workspace.path
      && !workspaces.archivedSessionIds.includes(summary.id)) {
      sessionId = await this.reuseBlank(workspace.workspaceId, summary.id)
    }
    const target = workspace?.workspaceId ?? recentWorkspace(workspaces.items, sessions.byId)
    // No default workspace creation: an empty workbench stays empty until the
    // user names a project, and the empty-state hero offers that.
    if (sessionId === undefined && target !== undefined) sessionId = await this.connectWorkspace(target)
    if (sessionId !== undefined && !navigation.aborted) {
      this.replaceMain(sessionId, navigation, 'preserve')
    }
  }

  /** @returns true when an archived current selection was cleared. */
  private clearArchivedCurrent(): boolean {
    const current = this.mainReference?.sessionId
    if (current === undefined
      || !this.workspaces.list.getSnapshot().archivedSessionIds.includes(current)) return false
    this.clearMain()
    return true
  }

  private clearMain(): void {
    const previous = this.mainReference
    this.mainReference = undefined
    this.selection.set({})
    previous?.release()
    this.ctx.layout.selectPanel(null)
  }

  private replaceMain(
    target: SessionTarget,
    signal: AbortSignal,
    panel: 'reveal' | 'preserve',
    beforeOpen?: (sessionId: SessionId) => void,
  ): void {
    signal.throwIfAborted()
    const reference = this.sessions.retain(target, { source: 'mainView' })
    try {
      signal.throwIfAborted()
      beforeOpen?.(reference.sessionId)
      if (signal.aborted) {
        reference.release()
        return
      }
      const subagentAddress = typeof target === 'string'
        ? this.sessions.subagentAddress(reference.sessionId)
        : target
      this.selection.set({
        sessionId: reference.sessionId,
        ...(subagentAddress === undefined ? {} : { subagentAddress }),
      })
    } catch (error: unknown) {
      reference.release()
      throw error
    }
    const previous = this.mainReference
    this.mainReference = reference
    previous?.release()
    if (panel === 'reveal') this.ctx.layout.selectPanel(null)
  }

}

/**
 * `error` as the Session Controller's creation failure, or undefined when it
 * is not one. Client plugin bundles do not share error-class identity, so the
 * name decides.
 */
function sessionCreateErrorOf(error: unknown): SessionCreateError | undefined {
  return error instanceof Error && error.name === 'SessionCreateError' ? error as SessionCreateError : undefined
}

/**
 * The words a failed Session creation is reported in: a Host refusal keeps its
 * stable code and message; any other failure keeps its own message.
 */
function creationFailureMessage(error: unknown): string {
  const refused = sessionCreateErrorOf(error)
  if (refused !== undefined) return `${refused.rpcError.code}: ${refused.rpcError.message}`
  return error instanceof Error ? error.message : String(error)
}

/** Stable tie-breaking follows Host Workspace order. */
function recentWorkspace(
  workspaces: readonly WorkspaceView[],
  sessions: SessionListState['byId'],
): WorkspaceId | undefined {
  let selected: WorkspaceId | undefined
  let selectedTime = Number.NEGATIVE_INFINITY
  for (const workspace of workspaces) {
    let latest = Number.NEGATIVE_INFINITY
    for (const sessionId of workspace.sessionIds) {
      const session = sessions[sessionId]
      if (session !== undefined) latest = Math.max(latest, session.updatedAt)
    }
    if (latest === Number.NEGATIVE_INFINITY) latest = Date.parse(workspace.createdAt)
    if (selected === undefined || latest > selectedTime) {
      selected = workspace.workspaceId
      selectedTime = latest
    }
  }
  return selected
}

export { UiWorkspaceService }
