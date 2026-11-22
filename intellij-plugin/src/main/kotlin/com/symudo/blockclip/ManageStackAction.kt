package com.symudo.blockclip

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep

class ManageStackAction : AnAction(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        val count = if (project != null) ClipStackService.getInstance(project).count() else 0
        e.presentation.isEnabled = count > 0
        e.presentation.text = BlockClipBundle.message("action.ManageStack.text")
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val stackService = ClipStackService.getInstance(project)
        val items = stackService.getItems()

        if (items.isEmpty()) {
            notify(project, BlockClipBundle.message("notification.stack.empty"), NotificationType.WARNING)
            return
        }

        data class PopupEntry(val title: String, val item: ClipItem?, val actionId: String? = null)

        val entries = mutableListOf<PopupEntry>()
        entries.add(PopupEntry(BlockClipBundle.message("action.CopyStack.text"), null, "copy"))
        entries.add(PopupEntry(BlockClipBundle.message("action.ClearStack.text"), null, "clear"))

        items.forEachIndexed { index, item ->
            val tag = if (item.isSnippet) "(${item.lineRange})" else "(${BlockClipBundle.message("label.whole.file")})"
            entries.add(PopupEntry("${index + 1}. ${item.relativePath} $tag - ${item.previewText}", item))
        }

        val step = object : BaseListPopupStep<PopupEntry>(
            BlockClipBundle.message("title.manage.stack", items.size),
            entries
        ) {
            override fun getTextFor(value: PopupEntry): String = value.title

            // 必须覆写 hasSubstep，否则 IntelliJ Popup 框架不会展开二级“跳转 / 删除”子菜单
            override fun hasSubstep(selectedValue: PopupEntry?): Boolean = selectedValue?.item != null

            override fun onChosen(selectedValue: PopupEntry?, finalChoice: Boolean): PopupStep<*>? {
                if (selectedValue == null) return FINAL_CHOICE

                if (selectedValue.item == null) {
                    return doFinalStep {
                        when (selectedValue.actionId) {
                            "copy" -> CopyStackAction.executeCopyStack(project)
                            "clear" -> ClearStackAction.executeClearStack(project)
                        }
                    }
                }

                val item = selectedValue.item
                val jumpLabel = BlockClipBundle.message("action.jump.to.item")
                val removeLabel = BlockClipBundle.message("action.remove.item")

                return object : BaseListPopupStep<String>(
                    item.relativePath,
                    listOf(jumpLabel, removeLabel)
                ) {
                    override fun onChosen(actionTitle: String?, finalChoice2: Boolean): PopupStep<*>? {
                        return doFinalStep {
                            if (actionTitle == removeLabel) {
                                stackService.removeById(item.id)
                                notify(
                                    project,
                                    BlockClipBundle.message("notification.stack.item.removed"),
                                    NotificationType.INFORMATION
                                )
                            } else if (actionTitle == jumpLabel) {
                                if (!item.file.isValid) {
                                    notify(
                                        project,
                                        BlockClipBundle.message("notification.file.not.found", item.relativePath),
                                        NotificationType.WARNING
                                    )
                                } else {
                                    val startLineZeroBased = MarkdownFormatter.parseStartLineZeroBased(item.lineRange)
                                    val descriptor = OpenFileDescriptor(project, item.file, startLineZeroBased, 0)
                                    FileEditorManager.getInstance(project).openTextEditor(descriptor, true)
                                }
                            }
                        }
                    }
                }
            }
        }

        JBPopupFactory.getInstance().createListPopup(step).showInBestPositionFor(e.dataContext)
    }

    private fun notify(project: com.intellij.openapi.project.Project?, content: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("BlockClip Notification")
            .createNotification(content, type)
            .notify(project)
    }
}
