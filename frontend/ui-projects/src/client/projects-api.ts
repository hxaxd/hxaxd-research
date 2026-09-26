/**
 * Workbench backend client and the project-creation orchestration.
 *
 * The plugin runs inside the DSH web origin and calls the workbench backend
 * cross-origin (the backend allow-lists the DSH loopback origins). Creation
 * is the one flow that spans both sides, in this exact order:
 *
 * 1. `POST /api/projects` — the backend allocates the managed directory and
 *    the registry row, idempotent per client request id;
 * 2. `workspaces.create({ path })` — the upstream workspace controller
 *    registers the directory as a DSH workspace (idempotent per canonical
 *    path) and `workspaces.rename` gives it the project name;
 * 3. `PATCH /api/projects/{id}/workspace` — the workspace id is bound back
 *    into the backend registry.
 *
 * Steps 2 and 3 are safe to retry; a failed bind leaves a working project
 * whose backend record just lacks the pointer, and the toast says so.
 */
import type {
  IWorkspaces, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'

/** One backend project record (wire shape: `backend/app/api/schemas.py`). */
export interface ProjectRecord {
  readonly id: string
  readonly name: string
  readonly directory: string
  readonly workspaceId: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

/** One material the backend accepted, after any same-name rename. */
export interface AddedMaterial {
  readonly name: string
  readonly size: number
}

const DEFAULT_BACKEND_BASE_URL = 'http://127.0.0.1:8642'
const BACKEND_OVERRIDE_STORAGE_KEY = 'hxaxd.backendBaseUrl'

/** The backend base URL: a localStorage override, else the local default. */
export function backendBaseUrl(): string {
  const override = typeof localStorage === 'undefined'
    ? null
    : localStorage.getItem(BACKEND_OVERRIDE_STORAGE_KEY)
  const clean = override?.trim()
  return clean !== undefined && clean !== '' ? clean : DEFAULT_BACKEND_BASE_URL
}

/** A backend call failed with a status; `message` carries the operator-facing detail. */
export class BackendError extends Error {
  override readonly name = 'BackendError'

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(`backend ${status}: ${message}`)
  }
}

/** Read the `detail` the backend puts on error responses, or the status text. */
async function backendFailure(response: Response): Promise<BackendError> {
  const body = await response.json().catch(() => undefined) as { detail?: unknown } | undefined
  const detail = typeof body?.detail === 'string' ? body.detail : response.statusText
  return new BackendError(response.status, detail)
}

async function requestJson<T>(
  path: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<T> {
  const requestInit: RequestInit = { ...init }
  if (init.body !== undefined) requestInit.headers = { 'Content-Type': 'application/json' }
  if (signal !== undefined) requestInit.signal = signal
  const response = await fetchImpl(`${backendBaseUrl()}${path}`, requestInit)
  if (!response.ok) throw await backendFailure(response)
  return response.json() as Promise<T>
}

/** Create the backend project record; the request id makes retries idempotent. */
export async function createProjectRecord(
  name: string,
  requestId: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ProjectRecord> {
  return requestJson<ProjectRecord>('/api/projects', {
    method: 'POST',
    body: JSON.stringify({ name, requestId }),
  }, fetchImpl, signal)
}

/** Bind the DSH workspace id onto the backend project record. */
export async function bindProjectWorkspace(
  projectId: string,
  workspaceId: string,
  fetchImpl: typeof fetch,
): Promise<ProjectRecord> {
  return requestJson<ProjectRecord>(
    `/api/projects/${encodeURIComponent(projectId)}/workspace`,
    { method: 'PATCH', body: JSON.stringify({ workspaceId }) },
    fetchImpl,
  )
}

/** List backend project records (used to resolve a directory to a project). */
export async function listProjects(
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<readonly ProjectRecord[]> {
  const payload = await requestJson<{ projects: readonly ProjectRecord[] }>(
    '/api/projects', { method: 'GET' }, fetchImpl, signal,
  )
  return payload.projects
}

/** Ask the backend to reveal a project folder in the system file manager. */
export async function revealProjectFolder(
  projectId: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(
    `${backendBaseUrl()}/api/projects/${encodeURIComponent(projectId)}/reveal`,
    { method: 'POST' },
  )
  if (!response.ok) throw await backendFailure(response)
}

/** Upload local materials into the project directory (auto-renamed on conflict). */
export async function addProjectMaterials(
  projectId: string,
  files: readonly File[],
  fetchImpl: typeof fetch,
): Promise<readonly AddedMaterial[]> {
  const form = new FormData()
  for (const file of files) form.append('files', file, file.name)
  const response = await fetchImpl(
    `${backendBaseUrl()}/api/projects/${encodeURIComponent(projectId)}/materials`,
    { method: 'POST', body: form },
  )
  if (!response.ok) throw await backendFailure(response)
  const payload = await response.json() as { materials: readonly AddedMaterial[] }
  return payload.materials
}

/** Creation ports for {@link createProjectWithWorkspace}; injectable for tests. */
export interface ProjectCreationPorts {
  readonly workspaces: Pick<IWorkspaces, 'create' | 'rename'>
  readonly fetchImpl: typeof fetch
}

/** The full create flow: backend record → upstream workspace → bind. */
export async function createProjectWithWorkspace(
  name: string,
  ports: ProjectCreationPorts,
): Promise<{ project: ProjectRecord; workspace: WorkspaceView }> {
  const requestId = crypto.randomUUID()
  const project = await createProjectRecord(name, requestId, ports.fetchImpl)
  const workspace = await ports.workspaces.create({ path: project.directory })
  // The workspace title defaults to the opaque directory name; the project
  // name is what the user typed. Display-only: a rename failure is non-fatal.
  try {
    await ports.workspaces.rename(workspace.workspaceId, name)
  } catch (reason: unknown) {
    console.warn('workspace rename rejected:', reason)
  }
  // A failed bind leaves a working project with an unbound record; the
  // caller decides how visibly to surface that.
  try {
    await bindProjectWorkspace(project.id, workspace.workspaceId, ports.fetchImpl)
  } catch (reason: unknown) {
    console.warn('workspace binding rejected:', reason)
    throw new WorkspaceBindError(workspace.workspaceId, reason)
  }
  return { project, workspace }
}

/** The create flow completed but the backend binding failed; the project works. */
export class WorkspaceBindError extends Error {
  override readonly name = 'WorkspaceBindError'

  constructor(
    /** The workspace the flow created; openable sessions can target it. */
    readonly workspaceId: WorkspaceId,
    reason: unknown,
  ) {
    super(reason instanceof Error ? reason.message : String(reason), { cause: reason })
  }
}
