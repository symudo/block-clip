package com.symudo.blockclip

import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VfsUtilCore
import com.intellij.openapi.vfs.VirtualFile
import java.io.File

object MarkdownFormatter {
    const val MAX_CONTENT_LENGTH = 15 * 1024 * 1024 // 15MB

    private val binaryExtensions = setOf(
        "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "svg",
        "mp3", "wav", "ogg", "flac",
        "mp4", "webm", "mkv", "avi", "mov",
        "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
        "zip", "rar", "7z", "gz", "tar", "bz2",
        "exe", "dll", "so", "dylib", "app", "dmg",
        "class", "jar", "war", "ear",
        "woff", "woff2", "ttf", "otf", "eot",
        "lockb", "ds_store"
    )

    private val extensionToLanguageMap = mapOf(
        "js" to "javascript",
        "mjs" to "javascript",
        "cjs" to "javascript",
        "ts" to "typescript",
        "mts" to "typescript",
        "cts" to "typescript",
        "jsx" to "javascriptreact",
        "tsx" to "typescriptreact",
        "py" to "python",
        "rs" to "rust",
        "rb" to "ruby",
        "cs" to "csharp",
        "sh" to "bash",
        "bash" to "bash",
        "zsh" to "bash",
        "yml" to "yaml",
        "yaml" to "yaml",
        "json" to "json",
        "jsonc" to "jsonc",
        "html" to "html",
        "htm" to "html",
        "css" to "css",
        "scss" to "scss",
        "sass" to "sass",
        "less" to "less",
        "vue" to "vue",
        "svelte" to "svelte",
        "go" to "go",
        "java" to "java",
        "kt" to "kotlin",
        "kts" to "kotlin",
        "cpp" to "cpp",
        "c" to "c",
        "h" to "c",
        "hpp" to "cpp",
        "sql" to "sql",
        "md" to "markdown",
        "xml" to "xml",
        "toml" to "toml",
        "dockerfile" to "dockerfile"
    )

    fun isBinaryFile(file: VirtualFile): Boolean {
        val extension = file.extension?.lowercase() ?: return false
        return binaryExtensions.contains(extension)
    }

    fun getLanguage(file: VirtualFile): String {
        val extension = file.extension?.lowercase() ?: ""
        return extensionToLanguageMap[extension] ?: if (extension.isNotEmpty()) extension else "plaintext"
    }

    fun getCodeFence(content: String): String {
        val regex = Regex("`{3,}")
        val matches = regex.findAll(content)
        var maxBackticks = 3
        for (match in matches) {
            if (match.value.length >= maxBackticks) {
                maxBackticks = match.value.length + 1
            }
        }
        return "`".repeat(maxBackticks)
    }

    fun getRelativePath(file: VirtualFile, project: Project?): String {
        val projectBaseDir = project?.basePath?.let { File(it) }
        if (projectBaseDir != null) {
            val fileSystemFile = File(file.path)
            try {
                val rel = fileSystemFile.relativeToOrNull(projectBaseDir)?.path?.replace('\\', '/')
                if (!rel.isNullOrEmpty()) {
                    return rel
                }
            } catch (_: Exception) {
            }
        }
        return file.name
    }

    fun getFormattedFileString(file: VirtualFile, project: Project?): String {
        val relativePath = getRelativePath(file, project)

        if (isBinaryFile(file)) {
            return "File: $relativePath\n"
        }

        // 优先读取已打开的 Document 内存缓存，实现“未保存脏数据优先”，保证所见即所得
        val document = FileDocumentManager.getInstance().getDocument(file)
        val fileContent = if (document != null) {
            document.text
        } else {
            try {
                String(file.contentsToByteArray(), Charsets.UTF_8)
            } catch (_: Exception) {
                return "File: $relativePath\n"
            }
        }

        val language = getLanguage(file)
        val fence = getCodeFence(fileContent)
        return "File: $relativePath\n\n$fence$language\n$fileContent\n$fence\n"
    }

    data class ProcessResult(
        val content: String,
        val processedCount: Int,
        val stoppedEarly: Boolean
    )

    fun processFiles(files: List<VirtualFile>, project: Project?): ProcessResult {
        val formattedContents = mutableListOf<String>()
        var currentLength = 0
        var stoppedEarly = false

        for (file in files) {
            val formatted = getFormattedFileString(file, project)
            if (currentLength + formatted.length > MAX_CONTENT_LENGTH) {
                stoppedEarly = true
                break
            }
            formattedContents.add(formatted)
            currentLength += formatted.length
        }

        val finalContent = formattedContents.joinToString("\n\n---\n\n")
        return ProcessResult(finalContent, formattedContents.size, stoppedEarly)
    }

    fun formatClipItem(item: ClipItem, project: Project?): String {
        val relativePath = item.relativePath.ifEmpty { getRelativePath(item.file, project) }
        if (isBinaryFile(item.file)) {
            return "File: $relativePath\n"
        }

        val fileContent = if (item.isSnippet) {
            item.snippetContent ?: ""
        } else {
            val document = FileDocumentManager.getInstance().getDocument(item.file)
            if (document != null) {
                document.text
            } else {
                try {
                    String(item.file.contentsToByteArray(), Charsets.UTF_8)
                } catch (_: Exception) {
                    ""
                }
            }
        }

        val language = item.language
        val fence = getCodeFence(fileContent)
        val header = if (item.lineRange != null) {
            "File: $relativePath (${item.lineRange})"
        } else {
            "File: $relativePath"
        }
        return "$header\n\n$fence$language\n$fileContent\n$fence\n"
    }

    fun processClipItems(items: List<ClipItem>, project: Project?): ProcessResult {
        val formattedContents = mutableListOf<String>()
        var currentLength = 0
        var stoppedEarly = false

        for (item in items) {
            val formatted = formatClipItem(item, project)
            if (currentLength + formatted.length > MAX_CONTENT_LENGTH) {
                stoppedEarly = true
                break
            }
            formattedContents.add(formatted)
            currentLength += formatted.length
        }

        val finalContent = formattedContents.joinToString("\n\n---\n\n")
        return ProcessResult(finalContent, formattedContents.size, stoppedEarly)
    }
}
