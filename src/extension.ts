import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import ignore from 'ignore'
import * as vscode from 'vscode'
import { ClipStackManager } from './clipStack'
import {
  formatFileBlock,
  formatLineRange,
  formatStats,
  getLanguage,
  isBinaryFile,
  isSensitiveFile,
  MAX_CONTENT_LENGTH,
  normalizePathKey
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
}

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
  'bun.lockb'
]

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function getRelativePath(uri: vscode.Uri, workspaceFolder?: vscode.WorkspaceFolder): string {
  const folder = workspaceFolder ?? vscode.workspace.getWorkspaceFolder(uri)
  return folder ? path.relative(folder.uri.fsPath, uri.fsPath).replace(/\\/g, '/') : path.basename(uri.fsPath)
}

async function readGitIgnoreScope(dirUri: vscode.Uri, includeDefaults = false): Promise<ScopedIgnore | null> {
  const ig = ignore()
  let hasRules = false

  if (includeDefaults) {
    ig.add(DEFAULT_IGNORES)
    hasRules = true
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
  visitedRealDirs: Set<string>
): Promise<vscode.Uri[]> {
  try {
    const realDir = normalizePathKey(await fs.realpath(directoryUri.fsPath))
    if (visitedRealDirs.has(realDir)) {
      return []
    }
    visitedRealDirs.add(realDir)
  } catch {
    // 虚拟文件系统或无法 realpath 时回退使用 fsPath 防环
    const fallbackKey = normalizePathKey(directoryUri.fsPath)
    if (visitedRealDirs.has(fallbackKey)) {
      return []
    }
    visitedRealDirs.add(fallbackKey)
  }

  // 加载当前目录自身的 .gitignore（如果还未被加载过）
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
    const entryUri = vscode.Uri.joinPath(directoryUri, name)
    const isDir = (type & vscode.FileType.Directory) !== 0
    const isFile = (type & vscode.FileType.File) !== 0

    if (isIgnoredByScopes(entryUri.fsPath, isDir, activeScopes)) {
      continue
    }

    if (isDir) {
      allFiles.push(...(await getAllFileUris(entryUri, activeScopes, visitedRealDirs)))
    } else if (isFile) {
      if (isSensitiveFile(entryUri.fsPath)) {
        continue
      }
      allFiles.push(entryUri)
    }
  }

  return allFiles
}

