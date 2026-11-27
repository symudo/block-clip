import * as fs from 'node:fs/promises'
import * as vscode from 'vscode'
import { ClipStackStore, type FormatAllOptions, type FormatAllResult, type StackEntry } from './clipStackStore'
import { isBinaryBuffer, normalizePathKey } from './formatter'

export interface ClipItem extends StackEntry {
  uri: vscode.Uri
}

export class ClipStackManager {
  private static instance: ClipStackManager | undefined
  private store = new ClipStackStore<ClipItem>()
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

  public static resetInstance(): void {
    ClipStackManager.instance = undefined
  }

  public getStatusBarItem(): vscode.StatusBarItem {
    return this.statusBarItem
  }

  public addItem(item: ClipItem): void {
    this.store.addItem(item)
    this.updateStatusBar()
  }

  public addItems(items: ClipItem[]): number {
    const addedCount = this.store.addItems(items)
    if (addedCount > 0) {
      this.updateStatusBar()
    }
    return addedCount
  }

  public popItem(): ClipItem | undefined {
    const item = this.store.popItem()
    this.updateStatusBar()
    return item
  }

  public removeById(id: string): boolean {
    const removed = this.store.removeById(id)
    if (removed) {
      this.updateStatusBar()
    }
    return removed
  }

  public removeByUri(uri: vscode.Uri): number {
    const count = this.store.removeByPath(uri.fsPath)
    if (count > 0) {
      this.updateStatusBar()
    }
    return count
  }

  public removeByDirectory(dirUri: vscode.Uri): number {
    const count = this.store.removeByDirectory(dirUri.fsPath)
    if (count > 0) {
      this.updateStatusBar()
    }
    return count
  }

  public clear(): void {
    this.store.clear()
    this.updateStatusBar()
  }

  public getItems(): ClipItem[] {
    return this.store.getItems()
  }

  public count(): number {
    return this.store.count()
  }

  public updateStatusBar(): void {
    const count = this.store.count()
    if (count > 0) {
      this.statusBarItem.text = `$(layers) ${vscode.l10n.t('Clip Stack: {0}', count)}`
      this.statusBarItem.tooltip = vscode.l10n.t('Clip Stack contains {0} item(s). Click to manage or copy.', count)
      this.statusBarItem.show()
    } else {
      this.statusBarItem.hide()
    }
  }

  private async isFileHeaderBinary(fileUri: vscode.Uri, sampleSize = 8192): Promise<boolean> {
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

  public async formatAll(maxLength?: number, options?: FormatAllOptions<ClipItem>): Promise<FormatAllResult> {
    return this.store.formatAll(
      async (item, remainingBudget) => {
        const targetUriStr = item.uri.toString()
        const targetKey = normalizePathKey(item.uri.fsPath)
        const openDoc = vscode.workspace.textDocuments.find(
          (d) =>
            d.uri.toString() === targetUriStr ||
            (d.uri.scheme === item.uri.scheme && normalizePathKey(d.uri.fsPath) === targetKey)
        )
        if (openDoc) {
          const text = openDoc.getText()
          if (text.length > remainingBudget) {
            return { status: 'too_large' }
          }
          return { status: 'ok', content: text }
        }
        if (item.uri.scheme === 'untitled') {
          return { status: 'missing' }
        }
        try {
          const stat = await vscode.workspace.fs.stat(item.uri)
          if (stat.size > 8192 && (await this.isFileHeaderBinary(item.uri))) {
            return { status: 'binary' }
          }
          if (stat.size > remainingBudget) {
            return { status: 'too_large' }
          }
          const bytes = await vscode.workspace.fs.readFile(item.uri)
          if (isBinaryBuffer(bytes)) {
            return { status: 'binary' }
          }
          return { status: 'ok', content: Buffer.from(bytes).toString('utf8') }
        } catch {
          return { status: 'missing' }
        }
      },
      maxLength,
      options
    )
  }
}
