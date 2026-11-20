import { formatFileBlock, isBinaryFile, MAX_CONTENT_LENGTH } from './formatter'

export interface StackEntry {
  id: string
  fsPath: string
  relativePath: string
  language: string
  isSnippet: boolean
  lineRange?: string
  snippetContent?: string
  previewText: string
  addedAt: number
}

export class ClipStackStore<T extends StackEntry = StackEntry> {
  private items: T[] = []

  public addItem(item: T): void {
    if (!item.isSnippet) {
      const existingIdx = this.items.findIndex((i) => !i.isSnippet && i.fsPath === item.fsPath)
      if (existingIdx !== -1) {
        this.items[existingIdx] = item
        return
      }
    }
    this.items.push(item)
  }

  public popItem(): T | undefined {
    return this.items.pop()
  }

  public removeById(id: string): boolean {
    const prevLength = this.items.length
    this.items = this.items.filter((i) => i.id !== id)
    return this.items.length < prevLength
  }

  public removeByPath(fsPath: string): number {
    const prevLength = this.items.length
    this.items = this.items.filter((i) => i.fsPath !== fsPath)
    return prevLength - this.items.length
  }

  public clear(): void {
    this.items = []
  }

  public getItems(): T[] {
    return [...this.items]
  }

  public count(): number {
    return this.items.length
  }

  public async formatAll(
    readFileContent: (item: T) => Promise<string>,
    maxLength: number = MAX_CONTENT_LENGTH
  ): Promise<[string, number, boolean]> {
    const formattedBlocks: string[] = []
    let currentLength = 0
    let stoppedEarly = false

    for (const item of this.items) {
      let block: string
      if (!item.isSnippet && isBinaryFile(item.fsPath)) {
        block = `File: ${item.relativePath}\n`
      } else {
        const content = item.isSnippet ? (item.snippetContent ?? '') : await readFileContent(item)
        block = formatFileBlock(item.relativePath, item.language, content, item.lineRange)
      }

      if (currentLength + block.length > maxLength) {
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
