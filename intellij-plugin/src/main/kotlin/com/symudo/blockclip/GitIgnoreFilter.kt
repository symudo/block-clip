package com.symudo.blockclip

import com.intellij.openapi.vfs.VirtualFile
import java.io.File

class GitIgnoreFilter(private val rootDir: File) {

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
        // 添加默认规则
        for (name in defaultIgnoredNames) {
            addRule(name)
        }
    }

    fun loadGitIgnore(file: File) {
        if (!file.exists() || !file.isFile) return
        file.forEachLine { rawLine ->
            val line = rawLine.trim()
            if (line.isNotEmpty() && !line.startsWith("#")) {
                addRule(line)
            }
        }
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

        if (startsWithSlash) {
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
                        sb.append(".*")
                        i++
                    } else {
                        sb.append("[^/]*")
                    }
                }
                '?' -> sb.append("[^/]")
                '.', '(', ')', '+', '|', '^', '$', '@', '%', '{', '}' -> {
                    sb.append('\\').append(c)
                }
                else -> sb.append(c)
            }
            i++
        }
        sb.append("($|/)")
        return sb.toString()
    }

    fun isIgnored(virtualFile: VirtualFile): Boolean {
        val fileSystemFile = File(virtualFile.path)
        val relativePath = fileSystemFile.relativeToOrNull(rootDir)?.path?.replace('\\', '/') ?: virtualFile.name
        val isDirectory = virtualFile.isDirectory

        var ignored = false
        for (rule in patterns) {
            if (rule.isDirectoryOnly && !isDirectory) {
                continue
            }
            if (rule.regex.containsMatchIn(relativePath)) {
                ignored = !rule.isNegation
            }
        }
        return ignored
    }

    companion object {
        fun collectAllFiles(
            folder: VirtualFile,
            projectBaseDir: File?
        ): List<VirtualFile> {
            val folderFile = File(folder.path)
            val filter = GitIgnoreFilter(folderFile)

            // 1. 如果存在项目根目录，且与当前文件夹不同，先加载项目根目录的 .gitignore
            if (projectBaseDir != null && projectBaseDir.exists() && projectBaseDir != folderFile) {
                val rootGitIgnore = File(projectBaseDir, ".gitignore")
                filter.loadGitIgnore(rootGitIgnore)
            }

            // 2. 加载当前文件夹的 .gitignore
            val localGitIgnore = File(folderFile, ".gitignore")
            filter.loadGitIgnore(localGitIgnore)

            val result = mutableListOf<VirtualFile>()
            traverse(folder, filter, result)
            return result
        }

        private fun traverse(
            dir: VirtualFile,
            filter: GitIgnoreFilter,
            result: MutableList<VirtualFile>
        ) {
            val children = dir.children ?: return
            for (child in children) {
                if (filter.isIgnored(child)) {
                    continue
                }
                if (child.isDirectory) {
                    traverse(child, filter, result)
                } else {
                    result.add(child)
                }
            }
        }
    }
}
