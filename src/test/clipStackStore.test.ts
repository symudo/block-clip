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

    const [content, count, stoppedEarly] = await store.formatAll(async () => 'export const a = 1;')
    assert.strictEqual(count, 3)
    assert.strictEqual(stoppedEarly, false)
    assert.ok(content.includes('File: a.ts\n\n```typescript\nexport const a = 1;\n```'))
    assert.ok(content.includes('File: a.ts (lines 10-12)\n\n```typescript\nreturn true;\n```'))
    assert.ok(content.includes('File: logo.png\n'))

    // 测试上限截断
    const [, truncatedCount, wasStopped] = await store.formatAll(async () => 'export const a = 1;', 60)
    assert.strictEqual(wasStopped, true)
    assert.strictEqual(truncatedCount, 1)
  })
})
