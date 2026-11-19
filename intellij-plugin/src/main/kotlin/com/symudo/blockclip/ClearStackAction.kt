package com.symudo.blockclip

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAware

class ClearStackAction : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        val count = if (project != null) ClipStackService.getInstance(project).count() else 0
        e.presentation.isEnabled = count > 0
        e.presentation.text = BlockClipBundle.message("action.ClearStack.text")
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val stackService = ClipStackService.getInstance(project)

        if (stackService.count() == 0) {
            notify(project, BlockClipBundle.message("notification.stack.already.empty"), NotificationType.INFORMATION)
            return
        }

        stackService.clear()
        notify(project, BlockClipBundle.message("notification.stack.cleared"), NotificationType.INFORMATION)
    }

    private fun notify(project: com.intellij.openapi.project.Project?, content: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("BlockClip Notification")
            .createNotification(content, type)
            .notify(project)
    }
}
