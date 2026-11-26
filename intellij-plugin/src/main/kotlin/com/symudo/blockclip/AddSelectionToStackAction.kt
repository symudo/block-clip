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
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project

/**
 * 编辑器内独立右键动作：将当前选中的代码片段加入暂存栈（与 VS Code addSelectionToStack 100% 对齐）。
 */
class AddSelectionToStackAction : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val editor = getSelectionEditor(e)
        e.presentation.isEnabledAndVisible = editor != null
        e.presentation.text = BlockClipBundle.message("action.AddToStack.selection.text")
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = getSelectionEditor(e) ?: return
        addEditorSelectionToStack(project, editor)
    }

    companion object {
        fun getSelectionEditor(e: AnActionEvent): Editor? {
            if (e.place == ActionPlaces.PROJECT_VIEW_POPUP || e.place == ActionPlaces.EDITOR_TAB_POPUP) {
                return null
            }
            val editor = e.getData(CommonDataKeys.EDITOR) ?: return null
            return if (editor.selectionModel.hasSelection()) editor else null
        }

        fun addEditorSelectionToStack(project: Project, editor: Editor): Boolean {
            val selectionModel = editor.selectionModel
            val selectedText = selectionModel.selectedText ?: ""
            val document = editor.document
            val startLineIdx = document.getLineNumber(selectionModel.selectionStart)
            val endLineIdx = document.getLineNumber(selectionModel.selectionEnd)
            val endCol = selectionModel.selectionEnd - document.getLineStartOffset(endLineIdx)
            val lineRange = MarkdownFormatter.formatLineRange(startLineIdx, endLineIdx, endCol)

            val file = FileDocumentManager.getInstance().getFile(document) ?: return false
            val relPath = MarkdownFormatter.getRelativePath(file, project)
            val lang = MarkdownFormatter.getLanguage(file)
            val preview = selectedText.trim().replace(Regex("\\s+"), " ").take(60)

            val stackService = ClipStackService.getInstance(project)
            stackService.addItem(
                ClipItem(
                    file = file,
                    relativePath = relPath,
                    language = lang,
                    isSnippet = true,
                    lineRange = lineRange,
                    snippetContent = selectedText,
                    previewText = preview
                )
            )
            NotificationGroupManager.getInstance()
                .getNotificationGroup("BlockClip Notification")
                .createNotification(
                    BlockClipBundle.message("notification.stack.added.snippet", lineRange, stackService.count()),
                    NotificationType.INFORMATION
                )
                .notify(project)
            return true
        }
    }
}
