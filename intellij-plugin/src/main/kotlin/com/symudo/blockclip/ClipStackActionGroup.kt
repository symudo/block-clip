package com.symudo.blockclip

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.project.DumbAware

class ClipStackActionGroup : DefaultActionGroup(), DumbAware {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        val project = e.project
        val count = if (project != null) ClipStackService.getInstance(project).count() else 0
        e.presentation.text = if (count > 0) {
            BlockClipBundle.message("group.ClipStack.count.text", count)
        } else {
            BlockClipBundle.message("group.ClipStack.text")
        }
        e.presentation.isEnabledAndVisible = true
        e.presentation.isPopupGroup = true
    }
}
