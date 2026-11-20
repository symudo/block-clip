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
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.vfs.VirtualFile
import java.awt.datatransfer.StringSelection

class CopyCodeAction : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread {
        return ActionUpdateThread.BGT
    }

    private fun shouldCopyEditorSelection(e: AnActionEvent): Editor? {
        // 在项目树或标签页右键时，始终复制整文件，不被编辑器遗留选区干扰
        if (e.place == ActionPlaces.PROJECT_VIEW_POPUP || e.place == ActionPlaces.EDITOR_TAB_POPUP) {
            return null
        }
        val editor = e.getData(CommonDataKeys.EDITOR) ?: return null
        return if (editor.selectionModel.hasSelection()) editor else null
    }

    override fun update(e: AnActionEvent) {
        val selectionEditor = shouldCopyEditorSelection(e)
        if (selectionEditor != null) {
            e.presentation.isEnabledAndVisible = true
            e.presentation.text = BlockClipBundle.message("action.CopySelection.text")
            e.presentation.description = BlockClipBundle.message("action.CopySelection.description")
            return
        }

        val files = getTargetFiles(e)
        val hasFiles = files.any { !it.isDirectory }
        e.presentation.isEnabledAndVisible = hasFiles
        e.presentation.text = BlockClipBundle.message("action.CopyCode.text")
        e.presentation.description = BlockClipBundle.message("action.CopyCode.description")
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project

        // 场景 A: 编辑器内有选中文本，直接复制选区（带相对路径、行号与体积/Token 估算）
        val selectionEditor = shouldCopyEditorSelection(e)
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
                val formatted = MarkdownFormatter.formatSelection(file, project, selectedText, lineRange)
                CopyPasteManager.getInstance().setContents(StringSelection(formatted))
                val stats = MarkdownFormatter.formatStats(formatted)
                notify(
                    project,
                    BlockClipBundle.message("notification.copied.snippet", file.name, lineRange, stats),
                    NotificationType.INFORMATION
                )
                return
            }
        }

        // 场景 B: 单文件 / 多文件复制
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
            val stats = MarkdownFormatter.formatStats(result.content)

            val message = when {
                result.stoppedEarly -> BlockClipBundle.message(
                    "notification.copied.truncated.files",
                    result.processedCount,
                    stats
                )
                files.size > 1 -> BlockClipBundle.message(
                    "notification.copied.multiple",
                    files.size,
                    stats
                )
                else -> BlockClipBundle.message(
                    "notification.copied.single",
                    files[0].name,
                    stats
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
