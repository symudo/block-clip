import * as path from 'node:path'

export const MAX_CONTENT_LENGTH = 15 * 1024 * 1024 // 15MB

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

export function isBinaryFile(filePath: string): boolean {
  const extension = path.extname(filePath).substring(1).toLowerCase()
  return binaryFileExtensions.has(extension)
}

export function getLanguage(filePath: string, knownLanguageId?: string): string {
  if (knownLanguageId && knownLanguageId !== 'plaintext') {
    return knownLanguageId
  }
  const extension = path.extname(filePath).substring(1).toLowerCase()
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

export function formatFileBlock(relativePath: string, language: string, content: string, lineRange?: string): string {
  const header = lineRange ? `File: ${relativePath} (${lineRange})` : `File: ${relativePath}`
  const fence = getCodeFence(content)
  return `${header}\n\n${fence}${language}\n${content}\n${fence}\n`
}
