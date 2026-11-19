import * as path from 'node:path'
import ignore from 'ignore'
import * as vscode from 'vscode'
import { ClipStackManager } from './clipStack'
import { formatFileBlock, getLanguage, isBinaryFile, MAX_CONTENT_LENGTH } from './formatter'

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function getRelativePath(uri: vscode.Uri, workspaceFolder?: vscode.WorkspaceFolder): string {
  return workspaceFolder
    ? path.relative(workspaceFolder.uri.fsPath, uri.fsPath).replace(/\\/g, '/')
    : path.basename(uri.fsPath)
}

async function getFormattedFileString(
  fileUri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder | undefined
): Promise<string> {
  const relativePath = getRelativePath(fileUri, workspaceFolder)

  if (isBinaryFile(fileUri.fsPath)) {
    return `File: ${relativePath}\n`
  }

  let fileContent = ''
  let language = 'plaintext'

  // 优先从已打开的内存编辑器中获取，避免读取磁盘导致未保存内容丢失
  const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fileUri.fsPath)
  if (openDoc) {
    fileContent = openDoc.getText()
    language = getLanguage(fileUri.fsPath, openDoc.languageId)
  } else {
    try {
      const fileContentBytes = await vscode.workspace.fs.readFile(fileUri)
      fileContent = Buffer.from(fileContentBytes).toString('utf8')
    } catch {
      fileContent = ''
    }
    language = getLanguage(fileUri.fsPath)
  }

  return formatFileBlock(relativePath, language, fileContent)
}

async function getAllFileUris(
  directoryUri: vscode.Uri,
  rootUri: vscode.Uri,
  ig: ReturnType<typeof ignore>
): Promise<vscode.Uri[]> {
  const allFiles: vscode.Uri[] = []
  const entries = await vscode.workspace.fs.readDirectory(directoryUri)

  for (const [name, type] of entries) {
    const entryUri = vscode.Uri.joinPath(directoryUri, name)
    const relativePath = path.relative(rootUri.fsPath, entryUri.fsPath).replace(/\\/g, '/')

    if (ig.ignores(relativePath)) {
      continue
    }

    if (type === vscode.FileType.Directory) {
      allFiles.push(...(await getAllFileUris(entryUri, rootUri, ig)))
    } else if (type === vscode.FileType.File) {
      allFiles.push(entryUri)
    }
  }

  return allFiles
}

