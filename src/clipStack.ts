import * as vscode from 'vscode'
import { formatFileBlock, isBinaryFile, MAX_CONTENT_LENGTH } from './formatter'

export interface ClipItem {
  id: string
  uri: vscode.Uri
  relativePath: string
  language: string
  isSnippet: boolean
  lineRange?: string // 例如 "lines 10-25" 或 "line 10"
  snippetContent?: string
  previewText: string
  addedAt: number
}

export class ClipStackManager {
  private static instance: ClipStackManager
  private items: ClipItem[] = []
  private statusBarItem: vscode.StatusBarItem

  private constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
    this.statusBarItem.command = 'copy-code-with-path.manageStack'
    this.updateStatusBar()
  }

  public static getInstance(): ClipStackManager {
    if (!ClipStackManager.instance) {
      ClipStackManager.instance = new ClipStackManager()
    }
    return ClipStackManager.instance
  }

  public getStatusBarItem(): vscode.StatusBarItem {
    return this.statusBarItem
  }

  public addItem(item: ClipItem): void {
    if (!item.isSnippet) {
      const existingIdx = this.items.findIndex((i) => !i.isSnippet && i.uri.fsPath === item.uri.fsPath)
      if (existingIdx !== -1) {
        this.items[existingIdx] = item
        this.updateStatusBar()
        return
      }
    }
    this.items.push(item)
    this.updateStatusBar()
  }

  public popItem(): ClipItem | undefined {
    const item = this.items.pop()
    this.updateStatusBar()
    return item
  }

  public removeById(id: string): boolean {
    const prevLength = this.items.length
    this.items = this.items.filter((i) => i.id !== id)
    const removed = this.items.length < prevLength
    if (removed) {
      this.updateStatusBar()
    }
    return removed
  }

  public removeByUri(uri: vscode.Uri): number {
    const prevLength = this.items.length
    this.items = this.items.filter((i) => i.uri.fsPath !== uri.fsPath)
    const count = prevLength - this.items.length
    if (count > 0) {
      this.updateStatusBar()
    }
    return count
  }

  public clear(): void {
    this.items = []
    this.updateStatusBar()
  }

  public getItems(): ClipItem[] {
    return [...this.items]
  }

  public count(): number {
    return this.items.length
  }

  public updateStatusBar(): void {
    const count = this.items.length
    if (count > 0) {
      this.statusBarItem.text = `$(layers) Clip Stack: ${count}`
      this.statusBarItem.tooltip = vscode.l10n.t('Clip Stack contains {0} item(s). Click to manage or copy.', count)
      this.statusBarItem.show()
    } else {
      this.statusBarItem.hide()
    }
  }

  public async formatAll(): Promise<[string, number, boolean]> {
    const formattedBlocks: string[] = []
    let currentLength = 0
    let stoppedEarly = false

    for (const item of this.items) {
      let content = ''
      if (item.isSnippet) {
        content = item.snippetContent || ''
      } else {
        if (isBinaryFile(item.uri.fsPath)) {
          formattedBlocks.push(`File: ${item.relativePath}\n`)
          continue
        }
        const openDoc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === item.uri.fsPath)
        if (openDoc) {
          content = openDoc.getText()
        } else {
          try {
            const bytes = await vscode.workspace.fs.readFile(item.uri)
            content = Buffer.from(bytes).toString('utf8')
          } catch {
            content = ''
          }
        }
      }

      const block = isBinaryFile(item.uri.fsPath)
        ? `File: ${item.relativePath}\n`
        : formatFileBlock(item.relativePath, item.language, content, item.lineRange)

      if (currentLength + block.length > MAX_CONTENT_LENGTH) {
        stoppedEarly = true
        break
      }

      formattedBlocks.push(block)
      currentLength += block.length
    }

    const finalContent = formattedBlocks.join('\n\n---\n\n')
    return [finalContent, formattedBlocks.length, stoppedEarly]
  }
}
