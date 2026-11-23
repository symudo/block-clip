import * as path from 'node:path'

export const DEFAULT_MAX_CONTENT_SIZE_MB = 50
export const MAX_CONTENT_LENGTH = DEFAULT_MAX_CONTENT_SIZE_MB * 1024 * 1024

/**
 * 将用户配置的 MB 上限换算为最大字符/字节数。
 * 0 或负数表示无限制（Number.MAX_SAFE_INTEGER）；非有限数字回退默认值。
 */
export function resolveMaxContentLength(sizeMB: number): number {
  if (!Number.isFinite(sizeMB)) {
    return MAX_CONTENT_LENGTH
  }
  if (sizeMB <= 0) {
    return Number.MAX_SAFE_INTEGER
  }
  return Math.floor(sizeMB * 1024 * 1024)
}

export const binaryFileExtensions = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'ico',
  'bmp',
  'svg',
  'mp3',
  'wav',
  'ogg',
  'flac',
  'mp4',
  'webm',
  'mkv',
  'avi',
  'mov',
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'zip',
  'rar',
  '7z',
  'gz',
  'tar',
  'bz2',
  'exe',
  'dll',
  'so',
  'dylib',
  'app',
  'dmg',
  'class',
  'jar',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'lockb',
  'ds_store'
])

const sensitiveExtensions = new Set(['pem', 'key', 'p12', 'pfx', 'jks', 'keystore'])

const sensitiveExactNames = new Set(['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', '.npmrc', '.pypirc', '.netrc'])

const safeEnvSuffixes = ['.example', '.sample', '.template', '.dist']

const fileNameToLanguageMap: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  gemfile: 'ruby',
  rakefile: 'ruby',
  vagrantfile: 'ruby',
  jenkinsfile: 'groovy',
  justfile: 'just'
}

export const extensionToLanguageMap: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  jsx: 'javascriptreact',
  tsx: 'typescriptreact',
  py: 'python',
  rs: 'rust',
  rb: 'ruby',
  cs: 'csharp',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  json: 'json',
  jsonc: 'jsonc',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  vue: 'vue',
  svelte: 'svelte',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  cpp: 'cpp',
  c: 'c',
  h: 'c',
  hpp: 'cpp',
  sql: 'sql',
  md: 'markdown',
  xml: 'xml',
  toml: 'toml',
  dockerfile: 'dockerfile'
}

/**
 * 归一化路径用于相等性比较（在 Windows 上兼容盘符及大小写差异）。
 */
export function normalizePathKey(filePath: string, isCaseInsensitive: boolean = process.platform === 'win32'): string {
  const normalized = filePath.replace(/\\/g, '/')
  return isCaseInsensitive ? normalized.toLowerCase() : normalized
}

export function isBinaryFile(filePath: string): boolean {
  const extension = path.extname(filePath).substring(1).toLowerCase()
  return binaryFileExtensions.has(extension)
}

/**
 * 判断是否为常见敏感文件（如 .env、密钥证书等）。
 * 保留 .env.example / .env.sample / .env.template / .env.dist 模板文件。
 */
export function isSensitiveFile(filePath: string): boolean {
  const baseName = path.basename(filePath).toLowerCase()

  if (sensitiveExactNames.has(baseName)) {
    return true
  }

  if (baseName === '.env' || baseName.startsWith('.env.')) {
    return !safeEnvSuffixes.some((suffix) => baseName.endsWith(suffix))
  }

  const extension = path.extname(baseName).substring(1)
  return sensitiveExtensions.has(extension)
}

export function getLanguage(filePath: string, knownLanguageId?: string): string {
  if (knownLanguageId && knownLanguageId !== 'plaintext') {
    return knownLanguageId
  }

  const baseName = path.basename(filePath).toLowerCase()
  if (fileNameToLanguageMap[baseName]) {
    return fileNameToLanguageMap[baseName]
  }
  if (baseName.startsWith('dockerfile.')) {
    return 'dockerfile'
  }

  const extension = path.extname(baseName).substring(1)
  if (extension) {
    return extensionToLanguageMap[extension] || extension
  }
  return 'plaintext'
}

export function getCodeFence(content: string): string {
  const matches = content.match(/`{3,}/g)
  if (!matches) {
    return '```'
  }
  let maxBackticks = 3
  for (const match of matches) {
    if (match.length >= maxBackticks) {
      maxBackticks = match.length + 1
    }
  }
  return '`'.repeat(maxBackticks)
}

/**
 * 计算人类可读的行号范围（1-based），自动修正跨行选区停在下一行行首导致的 Off-by-one 问题。
 */
export function formatLineRange(startLineZeroBased: number, endLineZeroBased: number, endCharacter: number): string {
  const startLine = startLineZeroBased + 1
  let endLine = endLineZeroBased + 1
  if (endLineZeroBased > startLineZeroBased && endCharacter === 0) {
    endLine -= 1
  }
  if (endLine < startLine) {
    endLine = startLine
  }
  return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`
}

/**
 * 轻量级 Token 粗略估算（零外部依赖）：
 * ASCII 约 4 字符 ≈ 1 token，非 ASCII（如中日韩文字）约 1.5 字符 ≈ 1 token。
 */
export function estimateTokens(text: string): number {
  if (!text) {
    return 0
  }
  let asciiCount = 0
  let nonAsciiCount = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) <= 0x7f) {
      asciiCount++
    } else {
      nonAsciiCount++
    }
  }
  return Math.max(1, Math.ceil(asciiCount / 4 + nonAsciiCount / 1.5))
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) {
    return `~${(tokens / 1000).toFixed(1)}k tokens`
  }
  return `~${tokens} tokens`
}

export function formatStats(text: string): string {
  const byteSize = Buffer.byteLength(text, 'utf8')
  const tokens = estimateTokens(text)
  return `${formatBytes(byteSize)}, ${formatTokenCount(tokens)}`
}

export function formatFileBlock(relativePath: string, language: string, content: string, lineRange?: string): string {
  const header = lineRange ? `File: ${relativePath} (${lineRange})` : `File: ${relativePath}`
  const fence = getCodeFence(content)
  return `${header}\n\n${fence}${language}\n${content}\n${fence}\n`
}
