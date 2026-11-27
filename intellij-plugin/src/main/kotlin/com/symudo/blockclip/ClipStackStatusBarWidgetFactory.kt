package com.symudo.blockclip

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import java.awt.Component
import java.awt.event.MouseEvent

/**
 * 底部状态栏实时暂存栈计数指示器（与 VS Code 状态栏 Clip Stack 指示器 100% 对齐）。
 * 栈为空时返回空文本不打扰界面；栈非空时显示计数，点击直接弹出暂存栈管理器。
 */
class ClipStackStatusBarWidgetFactory : StatusBarWidgetFactory {

    override fun getId(): String = WIDGET_ID

    override fun getDisplayName(): String = BlockClipBundle.message("group.ClipStack.text")

    override fun isAvailable(project: Project): Boolean = true

    override fun createWidget(project: Project): StatusBarWidget = ClipStackStatusBarWidget(project)

    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true

    companion object {
        const val WIDGET_ID = "com.symudo.blockclip.ClipStackStatusBarWidget"
    }
}

private class ClipStackStatusBarWidget(private val project: Project) :
    StatusBarWidget,
    StatusBarWidget.TextPresentation {

    override fun ID(): String = ClipStackStatusBarWidgetFactory.WIDGET_ID

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun getText(): String {
        if (project.isDisposed) return ""
        val count = ClipStackService.getInstance(project).count()
        return if (count > 0) BlockClipBundle.message("statusbar.clipStack.text", count) else ""
    }

    override fun getTooltipText(): String? {
        if (project.isDisposed) return null
        val count = ClipStackService.getInstance(project).count()
        return if (count > 0) BlockClipBundle.message("statusbar.clipStack.tooltip", count) else null
    }

    override fun getAlignment(): Float = Component.CENTER_ALIGNMENT

    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer {
        if (!project.isDisposed && ClipStackService.getInstance(project).count() > 0) {
            ManageStackAction.showManagePopup(project)
        }
    }

    override fun dispose() {}
}
