package com.symudo.blockclip

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import java.io.File
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.max

object MarkdownFormatter {
    const val MAX_CONTENT_LENGTH = 15 * 1024 * 1024 // 15MB

    private val isWindows = System.getProperty("os.name").lowercase(Locale.ROOT).contains("win")

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

    private val sensitiveExtensions = setOf("pem", "key", "p12", "pfx", "jks", "keystore")

    private val sensitiveExactNames = setOf(
        "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
        ".npmrc", ".pypirc", ".netrc"
    )

    private val safeEnvSuffixes = listOf(".example", ".sample", ".template", ".dist")

    private val fileNameToLanguageMap = mapOf(
        "dockerfile" to "dockerfile",
        "makefile" to "makefile",
        "gnumakefile" to "makefile",
        "cmakelists.txt" to "cmake",
        "gemfile" to "ruby",
        "rakefile" to "ruby",
        "vagrantfile" to "ruby",
        "jenkinsfile" to "groovy",
        "justfile" to "just"
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

    fun normalizePathKey(path: String, caseInsensitive: Boolean = isWindows): String {
        val normalized = path.replace('\\', '/')
        return if (caseInsensitive) normalized.lowercase(Locale.ROOT) else normalized
    }

    fun isBinaryFile(file: VirtualFile): Boolean {
        val extension = file.extension?.lowercase(Locale.ROOT) ?: return false
        return binaryExtensions.contains(extension)
    }

    /**
     * 判断是否为常见敏感文件（如 .env、密钥证书等）。
     * 保留 .env.example / .env.sample / .env.template / .env.dist 模板文件。
     */
    fun isSensitiveFile(fileName: String): Boolean {
        val lower = File(fileName).name.lowercase(Locale.ROOT)
        if (sensitiveExactNames.contains(lower)) {
            return true
        }
        if (lower == ".env" || lower.startsWith(".env.")) {
            return safeEnvSuffixes.none { lower.endsWith(it) }
        }
        val ext = lower.substringAfterLast('.', "")
        return sensitiveExtensions.contains(ext)
    }

    fun getLanguageByName(fileName: String): String {
        val lower = File(fileName).name.lowercase(Locale.ROOT)
        fileNameToLanguageMap[lower]?.let { return it }
        if (lower.startsWith("dockerfile.")) {
            return "dockerfile"
        }
        val dotIndex = lower.lastIndexOf('.')
        if (dotIndex > 0 && dotIndex < lower.length - 1) {
            val ext = lower.substring(dotIndex + 1)
            return extensionToLanguageMap[ext] ?: ext
        }
        return "plaintext"
    }

    fun getLanguage(file: VirtualFile): String {
        return getLanguageByName(file.name)
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

    /**
     * 计算人类可读的行号范围（1-based），自动修正跨行选区停在下一行第 0 列导致的 Off-by-one 问题。
     */
    fun formatLineRange(startLineZeroBased: Int, endLineZeroBased: Int, endColumn: Int): String {
        val startLine = startLineZeroBased + 1
        var endLine = endLineZeroBased + 1
        if (endLineZeroBased > startLineZeroBased && endColumn == 0) {
            endLine -= 1
        }
        if (endLine < startLine) {
            endLine = startLine
        }
        return if (startLine == endLine) "line $startLine" else "lines $startLine-$endLine"
    }

    /**
     * 解析 lineRange 字符串中的起始 0-based 行号（用于编辑器跳转定位）。
     */
    fun parseStartLineZeroBased(lineRange: String?): Int {
        if (lineRange.isNullOrBlank()) return 0
        val match = Regex("\\d+").find(lineRange) ?: return 0
        val oneBased = match.value.toIntOrNull() ?: return 0
        return max(0, oneBased - 1)
    }

    /**
     * 轻量级 Token 粗略估算（零外部依赖）：
     * ASCII 约 4 字符 ≈ 1 token，非 ASCII（如中文）约 1.5 字符 ≈ 1 token。
     */
    fun estimateTokens(text: String): Int {
        if (text.isEmpty()) return 0
        var asciiCount = 0
        var nonAsciiCount = 0
        for (ch in text) {
            if (ch.code <= 0x7F) {
                asciiCount++
            } else {
                nonAsciiCount++
            }
        }
        return max(1, ceil(asciiCount / 4.0 + nonAsciiCount / 1.5).toInt())
    }

    fun formatBytes(bytes: Long): String {
        return when {
            bytes < 1024L -> "$bytes B"
            bytes < 1024L * 1024L -> String.format(Locale.US, "%.1f KB", bytes / 1024.0)
            else -> String.format(Locale.US, "%.2f MB", bytes / (1024.0 * 1024.0))
        }
    }

    fun formatTokenCount(tokens: Int): String {
        return if (tokens >= 1000) {
            String.format(Locale.US, "~%.1fk tokens", tokens / 1000.0)
        } else {
            "~$tokens tokens"
        }
    }

    fun formatStats(text: String): String {
        val byteSize = text.toByteArray(Charsets.UTF_8).size.toLong()
        val tokens = estimateTokens(text)
        return "${formatBytes(byteSize)}, ${formatTokenCount(tokens)}"
    }

    fun getRelativePath(file: VirtualFile, project: Project?): String {
        val basePath = project?.basePath
        if (basePath != null) {
            val baseNorm = normalizePathKey(basePath).trimEnd('/')
            val fileNorm = normalizePathKey(file.path)
            if (fileNorm.startsWith("$baseNorm/")) {
                return file.path.replace('\\', '/').substring(baseNorm.length + 1)
            }
        }
        return file.name
    }

    sealed class FileReadResult {
        data class Ok(val content: String) : FileReadResult()
        object Missing : FileReadResult()
        object TooLarge : FileReadResult()
    }

    private fun readFileContentSafely(file: VirtualFile, remainingBudget: Int): FileReadResult {
        if (!file.isValid) {
            return FileReadResult.Missing
        }

        // 优先在 ReadAction 中读取已打开的 Document 内存缓存，实现“未保存脏数据优先”且线程安全
        val app = ApplicationManager.getApplication()
        if (app != null) {
            val docText = ReadAction.compute<String?, Throwable> {
                if (!file.isValid) null else FileDocumentManager.getInstance().getDocument(file)?.text
            }
            if (docText != null) {
                return if (docText.length > remainingBudget) {
                    FileReadResult.TooLarge
                } else {
                    FileReadResult.Ok(docText)
                }
            }
        }

        // 读取磁盘前先预检物理大小，避免将超大文件整份读入内存
        if (file.length > remainingBudget.toLong()) {
            return FileReadResult.TooLarge
        }

        return try {
            val text = String(file.contentsToByteArray(), Charsets.UTF_8)
            if (text.length > remainingBudget) {
                FileReadResult.TooLarge
            } else {
                FileReadResult.Ok(text)
            }
        } catch (_: Exception) {
            FileReadResult.Missing
        }
    }

    fun formatSelection(
        file: VirtualFile,
        project: Project?,
        selectedText: String,
        lineRange: String
    ): String {
        val relativePath = getRelativePath(file, project)
        val language = getLanguage(file)
        val fence = getCodeFence(selectedText)
        return "File: $relativePath ($lineRange)\n\n$fence$language\n$selectedText\n$fence\n"
    }

    data class ProcessResult(
        val content: String,
        val processedCount: Int,
        val stoppedEarly: Boolean,
        val skippedMissingCount: Int = 0
    )

    fun processFiles(
        files: List<VirtualFile>,
        project: Project?,
        maxLength: Int = MAX_CONTENT_LENGTH
    ): ProcessResult {
        val formattedContents = mutableListOf<String>()
        var currentLength = 0
        var stoppedEarly = false
        var skippedMissing = 0

        for (file in files) {
            val remaining = maxLength - currentLength
            val relativePath = getRelativePath(file, project)
            val block = if (isBinaryFile(file)) {
                "File: $relativePath\n"
            } else {
                when (val read = readFileContentSafely(file, remaining)) {
                    is FileReadResult.Missing -> {
                        skippedMissing++
                        continue
                    }
                    is FileReadResult.TooLarge -> {
                        stoppedEarly = true
                        break
                    }
                    is FileReadResult.Ok -> {
                        val language = getLanguage(file)
                        val fence = getCodeFence(read.content)
                        "File: $relativePath\n\n$fence$language\n${read.content}\n$fence\n"
                    }
                }
            }

            if (currentLength + block.length > maxLength) {
                stoppedEarly = true
                break
            }
            formattedContents.add(block)
            currentLength += block.length
        }

        val finalContent = formattedContents.joinToString("\n\n---\n\n")
        return ProcessResult(finalContent, formattedContents.size, stoppedEarly, skippedMissing)
    }

    fun formatClipItem(item: ClipItem, project: Project?): String {
        val relativePath = item.relativePath.ifEmpty { getRelativePath(item.file, project) }
        if (!item.isSnippet && isBinaryFile(item.file)) {
            return "File: $relativePath\n"
        }

        val fileContent = if (item.isSnippet) {
            item.snippetContent ?: ""
        } else {
            when (val read = readFileContentSafely(item.file, MAX_CONTENT_LENGTH)) {
                is FileReadResult.Ok -> read.content
                else -> ""
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

    fun processClipItems(
        items: List<ClipItem>,
        project: Project?,
        maxLength: Int = MAX_CONTENT_LENGTH
    ): ProcessResult {
        val formattedContents = mutableListOf<String>()
        var currentLength = 0
        var stoppedEarly = false
        var skippedMissing = 0

        for (item in items) {
            val remaining = maxLength - currentLength
            val relativePath = item.relativePath.ifEmpty { getRelativePath(item.file, project) }
            val block = if (!item.isSnippet && isBinaryFile(item.file)) {
                "File: $relativePath\n"
            } else if (item.isSnippet) {
                val content = item.snippetContent ?: ""
                val fence = getCodeFence(content)
                val header = if (item.lineRange != null) "File: $relativePath (${item.lineRange})" else "File: $relativePath"
                "$header\n\n$fence${item.language}\n$content\n$fence\n"
            } else {
                when (val read = readFileContentSafely(item.file, remaining)) {
                    is FileReadResult.Missing -> {
                        skippedMissing++
                        continue
                    }
                    is FileReadResult.TooLarge -> {
                        stoppedEarly = true
                        break
                    }
                    is FileReadResult.Ok -> {
                        val fence = getCodeFence(read.content)
                        "File: $relativePath\n\n$fence${item.language}\n${read.content}\n$fence\n"
                    }
                }
            }

            if (currentLength + block.length > maxLength) {
                stoppedEarly = true
                break
            }
            formattedContents.add(block)
            currentLength += block.length
        }

        val finalContent = formattedContents.joinToString("\n\n---\n\n")
        return ProcessResult(finalContent, formattedContents.size, stoppedEarly, skippedMissing)
    }
}