async function collectFolderFileUris(
  folderUri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder | undefined
): Promise<vscode.Uri[]> {
  const scopes: ScopedIgnore[] = []

  // 若存在工作区根目录，从根目录向下沿途收集 .gitignore，保证每层规则均以自身所在目录为基准路径
  if (workspaceFolder) {
    const rootScope = await readGitIgnoreScope(workspaceFolder.uri, true)
    if (rootScope) {
      scopes.push(rootScope)
    }

    // 收集工作区根与目标子目录之间可能存在的中间层 .gitignore
    const relToRoot = path.relative(workspaceFolder.uri.fsPath, folderUri.fsPath)
    if (relToRoot && !relToRoot.startsWith('..') && !path.isAbsolute(relToRoot)) {
      const parts = relToRoot.split(path.sep).filter(Boolean)
      let currentUri = workspaceFolder.uri
      for (const part of parts) {
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

  return getAllFileUris(folderUri, scopes, new Set<string>())
}

async function getFormattedFileString(
  fileUri: vscode.Uri,
  remainingBudget: number
): Promise<{ status: 'ok'; block: string } | { status: 'missing' } | { status: 'too_large' }> {
  // 多根工作区下按每个文件独立归属计算相对路径
  const relativePath = getRelativePath(fileUri)

  if (isBinaryFile(fileUri.fsPath)) {
    const block = `File: ${relativePath}\n`
    return block.length > remainingBudget ? { status: 'too_large' } : { status: 'ok', block }
  }

  let fileContent: string
  let language: string

  const targetKey = normalizePathKey(fileUri.fsPath)
  const openDoc = vscode.workspace.textDocuments.find((d) => normalizePathKey(d.uri.fsPath) === targetKey)
  if (openDoc) {
    fileContent = openDoc.getText()
    if (fileContent.length > remainingBudget) {
      return { status: 'too_large' }
    }
    language = getLanguage(fileUri.fsPath, openDoc.languageId)
  } else {
    try {
      const stat = await vscode.workspace.fs.stat(fileUri)
      if (stat.size > remainingBudget) {
        return { status: 'too_large' }
      }
      const fileContentBytes = await vscode.workspace.fs.readFile(fileUri)
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

async function processUris(uris: vscode.Uri[]): Promise<ProcessUrisResult> {
  const allFormattedContents: string[] = []
  let currentLength = 0
  let stoppedEarly = false
  let skippedMissingCount = 0

  for (const uri of uris) {
    const remaining = MAX_CONTENT_LENGTH - currentLength
    const result = await getFormattedFileString(uri, remaining)

    if (result.status === 'missing') {
      skippedMissingCount++
      continue
    }
    if (result.status === 'too_large') {
      stoppedEarly = true
      break
    }

    allFormattedContents.push(result.block)
    currentLength += result.block.length
  }

  const finalContent = allFormattedContents.join('\n\n---\n\n')
  return {
    content: finalContent,
    processedCount: allFormattedContents.length,
    stoppedEarly,
    skippedMissingCount
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

    const doc = editor.document
    const selection = editor.selection
    const snippetText = doc.getText(selection)
    const lineRange = formatLineRange(selection.start.line, selection.end.line, selection.end.character)
    const relPath = getRelativePath(doc.uri)
    const lang = getLanguage(doc.uri.fsPath, doc.languageId)
    const formatted = formatFileBlock(relPath, lang, snippetText, lineRange)

    if (formatted.length > MAX_CONTENT_LENGTH) {
      vscode.window.showWarningMessage(vscode.l10n.t('Selected content exceeds the 15MB size limit.'))
      return
    }

    await vscode.env.clipboard.writeText(formatted)
    const stats = formatStats(formatted)
    vscode.window.showInformationMessage(
      vscode.l10n.t('Snippet copied: {0} ({1}) [{2}]', path.basename(doc.uri.fsPath), lineRange, stats)
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
        const statResults = await Promise.allSettled(targetUris.map((uri) => vscode.workspace.fs.stat(uri)))
        statResults.forEach((res, index) => {
          if (res.status === 'fulfilled' && (res.value.type & vscode.FileType.File) !== 0) {
            fileUris.push(targetUris[index])
          }
        })

        if (fileUris.length === 0) {
          vscode.window.showWarningMessage(vscode.l10n.t('No valid files found in the selection.'))
          return
        }

        const { content: finalContent, processedCount, stoppedEarly } = await processUris(fileUris)

        if (processedCount === 0) {
          vscode.window.showWarningMessage(
            stoppedEarly
              ? vscode.l10n.t('No files copied. File size exceeds the 15MB limit.')
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
          vscode.window.showInformationMessage(
            vscode.l10n.t('Code copied: {0} [{1}]', path.basename(fileUris[0].fsPath), contentStats)
          )
        }
      } catch (error) {
        console.error(error)
        const message = getErrorMessage(error)
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to copy file content: {0}', message))
      }
    }
  )

  // 2. 复制文件夹
  const copyFolderCodeCommand = vscode.commands.registerCommand(
    'copy-code-with-path.copyFolderCode',
    async (folderUri?: vscode.Uri) => {
      if (!folderUri) {
        vscode.window.showErrorMessage(vscode.l10n.t('Cannot get folder path. Please use from the file explorer.'))
        return
      }

      try {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(folderUri)
        if (!workspaceFolder) {
          vscode.window.showErrorMessage(vscode.l10n.t('Cannot determine the workspace folder.'))
          return
        }

        const allFileUris = await collectFolderFileUris(folderUri, workspaceFolder)

        if (allFileUris.length === 0) {
          vscode.window.showWarningMessage(vscode.l10n.t('The selected folder is empty or contains no copyable files.'))
          return
        }

        const { content: finalContent, processedCount, stoppedEarly } = await processUris(allFileUris)

        if (processedCount === 0) {
          vscode.window.showWarningMessage(
            stoppedEarly
              ? vscode.l10n.t('No files copied. File size exceeds the 15MB limit.')
              : vscode.l10n.t('The selected folder is empty or contains no copyable files.')
          )
          return
        }

        await vscode.env.clipboard.writeText(finalContent)
        const contentStats = formatStats(finalContent)

        const folderName = path.basename(folderUri.fsPath)
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
        const statResults = await Promise.allSettled(targetUris.map((uri) => vscode.workspace.fs.stat(uri)))
        for (let i = 0; i < statResults.length; i++) {
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
            const folderFiles = await collectFolderFileUris(targetUri, workspaceFolder)
            fileUris.push(...folderFiles)
          }
        }

        if (fileUris.length === 0) {
          vscode.window.showWarningMessage(vscode.l10n.t('No valid files found in the selection.'))
          return
        }

        for (const uri of fileUris) {
          const relPath = getRelativePath(uri)
          const targetKey = normalizePathKey(uri.fsPath)
          const openDoc = vscode.workspace.textDocuments.find((d) => normalizePathKey(d.uri.fsPath) === targetKey)
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
      for (const uri of targetUris) {
        removedCount += stackManager.removeByUri(uri)
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
      const { content: finalContent, processedCount, stoppedEarly } = await stackManager.formatAll()

      if (processedCount === 0) {
        vscode.window.showWarningMessage(
          stoppedEarly
            ? vscode.l10n.t('No items copied from clip stack. Content exceeds the 15MB limit.')
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

    qp.onDidTriggerItemButton((e) => {
      if (e.item.clipId) {
        stackManager.removeById(e.item.clipId)
        vscode.window.showInformationMessage(vscode.l10n.t('Removed selected item from clip stack.'))
        qp.dispose()
        if (stackManager.count() > 0) {
          vscode.commands.executeCommand('copy-code-with-path.manageStack')
        }
      }
    })

    qp.onDidAccept(async () => {
      const selected = qp.selectedItems[0]
      qp.dispose()
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
