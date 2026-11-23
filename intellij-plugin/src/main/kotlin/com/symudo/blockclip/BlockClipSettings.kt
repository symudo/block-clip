package com.symudo.blockclip

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

@Service(Service.Level.APP)
@State(
    name = "com.symudo.blockclip.BlockClipSettings",
    storages = [Storage("BlockClipSettings.xml")]
)
class BlockClipSettings : PersistentStateComponent<BlockClipSettings.StateData> {

    data class StateData(
        var maxContentSizeMB: Int = DEFAULT_MAX_CONTENT_SIZE_MB
    )

    private var state = StateData()

    override fun getState(): StateData = state

    override fun loadState(state: StateData) {
        this.state = StateData(maxContentSizeMB = state.maxContentSizeMB.coerceAtLeast(0))
    }

    var maxContentSizeMB: Int
        get() = state.maxContentSizeMB
        set(value) {
            state.maxContentSizeMB = value.coerceAtLeast(0)
        }

    companion object {
        const val DEFAULT_MAX_CONTENT_SIZE_MB = 50

        fun getInstance(): BlockClipSettings? {
            return ApplicationManager.getApplication()?.getService(BlockClipSettings::class.java)
        }

        fun getCurrentMaxSizeMB(): Int {
            return getInstance()?.maxContentSizeMB ?: DEFAULT_MAX_CONTENT_SIZE_MB
        }

        fun getCurrentMaxLength(): Long {
            return MarkdownFormatter.resolveMaxContentLength(getCurrentMaxSizeMB())
        }
    }
}
