package com.symudo.blockclip

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.fileTypes.FileTypeManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.vfs.VirtualFile
import java.io.File

class GitIgnoreFilter(private val rootDir: File, includeDefaults: Boolean = true) {

    private val defaultIgnoredNames = setOf(
        ".git",
        "node_modules",
        "dist",
        "build",
        "out",
        "coverage",
        ".idea",
        ".vscode",
        "package-lock.json",
        "yarn.lock",
        "pnpm-lock.yaml",
        "bun.lockb",
        ".DS_Store"
    )

    private val patterns = mutableListOf<GitIgnoreRule>()

    data class GitIgnoreRule(
        val regex: Regex,
        val isDirectoryOnly: Boolean,
        val isNegation: Boolean
    )

    init {
        if (includeDefaults) {
            for (name in defaultIgnoredNames) {
                addRule(name)
            }
        }
    }

    fun loadGitIgnore(file: File): Boolean {
        if (!file.exists() || !file.isFile) return false
        var loadedAny = false
        file.forEachLine { rawLine ->
            val line = rawLine.trim()
            if (line.isNotEmpty() && !line.startsWith("#")) {
                addRule(line)
                loadedAny = true
            }
        }
        return loadedAny
    }

    private fun addRule(rawRule: String) {
        var pattern = rawRule.replace('\\', '/')
        val isNegation = pattern.startsWith("!")
        if (isNegation) {
            pattern = pattern.substring(1).trim()
        }
        val isDirectoryOnly = pattern.endsWith("/")
        if (isDirectoryOnly) {
            pattern = pattern.removeSuffix("/")
        }
        if (pattern.isEmpty()) return

        val regexStr = wildcardToRegex(pattern)
        try {
            patterns.add(GitIgnoreRule(Regex(regexStr), isDirectoryOnly, isNegation))
        } catch (_: Exception) {
        }
    }

    private fun wildcardToRegex(pattern: String): String {
        val sb = StringBuilder()
        val startsWithSlash = pattern.startsWith("/")
        val cleanPattern = if (startsWithSlash) pattern.substring(1) else pattern
        val hasInternalSlash = cleanPattern.contains('/')

        // gitignore 规范：含斜杠（除尾部斜杠外）的模式锚定在当前 .gitignore 所在目录根
        if (startsWithSlash || hasInternalSlash) {
            sb.append("^")
        } else {
            sb.append("(^|/)")
        }

        var i = 0
        while (i < cleanPattern.length) {
            val c = cleanPattern[i]
            when (c) {
                '*' -> {
                    if (i + 1 < cleanPattern.length && cleanPattern[i + 1] == '*') {
                        if (i + 2 < cleanPattern.length && cleanPattern[i + 2] == '/') {
                            // **/ 同时匹配根目录（零层目录）与任意深层目录
                            sb.append("(?:.*/)?")
                            i += 2
                        } else {
                            sb.append(".*")
                            i++
                        }
                    } else {
                        sb.append("[^/]*")
                    }
                }
                '?' -> sb.append("[^/]")
                '.', '(', ')', '+', '|', '^', '$', '@', '%', '{', '}', '[', ']', '\\' -> {
                    sb.append('\\').append(c)
                }
                else -> sb.append(c)
            }
            i++
        }
        sb.append("($|/)")
        return sb.toString()
    }

    fun isIgnoredPath(relativePath: String, isDirectory: Boolean): Boolean {
        val normalized = relativePath.replace('\\', '/').trimStart('/')
        if (normalized.isEmpty()) return false
        if (!isDirectory && MarkdownFormatter.isSensitiveFile(normalized)) {
            return true
        }
        var ignored = false
        for (rule in patterns) {
            if (rule.isDirectoryOnly && !isDirectory) {
                // 目录规则（如 build/）同样忽略其内部文件（如 build/a.js），但不忽略同名普通文件（如 build）
                val match = rule.regex.find(normalized)
                if (match != null && match.value.endsWith("/")) {
                    ignored = !rule.isNegation
                }
                continue
            }
            if (rule.regex.containsMatchIn(normalized)) {
                ignored = !rule.isNegation
            }
        }
        return ignored
    }

    fun isIgnored(virtualFile: VirtualFile): Boolean {
        val rootNorm = MarkdownFormatter.normalizePathKey(rootDir.path).trimEnd('/')
        val fileNorm = MarkdownFormatter.normalizePathKey(virtualFile.path)
        val relativePath = if (fileNorm.startsWith("$rootNorm/")) {
            virtualFile.path.replace('\\', '/').substring(rootNorm.length + 1)
        } else {
            return false
        }
        return isIgnoredPath(relativePath, virtualFile.isDirectory)
    }

