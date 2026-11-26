package com.symudo.blockclip

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.WindowManager

@Service(Service.Level.PROJECT)
class ClipStackService(private val project: Project) {

    private val items = mutableListOf<ClipItem>()

    private fun updateStatusBar() {
        val app = ApplicationManager.getApplication() ?: return
        if (project.isDisposed) return
        app.invokeLater {
            if (!project.isDisposed) {
                WindowManager.getInstance()
                    ?.getStatusBar(project)
                    ?.updateWidget(ClipStackStatusBarWidgetFactory.WIDGET_ID)
            }
        }
    }

    @Synchronized
    fun addItem(item: ClipItem) {
        if (!item.isSnippet) {
            val targetKey = MarkdownFormatter.normalizePathKey(item.file.path)
            val existingIndex = items.indexOfFirst {
                !it.isSnippet && MarkdownFormatter.normalizePathKey(it.file.path) == targetKey
            }
            if (existingIndex != -1) {
                items[existingIndex] = item
                updateStatusBar()
                return
            }
        }
        items.add(item)
        updateStatusBar()
    }

    @Synchronized
    fun popItem(): ClipItem? {
        return if (items.isNotEmpty()) {
            val popped = items.removeAt(items.size - 1)
            updateStatusBar()
            popped
        } else {
            null
        }
    }

    @Synchronized
    fun removeById(id: String): Boolean {
        val prevSize = items.size
        items.removeAll { it.id == id }
        val removed = items.size < prevSize
        if (removed) updateStatusBar()
        return removed
    }

    @Synchronized
    fun removeByFile(file: VirtualFile): Int {
        val targetKey = MarkdownFormatter.normalizePathKey(file.path)
        val prevSize = items.size
        items.removeAll { MarkdownFormatter.normalizePathKey(it.file.path) == targetKey }
        val removed = prevSize - items.size
        if (removed > 0) updateStatusBar()
        return removed
    }

    @Synchronized
    fun removeByDirectory(dir: VirtualFile): Int {
        val prevSize = items.size
        items.removeAll { item ->
            MarkdownFormatter.isPathUnderDirectory(item.file.path, dir.path)
        }
        val removed = prevSize - items.size
        if (removed > 0) updateStatusBar()
        return removed
    }

    @Synchronized
    fun clear() {
        items.clear()
        updateStatusBar()
    }

    @Synchronized
    fun getItems(): List<ClipItem> {
        return items.toList()
    }

    @Synchronized
    fun count(): Int {
        return items.size
    }

    fun formatAll(
        maxLength: Long = BlockClipSettings.getCurrentMaxLength(),
        indicator: ProgressIndicator? = null
    ): MarkdownFormatter.ProcessResult {
        val currentItems = getItems()
        return MarkdownFormatter.processClipItems(currentItems, project, maxLength, indicator)
    }

    companion object {
        fun getInstance(project: Project): ClipStackService {
            return project.getService(ClipStackService::class.java)
        }
    }
}
