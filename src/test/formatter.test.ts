import assert from 'node:assert'
import { describe, it } from 'node:test'
import { formatFileBlock, getCodeFence, getLanguage, isBinaryFile } from '../formatter'

describe('Formatter & Stack Helpers', () => {
  it('identifies binary files correctly', () => {
    assert.strictEqual(isBinaryFile('image.png'), true)
    assert.strictEqual(isBinaryFile('song.mp3'), true)
    assert.strictEqual(isBinaryFile('archive.zip'), true)
    assert.strictEqual(isBinaryFile('script.ts'), false)
    assert.strictEqual(isBinaryFile('README.md'), false)
  })

  it('resolves languages properly', () => {
    assert.strictEqual(getLanguage('main.py'), 'python')
    assert.strictEqual(getLanguage('app.tsx'), 'typescriptreact')
    assert.strictEqual(getLanguage('Cargo.toml'), 'toml')
    assert.strictEqual(getLanguage('unknown.xyz'), 'xyz')
    assert.strictEqual(getLanguage('noext'), 'plaintext')
  })

  it('calculates adaptive code fences correctly', () => {
    assert.strictEqual(getCodeFence('const a = 1;'), '```')
    assert.strictEqual(getCodeFence('```js\nconst a = 1;\n```'), '````')
    assert.strictEqual(getCodeFence('````markdown\n```\n````'), '`````')
  })

  it('formats whole file block properly', () => {
    const formatted = formatFileBlock('src/app.ts', 'typescript', 'console.log("hello");')
    assert.ok(formatted.startsWith('File: src/app.ts\n\n```typescript\n'))
    assert.ok(formatted.endsWith('```\n'))
  })

  it('formats snippet block with lineRange properly', () => {
    const formatted = formatFileBlock('src/app.ts', 'typescript', 'console.log("part");', 'lines 10-15')
    assert.ok(formatted.startsWith('File: src/app.ts (lines 10-15)\n\n```typescript\n'))
    assert.ok(formatted.endsWith('```\n'))
  })
})
