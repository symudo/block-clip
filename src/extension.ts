import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import ignore from 'ignore'
import * as vscode from 'vscode'
import { ClipStackManager } from './clipStack'
import {
  DEFAULT_MAX_CONTENT_SIZE_MB,
  formatFileBlock,
  formatLineRange,
  formatStats,
  getLanguage,
  isBinaryBuffer,
  isBinaryFile,
  isSensitiveFile,
  normalizePathKey,
  resolveMaxContentLength,
  sanitizeForClipboard
} from './formatter'

interface ScopedIgnore {
  baseDir: string
  ig: ReturnType<typeof ignore>
}

interface ProcessUrisResult {
  content: string
  processedCount: number
  stoppedEarly: boolean
  skippedMissingCount: number
  firstProcessedPath?: string
  cancelled?: boolean
}

type ProgressReporter = vscode.Progress<{ message?: string; increment?: number }>

const DEFAULT_IGNORES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.vscode',
  '.idea',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
  '.DS_Store'
]

function getMaxContentConfig(): { sizeMB: number; maxLength: number } {
  const raw = vscode.workspace
    .getConfiguration('blockClip')
    .get<number>('maxContentSizeMB', DEFAULT_MAX_CONTENT_SIZE_MB)
  const sizeMB = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MAX_CONTENT_SIZE_MB
  return { sizeMB, maxLength: resolveMaxContentLength(sizeMB) }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function getRelativePath(uri: vscode.Uri, workspaceFolder?: vscode.WorkspaceFolder): string {
  if (uri.scheme === 'untitled') {
    return path.basename(uri.path) || uri.toString()
  }
  const folder = workspaceFolder ?? vscode.workspace.getWorkspaceFolder(uri)
  return folder ? path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/') : path.basename(uri.fsPath)
}

async function readGitIgnoreScope(dirUri: vscode.Uri, includeDefaults = false): Promise<ScopedIgnore | null> {
  const ig = ignore()
  let hasRules = false

  if (includeDefaults) {
    ig.add(DEFAULT_IGNORES)
    hasRules = true

    // 尊重 VS Code 侧边栏资源管理器隐藏规则（files.exclude），逐条加载防止单条异常模式拖垮整组规则
    try {
      const filesExclude = vscode.workspace.getConfiguration('files', dirUri).get<Record<string, boolean>>('exclude')
      if (filesExclude && typeof filesExclude === 'object') {
        for (const [rawPattern, enabled] of Object.entries(filesExclude)) {
          if (enabled !== true) continue
          const pattern = rawPattern.trim()
          if (pattern.length === 0 || pattern.startsWith('!')) continue
          try {
            ig.add(pattern)
          } catch {
            // 忽略 ignore 库不识别的特殊 glob 模式
          }
        }
      }
    } catch {
      // 忽略配置读取异常
    }

    // 同步读取 .git/info/exclude（本地私有忽略规则）
    try {
      const gitExcludeUri = vscode.Uri.joinPath(dirUri, '.git', 'info', 'exclude')
      const bytes = await vscode.workspace.fs.readFile(gitExcludeUri)
      ig.add(Buffer.from(bytes).toString('utf8'))
    } catch {
      // 无 .git/info/exclude 时静默处理
    }
  }

  try {
    const gitignoreUri = vscode.Uri.joinPath(dirUri, '.gitignore')
    const bytes = await vscode.workspace.fs.readFile(gitignoreUri)
    ig.add(Buffer.from(bytes).toString('utf8'))
    hasRules = true
  } catch {
    // 无 .gitignore 时静默处理
  }

  return hasRules ? { baseDir: dirUri.fsPath, ig } : null
}

function isIgnoredByScopes(entryFsPath: string, isDirectory: boolean, scopes: ScopedIgnore[]): boolean {
  for (const scope of scopes) {
    const rel = path.relative(scope.baseDir, entryFsPath).replace(/\\/g, '/')
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      continue
    }
    const candidate = isDirectory ? `${rel}/` : rel
    if (scope.ig.ignores(candidate)) {
      return true
    }
  }
  return false
}

