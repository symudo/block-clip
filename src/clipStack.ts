import * as vscode from 'vscode'
import { ClipStackStore, type FormatAllResult, type StackEntry } from './clipStackStore'
import { normalizePathKey } from './formatter'

export interface ClipItem extends StackEntry {
  uri: vscode.Uri
}

export class ClipStackManager {
  private static instance: ClipStackManager
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

  public getStatusBarItem(): vscode.StatusBarItem {
    return this.statusBarItem
  }

  public addItem(item: ClipItem): void {
    this.store.addItem(item)
    this.updateStatusBar()
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
      this.statusBarItem.text = `$(layers) Clip Stack: ${count}`
      this.statusBarItem.tooltip = vscode.l10n.t('Clip Stack contains {0} item(s). Click to manage or copy.', count)
      this.statusBarItem.show()
    } else {
      this.statusBarItem.hide()
    }
  }

  public async formatAll(): Promise<FormatAllResult> {
    return this.store.formatAll(async (item, remainingBudget) => {
      const targetKey = normalizePathKey(item.uri.fsPath)
      const openDoc = vscode.workspace.textDocuments.find((d) => normalizePathKey(d.uri.fsPath) === targetKey)
      if (openDoc) {
        const text = openDoc.getText()
        if (text.length > remainingBudget) {
          return { status: 'too_large' }
        }
        return { status: 'ok', content: text }
      }
      try {
        const stat = await vscode.workspace.fs.stat(item.uri)
        if (stat.size > remainingBudget) {
          return { status: 'too_large' }
        }
        const bytes = await vscode.workspace.fs.readFile(item.uri)
        return { status: 'ok', content: Buffer.from(bytes).toString('utf8') }
      } catch {
        return { status: 'missing' }
      }
    })
  }
}
