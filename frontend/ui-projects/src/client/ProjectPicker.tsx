/**
 * Project picker for the conversation empty-state slot: a menu of existing
 * projects plus the new-project entry with its name dialog. Replaces the
 * upstream directory-picking flow — projects are created with a name, never
 * by choosing a folder (the backend allocates the directory).
 */
import { useCallback, useEffect, useState } from 'react'
import { Button, IconFolderCloseRegular, IconPlusOutlineRegular, Menu, Modal, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type { ProjectPickerProps } from './contract/slots.ts'
import css from './WorkspacePicker.module.css'

const NEW_PROJECT = '::new-project'

/** Props of the shared new-project dialog. */
export interface NewProjectDialogProps {
  /** The standard locale seat. */
  t: ProjectPickerProps['t']
  /** Dialog visibility. */
  open: boolean
  /** Create the backend record, the upstream workspace, and the binding. */
  createProject: (name: string) => Promise<WorkspaceId>
  /** A project is ready to open. */
  onCreated: (workspaceId: WorkspaceId) => void
  /** Report flow occupancy (a creation in flight) to the owner. */
  onBusyChange?: (busy: boolean) => void
  /** Close the dialog (outside click / Escape / post-creation). */
  onClose: () => void
}

/**
 * The name dialog one project creation runs through. A real failure (backend
 * unreachable, workspace refused) lands back in the dialog so the draft
 * survives; a failed binding resolves normally and is surfaced as a notice,
 * because the project itself works.
 */
export function NewProjectDialog({
  t, open, createProject, onCreated, onBusyChange, onClose,
}: NewProjectDialogProps) {
  const [draft, setDraft] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = draft.trim()
  const close = useCallback(() => {
    if (creating) return
    onClose()
  }, [creating, onClose])
  useEffect(() => { onBusyChange?.(creating) }, [creating, onBusyChange])
  useEffect(() => {
    if (!open) {
      setDraft('')
      setError(null)
      setCreating(false)
    }
  }, [open])
  const confirm = (): void => {
    if (creating || trimmed === '') return
    setCreating(true)
    setError(null)
    createProject(trimmed).then((workspaceId) => {
      setCreating(false)
      onClose()
      onCreated(workspaceId)
    }).catch((reason: unknown) => {
      setCreating(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <Modal
      open={open}
      onClose={close}
      closeLabel={t('close')}
      title={t('project.new.title')}
      footer={(
        <>
          <Button variant="outline" disabled={creating} onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" disabled={creating || trimmed === ''} onClick={confirm}>{t('project.new.confirm')}</Button>
        </>
      )}
    >
      <input
        className={css.nameInput}
        value={draft}
        aria-label={t('project.name.label')}
        placeholder={t('project.name.placeholder')}
        maxLength={120}
        data-modal-autofocus
        disabled={creating}
        onFocus={(e) => { e.target.select() }}
        onChange={(e) => { setDraft(e.target.value); setError(null) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault()
            confirm()
          }
        }}
      />
      {creating && <div className={css.menuStatus} role="status">{t('project.create.pending')}</div>}
      {error !== null && <div className={css.modalError} role="alert">{error}</div>}
    </Modal>
  )
}

/**
 * The conversation empty-state registration: lists existing projects and the
 * new-project entry; picking an existing project reports it through `onPick`.
 * @param props - empty-state slot props (owner share + injected creation callback).
 * @returns the picker element.
 */
export function ProjectPicker({
  open,
  anchorRef,
  useWorkspaces,
  selectedId,
  onPick,
  onClose,
  createProject,
  t,
}: ProjectPickerProps) {
  const workspaceSnapshot = useWorkspaces(state => state)
  const workspaces = workspaceSnapshot.items
  const getAnchorRect = useCallback(
    () => anchorRef?.current?.getBoundingClientRect() ?? null,
    [anchorRef],
  )
  const [dialogOpen, setDialogOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    if (!open) setDialogOpen(false)
  }, [open])

  const projectEntries: MenuEntry[] = workspaces.map(workspace => ({
    id: workspace.workspaceId,
    label: workspaceDisplayTitle(workspace.title, t('workspace.defaultName')),
    icon: <IconFolderCloseRegular size={16} />,
    disabled: creating,
  }))
  const newEntry: MenuEntry = {
    id: NEW_PROJECT,
    label: t('project.new'),
    icon: <IconPlusOutlineRegular size={16} />,
    disabled: creating,
  }
  const handleSelect = (id: string): void => {
    if (id === NEW_PROJECT) {
      setDialogOpen(true)
      return
    }
    onPick(id as WorkspaceId)
  }
  const createAndOpen = async (name: string): Promise<WorkspaceId> => {
    setCreating(true)
    try {
      return await createProject(name)
    } finally {
      setCreating(false)
    }
  }
  return (
    <>
      <Menu
        open={open && !dialogOpen}
        anchor={null}
        items={[...projectEntries, newEntry]}
        selectedId={selectedId}
        onSelect={handleSelect}
        onClose={onClose}
        side="bottom"
        portal
        getAnchorRect={getAnchorRect}
      />
      {open && !dialogOpen && projectEntries.length === 0 && workspaceSnapshot.phase === 'pending'
        && <div className={css.menuStatus} role="status">{t('picker.loading')}</div>}
      <NewProjectDialog
        t={t}
        open={dialogOpen}
        createProject={createAndOpen}
        onCreated={(workspaceId) => {
          setDialogOpen(false)
          onClose()
          onPick(workspaceId)
        }}
        onClose={() => { setDialogOpen(false) }}
      />
    </>
  )
}
