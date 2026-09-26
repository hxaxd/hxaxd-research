/**
 * The English dictionary must cover the zh key set exactly: keys are added in
 * zh (the source of truth) and both dictionaries are registered together.
 */
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('locale dictionaries', () => {
  it('en covers the zh key set exactly', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('keeps the project flow keys present', () => {
    for (const key of [
      'project.new',
      'project.new.title',
      'project.name.label',
      'project.materials.add',
      'project.materials.added',
      'project.materials.failed',
      'project.reveal',
      'project.reveal.failed',
      'toast.projectBindFailed',
    ] as const) {
      expect(zh[key], key).toBeTruthy()
      expect(en[key], key).toBeTruthy()
    }
  })

  it('leaves no directory-picker copy behind', () => {
    const removed = ['folderError.title', 'folderError.retry', 'menu.addWorkspace', 'shortcut.noPicker', 'defaultWorkspace.failed']
    for (const key of removed) {
      expect(zh).not.toHaveProperty(key)
      expect(en).not.toHaveProperty(key)
    }
    expect(JSON.stringify(zh)).not.toContain('工作区')
  })
})
