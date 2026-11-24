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
    const val DEFAULT_MAX_CONTENT_SIZE_MB = 50
    const val MAX_CONTENT_LENGTH: Long = DEFAULT_MAX_CONTENT_SIZE_MB.toLong() * 1024L * 1024L

    /**
     * 将用户配置的 MB 上限换算为最大字符/字节数（使用 Long 避免大数值 Int 溢出）。
     * <= 0 表示无限制（Long.MAX_VALUE）。
     */
    fun resolveMaxContentLength(sizeMB: Int): Long {
        if (sizeMB <= 0) {
            return Long.MAX_VALUE
        }
        return sizeMB.toLong() * 1024L * 1024L
    }

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
        "db", "sqlite", "sqlite3", "bin", "dat", "ldb", "sst", "wal", "shm",
        "idx", "pack", "wasm", "node", "pyc", "pyo", "o", "a", "lib", "pdb",
        "hprof", "parquet", "avro", "pb",
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
        val extension = file.extension?.lowercase(Locale.ROOT)
        if (extension != null && binaryExtensions.contains(extension)) {
            return true
        }
        // 在真实 IDE 环境下于 ReadAction 中借助 IntelliJ 自身文件类型系统判定二进制文件
        if (ApplicationManager.getApplication() != null) {
            try {
                val isBinary = ReadAction.compute<Boolean, Throwable> {
                    file.isValid && file.fileType.isBinary
                }
                if (isBinary) {
                    return true
                }
            } catch (_: Exception) {
            }
        }
        return false
    }

    /**
     * 与 Git 相同的内容级二进制探测：扫描前 sampleSize（默认 8KB）字节中是否包含 NUL (0x00) 空字节。
     * 彻底识别未知扩展名或无后缀的数据库/缓存/索引二进制文件，杜绝 Windows 剪贴板 NUL 截断。
     */
    fun isBinaryBytes(bytes: ByteArray, sampleSize: Int = 8192): Boolean {
        val limit = minOf(bytes.size, sampleSize)
        for (i in 0 until limit) {
            if (bytes[i] == 0.toByte()) {
                return true
            }
        }
        return false
    }

    /**
     * 写入系统剪贴板前的兜底清洗：移除任何 NUL (\0) 字符，防止 Windows CF_UNICODETEXT 截断后续代码。
     */
    fun sanitizeForClipboard(text: String): String {
        return if (text.indexOf('\u0000') >= 0) text.replace("\u0000", "") else text
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
        object Binary : FileReadResult()
        object Missing : FileReadResult()
        object TooLarge : FileReadResult()
    }

    private fun readFileContentSafely(file: VirtualFile, remainingBudget: Long): FileReadResult {
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
                return if (docText.length.toLong() > remainingBudget) {
                    FileReadResult.TooLarge
                } else {
                    FileReadResult.Ok(docText)
                }
            }
        }

        // 大文件在检查大小上限与全量读盘前，先仅流式读取前 8KB 探测二进制，避免超大未知二进制文件误中断后续复制
        if (file.length > 8192L && isFileHeaderBinary(file)) {
            return FileReadResult.Binary
        }

        // 读取磁盘前先预检物理大小，避免将超大文件整份读入内存
        if (file.length > remainingBudget) {
            return FileReadResult.TooLarge
        }

        return try {
            val bytes = file.contentsToByteArray()
            if (isBinaryBytes(bytes)) {
                return FileReadResult.Binary
            }
            val text = String(bytes, Charsets.UTF_8)
            if (text.length.toLong() > remainingBudget) {
                FileReadResult.TooLarge
            } else {
                FileReadResult.Ok(text)
            }
        } catch (_: Exception) {
            FileReadResult.Missing
        }
    }

    private fun isFileHeaderBinary(file: VirtualFile, sampleSize: Int = 8192): Boolean {
        return try {
            file.inputStream.use { stream ->
                val buffer = ByteArray(sampleSize)
                var totalRead = 0
                while (totalRead < sampleSize) {
                    val read = stream.read(buffer, totalRead, sampleSize - totalRead)
                    if (read <= 0) break
                    totalRead += read
                }
                for (i in 0 until totalRead) {
                    if (buffer[i] == 0.toByte()) {
                        return true
                    }
                }
                false
            }
        } catch (_: Exception) {
            false
        }
    }

    fun formatSelection(
        file: VirtualFile,
        project: Project?,
        selectedText: String,
        lineRange: String
    ): String {
        val cleanText = sanitizeForClipboard(selectedText)
        val relativePath = getRelativePath(file, project)
        val language = getLanguage(file)
        val fence = getCodeFence(cleanText)
        return "File: $relativePath ($lineRange)\n\n$fence$language\n$cleanText\n$fence\n"
    }

    data class ProcessResult(
        val content: String,
        val processedCount: Int,
        val stoppedEarly: Boolean,
        val skippedMissingCount: Int = 0,
        val firstProcessedFileName: String? = null
    )

    fun processFiles(
        files: List<VirtualFile>,
        project: Project?,
        maxLength: Long = BlockClipSettings.getCurrentMaxLength()
    ): ProcessResult {
        val formattedContents = mutableListOf<String>()
        var currentLength = 0L
        var stoppedEarly = false
        var skippedMissing = 0
        var firstProcessedFileName: String? = null

        for (file in files) {
            val remaining = if (maxLength == Long.MAX_VALUE) Long.MAX_VALUE else maxLength - currentLength
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
                    is FileReadResult.Binary -> {
                        "File: $relativePath\n"
                    }
                    is FileReadResult.Ok -> {
                        val language = getLanguage(file)
                        val fence = getCodeFence(read.content)
                        "File: $relativePath\n\n$fence$language\n${read.content}\n$fence\n"
                    }
                }
            }

            if (block.length.toLong() > remaining) {
                stoppedEarly = true
                break
            }
            if (firstProcessedFileName == null) {
                firstProcessedFileName = file.name
            }
            formattedContents.add(block)
            currentLength += block.length.toLong()
        }

        val finalContent = sanitizeForClipboard(formattedContents.joinToString("\n\n---\n\n"))
        return ProcessResult(finalContent, formattedContents.size, stoppedEarly, skippedMissing, firstProcessedFileName)
    }

    fun formatClipItem(item: ClipItem, project: Project?): String {
        val relativePath = item.relativePath.ifEmpty { getRelativePath(item.file, project) }
        if (!item.isSnippet && isBinaryFile(item.file)) {
            return "File: $relativePath\n"
        }

        val fileContent = if (item.isSnippet) {
            item.snippetContent ?: ""
        } else {
            when (val read = readFileContentSafely(item.file, BlockClipSettings.getCurrentMaxLength())) {
                is FileReadResult.Binary -> return "File: $relativePath\n"
                is FileReadResult.Ok -> read.content
                else -> ""
            }
        }

        val cleanContent = sanitizeForClipboard(fileContent)
        val language = item.language
        val fence = getCodeFence(cleanContent)
        val header = if (item.lineRange != null) {
            "File: $relativePath (${item.lineRange})"
        } else {
            "File: $relativePath"
        }
        return "$header\n\n$fence$language\n$cleanContent\n$fence\n"
    }

    fun processClipItems(
        items: List<ClipItem>,
        project: Project?,
        maxLength: Long = BlockClipSettings.getCurrentMaxLength()
    ): ProcessResult {
        val formattedContents = mutableListOf<String>()
        var currentLength = 0L
        var stoppedEarly = false
        var skippedMissing = 0
        var firstProcessedFileName: String? = null

        for (item in items) {
            val remaining = if (maxLength == Long.MAX_VALUE) Long.MAX_VALUE else maxLength - currentLength
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
                    is FileReadResult.Binary -> {
                        "File: $relativePath\n"
                    }
                    is FileReadResult.Ok -> {
                        val fence = getCodeFence(read.content)
                        "File: $relativePath\n\n$fence${item.language}\n${read.content}\n$fence\n"
                    }
                }
            }

            if (block.length.toLong() > remaining) {
                stoppedEarly = true
                break
            }
            if (firstProcessedFileName == null) {
                firstProcessedFileName = item.file.name
            }
            formattedContents.add(block)
            currentLength += block.length.toLong()
        }

        val finalContent = sanitizeForClipboard(formattedContents.joinToString("\n\n---\n\n"))
        return ProcessResult(finalContent, formattedContents.size, stoppedEarly, skippedMissing, firstProcessedFileName)
    }
}
