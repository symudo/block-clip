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
import java.awt.datatransfer.StringSelection

/**
 * 编辑器内独立右键动作：复制当前选中的代码片段（与 VS Code copySelection 100% 对齐）。
 */
class CopySelectionAction : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val editor = getSelectionEditor(e)
        e.presentation.isEnabledAndVisible = editor != null
        e.presentation.text = BlockClipBundle.message("action.CopySelection.text")
        e.presentation.description = BlockClipBundle.message("action.CopySelection.description")
    }

    override fun actionPerformed(e: AnActionEvent) {
        val editor = getSelectionEditor(e) ?: return
        copyEditorSelection(e.project, editor)
    }

    companion object {
        fun getSelectionEditor(e: AnActionEvent): Editor? {
            if (e.place == ActionPlaces.PROJECT_VIEW_POPUP || e.place == ActionPlaces.EDITOR_TAB_POPUP) {
                return null
            }
            val editor = e.getData(CommonDataKeys.EDITOR) ?: return null
            return if (editor.selectionModel.hasSelection()) editor else null
        }

        fun copyEditorSelection(project: com.intellij.openapi.project.Project?, editor: Editor): Boolean {
            val selectionModel = editor.selectionModel
            val selectedText = selectionModel.selectedText ?: ""
            val document = editor.document
            val startLineIdx = document.getLineNumber(selectionModel.selectionStart)
            val endLineIdx = document.getLineNumber(selectionModel.selectionEnd)
            val endCol = selectionModel.selectionEnd - document.getLineStartOffset(endLineIdx)
            val lineRange = MarkdownFormatter.formatLineRange(startLineIdx, endLineIdx, endCol)

            val file = FileDocumentManager.getInstance().getFile(document) ?: return false
            val maxSizeMB = BlockClipSettings.getCurrentMaxSizeMB()
            val maxLength = BlockClipSettings.getCurrentMaxLength()
            val formatted = MarkdownFormatter.formatSelection(file, project, selectedText, lineRange)
            if (formatted.length.toLong() > maxLength) {
                notify(project, BlockClipBundle.message("notification.error.too.large", maxSizeMB), NotificationType.WARNING)
                return true
            }

            CopyPasteManager.getInstance().setContents(StringSelection(formatted))
            val stats = MarkdownFormatter.formatStats(formatted)
            notify(
                project,
                BlockClipBundle.message("notification.copied.snippet", file.name, lineRange, stats),
                NotificationType.INFORMATION
            )
            return true
        }

        private fun notify(project: com.intellij.openapi.project.Project?, content: String, type: NotificationType) {
            NotificationGroupManager.getInstance()
                .getNotificationGroup("BlockClip Notification")
                .createNotification(content, type)
                .notify(project)
        }
    }
}
