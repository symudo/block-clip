package com.symudo.blockclip

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.vfs.VirtualFile

class RemoveFromStackAction : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val targets = getTargetEntries(e)
        e.presentation.isEnabledAndVisible = targets.isNotEmpty()
        e.presentation.text = BlockClipBundle.message("action.RemoveFromStack.text")
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val targets = getTargetEntries(e)
        if (targets.isEmpty()) return

        val stackService = ClipStackService.getInstance(project)
        var removedCount = 0
        for (target in targets) {
            removedCount += if (target.isDirectory) {
                stackService.removeByDirectory(target)
            } else {
                stackService.removeByFile(target)
            }
        }

        if (removedCount > 0) {
            notify(
                project,
                BlockClipBundle.message("notification.stack.removed.file", removedCount, stackService.count()),
                NotificationType.INFORMATION
            )
        } else {
            notify(
                project,
                BlockClipBundle.message("notification.stack.no.match"),
                NotificationType.WARNING
            )
        }
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
