/**
 * Unit tests for the project-creation orchestration and the backend client:
 * idempotent creation flow, binding-failure semantics, and error surfacing.
 * The backend and the workspace controller are fakes; the fetch adapter is
 * injected.
 */
import { describe, expect, it } from 'vitest'
import {
  BackendError, WorkspaceBindError, backendBaseUrl, createProjectWithWorkspace,
} from '../src/client/projects-api.ts'
import type { ProjectRecord } from '../src/shared/api/contracts.ts'

const PROJECT: ProjectRecord = {
  id: 'abc',
  name: '论文阅读',
  directory: '/data/projects/abc',
  workspaceId: null,
  createdAt: '2026-09-26T00:00:00Z',
  updatedAt: '2026-09-26T00:00:00Z',
}

/** Fake fetch answering the two backend routes the creation flow uses. */
function fakeFetch(handlers: {
  create?: (body: { name: string; requestId: string }) => Response
  bind?: (projectId: string, body: { workspaceId: string }) => Response
}): typeof fetch {
  return (async (input, init) => {
    const url = String(input)
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body))
    if (url.endsWith('/api/projects') && init?.method === 'POST') {
      return handlers.create?.(body) ?? Response.json(PROJECT)
    }
    const bindMatch = /\/api\/projects\/[^/]+\/workspace$/u.exec(url)
    if (bindMatch !== null) {
      return handlers.bind?.(body.workspaceId) ?? Response.json(PROJECT)
    }
    return Response.json({ detail: 'not found' }, { status: 404 })
  }) as typeof fetch
}

function fakeWorkspaces(renameError?: Error) {
  const calls: { path?: string; title?: string }[] = []
  return {
    calls,
    async create(input: { path: string }) {
      calls.push(input)
      return { workspaceId: 'w-1', path: input.path, title: 'abc', sessionIds: [], createdAt: '', updatedAt: '' }
    },
    async rename(_id: string, title: string) {
      calls.push({ title })
      if (renameError !== undefined) throw renameError
    },
  }
}

describe('createProjectWithWorkspace', () => {
  it('creates the record, registers and renames the workspace, then binds', async () => {
    const workspaces = fakeWorkspaces()
    const { project, workspace } = await createProjectWithWorkspace('论文阅读', {
      workspaces,
      fetchImpl: fakeFetch({
        bind: workspaceId => Response.json({ ...PROJECT, workspaceId }),
      }),
    })

    expect(project.directory).toBe('/data/projects/abc')
    expect(workspace.workspaceId).toBe('w-1')
    expect(workspaces.calls).toEqual([
      { path: '/data/projects/abc' },
      { title: '论文阅读' },
    ])
  })

  it('throws WorkspaceBindError carrying the workspace id when only the binding failed', async () => {
    const workspaces = fakeWorkspaces()
    const error = await createProjectWithWorkspace('论文阅读', {
      workspaces,
      fetchImpl: fakeFetch({ bind: () => Response.json({ detail: 'nope' }, { status: 409 }) }),
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(WorkspaceBindError)
    expect((error as WorkspaceBindError).workspaceId).toBe('w-1')
  })

  it('propagates backend failures of the record creation with their detail', async () => {
    const error = await createProjectWithWorkspace('论文阅读', {
      workspaces: fakeWorkspaces(),
      fetchImpl: fakeFetch({
        create: () => Response.json({ detail: '项目目录已存在且非空' }, { status: 409 }),
      }),
    }).catch((reason: unknown) => reason)

    expect(error).toBeInstanceOf(BackendError)
    expect((error as BackendError).message).toContain('项目目录已存在且非空')
  })

  it('continues after a refused workspace rename (display-only)', async () => {
    const result = await createProjectWithWorkspace('论文阅读', {
      workspaces: fakeWorkspaces(new Error('rename refused')),
      fetchImpl: fakeFetch({}),
    })
    expect(result.workspace.workspaceId).toBe('w-1')
  })
})

describe('backendBaseUrl', () => {
  it('defaults to the local workbench backend', () => {
    expect(backendBaseUrl()).toBe('http://127.0.0.1:8642')
  })
})
