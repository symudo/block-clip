package com.symudo.blockclip

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.vfs.VirtualFile
import java.awt.datatransfer.StringSelection

class CopyCodeAction : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    private fun isPopupPlace(place: String): Boolean {
        return place == ActionPlaces.PROJECT_VIEW_POPUP ||
            place == ActionPlaces.EDITOR_TAB_POPUP ||
            place == ActionPlaces.EDITOR_POPUP
    }

    override fun update(e: AnActionEvent) {
        val files = getTargetFiles(e)
        val hasFiles = files.any { !it.isDirectory }
        e.presentation.isEnabledAndVisible = hasFiles
        e.presentation.text = BlockClipBundle.message("action.CopyCode.text")
        e.presentation.description = BlockClipBundle.message("action.CopyCode.description")
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project

        // 通过快捷键（Alt+Shift+B）等非右键菜单触发且编辑器有选区时，智能复制选区（与 VS Code 100% 对齐）
        if (!isPopupPlace(e.place)) {
            val selectionEditor = CopySelectionAction.getSelectionEditor(e)
            if (selectionEditor != null && CopySelectionAction.copyEditorSelection(project, selectionEditor)) {
                return
            }
        }

        // 场景 B: 单文件 / 多文件复制（放入后台任务执行，杜绝阻塞 UI 主线程）
        val files = getTargetFiles(e).filter { !it.isDirectory }
        if (files.isEmpty()) {
            notify(project, BlockClipBundle.message("notification.no.files"), NotificationType.WARNING)
            return
        }

        ProgressManager.getInstance().run(object : Task.Backgroundable(
            project,
            BlockClipBundle.message("progress.copying.files"),
            true
        ) {
            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = true
                try {
                    indicator.checkCanceled()
                    val maxSizeMB = BlockClipSettings.getCurrentMaxSizeMB()
                    val maxLength = BlockClipSettings.getCurrentMaxLength()
                    val result = MarkdownFormatter.processFiles(files, project, maxLength)

                    if (result.processedCount == 0) {
                        val warnMsg = if (result.stoppedEarly) {
                            BlockClipBundle.message("notification.error.too.large", maxSizeMB)
                        } else {
                            BlockClipBundle.message("notification.no.files")
                        }
                        notify(project, warnMsg, NotificationType.WARNING)
                        return
                    }

                    CopyPasteManager.getInstance().setContents(StringSelection(result.content))
                    val stats = MarkdownFormatter.formatStats(result.content)

                    val message = when {
                        result.stoppedEarly -> BlockClipBundle.message(
                            "notification.copied.truncated.files",
                            result.processedCount,
                            stats
                        )
                        result.processedCount > 1 -> BlockClipBundle.message(
                            "notification.copied.multiple",
                            result.processedCount,
                            stats
                        )
                        else -> BlockClipBundle.message(
                            "notification.copied.single",
                            result.firstProcessedFileName ?: files[0].name,
                            stats
                        )
                    }

                    val type = if (result.stoppedEarly) NotificationType.WARNING else NotificationType.INFORMATION
                    notify(project, message, type)
                } catch (ex: Exception) {
                    if (ex is ProcessCanceledException) throw ex
                    notify(
                        project,
                        BlockClipBundle.message("notification.error.file", ex.message ?: "Unknown error"),
                        NotificationType.ERROR
                    )
                }
            }
        })
    }

    private fun getTargetFiles(e: AnActionEvent): List<VirtualFile> {
        val fileArray = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)
        if (!fileArray.isNullOrEmpty()) {
            return fileArray.toList()
        }

        val singleFile = e.getData(CommonDataKeys.VIRTUAL_FILE)
        if (singleFile != null) {
            return listOf(singleFile)
        }

        if (e.place == ActionPlaces.PROJECT_VIEW_POPUP || e.place == ActionPlaces.EDITOR_TAB_POPUP) {
            return emptyList()
        }

        val editor = e.getData(CommonDataKeys.EDITOR)
        val document = editor?.document
        if (document != null) {
            val virtualFile = FileDocumentManager.getInstance().getFile(document)
            if (virtualFile != null) {
                return listOf(virtualFile)
            }
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
