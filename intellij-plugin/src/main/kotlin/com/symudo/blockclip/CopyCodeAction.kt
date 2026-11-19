package com.symudo.blockclip

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.vfs.VirtualFile
import java.awt.datatransfer.StringSelection

class CopyCodeAction : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread {
        return ActionUpdateThread.BGT
    }

    override fun update(e: AnActionEvent) {
        val files = getTargetFiles(e)
        // 只要存在选中的非目录文件，或者在活动的文本编辑器中，即显示并启用
        val hasFiles = files.any { !it.isDirectory }
        e.presentation.isEnabledAndVisible = hasFiles
        e.presentation.text = BlockClipBundle.message("action.CopyCode.text")
        e.presentation.description = BlockClipBundle.message("action.CopyCode.description")
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project
        val files = getTargetFiles(e).filter { !it.isDirectory }

        if (files.isEmpty()) {
            notify(
                project,
                BlockClipBundle.message("notification.no.files"),
                NotificationType.WARNING
            )
            return
        }

        try {
            val result = MarkdownFormatter.processFiles(files, project)
            CopyPasteManager.getInstance().setContents(StringSelection(result.content))

            val message = when {
                result.stoppedEarly -> BlockClipBundle.message(
                    "notification.copied.truncated.files",
                    result.processedCount
                )
                files.size > 1 -> BlockClipBundle.message(
                    "notification.copied.multiple",
                    files.size
                )
                else -> BlockClipBundle.message(
                    "notification.copied.single",
                    files[0].name
                )
            }

            val type = if (result.stoppedEarly) NotificationType.WARNING else NotificationType.INFORMATION
            notify(project, message, type)
        } catch (ex: Exception) {
            notify(
                project,
                BlockClipBundle.message("notification.error.file", ex.message ?: "Unknown error"),
                NotificationType.ERROR
            )
        }
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

        val editor = e.getData(CommonDataKeys.EDITOR)
        val document = editor?.document
        if (document != null) {
            val virtualFile = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getFile(document)
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