async function getAllFileUris(
  directoryUri: vscode.Uri,
  scopes: ScopedIgnore[],
  visitedRealDirs: Set<string>,
  onFileFound?: (totalFound: number) => void,
  token?: vscode.CancellationToken,
  counter: { count: number } = { count: 0 }
): Promise<vscode.Uri[]> {
  if (token?.isCancellationRequested) {
    return []
  }

  try {
    const realDir = normalizePathKey(await fs.realpath(directoryUri.fsPath))
    if (visitedRealDirs.has(realDir)) {
      return []
    }
    visitedRealDirs.add(realDir)
  } catch {
    const fallbackKey = normalizePathKey(directoryUri.fsPath)
    if (visitedRealDirs.has(fallbackKey)) {
      return []
    }
    visitedRealDirs.add(fallbackKey)
  }

  let activeScopes = scopes
  const dirKey = normalizePathKey(directoryUri.fsPath)
  if (!scopes.some((s) => normalizePathKey(s.baseDir) === dirKey)) {
    const localScope = await readGitIgnoreScope(directoryUri, false)
    if (localScope) {
      activeScopes = [...scopes, localScope]
    }
  }

  const allFiles: vscode.Uri[] = []
  let entries: [string, vscode.FileType][]
  try {
    entries = await vscode.workspace.fs.readDirectory(directoryUri)
  } catch {
    return []
  }

  for (const [name, type] of entries) {
    if (token?.isCancellationRequested) {
      return []
    }

    const entryUri = vscode.Uri.joinPath(directoryUri, name)
    const isDir = (type & vscode.FileType.Directory) !== 0
    const isFile = (type & vscode.FileType.File) !== 0

    if (isIgnoredByScopes(entryUri.fsPath, isDir, activeScopes)) {
      continue
    }

    if (isDir) {
      allFiles.push(...(await getAllFileUris(entryUri, activeScopes, visitedRealDirs, onFileFound, token, counter)))
    } else if (isFile) {
      if (isSensitiveFile(entryUri.fsPath)) {
        continue
      }
      allFiles.push(entryUri)
      counter.count++
      onFileFound?.(counter.count)
    }
  }

  return allFiles
}

async function collectFolderFileUris(
  folderUri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder | undefined,
  onFileFound?: (totalFound: number) => void,
  token?: vscode.CancellationToken,
  counter: { count: number } = { count: 0 }
): Promise<vscode.Uri[]> {
  if (token?.isCancellationRequested) {
    return []
  }

  const scopes: ScopedIgnore[] = []

  if (workspaceFolder) {
    const rootScope = await readGitIgnoreScope(workspaceFolder.uri, true)
    if (rootScope) {
      scopes.push(rootScope)
    }

    const relToRoot = path.relative(workspaceFolder.uri.fsPath, folderUri.fsPath)
    if (relToRoot && !relToRoot.startsWith('..') && !path.isAbsolute(relToRoot)) {
      const parts = relToRoot.split(path.sep).filter(Boolean)
      let currentUri = workspaceFolder.uri
      for (const part of parts) {
        if (token?.isCancellationRequested) {
          return []
        }
        currentUri = vscode.Uri.joinPath(currentUri, part)
        const midScope = await readGitIgnoreScope(currentUri, false)
        if (midScope) {
          scopes.push(midScope)
        }
      }
    }
  } else {
    const localScope = await readGitIgnoreScope(folderUri, true)
    if (localScope) {
      scopes.push(localScope)
    }
  }

  return getAllFileUris(folderUri, scopes, new Set<string>(), onFileFound, token, counter)
}

function findOpenDocument(fileUri: vscode.Uri): vscode.TextDocument | undefined {
  const targetUriStr = fileUri.toString()
  const targetKey = normalizePathKey(fileUri.fsPath)
  return vscode.workspace.textDocuments.find(
    (d) =>
      d.uri.toString() === targetUriStr ||
      (d.uri.scheme === fileUri.scheme && normalizePathKey(d.uri.fsPath) === targetKey)
  )
}

async function isFileHeaderBinary(fileUri: vscode.Uri, sampleSize = 8192): Promise<boolean> {
  if (fileUri.scheme !== 'file') {
    return false
  }
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(fileUri.fsPath, 'r')
    const buffer = Buffer.alloc(sampleSize)
    const { bytesRead } = await handle.read(buffer, 0, sampleSize, 0)
    return isBinaryBuffer(buffer.subarray(0, bytesRead), sampleSize)
  } catch {
    return false
  } finally {
    await handle?.close().catch(() => {})
  }
}

