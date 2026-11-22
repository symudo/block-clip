package com.symudo.blockclip

import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile

@Service(Service.Level.PROJECT)
class ClipStackService(private val project: Project) {

    private val items = mutableListOf<ClipItem>()

    @Synchronized
    fun addItem(item: ClipItem) {
        if (!item.isSnippet) {
            val targetKey = MarkdownFormatter.normalizePathKey(item.file.path)
            val existingIndex = items.indexOfFirst {
                !it.isSnippet && MarkdownFormatter.normalizePathKey(it.file.path) == targetKey
            }
            if (existingIndex != -1) {
                items[existingIndex] = item
                return
            }
        }
        items.add(item)
    }

    @Synchronized
    fun popItem(): ClipItem? {
        return if (items.isNotEmpty()) {
            items.removeAt(items.size - 1)
        } else {
            null
        }
    }

    @Synchronized
    fun removeById(id: String): Boolean {
        val prevSize = items.size
        items.removeAll { it.id == id }
        return items.size < prevSize
    }

    @Synchronized
    fun removeByFile(file: VirtualFile): Int {
        val targetKey = MarkdownFormatter.normalizePathKey(file.path)
        val prevSize = items.size
        items.removeAll { MarkdownFormatter.normalizePathKey(it.file.path) == targetKey }
        return prevSize - items.size
    }

    @Synchronized
    fun clear() {
        items.clear()
    }

    @Synchronized
    fun getItems(): List<ClipItem> {
        return items.toList()
    }

    @Synchronized
    fun count(): Int {
        return items.size
    }

    fun formatAll(): MarkdownFormatter.ProcessResult {
        val currentItems = getItems()
        return MarkdownFormatter.processClipItems(currentItems, project)
    }

    companion object {
        fun getInstance(project: Project): ClipStackService {
            return project.getService(ClipStackService::class.java)
        }
    }
}
