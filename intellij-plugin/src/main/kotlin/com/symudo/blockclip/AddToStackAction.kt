package com.symudo.blockclip

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.vfs.VirtualFile
import java.io.File

class AddToStackAction : AnAction(), DumbAware {

    // 必须使用 BGT：在 IntelliJ 2024.3~2026.3 的 ProjectViewPopupMenu 中 VIRTUAL_FILE_ARRAY 由后台数据提供器提供
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    private fun isPopupPlace(place: String): Boolean {
        return place == ActionPlaces.PROJECT_VIEW_POPUP ||
            place == ActionPlaces.EDITOR_TAB_POPUP ||
            place == ActionPlaces.EDITOR_POPUP
    }

    override fun update(e: AnActionEvent) {
        val targets = getTargetEntries(e)
        e.presentation.isEnabledAndVisible = targets.isNotEmpty()
        val hasDirectory = targets.any { it.isDirectory }
        e.presentation.text = if (hasDirectory) {
            BlockClipBundle.message("action.AddToStack.folder.text")
        } else {
            BlockClipBundle.message("action.AddToStack.file.text")
        }
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val stackService = ClipStackService.getInstance(project)

        // 通过快捷键（Alt+Shift+S）等非右键菜单触发且编辑器有选区时，智能将选区加入暂存栈（与 VS Code 100% 对齐）
        if (!isPopupPlace(e.place)) {
            val selectionEditor = AddSelectionToStackAction.getSelectionEditor(e)
            if (selectionEditor != null && AddSelectionToStackAction.addEditorSelectionToStack(project, selectionEditor)) {
                return
            }
        }

        // 场景 B: 单文件 / 多文件 / 文件夹递归入栈
        val targets = getTargetEntries(e)
        if (targets.isEmpty()) {
            notify(project, BlockClipBundle.message("notification.no.files"), NotificationType.WARNING)
            return
        }

        val hasDirectory = targets.any { it.isDirectory }
        if (hasDirectory) {
            ProgressManager.getInstance().run(object : Task.Backgroundable(
                project,
                BlockClipBundle.message("progress.adding.to.stack"),
                true
            ) {
                override fun run(indicator: ProgressIndicator) {
                    indicator.isIndeterminate = true
                    try {
                        val projectBaseDir = project.basePath?.let { File(it) }
                        val collected = mutableListOf<VirtualFile>()
                        for (entry in targets) {
                            indicator.checkCanceled()
                            if (entry.isDirectory) {
                                collected.addAll(GitIgnoreFilter.collectAllFiles(entry, projectBaseDir, indicator, project))
                            } else {
                                collected.add(entry)
                            }
                        }
                        addFilesToStack(project, stackService, collected)
                    } catch (ex: Exception) {
                        if (ex is ProcessCanceledException) throw ex
                        notify(
                            project,
                            BlockClipBundle.message("notification.error.folder", ex.message ?: "Unknown error"),
                            NotificationType.ERROR
                        )
                    }
                }
            })
        } else {
            addFilesToStack(project, stackService, targets)
        }
    }

    private fun addFilesToStack(
        project: com.intellij.openapi.project.Project,
        stackService: ClipStackService,
        files: List<VirtualFile>
    ) {
        if (files.isEmpty()) {
            notify(project, BlockClipBundle.message("notification.no.files"), NotificationType.WARNING)
            return
        }

        val wholeFileLabel = BlockClipBundle.message("label.whole.file")
        val itemsToAdd = files.map { file ->
            ClipItem(
                file = file,
                relativePath = MarkdownFormatter.getRelativePath(file, project),
                language = MarkdownFormatter.getLanguage(file),
                isSnippet = false,
                previewText = wholeFileLabel
            )
        }
        val addedUniqueCount = stackService.addItems(itemsToAdd)

        notify(
            project,
            BlockClipBundle.message("notification.stack.added.files", addedUniqueCount, stackService.count()),
            NotificationType.INFORMATION
        )
    }

    private fun getTargetEntries(e: AnActionEvent): List<VirtualFile> {
        val fileArray = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)
        if (!fileArray.isNullOrEmpty()) return fileArray.toList()

        val singleFile = e.getData(CommonDataKeys.VIRTUAL_FILE)
        if (singleFile != null) return listOf(singleFile)

        if (e.place == ActionPlaces.PROJECT_VIEW_POPUP || e.place == ActionPlaces.EDITOR_TAB_POPUP) {
            return emptyList()
        }

        val editor = e.getData(CommonDataKeys.EDITOR)
        val document = editor?.document
        if (document != null) {
            val virtualFile = FileDocumentManager.getInstance().getFile(document)
            if (virtualFile != null) return listOf(virtualFile)
        }
        return emptyList()
    }

    private fun notify(project: com.intellij.openapi.project.Project?, content: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("BlockClip Notification")
            .createNotification(content, type)
            .notify(project)
    }
}
