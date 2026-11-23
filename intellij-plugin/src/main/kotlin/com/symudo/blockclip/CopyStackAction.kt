package com.symudo.blockclip

import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
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
        executeCopyStack(project)
    }

    companion object {
        fun executeCopyStack(project: Project) {
            val stackService = ClipStackService.getInstance(project)

            if (stackService.count() == 0) {
                notify(project, BlockClipBundle.message("notification.stack.empty"), NotificationType.WARNING)
                return
            }

            ProgressManager.getInstance().run(object : Task.Backgroundable(
                project,
                BlockClipBundle.message("progress.copying.stack"),
                true
            ) {
                override fun run(indicator: ProgressIndicator) {
                    indicator.isIndeterminate = true
                    try {
                        indicator.checkCanceled()
                        val maxSizeMB = BlockClipSettings.getCurrentMaxSizeMB()
                        val maxLength = BlockClipSettings.getCurrentMaxLength()
                        val result = stackService.formatAll(maxLength)

                        if (result.processedCount == 0) {
                            val warnMsg = if (result.stoppedEarly) {
                                BlockClipBundle.message("notification.error.too.large", maxSizeMB)
                            } else {
                                BlockClipBundle.message("notification.stack.no.readable")
                            }
                            notify(project, warnMsg, NotificationType.WARNING)
                            return
                        }

                        CopyPasteManager.getInstance().setContents(StringSelection(result.content))
                        val stats = MarkdownFormatter.formatStats(result.content)

                        val message = if (result.stoppedEarly) {
                            BlockClipBundle.message("notification.stack.copied.truncated", result.processedCount, stats)
                        } else {
                            BlockClipBundle.message("notification.stack.copied.all", result.processedCount, stats)
                        }

                        val type = if (result.stoppedEarly) NotificationType.WARNING else NotificationType.INFORMATION
                        val notification = NotificationGroupManager.getInstance()
                            .getNotificationGroup("BlockClip Notification")
                            .createNotification(message, type)

                        notification.addAction(
                            NotificationAction.createSimpleExpiring(BlockClipBundle.message("action.ClearStack.short.text")) {
                                stackService.clear()
                                notify(project, BlockClipBundle.message("notification.stack.cleared"), NotificationType.INFORMATION)
                            }
                        )
                        notification.notify(project)
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

        private fun notify(project: Project?, content: String, type: NotificationType) {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("BlockClip Notification")
                .createNotification(content, type)
                .notify(project)
        }
    }
}
