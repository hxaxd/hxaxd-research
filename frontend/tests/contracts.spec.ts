/**
 * Contract test: the handwritten API types must match the pinned OpenAPI
 * schema (`src/shared/api/openapi.json`), which the backend contract test
 * keeps identical to the live app. A failure here means the backend fields
 * and the frontend types drifted apart.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ProjectRecord } from '../src/shared/api/contracts.ts'

const schemaPath = fileURLToPath(new URL('../src/shared/api/openapi.json', import.meta.url))
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
  components: { schemas: Record<string, { properties: Record<string, unknown>; required?: string[] }> }
}

function fieldsOf(name: string): { required: string[]; optional: string[] } {
  const model = schema.components.schemas[name]
  expect(model, `schema component ${name} missing`).toBeDefined()
  const declared = Object.keys(model.properties)
  const required = model.required ?? []
  return {
    required: [...required].sort(),
    optional: declared.filter(field => !required.includes(field)).sort(),
  }
}

describe('pinned OpenAPI contract', () => {
  it('ProjectOut matches the handwritten ProjectRecord', () => {
    const { required, optional } = fieldsOf('ProjectOut')
    // workspaceId is nullable but always present on the wire.
    expect(required).toEqual(['createdAt', 'directory', 'id', 'name', 'updatedAt', 'workspaceId'])
    expect(optional).toEqual([])
    const record: ProjectRecord = {
      id: 'x', name: 'x', directory: 'x', workspaceId: null, createdAt: 'x', updatedAt: 'x',
    }
    // The handwritten type must have exactly those fields.
    expect(Object.keys(record).sort()).toEqual([...required, ...optional].sort())
  })

  it('create and bind requests match the handwritten requests', () => {
    expect(fieldsOf('CreateProjectRequest').required).toEqual(['name', 'requestId'])
    expect(fieldsOf('BindWorkspaceRequest').required).toEqual(['workspaceId'])
  })
})