async function getFormattedFileString(
  fileUri: vscode.Uri,
  remainingBudget: number
): Promise<{ status: 'ok'; block: string } | { status: 'missing' } | { status: 'too_large' }> {
  const relativePath = getRelativePath(fileUri)

  if (fileUri.scheme !== 'untitled' && isBinaryFile(fileUri.fsPath)) {
    const block = `File: ${relativePath}\n`
    return block.length > remainingBudget ? { status: 'too_large' } : { status: 'ok', block }
  }

  let fileContent: string
  let language: string

  const openDoc = findOpenDocument(fileUri)
  if (openDoc) {
    fileContent = openDoc.getText()
    if (fileContent.length > remainingBudget) {
      return { status: 'too_large' }
    }
    language = getLanguage(fileUri.fsPath, openDoc.languageId)
  } else if (fileUri.scheme === 'untitled') {
    return { status: 'missing' }
  } else {
    try {
      const stat = await vscode.workspace.fs.stat(fileUri)
      // 大文件在检查大小上限与全量读盘前，先仅读前 8KB 探测二进制，避免超大未知二进制文件误中断后续复制
      if (stat.size > 8192 && (await isFileHeaderBinary(fileUri))) {
        const block = `File: ${relativePath}\n`
        return block.length > remainingBudget ? { status: 'too_large' } : { status: 'ok', block }
      }
      if (stat.size > remainingBudget) {
        return { status: 'too_large' }
      }
      const fileContentBytes = await vscode.workspace.fs.readFile(fileUri)
      if (isBinaryBuffer(fileContentBytes)) {
        const block = `File: ${relativePath}\n`
        return block.length > remainingBudget ? { status: 'too_large' } : { status: 'ok', block }
      }
      fileContent = Buffer.from(fileContentBytes).toString('utf8')
    } catch {
      return { status: 'missing' }
    }
    language = getLanguage(fileUri.fsPath)
  }

  const block = formatFileBlock(relativePath, language, fileContent)
  if (block.length > remainingBudget) {
    return { status: 'too_large' }
  }
  return { status: 'ok', block }
}

function createScanProgressCallback(progress: ProgressReporter): (totalFound: number) => void {
  let lastReportTime = 0
  return (totalFound: number) => {
    const now = Date.now()
    if (totalFound === 1 || now - lastReportTime >= 60) {
      lastReportTime = now
      progress.report({ message: vscode.l10n.t('Scanning files ({0} found)...', totalFound) })
    }
  }
}

function createItemProgressCallback(
  progress: ProgressReporter
): (current: number, total: number, label: string) => void {
  let reportedPercent = 0
  let lastReportTime = 0
  return (current: number, total: number, label: string) => {
    if (total <= 0) return
    const nextPercent = Math.min(100, (current / total) * 100)
    const now = Date.now()
    if (current === 1 || current === total || nextPercent - reportedPercent >= 1 || now - lastReportTime >= 60) {
      const increment = Math.max(0, nextPercent - reportedPercent)
      reportedPercent = nextPercent
      lastReportTime = now
      progress.report({
        increment,
        message: `(${current}/${total}) ${label}`
      })
    }
  }
}

async function processUris(
  uris: vscode.Uri[],
  maxLength: number,
  progress?: ProgressReporter,
  token?: vscode.CancellationToken
): Promise<ProcessUrisResult> {
  const allFormattedContents: string[] = []
  let currentLength = 0
  let stoppedEarly = false
  let skippedMissingCount = 0
  let firstProcessedPath: string | undefined
  const total = uris.length
  const reportItem = progress ? createItemProgressCallback(progress) : undefined

  for (let i = 0; i < total; i++) {
    if (token?.isCancellationRequested) {
      return {
        content: '',
        processedCount: 0,
        stoppedEarly: false,
        skippedMissingCount,
        cancelled: true
      }
    }

    const uri = uris[i]
    const displayName = uri.scheme === 'untitled' ? getRelativePath(uri) : path.basename(uri.fsPath)
    reportItem?.(i + 1, total, displayName)

    const remaining = maxLength - currentLength
    const result = await getFormattedFileString(uri, remaining)

    if (token?.isCancellationRequested) {
      return {
        content: '',
        processedCount: 0,
        stoppedEarly: false,
        skippedMissingCount,
        cancelled: true
      }
    }

    if (result.status === 'missing') {
      skippedMissingCount++
      continue
    }
    if (result.status === 'too_large') {
      stoppedEarly = true
      break
    }

    if (!firstProcessedPath) {
      firstProcessedPath = uri.scheme === 'untitled' ? getRelativePath(uri) : uri.fsPath
    }
    allFormattedContents.push(result.block)
    currentLength += result.block.length
  }

  const finalContent = sanitizeForClipboard(allFormattedContents.join('\n\n---\n\n'))
  return {
    content: finalContent,
    processedCount: allFormattedContents.length,
    stoppedEarly,
    skippedMissingCount,
    firstProcessedPath,
    cancelled: false
  }
}