async function processUris(
  uris: vscode.Uri[],
  workspaceFolder: vscode.WorkspaceFolder | undefined
): Promise<[string, number, boolean]> {
  const allFormattedContents: string[] = []
  let currentLength = 0
  let stoppedEarly = false

  for (const uri of uris) {
    const formattedContent = await getFormattedFileString(uri, workspaceFolder)

    if (currentLength + formattedContent.length > MAX_CONTENT_LENGTH) {
      stoppedEarly = true
      break
    }

    allFormattedContents.push(formattedContent)
    currentLength += formattedContent.length
  }

  const finalContent = allFormattedContents.join('\n\n---\n\n')
  return [finalContent, allFormattedContents.length, stoppedEarly]
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

  // 1. 复制单文件 / 多文件
  const copyCodeCommand = vscode.commands.registerCommand(
    'copy-code-with-path.copyCode',
    async (clickedUri?: vscode.Uri, allSelectedUris?: vscode.Uri[]) => {
      const targetUris = resolveTargetUris(clickedUri, allSelectedUris)

      if (targetUris.length === 0 || !targetUris[0]) {
        vscode.window.showErrorMessage(
          vscode.l10n.t('Cannot get file path. Please use from the explorer or an editor tab.')
        )
        return
      }

      try {
        const fileUris: vscode.Uri[] = []
        const stats = await Promise.all(targetUris.map((uri) => vscode.workspace.fs.stat(uri)))
        stats.forEach((stat, index) => {
          if (stat.type === vscode.FileType.File) {
            fileUris.push(targetUris[index])
          }
        })

        if (fileUris.length === 0) {
          vscode.window.showWarningMessage(vscode.l10n.t('No valid files found in the selection.'))
          return
        }

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUris[0])
        const [finalContent, processedCount, stoppedEarly] = await processUris(fileUris, workspaceFolder)

        await vscode.env.clipboard.writeText(finalContent)

        if (stoppedEarly) {
          vscode.window.showWarningMessage(
            vscode.l10n.t('Copied {0} file(s). Some files were skipped due to size limits.', processedCount)
          )
        } else if (fileUris.length > 1) {
          vscode.window.showInformationMessage(vscode.l10n.t('Copied contents of {0} file(s).', fileUris.length))
        } else {
          vscode.window.showInformationMessage(vscode.l10n.t('Code copied: {0}', path.basename(fileUris[0].fsPath)))
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

        const ig = ignore()
        ig.add('.git')
        ig.add('node_modules')
        ig.add('dist')
        ig.add('build')
        ig.add('out')
        ig.add('coverage')
        ig.add('.vscode')
        ig.add('.idea')
        ig.add('package-lock.json')
        ig.add('yarn.lock')
        ig.add('pnpm-lock.yaml')
        ig.add('bun.lockb')

        if (workspaceFolder.uri.fsPath !== folderUri.fsPath) {
          try {
            const rootGitignoreUri = vscode.Uri.joinPath(workspaceFolder.uri, '.gitignore')
            const rootGitignoreBytes = await vscode.workspace.fs.readFile(rootGitignoreUri)
            ig.add(Buffer.from(rootGitignoreBytes).toString('utf8'))
          } catch {
            // 静默处理
          }
        }

        const gitignoreUri = vscode.Uri.joinPath(folderUri, '.gitignore')
        try {
          const gitignoreContentBytes = await vscode.workspace.fs.readFile(gitignoreUri)
          ig.add(Buffer.from(gitignoreContentBytes).toString('utf8'))
        } catch {
          // 静默处理
        }

        const allFileUris = await getAllFileUris(folderUri, folderUri, ig)

        if (allFileUris.length === 0) {
          vscode.window.showWarningMessage(vscode.l10n.t('The selected folder is empty or contains no copyable files.'))
          return
        }

        const [finalContent, processedCount, stoppedEarly] = await processUris(allFileUris, workspaceFolder)

        await vscode.env.clipboard.writeText(finalContent)

        const folderName = path.basename(folderUri.fsPath)
        if (stoppedEarly) {
          vscode.window.showWarningMessage(
            vscode.l10n.t(
              "Copied {1} item(s) from folder '{0}'. Some files were skipped due to size limits.",
              folderName,
              processedCount
            )
          )
        } else {
          vscode.window.showInformationMessage(
            vscode.l10n.t("Copied {1} item(s) from folder '{0}'.", folderName, allFileUris.length)
          )
        }
      } catch (error) {
        console.error(error)
        const message = getErrorMessage(error)
        vscode.window.showErrorMessage(vscode.l10n.t('Failed to copy folder content: {0}', message))
      }
    }
  )

  // 3. 添加到暂存栈 (支持部分代码片段或整文件)
  const addToStackCommand = vscode.commands.registerCommand(
    'copy-code-with-path.addToStack',
    async (clickedUri?: vscode.Uri, allSelectedUris?: vscode.Uri[]) => {
      const editor = vscode.window.activeTextEditor

      // 场景 A: 在编辑器中选定了部分代码片段
      if (editor?.selection && !editor.selection.isEmpty) {
        const doc = editor.document
        const selection = editor.selection
        const snippetText = doc.getText(selection)
        const startLine = selection.start.line + 1
        const endLine = selection.end.line + 1
        const lineRange = startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri)
        const relPath = getRelativePath(doc.uri, workspaceFolder)
        const lang = getLanguage(doc.uri.fsPath, doc.languageId)
        const preview = snippetText.trim().replace(/\s+/g, ' ').substring(0, 60)

        stackManager.addItem({
          id: `${doc.uri.fsPath}#${Date.now()}#${Math.random().toString(36).substring(2, 7)}`,
          uri: doc.uri,
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
        return
      }

      // 场景 B: 未选中文本或从侧边栏/Tab 触发全文件入栈
      const targetUris = resolveTargetUris(clickedUri, allSelectedUris)
      if (targetUris.length === 0 || !targetUris[0]) {
        vscode.window.showErrorMessage(
          vscode.l10n.t('Cannot get file path. Please use from the explorer or an editor tab.')
        )
        return
      }

      const fileUris: vscode.Uri[] = []
      const stats = await Promise.all(targetUris.map((uri) => vscode.workspace.fs.stat(uri)))
      stats.forEach((stat, index) => {
        if (stat.type === vscode.FileType.File) {
          fileUris.push(targetUris[index])
        }
      })

      if (fileUris.length === 0) {
        vscode.window.showWarningMessage(vscode.l10n.t('No valid files found in the selection.'))
        return
      }

      for (const uri of fileUris) {
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri)
        const relPath = getRelativePath(uri, workspaceFolder)
        const lang = getLanguage(uri.fsPath)

        stackManager.addItem({
          id: uri.fsPath,
          uri,
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
    }
  )

  // 4. 从暂存栈移除当前文件相关的所有条目
  const removeFromStackCommand = vscode.commands.registerCommand(
    'copy-code-with-path.removeFromStack',
    async (clickedUri?: vscode.Uri) => {
      const targetUris = resolveTargetUris(clickedUri)
      if (targetUris.length === 0 || !targetUris[0]) {
        vscode.window.showErrorMessage(vscode.l10n.t('Cannot get file path.'))
        return
      }

      const removedCount = stackManager.removeByUri(targetUris[0])
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

  // 6. 复制暂存栈中的所有代码
  const copyStackCommand = vscode.commands.registerCommand('copy-code-with-path.copyStack', async () => {
    if (stackManager.count() === 0) {
      vscode.window.showWarningMessage(vscode.l10n.t('Clip stack is empty. Add files or snippets first.'))
      return
    }

    try {
      const [finalContent, processedCount, stoppedEarly] = await stackManager.formatAll()
      await vscode.env.clipboard.writeText(finalContent)

      if (stoppedEarly) {
        vscode.window.showWarningMessage(
          vscode.l10n.t('Copied {0} item(s) from clip stack. Some were skipped due to size limits.', processedCount)
        )
      } else {
        vscode.window.showInformationMessage(
          vscode.l10n.t('Copied all {0} item(s) from clip stack to clipboard!', processedCount)
        )
      }
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
            // 静默处理
          }
        }
      }
    })

    qp.show()
  })

  context.subscriptions.push(
    copyCodeCommand,
    copyFolderCodeCommand,
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
