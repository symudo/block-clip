import assert from 'node:assert'
import { describe, it } from 'node:test'
import {
  DEFAULT_MAX_CONTENT_SIZE_MB,
  estimateTokens,
  formatBytes,
  formatFileBlock,
  formatLineRange,
  formatStats,
  getCodeFence,
  getLanguage,
  isBinaryBuffer,
  isBinaryFile,
  isSensitiveFile,
  normalizePathKey,
  resolveMaxContentLength,
  sanitizeForClipboard
} from '../formatter'

describe('Formatter & Helpers', () => {
  it('identifies binary files by extension and by NUL bytes in content', () => {
    assert.strictEqual(isBinaryFile('image.png'), true)
    assert.strictEqual(isBinaryFile('data.sqlite'), true)
    assert.strictEqual(isBinaryFile('cache.db'), true)
    assert.strictEqual(isBinaryFile('script.ts'), false)
    assert.strictEqual(isBinaryFile('README.md'), false)

    // 模拟 SQLite 或无后缀插件数据文件（前 8KB 含 0x00 空字节）
    assert.strictEqual(isBinaryBuffer(Buffer.from('SQLite format 3\u0000more')), true)
    assert.strictEqual(isBinaryBuffer(new Uint8Array([0x41, 0x42, 0x00, 0x43])), true)
    assert.strictEqual(isBinaryBuffer(Buffer.from('export const msg = "你好世界";\n', 'utf8')), false)

    // 剪贴板写入兜底清洗 NUL
    assert.strictEqual(sanitizeForClipboard('abc\u0000def\u0000ghi'), 'abcdefghi')
    assert.strictEqual(sanitizeForClipboard('clean text'), 'clean text')
  })

  it('identifies sensitive files while allowing safe env templates', () => {
    assert.strictEqual(isSensitiveFile('/proj/.env'), true)
    assert.strictEqual(isSensitiveFile('/proj/.env.local'), true)
    assert.strictEqual(isSensitiveFile('/proj/.env.production'), true)
    assert.strictEqual(isSensitiveFile('/proj/cert/server.pem'), true)
    assert.strictEqual(isSensitiveFile('/proj/private.key'), true)
    assert.strictEqual(isSensitiveFile('/home/.ssh/id_rsa'), true)

    assert.strictEqual(isSensitiveFile('/proj/.env.example'), false)
    assert.strictEqual(isSensitiveFile('/proj/.env.sample'), false)
    assert.strictEqual(isSensitiveFile('/proj/.env.template'), false)
    assert.strictEqual(isSensitiveFile('/proj/.env.dist'), false)
    assert.strictEqual(isSensitiveFile('/proj/src/env.ts'), false)
  })

  it('resolves languages properly including extensionless filenames', () => {
    assert.strictEqual(getLanguage('main.py'), 'python')
    assert.strictEqual(getLanguage('app.tsx'), 'typescriptreact')
    assert.strictEqual(getLanguage('Cargo.toml'), 'toml')
    assert.strictEqual(getLanguage('unknown.xyz'), 'xyz')
    assert.strictEqual(getLanguage('noext'), 'plaintext')
    assert.strictEqual(getLanguage('file.txt', 'typescript'), 'typescript')

    // 无扩展名特殊文件名
    assert.strictEqual(getLanguage('/proj/Dockerfile'), 'dockerfile')
    assert.strictEqual(getLanguage('/proj/Dockerfile.prod'), 'dockerfile')
    assert.strictEqual(getLanguage('/proj/Makefile'), 'makefile')
    assert.strictEqual(getLanguage('/proj/CMakeLists.txt'), 'cmake')
  })

  it('normalizes path keys for cross-case comparison', () => {
    assert.strictEqual(normalizePathKey('D:\\Repo\\Src\\App.ts', true), 'd:/repo/src/app.ts')
    assert.strictEqual(normalizePathKey('d:/Repo/Src/App.ts', true), 'd:/repo/src/app.ts')
    assert.strictEqual(normalizePathKey('/repo/Src/App.ts', false), '/repo/Src/App.ts')
  })

  it('calculates adaptive code fences correctly', () => {
    assert.strictEqual(getCodeFence('const a = 1;'), '```')
    assert.strictEqual(getCodeFence('```js\nconst a = 1;\n```'), '````')
    assert.strictEqual(getCodeFence('````markdown\n```\n````'), '`````')
  })

  it('formats line ranges and fixes trailing-newline off-by-one', () => {
    assert.strictEqual(formatLineRange(0, 0, 10), 'line 1')
    assert.strictEqual(formatLineRange(9, 14, 5), 'lines 10-15')
    assert.strictEqual(formatLineRange(9, 15, 0), 'lines 10-15')
    assert.strictEqual(formatLineRange(9, 10, 0), 'line 10')
  })

  it('estimates tokens and formats size stats accurately', () => {
    assert.strictEqual(estimateTokens(''), 0)
    assert.strictEqual(estimateTokens('abcd'), 1)
    assert.strictEqual(estimateTokens('a'.repeat(400)), 100)
    assert.ok(estimateTokens('你好世界测试代码') >= 5)

    assert.strictEqual(formatBytes(512), '512 B')
    assert.strictEqual(formatBytes(2048), '2.0 KB')
    assert.strictEqual(formatBytes(2 * 1024 * 1024), '2.00 MB')

    const stats = formatStats('console.log("hello world");')
    assert.match(stats, /\d+(\.\d+)? (B|KB|MB), ~\d+(\.\d+k)? tokens/)
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

  it('resolves custom max content size in MB including unlimited (0) and invalid values', () => {
    assert.strictEqual(resolveMaxContentLength(50), 50 * 1024 * 1024)
    assert.strictEqual(resolveMaxContentLength(100), 100 * 1024 * 1024)
    assert.strictEqual(resolveMaxContentLength(0), Number.MAX_SAFE_INTEGER)
    assert.strictEqual(resolveMaxContentLength(-5), Number.MAX_SAFE_INTEGER)
    assert.strictEqual(resolveMaxContentLength(Number.NaN), DEFAULT_MAX_CONTENT_SIZE_MB * 1024 * 1024)
  })
})
