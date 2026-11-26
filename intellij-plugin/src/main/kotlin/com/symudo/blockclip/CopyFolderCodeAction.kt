package com.symudo.blockclip

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import java.awt.datatransfer.StringSelection
import java.io.File

class CopyFolderCodeAction : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread {
        return ActionUpdateThread.BGT
    }

    override fun update(e: AnActionEvent) {
        val folder = getTargetFolder(e)
        e.presentation.isEnabledAndVisible = folder != null && folder.isDirectory
        e.presentation.text = BlockClipBundle.message("action.CopyFolderCode.text")
        e.presentation.description = BlockClipBundle.message("action.CopyFolderCode.description")
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project
        val folder = getTargetFolder(e)

        if (folder == null || !folder.isDirectory) {
            notify(
                project,
                BlockClipBundle.message("notification.error.no.path"),
                NotificationType.ERROR
            )
            return
        }

        val folderName = folder.name
        ProgressManager.getInstance().run(object : Task.Backgroundable(
            project,
            BlockClipBundle.message("progress.copying.folder", folderName),
            true
        ) {
            override fun run(indicator: ProgressIndicator) {
                indicator.isIndeterminate = true
                try {
                    val projectBaseDir = project?.basePath?.let { File(it) }
                    val files = GitIgnoreFilter.collectAllFiles(folder, projectBaseDir, indicator, project)

                    if (files.isEmpty()) {
                        notify(
                            project,
                            BlockClipBundle.message("notification.empty.folder"),
                            NotificationType.WARNING
                        )
                        return
                    }

                    indicator.checkCanceled()
                    val maxSizeMB = BlockClipSettings.getCurrentMaxSizeMB()
                    val maxLength = BlockClipSettings.getCurrentMaxLength()
                    val result = MarkdownFormatter.processFiles(files, project, maxLength)

                    if (result.processedCount == 0) {
                        val warnMsg = if (result.stoppedEarly) {
                            BlockClipBundle.message("notification.error.too.large", maxSizeMB)
                        } else {
                            BlockClipBundle.message("notification.empty.folder")
                        }
                        notify(project, warnMsg, NotificationType.WARNING)
                        return
                    }

                    CopyPasteManager.getInstance().setContents(StringSelection(result.content))
                    val stats = MarkdownFormatter.formatStats(result.content)

                    val message = if (result.stoppedEarly) {
                        BlockClipBundle.message(
                            "notification.copied.truncated.folder",
                            folderName,
                            result.processedCount,
                            stats
                        )
                    } else {
                        BlockClipBundle.message(
                            "notification.copied.folder",
                            folderName,
                            result.processedCount,
                            stats
                        )
                    }

                    val type = if (result.stoppedEarly) NotificationType.WARNING else NotificationType.INFORMATION
                    notify(project, message, type)
                } catch (ex: Exception) {
                    if (ex is ProcessCanceledException) {
                        throw ex
                    }
                    notify(
                        project,
                        BlockClipBundle.message("notification.error.folder", ex.message ?: "Unknown error"),
                        NotificationType.ERROR
                    )
                }
            }
        })
    }

    private fun getTargetFolder(e: AnActionEvent): VirtualFile? {
        val fileArray = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)
        if (!fileArray.isNullOrEmpty()) {
            return if (fileArray.size == 1 && fileArray[0].isDirectory) fileArray[0] else null
        }
        val singleFile = e.getData(CommonDataKeys.VIRTUAL_FILE)
        if (singleFile != null) {
            return if (singleFile.isDirectory) singleFile else null
        }
        // 非目录树右键（如 Find Action / 全局调用）无目录选中时自动回退至项目根目录（与 VS Code 对齐）
        if (e.place != ActionPlaces.PROJECT_VIEW_POPUP) {
            val basePath = e.project?.basePath ?: return null
            return LocalFileSystem.getInstance().findFileByPath(basePath)?.takeIf { it.isDirectory }
        }
        return null
    }

    private fun notify(project: com.intellij.openapi.project.Project?, content: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("BlockClip Notification")
            .createNotification(content, type)
            .notify(project)
    }
}
