import * as path from 'node:path'
import ignore from 'ignore'
import * as vscode from 'vscode'

// 设置一个合理的内容总长度上限（例如 15MB），防止 "Invalid string length" 错误
const MAX_CONTENT_LENGTH = 15 * 1024 * 1024

const binaryFileExtensions = new Set([
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
  'app',
  'dmg',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'eot',
  'lockb',
  'DS_Store'
])

const extensionToLanguageMap: Record<string, string> = {
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

function isBinaryFile(filePath: string): boolean {
  const extension = path.extname(filePath).substring(1).toLowerCase()
  return binaryFileExtensions.has(extension)
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function getCodeFence(content: string): string {
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

async function getFormattedFileString(
  fileUri: vscode.Uri,
  workspaceFolder: vscode.WorkspaceFolder | undefined
): Promise<string> {
  const relativePath = workspaceFolder
    ? path.relative(workspaceFolder.uri.fsPath, fileUri.fsPath).replace(/\\/g, '/')
    : path.basename(fileUri.fsPath)

  if (isBinaryFile(fileUri.fsPath)) {
    return `File: ${relativePath}\n`
  }

  let fileContent: string
  let language = 'plaintext'

  // 优先从已打开的内存编辑器中获取，避免读取磁盘导致未保存内容丢失
  const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fileUri.fsPath)
  if (openDoc) {
    fileContent = openDoc.getText()
    language = openDoc.languageId
  } else {
    const fileContentBytes = await vscode.workspace.fs.readFile(fileUri)
    fileContent = Buffer.from(fileContentBytes).toString('utf8')
    const extension = path.extname(fileUri.fsPath).substring(1).toLowerCase()
    if (extension) {
      language = extensionToLanguageMap[extension] || extension
    }
  }

  const fence = getCodeFence(fileContent)
  return `File: ${relativePath}\n\n${fence}${language}\n${fileContent}\n${fence}\n`
}

/**
 * 高效地、递归地获取所有未被忽略的文件 URI。
 * 路径匹配基准根据 rootUri 计算，确保正确应用 .gitignore 规则。
 */
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

/**
 * 负责处理文件列表：串行读取、检查大小、拼接内容。
 * @returns [拼接好的内容, 处理的文件数, 是否因大小超限而中止]
 */
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

export function activate(context: vscode.ExtensionContext) {
  const copyCodeCommand = vscode.commands.registerCommand(
    'copy-code-with-path.copyCode',
    async (clickedUri?: vscode.Uri, allSelectedUris?: vscode.Uri[]) => {
      // 兼容资源管理器多选/单选、文件标签(Tab)右键，以及从活动编辑器执行
      let targetUris: vscode.Uri[] = []

      if (allSelectedUris && allSelectedUris.length > 0) {
        targetUris = allSelectedUris
      } else if (clickedUri) {
        targetUris = [clickedUri]
      } else if (vscode.window.activeTextEditor?.document.uri) {
        targetUris = [vscode.window.activeTextEditor.document.uri]
      }

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

        // 若当前选中的文件夹不是工作区根目录，先尝试读取工作区根目录的 .gitignore
        if (workspaceFolder.uri.fsPath !== folderUri.fsPath) {
          try {
            const rootGitignoreUri = vscode.Uri.joinPath(workspaceFolder.uri, '.gitignore')
            const rootGitignoreBytes = await vscode.workspace.fs.readFile(rootGitignoreUri)
            ig.add(Buffer.from(rootGitignoreBytes).toString('utf8'))
          } catch {
            // 根目录无 .gitignore 时静默处理
          }
        }

        // 尝试读取当前文件夹下的 .gitignore
        const gitignoreUri = vscode.Uri.joinPath(folderUri, '.gitignore')
        try {
          const gitignoreContentBytes = await vscode.workspace.fs.readFile(gitignoreUri)
          ig.add(Buffer.from(gitignoreContentBytes).toString('utf8'))
        } catch {
          // 当前文件夹无 .gitignore 时静默处理
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

  context.subscriptions.push(copyCodeCommand, copyFolderCodeCommand)
}

export function deactivate() {}
