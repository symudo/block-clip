import assert from 'node:assert'
import { describe, it } from 'node:test'
import { ClipStackStore } from '../clipStackStore'

describe('ClipStackStore', () => {
  it('deduplicates whole files while allowing multiple snippets from the same file', () => {
    const store = new ClipStackStore()

    store.addItem({
      id: '/proj/a.ts',
      fsPath: '/proj/a.ts',
      relativePath: 'a.ts',
      language: 'typescript',
      isSnippet: false,
      previewText: 'Whole file',
      addedAt: 1
    })
    store.addItem({
      id: '/proj/a.ts',
      fsPath: '/proj/a.ts',
      relativePath: 'a.ts',
      language: 'typescript',
      isSnippet: false,
      previewText: 'Whole file updated',
      addedAt: 2
    })
    assert.strictEqual(store.count(), 1)
    assert.strictEqual(store.getItems()[0].addedAt, 2)

    store.addItem({
      id: '/proj/a.ts#1',
      fsPath: '/proj/a.ts',
      relativePath: 'a.ts',
      language: 'typescript',
      isSnippet: true,
      lineRange: 'lines 1-5',
      snippetContent: 'const x = 1;',
      previewText: 'const x = 1;',
      addedAt: 3
    })
    store.addItem({
      id: '/proj/a.ts#2',
      fsPath: '/proj/a.ts',
      relativePath: 'a.ts',
      language: 'typescript',
      isSnippet: true,
      lineRange: 'lines 20-30',
      snippetContent: 'const y = 2;',
      previewText: 'const y = 2;',
      addedAt: 4
    })
    assert.strictEqual(store.count(), 3)
  })

  it('supports LIFO pop, removeById, removeByPath, and clear', () => {
    const store = new ClipStackStore()
    store.addItem({
      id: '1',
      fsPath: '/proj/a.ts',
      relativePath: 'a.ts',
      language: 'typescript',
      isSnippet: true,
      lineRange: 'line 1',
      snippetContent: 'a1',
      previewText: 'a1',
      addedAt: 1
    })
    store.addItem({
      id: '2',
      fsPath: '/proj/a.ts',
      relativePath: 'a.ts',
      language: 'typescript',
      isSnippet: true,
      lineRange: 'line 2',
      snippetContent: 'a2',
      previewText: 'a2',
      addedAt: 2
    })
    store.addItem({
      id: '3',
      fsPath: '/proj/b.ts',
      relativePath: 'b.ts',
      language: 'typescript',
      isSnippet: false,
      previewText: 'b',
      addedAt: 3
    })

    const popped = store.popItem()
    assert.strictEqual(popped?.id, '3')
    assert.strictEqual(store.count(), 2)

    assert.strictEqual(store.removeById('1'), true)
    assert.strictEqual(store.removeById('non-existent'), false)
    assert.strictEqual(store.count(), 1)

    assert.strictEqual(store.removeByPath('/proj/a.ts'), 1)
    assert.strictEqual(store.count(), 0)

    store.addItem({
      id: '4',
      fsPath: '/proj/c.ts',
      relativePath: 'c.ts',
      language: 'typescript',
      isSnippet: false,
      previewText: 'c',
      addedAt: 4
    })
    store.clear()
    assert.strictEqual(store.count(), 0)
  })

  it('skips missing deleted files without emitting fake empty code blocks', async () => {
    const store = new ClipStackStore()
    store.addItem({
      id: 'deleted',
      fsPath: '/proj/deleted.ts',
      relativePath: 'deleted.ts',
      language: 'typescript',
      isSnippet: false,
      previewText: 'Whole file',
      addedAt: 1
    })
    store.addItem({
      id: 'alive',
      fsPath: '/proj/alive.ts',
      relativePath: 'alive.ts',
      language: 'typescript',
      isSnippet: false,
      previewText: 'Whole file',
      addedAt: 2
    })

    const res = await store.formatAll(async (item) => {
      if (item.fsPath.includes('deleted')) {
        return { status: 'missing' }
      }
      return { status: 'ok', content: 'export const ok = true;' }
    })

    assert.strictEqual(res.processedCount, 1)
    assert.strictEqual(res.skippedMissingCount, 1)
    assert.strictEqual(res.stoppedEarly, false)
    assert.ok(!res.content.includes('deleted.ts'))
    assert.ok(res.content.includes('alive.ts'))
  })

  it('handles oversized files via pre-check and never reports false success when first item exceeds limit', async () => {
    const store = new ClipStackStore()
    store.addItem({
      id: 'huge',
      fsPath: '/proj/huge.sql',
      relativePath: 'huge.sql',
      language: 'sql',
      isSnippet: false,
      previewText: 'Whole file',
      addedAt: 1
    })

    const res = await store.formatAll(async () => ({ status: 'too_large' }), 100)
    assert.strictEqual(res.processedCount, 0)
    assert.strictEqual(res.stoppedEarly, true)
    assert.strictEqual(res.content, '')
  })

  it('formats mixed files and snippets and respects max length limit', async () => {
    const store = new ClipStackStore()
    store.addItem({
      id: '1',
      fsPath: '/proj/a.ts',
      relativePath: 'a.ts',
      language: 'typescript',
      isSnippet: false,
      previewText: 'a',
      addedAt: 1
    })
    store.addItem({
      id: '2',
      fsPath: '/proj/a.ts#s1',
      relativePath: 'a.ts',
      language: 'typescript',
      isSnippet: true,
      lineRange: 'lines 10-12',
      snippetContent: 'return true;',
      previewText: 'return true;',
      addedAt: 2
    })
    store.addItem({
      id: '3',
      fsPath: '/proj/logo.png',
      relativePath: 'logo.png',
      language: 'plaintext',
      isSnippet: false,
      previewText: 'logo',
      addedAt: 3
    })

    const res = await store.formatAll(async () => ({ status: 'ok', content: 'export const a = 1;' }))
    assert.strictEqual(res.processedCount, 3)
    assert.strictEqual(res.stoppedEarly, false)
    assert.ok(res.content.includes('File: a.ts\n\n```typescript\nexport const a = 1;\n```'))
    assert.ok(res.content.includes('File: a.ts (lines 10-12)\n\n```typescript\nreturn true;\n```'))
    assert.ok(res.content.includes('File: logo.png\n'))

    const truncated = await store.formatAll(async () => ({ status: 'ok', content: 'export const a = 1;' }), 60)
    assert.strictEqual(truncated.stoppedEarly, true)
    assert.strictEqual(truncated.processedCount, 1)
  })
})
