import { formatFileBlock, isBinaryFile, MAX_CONTENT_LENGTH, normalizePathKey, sanitizeForClipboard } from './formatter'

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

export type FileReadResult =
  | { status: 'ok'; content: string }
  | { status: 'binary' }
  | { status: 'missing' }
  | { status: 'too_large' }

export interface FormatAllResult {
  content: string
  processedCount: number
  stoppedEarly: boolean
  skippedMissingCount: number
  firstProcessedPath?: string
  cancelled?: boolean
}

export interface FormatAllOptions<T> {
  isCancelled?: () => boolean
  onProgress?: (processed: number, total: number, item: T) => void
}

export class ClipStackStore<T extends StackEntry = StackEntry> {
  private items: T[] = []

  public addItem(item: T): void {
    if (!item.isSnippet) {
      const targetKey = normalizePathKey(item.fsPath)
      const existingIdx = this.items.findIndex((i) => !i.isSnippet && normalizePathKey(i.fsPath) === targetKey)
      if (existingIdx !== -1) {
        this.items[existingIdx] = item
        return
      }
    }
    this.items.push(item)
  }

  /**
   * 批量入栈（O(N) 索引去重），返回本次实际唯一添加/更新的条目数。
   */
  public addItems(newItems: T[]): number {
    if (newItems.length === 0) {
      return 0
    }
    const wholeFileIndexMap = new Map<string, number>()
    this.items.forEach((existing, idx) => {
      if (!existing.isSnippet) {
        wholeFileIndexMap.set(normalizePathKey(existing.fsPath), idx)
      }
    })

    const seenKeysInBatch = new Set<string>()
    let uniqueCount = 0

    for (const item of newItems) {
      if (!item.isSnippet) {
        const key = normalizePathKey(item.fsPath)
        const existingIdx = wholeFileIndexMap.get(key)
        if (existingIdx !== undefined) {
          this.items[existingIdx] = item
        } else {
          wholeFileIndexMap.set(key, this.items.length)
          this.items.push(item)
        }
        if (!seenKeysInBatch.has(key)) {
          seenKeysInBatch.add(key)
          uniqueCount++
        }
      } else {
        this.items.push(item)
        uniqueCount++
      }
    }
    return uniqueCount
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
    const targetKey = normalizePathKey(fsPath)
    const prevLength = this.items.length
    this.items = this.items.filter((i) => normalizePathKey(i.fsPath) !== targetKey)
    return prevLength - this.items.length
  }

  public removeByDirectory(dirPath: string): number {
    const dirPrefix = `${normalizePathKey(dirPath).replace(/\/+$/, '')}/`
    const prevLength = this.items.length
    this.items = this.items.filter((i) => !normalizePathKey(i.fsPath).startsWith(dirPrefix))
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
    readFileContent: (item: T, remainingBudget: number) => Promise<FileReadResult>,
    maxLength: number = MAX_CONTENT_LENGTH,
    options?: FormatAllOptions<T>
  ): Promise<FormatAllResult> {
    const formattedBlocks: string[] = []
    let currentLength = 0
    let stoppedEarly = false
    let skippedMissingCount = 0
    let firstProcessedPath: string | undefined
    const total = this.items.length

    for (let i = 0; i < total; i++) {
      if (options?.isCancelled?.()) {
        return {
          content: '',
          processedCount: 0,
          stoppedEarly: false,
          skippedMissingCount,
          cancelled: true
        }
      }

      const item = this.items[i]
      options?.onProgress?.(i + 1, total, item)

      let block: string
      if (!item.isSnippet && isBinaryFile(item.fsPath)) {
        block = `File: ${item.relativePath}\n`
      } else if (item.isSnippet) {
        block = formatFileBlock(item.relativePath, item.language, item.snippetContent ?? '', item.lineRange)
      } else {
        const remaining = maxLength - currentLength
        const readResult = await readFileContent(item, remaining)
        if (options?.isCancelled?.()) {
          return {
            content: '',
            processedCount: 0,
            stoppedEarly: false,
            skippedMissingCount,
            cancelled: true
          }
        }
        if (readResult.status === 'missing') {
          skippedMissingCount++
          continue
        }
        if (readResult.status === 'too_large') {
          stoppedEarly = true
          break
        }
        block =
          readResult.status === 'binary'
            ? `File: ${item.relativePath}\n`
            : formatFileBlock(item.relativePath, item.language, readResult.content, item.lineRange)
      }

      if (currentLength + block.length > maxLength) {
        stoppedEarly = true
        break
      }

      if (!firstProcessedPath) {
        firstProcessedPath = item.fsPath
      }
      formattedBlocks.push(block)
      currentLength += block.length
    }

    const finalContent = sanitizeForClipboard(formattedBlocks.join('\n\n---\n\n'))
    return {
      content: finalContent,
      processedCount: formattedBlocks.length,
      stoppedEarly,
      skippedMissingCount,
      firstProcessedPath,
      cancelled: false
    }
  }
}
