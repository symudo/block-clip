package com.symudo.blockclip

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbAware
import java.awt.datatransfer.StringSelection

class CopyStackAction : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        val count = if (project != null) ClipStackService.getInstance(project).count() else 0
        e.presentation.text = if (count > 0) {
            BlockClipBundle.message("action.CopyStack.count.text", count)
        } else {
            BlockClipBundle.message("action.CopyStack.text")
        }
        e.presentation.isEnabledAndVisible = true
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val stackService = ClipStackService.getInstance(project)

        if (stackService.count() == 0) {
            notify(project, BlockClipBundle.message("notification.stack.empty"), NotificationType.WARNING)
            return
        }

        try {
            val result = stackService.formatAll()
            CopyPasteManager.getInstance().setContents(StringSelection(result.content))

            val message = if (result.stoppedEarly) {
                BlockClipBundle.message("notification.stack.copied.truncated", result.processedCount)
            } else {
                BlockClipBundle.message("notification.stack.copied.all", result.processedCount)
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

    private fun notify(project: com.intellij.openapi.project.Project?, content: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("BlockClip Notification")
            .createNotification(content, type)
            .notify(project)
    }
}
