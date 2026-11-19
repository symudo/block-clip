package com.symudo.blockclip

import com.intellij.openapi.vfs.VirtualFile
import java.util.UUID

data class ClipItem(
    val id: String = UUID.randomUUID().toString(),
    val file: VirtualFile,
    val relativePath: String,
    val language: String,
    val isSnippet: Boolean,
    val lineRange: String? = null,
    val snippetContent: String? = null,
    val previewText: String = "",
    val addedAt: Long = System.currentTimeMillis()
)