function resolveTargetUris(clickedUri?: vscode.Uri, allSelectedUris?: vscode.Uri[]): vscode.Uri[] {
  if (allSelectedUris && allSelectedUris.length > 0) {
    return allSelectedUris
  }
  if (clickedUri) {
    return [clickedUri]
  }
  if (vscode.window.activeTextEditor?.document.uri) {
    return [vscode.window.activeTextEditor.document.uri]
  }
  return []
}

export function activate(context: vscode.ExtensionContext) {
  const stackManager = ClipStackManager.getInstance()

  // 0. 直接复制选中代码片段（带相对路径与行号）
  const copySelectionCommand = vscode.commands.registerCommand('copy-code-with-path.copySelection', async () => {
    const editor = vscode.window.activeTextEditor
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showWarningMessage(vscode.l10n.t('No text selected in the active editor.'))
      return
    }

    const { sizeMB, maxLength } = getMaxContentConfig()
    const doc = editor.document
    const selection = editor.selection
    const snippetText = doc.getText(selection)
    const lineRange = formatLineRange(selection.start.line, selection.end.line, selection.end.character)
    const relPath = getRelativePath(doc.uri)
    const lang = getLanguage(doc.uri.fsPath, doc.languageId)
    const formatted = sanitizeForClipboard(formatFileBlock(relPath, lang, snippetText, lineRange))

    if (formatted.length > maxLength) {
      vscode.window.showWarningMessage(vscode.l10n.t('Selected content exceeds the {0}MB size limit.', sizeMB))
      return
    }

    await vscode.env.clipboard.writeText(formatted)
    const stats = formatStats(formatted)
    vscode.window.showInformationMessage(
      vscode.l10n.t('Snippet copied: {0} ({1}) [{2}]', path.basename(relPath), lineRange, stats)
    )
  })

  // 1. 复制单文件 / 多文件（无参数快捷键触发且有选区时，智能复制选中片段）
  const copyCodeCommand = vscode.commands.registerCommand(
    'copy-code-with-path.copyCode',
    async (clickedUri?: vscode.Uri, allSelectedUris?: vscode.Uri[]) => {
      const editor = vscode.window.activeTextEditor
      if (!clickedUri && (!allSelectedUris || allSelectedUris.length === 0) && editor && !editor.selection.isEmpty) {
        await vscode.commands.executeCommand('copy-code-with-path.copySelection')
        return
      }

      const targetUris = resolveTargetUris(clickedUri, allSelectedUris)
      if (targetUris.length === 0 || !targetUris[0]) {
        vscode.window.showErrorMessage(
          vscode.l10n.t('Cannot get file path. Please use from the explorer or an editor tab.')
        )
        return
      }

      try {
        const fileUris: vscode.Uri[] = []
        const statResults = await Promise.allSettled(
          targetUris.map((uri) =>
            uri.scheme === 'untitled'
              ? Promise.resolve({ type: vscode.FileType.File } as vscode.FileStat)
              : vscode.workspace.fs.stat(uri)
          )
        )
        statResults.forEach((res, index) => {
          if (res.status === 'fulfilled' && (res.value.type & vscode.FileType.File) !== 0) {
            fileUris.push(targetUris[index])
          }
        })

        if (fileUris.length === 0) {
          vscode.window.showWarningMessage(vscode.l10n.t('No valid files found in the selection.'))
          return
        }

        const { sizeMB, maxLength } = getMaxContentConfig()
        const {
          content: finalContent,
          processedCount,
          stoppedEarly,
          firstProcessedPath,
          cancelled
        } = fileUris.length > 1
          ? await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('Copying selected files...'),
                cancellable: true
              },
              (progress, token) => processUris(fileUris, maxLength, progress, token)
            )
          : await processUris(fileUris, maxLength)

        if (cancelled) {
          return
        }

        if (processedCount === 0) {
          vscode.window.showWarningMessage(
            stoppedEarly
              ? vscode.l10n.t('No files copied. File size exceeds the {0}MB limit.', sizeMB)
              : vscode.l10n.t('No valid files found in the selection.')
          )
          return
        }

        await vscode.env.clipboard.writeText(finalContent)
        const contentStats = formatStats(finalContent)

        if (stoppedEarly) {
          vscode.window.showWarningMessage(
            vscode.l10n.t(
              'Copied {0} file(s) [{1}]. Some files were skipped due to size limits.',
              processedCount,
              contentStats
            )
          )
        } else if (processedCount > 1) {
          vscode.window.showInformationMessage(
            vscode.l10n.t('Copied contents of {0} file(s) [{1}].', processedCount, contentStats)
          )
        } else {
          const copiedName = path.basename(firstProcessedPath ?? fileUris[0].fsPath)
          vscode.window.showInformationMessage(vscode.l10n.t('Code copied: {0} [{1}]', copiedName, contentStats))
        }
      } catch (error) {
        console.error(error)
        const message = getErrorMessage(error)
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to copy file content: {0}', message))
      }
    }
  )

  // 2. 复制文件夹（支持资源管理器空白处右键或命令面板自动回退到工作区根目录）
  const copyFolderCodeCommand = vscode.commands.registerCommand(
    'copy-code-with-path.copyFolderCode',
    async (folderUri?: vscode.Uri) => {
      let targetFolderUri = folderUri
      if (!targetFolderUri) {
        const folders = vscode.workspace.workspaceFolders
        if (!folders || folders.length === 0) {
          vscode.window.showErrorMessage(vscode.l10n.t('Cannot get folder path. Please use from the file explorer.'))
          return
        }
        if (folders.length === 1) {
          targetFolderUri = folders[0].uri
        } else {
          const picked = await vscode.window.showQuickPick(
            folders.map((f) => ({
              label: f.name,
              description: f.uri.fsPath,
              uri: f.uri
            })),
            { placeHolder: vscode.l10n.t('Select a workspace root folder to copy') }
          )
          if (!picked) {
            return
          }
          targetFolderUri = picked.uri
        }
      }

      try {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetFolderUri)
        if (!workspaceFolder) {
          vscode.window.showErrorMessage(vscode.l10n.t('Cannot determine the workspace folder.'))
          return
        }

        const folderName = path.basename(targetFolderUri.fsPath)
        const { sizeMB, maxLength } = getMaxContentConfig()

        const runResult = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: vscode.l10n.t("Copying files from folder '{0}'...", folderName),
            cancellable: true
          },
          async (progress, token) => {
            const onScanFile = createScanProgressCallback(progress)
            const allFileUris = await collectFolderFileUris(targetFolderUri, workspaceFolder, onScanFile, token)
            if (token.isCancellationRequested) {
              return { cancelled: true as const, empty: false, result: undefined }
            }
            if (allFileUris.length === 0) {
              return { cancelled: false as const, empty: true, result: undefined }
            }
            const res = await processUris(allFileUris, maxLength, progress, token)
            return { cancelled: Boolean(res.cancelled), empty: false, result: res }
          }
        )

        if (runResult.cancelled) {
          return
        }
        if (runResult.empty || !runResult.result) {
          vscode.window.showWarningMessage(vscode.l10n.t('The selected folder is empty or contains no copyable files.'))
          return
        }

        const { content: finalContent, processedCount, stoppedEarly } = runResult.result

        if (processedCount === 0) {
          vscode.window.showWarningMessage(
            stoppedEarly
              ? vscode.l10n.t('No files copied. File size exceeds the {0}MB limit.', sizeMB)
              : vscode.l10n.t('The selected folder is empty or contains no copyable files.')
          )
          return
        }

        await vscode.env.clipboard.writeText(finalContent)
        const contentStats = formatStats(finalContent)

        if (stoppedEarly) {
          vscode.window.showWarningMessage(
            vscode.l10n.t(
              "Copied {1} item(s) from folder '{0}' [{2}]. Some files were skipped due to size limits.",
              folderName,
              processedCount,
              contentStats
            )
          )
        } else {
          vscode.window.showInformationMessage(
            vscode.l10n.t("Copied {1} item(s) from folder '{0}' [{2}].", folderName, processedCount, contentStats)
          )
        }
      } catch (error) {
        console.error(error)
        const message = getErrorMessage(error)
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to copy folder content: {0}', message))
      }
    }
  )

  // 3A. 将当前编辑器选中代码片段加入暂存栈（明确操作，绝不与侧边栏/Tab 混淆）
  const addSelectionToStackCommand = vscode.commands.registerCommand(
    'copy-code-with-path.addSelectionToStack',
    async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor || editor.selection.isEmpty) {
        vscode.window.showWarningMessage(vscode.l10n.t('No text selected in the active editor.'))
        return
      }

      const doc = editor.document
      const selection = editor.selection
      const snippetText = doc.getText(selection)
      const lineRange = formatLineRange(selection.start.line, selection.end.line, selection.end.character)
      const relPath = getRelativePath(doc.uri)
      const lang = getLanguage(doc.uri.fsPath, doc.languageId)
      const preview = snippetText.trim().replace(/\s+/g, ' ').substring(0, 60)

      stackManager.addItem({
        id: `${doc.uri.fsPath}#${Date.now()}#${Math.random().toString(36).substring(2, 7)}`,
        uri: doc.uri,
        fsPath: doc.uri.fsPath,
        relativePath: relPath,
        language: lang,
        isSnippet: true,
        lineRange,
        snippetContent: snippetText,
        previewText: preview,
        addedAt: Date.now()
      })

      vscode.window.showInformationMessage(
        vscode.l10n.t('Added code snippet ({0}) to clip stack. Total: {1} item(s).', lineRange, stackManager.count())
      )
    }
  )

  // 3B. 添加文件或文件夹到暂存栈（无参数快捷键触发且有选区时，智能转调片段入栈；右键菜单明确入栈文件/文件夹）
  const addToStackCommand = vscode.commands.registerCommand(
    'copy-code-with-path.addToStack',
    async (clickedUri?: vscode.Uri, allSelectedUris?: vscode.Uri[]) => {
      const editor = vscode.window.activeTextEditor
      if (!clickedUri && (!allSelectedUris || allSelectedUris.length === 0) && editor && !editor.selection.isEmpty) {
        await vscode.commands.executeCommand('copy-code-with-path.addSelectionToStack')
        return
      }

      const targetUris = resolveTargetUris(clickedUri, allSelectedUris)
      if (targetUris.length === 0 || !targetUris[0]) {
        vscode.window.showErrorMessage(
          vscode.l10n.t('Cannot get file path. Please use from the explorer or an editor tab.')
        )
        return
      }

      try {
        const fileUris: vscode.Uri[] = []
        const statResults = await Promise.allSettled(
          targetUris.map((uri) =>
            uri.scheme === 'untitled'
              ? Promise.resolve({ type: vscode.FileType.File } as vscode.FileStat)
              : vscode.workspace.fs.stat(uri)
          )
        )
        const hasDirectory = statResults.some(
          (res) => res.status === 'fulfilled' && (res.value.type & vscode.FileType.Directory) !== 0
        )

        const collectTargets = async (
          progress?: ProgressReporter,
          token?: vscode.CancellationToken
        ): Promise<boolean> => {
          const onScanFile = progress ? createScanProgressCallback(progress) : undefined
          const sharedCounter = { count: 0 }
          for (let i = 0; i < statResults.length; i++) {
            if (token?.isCancellationRequested) {
              return true
            }
            const res = statResults[i]
            if (res.status !== 'fulfilled') {
              continue
            }
            const stat = res.value
            const targetUri = targetUris[i]
            if ((stat.type & vscode.FileType.File) !== 0) {
              fileUris.push(targetUri)
            } else if ((stat.type & vscode.FileType.Directory) !== 0) {
              const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetUri)
              const folderFiles = await collectFolderFileUris(
                targetUri,
                workspaceFolder,
                onScanFile,
                token,
                sharedCounter
              )
              if (token?.isCancellationRequested) {
                return true
              }
              fileUris.push(...folderFiles)
            }
          }
          return Boolean(token?.isCancellationRequested)
        }

        const cancelled = hasDirectory
          ? await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('Scanning folder files for Clip Stack...'),
                cancellable: true
              },
              (progress, token) => collectTargets(progress, token)
            )
          : await collectTargets()

        if (cancelled) {
          return
        }

        if (fileUris.length === 0) {
          vscode.window.showWarningMessage(vscode.l10n.t('No valid files found in the selection.'))
          return
        }

        for (const uri of fileUris) {
          const relPath = getRelativePath(uri)
          const openDoc = findOpenDocument(uri)
          const lang = getLanguage(uri.fsPath, openDoc?.languageId)

          stackManager.addItem({
            id: normalizePathKey(uri.fsPath),
            uri,
            fsPath: uri.fsPath,
            relativePath: relPath,
            language: lang,
            isSnippet: false,
            previewText: vscode.l10n.t('Whole file content'),
            addedAt: Date.now()
          })
        }

        vscode.window.showInformationMessage(
          vscode.l10n.t('Added {0} file(s) to clip stack. Total: {1} item(s).', fileUris.length, stackManager.count())
        )
      } catch (error) {
        console.error(error)
        const message = getErrorMessage(error)
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to add to clip stack: {0}', message))
      }
    }
  )

  // 4. 从暂存栈移除当前文件相关的所有条目
  const removeFromStackCommand = vscode.commands.registerCommand(
    'copy-code-with-path.removeFromStack',
    async (clickedUri?: vscode.Uri, allSelectedUris?: vscode.Uri[]) => {
      const targetUris = resolveTargetUris(clickedUri, allSelectedUris)
      if (targetUris.length === 0 || !targetUris[0]) {
        vscode.window.showErrorMessage(vscode.l10n.t('Cannot get file path.'))
        return
      }

      let removedCount = 0
      const statResults = await Promise.allSettled(
        targetUris.map((uri) =>
          uri.scheme === 'untitled'
            ? Promise.resolve({ type: vscode.FileType.File } as vscode.FileStat)
            : vscode.workspace.fs.stat(uri)
        )
      )
      for (let i = 0; i < targetUris.length; i++) {
        const uri = targetUris[i]
        const statRes = statResults[i]
        if (statRes.status === 'fulfilled' && (statRes.value.type & vscode.FileType.Directory) !== 0) {
          removedCount += stackManager.removeByDirectory(uri)
        } else {
          removedCount += stackManager.removeByUri(uri)
        }
      }

      if (removedCount > 0) {
        vscode.window.showInformationMessage(
          vscode.l10n.t(
            'Removed {0} item(s) from clip stack. Remaining: {1} item(s).',
            removedCount,
            stackManager.count()
          )
        )
      } else {
        vscode.window.showWarningMessage(vscode.l10n.t('No matching items found in clip stack for this file.'))
      }
    }
  )

  // 5. 撤销/弹出暂存栈最后一条添加 (Pop Last Item)
  const popFromStackCommand = vscode.commands.registerCommand('copy-code-with-path.popFromStack', () => {
    const popped = stackManager.popItem()
    if (popped) {
      const desc = popped.lineRange ? `${popped.relativePath} (${popped.lineRange})` : popped.relativePath
      vscode.window.showInformationMessage(
        vscode.l10n.t('Popped last item: {0}. Remaining: {1} item(s).', desc, stackManager.count())
      )
    } else {
      vscode.window.showWarningMessage(vscode.l10n.t('Clip stack is already empty.'))
    }
  })

  // 6. 复制暂存栈中的所有代码（附带估算体积/Token 及一键清空按钮）
  const copyStackCommand = vscode.commands.registerCommand('copy-code-with-path.copyStack', async () => {
    if (stackManager.count() === 0) {
      vscode.window.showWarningMessage(vscode.l10n.t('Clip stack is empty. Add files or snippets first.'))
      return
    }

    try {
      const { sizeMB, maxLength } = getMaxContentConfig()
      const {
        content: finalContent,
        processedCount,
        stoppedEarly,
        cancelled
      } = stackManager.count() > 1
        ? await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: vscode.l10n.t('Formatting and copying Clip Stack...'),
              cancellable: true
            },
            (progress, token) => {
              const reportItem = createItemProgressCallback(progress)
              return stackManager.formatAll(maxLength, {
                isCancelled: () => token.isCancellationRequested,
                onProgress: (current, total, item) => reportItem(current, total, path.basename(item.relativePath))
              })
            }
          )
        : await stackManager.formatAll(maxLength)

      if (cancelled) {
        return
      }

      if (processedCount === 0) {
        vscode.window.showWarningMessage(
          stoppedEarly
            ? vscode.l10n.t('No items copied from clip stack. Content exceeds the {0}MB limit.', sizeMB)
            : vscode.l10n.t('No readable files remain in the clip stack.')
        )
        return
      }

      await vscode.env.clipboard.writeText(finalContent)
      const contentStats = formatStats(finalContent)
      const clearBtn = vscode.l10n.t('Clear Stack')

      const promptPromise = stoppedEarly
        ? vscode.window.showWarningMessage(
            vscode.l10n.t(
              'Copied {0} item(s) from clip stack [{1}]. Some were skipped due to size limits.',
              processedCount,
              contentStats
            ),
            clearBtn
          )
        : vscode.window.showInformationMessage(
            vscode.l10n.t('Copied all {0} item(s) from clip stack [{1}]!', processedCount, contentStats),
            clearBtn
          )

      promptPromise.then((choice) => {
        if (choice === clearBtn) {
          stackManager.clear()
          vscode.window.showInformationMessage(vscode.l10n.t('Cleared clip stack.'))
        }
      })
    } catch (error) {
      console.error(error)
      const message = getErrorMessage(error)
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to copy file content: {0}', message))
    }
  })

  // 7. 清空暂存栈
  const clearStackCommand = vscode.commands.registerCommand('copy-code-with-path.clearStack', () => {
    if (stackManager.count() === 0) {
      vscode.window.showInformationMessage(vscode.l10n.t('Clip stack is already empty.'))
      return
    }
    stackManager.clear()
    vscode.window.showInformationMessage(vscode.l10n.t('Cleared clip stack.'))
  })

  // 8. 交互式查看与管理暂存栈 (QuickPick)
  const manageStackCommand = vscode.commands.registerCommand('copy-code-with-path.manageStack', async () => {
    const items = stackManager.getItems()
    if (items.length === 0) {
      vscode.window.showInformationMessage(vscode.l10n.t('Clip stack is empty. Add files or snippets first.'))
      return
    }

    interface StackQuickPickItem extends vscode.QuickPickItem {
      clipId?: string
      action?: 'copy' | 'clear'
    }

    const qpItems: StackQuickPickItem[] = [
      {
        label: `$(copy) ${vscode.l10n.t('Copy All Stack Content to Clipboard')}`,
        description: vscode.l10n.t('{0} item(s) in stack', items.length),
        action: 'copy'
      },
      {
        label: `$(trash) ${vscode.l10n.t('Clear Entire Clip Stack')}`,
        action: 'clear'
      },
      {
        label: '',
        kind: vscode.QuickPickItemKind.Separator
      }
    ]

    items.forEach((item, index) => {
      const tag = item.isSnippet ? `(${item.lineRange})` : `(${vscode.l10n.t('Whole file')})`
      qpItems.push({
        label: `${index + 1}. $(file-code) ${item.relativePath} ${tag}`,
        description: item.previewText,
        clipId: item.id,
        buttons: [
          {
            iconPath: new vscode.ThemeIcon('trash'),
            tooltip: vscode.l10n.t('Remove this item from stack')
          }
        ]
      })
    })

    const qp = vscode.window.createQuickPick<StackQuickPickItem>()
    qp.title = vscode.l10n.t('Clip Stack Manager ({0} items)', items.length)
    qp.placeholder = vscode.l10n.t('Select an item to view, or click the trash button to delete it')
    qp.items = qpItems

    qp.onDidHide(() => {
      qp.dispose()
    })

    qp.onDidTriggerItemButton((e) => {
      if (e.item.clipId) {
        stackManager.removeById(e.item.clipId)
        vscode.window.showInformationMessage(vscode.l10n.t('Removed selected item from clip stack.'))
        qp.hide()
        if (stackManager.count() > 0) {
          vscode.commands.executeCommand('copy-code-with-path.manageStack')
        }
      }
    })

    qp.onDidAccept(async () => {
      const selected = qp.selectedItems[0]
      qp.hide()
      if (!selected) return

      if (selected.action === 'copy') {
        vscode.commands.executeCommand('copy-code-with-path.copyStack')
      } else if (selected.action === 'clear') {
        vscode.commands.executeCommand('copy-code-with-path.clearStack')
      } else if (selected.clipId) {
        const item = items.find((i) => i.id === selected.clipId)
        if (item) {
          try {
            const doc = await vscode.workspace.openTextDocument(item.uri)
            const ed = await vscode.window.showTextDocument(doc)
            if (item.lineRange) {
              const match = item.lineRange.match(/\d+/)
              if (match) {
                const lineNum = Math.max(0, parseInt(match[0], 10) - 1)
                const pos = new vscode.Position(lineNum, 0)
                ed.selection = new vscode.Selection(pos, pos)
                ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
              }
            }
          } catch {
            vscode.window.showWarningMessage(vscode.l10n.t('File no longer exists: {0}', item.relativePath))
          }
        }
      }
    })

    qp.show()
  })

  context.subscriptions.push(
    copySelectionCommand,
    copyCodeCommand,
    copyFolderCodeCommand,
    addSelectionToStackCommand,
    addToStackCommand,
    removeFromStackCommand,
    popFromStackCommand,
    copyStackCommand,
    clearStackCommand,
    manageStackCommand,
    stackManager.getStatusBarItem()
  )
}

export function deactivate() {}
