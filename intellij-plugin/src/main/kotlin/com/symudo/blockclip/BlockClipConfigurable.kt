package com.symudo.blockclip

import com.intellij.openapi.options.Configurable
import com.intellij.ui.components.JBLabel
import com.intellij.util.ui.FormBuilder
import com.intellij.util.ui.UIUtil
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JSpinner
import javax.swing.SpinnerNumberModel

class BlockClipConfigurable : Configurable {

    private var mainPanel: JPanel? = null
    private var maxSizeSpinner: JSpinner? = null

    override fun getDisplayName(): String = BlockClipBundle.message("settings.display.name")

    override fun createComponent(): JComponent {
        val currentVal = BlockClipSettings.getCurrentMaxSizeMB()
        val spinner = JSpinner(SpinnerNumberModel(currentVal, 0, 10000, 10))
        maxSizeSpinner = spinner

        val hintLabel = JBLabel(BlockClipBundle.message("settings.maxSizeMB.hint")).apply {
            foreground = UIUtil.getContextHelpForeground()
            font = UIUtil.getLabelFont(UIUtil.FontSize.SMALL)
        }

        val panel = FormBuilder.createFormBuilder()
            .addLabeledComponent(JBLabel(BlockClipBundle.message("settings.maxSizeMB.label")), spinner, 1, false)
            .addComponent(hintLabel, 4)
            .addComponentFillVertically(JPanel(), 0)
            .panel

        mainPanel = panel
        return panel
    }

    override fun isModified(): Boolean {
        val spinnerVal = (maxSizeSpinner?.value as? Number)?.toInt() ?: return false
        return spinnerVal != BlockClipSettings.getCurrentMaxSizeMB()
    }

    override fun apply() {
        val spinnerVal = (maxSizeSpinner?.value as? Number)?.toInt() ?: BlockClipSettings.DEFAULT_MAX_CONTENT_SIZE_MB
        BlockClipSettings.getInstance()?.maxContentSizeMB = spinnerVal.coerceAtLeast(0)
    }

    override fun reset() {
        maxSizeSpinner?.value = BlockClipSettings.getCurrentMaxSizeMB()
    }

    override fun disposeUIResources() {
        mainPanel = null
        maxSizeSpinner = null
    }
}
