package com.symudo.blockclip

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.vfs.VirtualFile

class AddToStackAction : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val editor = e.getData(CommonDataKeys.EDITOR)
        val hasSelection = editor?.selectionModel?.hasSelection() == true
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        val hasFile = file != null && !file.isDirectory

        e.presentation.isEnabledAndVisible = hasSelection || hasFile
        if (hasSelection) {
            e.presentation.text = BlockClipBundle.message("action.AddToStack.selection.text")
        } else {
            e.presentation.text = BlockClipBundle.message("action.AddToStack.file.text")
        }
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val stackService = ClipStackService.getInstance(project)
        val editor = e.getData(CommonDataKeys.EDITOR)

        // 场景 A: 选定了部分代码片段
        if (editor != null && editor.selectionModel.hasSelection()) {
            val selectionModel = editor.selectionModel
            val selectedText = selectionModel.selectedText ?: ""
            val document = editor.document
            val startLine = document.getLineNumber(selectionModel.selectionStart) + 1
            val endLine = document.getLineNumber(selectionModel.selectionEnd) + 1
            val lineRange = if (startLine == endLine) "line $startLine" else "lines $startLine-$endLine"

            val file = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getFile(document)
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

        // 场景 B: 未选中文本，整文件入栈
        val files = getTargetFiles(e).filter { !it.isDirectory }
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

    private fun getTargetFiles(e: AnActionEvent): List<VirtualFile> {
        val fileArray = e.getData(CommonDataKeys.VIRTUAL_FILE_ARRAY)
        if (!fileArray.isNullOrEmpty()) return fileArray.toList()

        val singleFile = e.getData(CommonDataKeys.VIRTUAL_FILE)
        if (singleFile != null) return listOf(singleFile)

        val editor = e.getData(CommonDataKeys.EDITOR)
        val document = editor?.document
        if (document != null) {
            val virtualFile = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().getFile(document)
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