    companion object {
        private fun isProjectExcluded(file: VirtualFile, project: Project?): Boolean {
            if (ApplicationManager.getApplication() == null || project == null || project.isDisposed) {
                return false
            }
            return try {
                ReadAction.compute<Boolean, Throwable> {
                    file.isValid && ProjectFileIndex.getInstance(project).isExcluded(file)
                }
            } catch (_: Exception) {
                false
            }
        }

        private fun isHiddenOrExcludedInIde(
            child: VirtualFile,
            project: Project?,
            skipProjectExcluded: Boolean
        ): Boolean {
            if (ApplicationManager.getApplication() == null) return false
            return try {
                ReadAction.compute<Boolean, Throwable> {
                    if (!child.isValid) return@compute true
                    if (FileTypeManager.getInstance().isFileIgnored(child)) return@compute true
                    if (project != null && !project.isDisposed) {
                        val fileIndex = ProjectFileIndex.getInstance(project)
                        if (fileIndex.isUnderIgnored(child)) {
                            return@compute true
                        }
                        if (skipProjectExcluded && fileIndex.isExcluded(child)) {
                            return@compute true
                        }
                    }
                    false
                }
            } catch (_: Exception) {
                false
            }
        }

        fun collectAllFiles(
            folder: VirtualFile,
            projectBaseDir: File?,
            indicator: ProgressIndicator? = null,
            project: Project? = null
        ): List<VirtualFile> {
            val folderFile = File(folder.path)
            val filters = mutableListOf<GitIgnoreFilter>()

            // 1. 构建多层级过滤器链：每个 .gitignore 以其自身所在目录为基准，同时读取 .git/info/exclude
            if (projectBaseDir != null && projectBaseDir.exists()) {
                val rootFilter = GitIgnoreFilter(projectBaseDir, includeDefaults = true)
                rootFilter.loadGitIgnore(File(projectBaseDir, ".git/info/exclude"))
                rootFilter.loadGitIgnore(File(projectBaseDir, ".gitignore"))
                filters.add(rootFilter)

                val rootNorm = MarkdownFormatter.normalizePathKey(projectBaseDir.path).trimEnd('/')
                val folderNorm = MarkdownFormatter.normalizePathKey(folderFile.path).trimEnd('/')
                if (folderNorm.startsWith("$rootNorm/")) {
                    val relParts = folderFile.path.replace('\\', '/')
                        .substring(rootNorm.length + 1)
                        .split('/')
                        .filter { it.isNotEmpty() }
                    var cur = projectBaseDir
                    for (part in relParts) {
                        cur = File(cur, part)
                        val giFile = File(cur, ".gitignore")
                        if (giFile.exists() && giFile.isFile) {
                            val midFilter = GitIgnoreFilter(cur, includeDefaults = false)
                            if (midFilter.loadGitIgnore(giFile)) {
                                filters.add(midFilter)
                            }
                        }
                    }
                }
            } else {
                val localFilter = GitIgnoreFilter(folderFile, includeDefaults = true)
                localFilter.loadGitIgnore(File(folderFile, ".git/info/exclude"))
                localFilter.loadGitIgnore(File(folderFile, ".gitignore"))
                filters.add(localFilter)
            }

            // 若用户主动右键复制了一个本身被标为 Excluded 的目录，则不再因父级排除状态将其子文件过滤为空
            val skipProjectExcluded = !isProjectExcluded(folder, project)
            val result = mutableListOf<VirtualFile>()
            val visitedDirs = mutableSetOf<String>()
            traverse(folder, filters, result, visitedDirs, indicator, project, skipProjectExcluded)
            return result
        }

        private fun traverse(
            dir: VirtualFile,
            filters: List<GitIgnoreFilter>,
            result: MutableList<VirtualFile>,
            visitedDirs: MutableSet<String>,
            indicator: ProgressIndicator?,
            project: Project?,
            skipProjectExcluded: Boolean
        ) {
            indicator?.checkCanceled()
            val canonicalKey = try {
                MarkdownFormatter.normalizePathKey(File(dir.path).canonicalPath)
            } catch (_: Exception) {
                MarkdownFormatter.normalizePathKey(dir.path)
            }
            if (!visitedDirs.add(canonicalKey)) {
                return
            }

            // 动态加载子目录自身的 .gitignore
            val dirFile = File(dir.path)
            val localGi = File(dirFile, ".gitignore")
            val activeFilters = if (localGi.exists() && localGi.isFile &&
                filters.none { MarkdownFormatter.normalizePathKey(it.rootDir.path) == MarkdownFormatter.normalizePathKey(dirFile.path) }
            ) {
                val subFilter = GitIgnoreFilter(dirFile, includeDefaults = false)
                if (subFilter.loadGitIgnore(localGi)) filters + subFilter else filters
            } else {
                filters
            }

            val children = dir.children ?: return
            for (child in children) {
                indicator?.checkCanceled()
                // 尊重 IDE 目录树中的忽略与排除目录（例如插件生成并隐藏的数据/日志目录）
                if (isHiddenOrExcludedInIde(child, project, skipProjectExcluded)) {
                    continue
                }
                if (activeFilters.any { it.isIgnored(child) }) {
                    continue
                }
                if (child.isDirectory) {
                    traverse(child, activeFilters, result, visitedDirs, indicator, project, skipProjectExcluded)
                } else {
                    if (!MarkdownFormatter.isSensitiveFile(child.name)) {
                        result.add(child)
                    }
                }
            }
        }
    }
}
