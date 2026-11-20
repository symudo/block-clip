package com.symudo.blockclip

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.vfs.VirtualFile
import java.io.File

class AddToStackAction : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    private fun shouldUseEditorSelection(e: AnActionEvent): Editor? {
        if (e.place == ActionPlaces.PROJECT_VIEW_POPUP || e.place == ActionPlaces.EDITOR_TAB_POPUP) {
            return null
        }
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return null
        return if (editor.selectionModel.hasSelection()) editor else null
    }

    override fun update(e: AnActionEvent) {
        val selectionEditor = shouldUseEditorSelection(e)
        if (selectionEditor != null) {
            e.presentation.isEnabledAndVisible = true
            e.presentation.text = BlockClipBundle.message("action.AddToStack.selection.text")
            return
        }

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

        // 场景 A: 编辑器内选定了部分代码片段
        val selectionEditor = shouldUseEditorSelection(e)
        if (selectionEditor != null) {
            val selectionModel = selectionEditor.selectionModel
            val selectedText = selectionModel.selectedText ?: ""
            val document = selectionEditor.document
            val startLineIdx = document.getLineNumber(selectionModel.selectionStart)
            val endLineIdx = document.getLineNumber(selectionModel.selectionEnd)
            val endCol = selectionModel.selectionEnd - document.getLineStartOffset(endLineIdx)
            val lineRange = MarkdownFormatter.formatLineRange(startLineIdx, endLineIdx, endCol)

            val file = FileDocumentManager.getInstance().getFile(document)
            if (file != null) {
                val relPath = MarkdownFormatter.getRelativePath(file, project)
                val lang = MarkdownFormatter.getLanguage(file)
                val preview = selectedText.trim().replace(Regex("\\s+"), " ").take(60)

                val item = ClipItem(
                    file = file,
                    relativePath = relPath,
                    language = lang,
                    isSnippet = true,
                    lineRange = lineRange,
                    snippetContent = selectedText,
                    previewText = preview
                )
                stackService.addItem(item)
                notify(
                    project,
                    BlockClipBundle.message("notification.stack.added.snippet", lineRange, stackService.count()),
                    NotificationType.INFORMATION
                )
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
                                collected.addAll(GitIgnoreFilter.collectAllFiles(entry, projectBaseDir, indicator))
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

        for (file in files) {
            val relPath = MarkdownFormatter.getRelativePath(file, project)
            val lang = MarkdownFormatter.getLanguage(file)
            val item = ClipItem(
                file = file,
                relativePath = relPath,
                language = lang,
                isSnippet = false,
                previewText = BlockClipBundle.message("label.whole.file")
            )
            stackService.addItem(item)
        }

        notify(
            project,
            BlockClipBundle.message("notification.stack.added.files", files.size, stackService.count()),
            NotificationType.INFORMATION
        )
    }

    private fun getTargetEntries(e: AnActionEvent): List<VirtualFile> {
        val fileArray = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)
        if (!fileArray.isNullOrEmpty()) return fileArray.toList()

        val singleFile = e.getData(CommonDataKeys.VIRTUAL_FILE)
        if (singleFile != null) return listOf(singleFile)

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
