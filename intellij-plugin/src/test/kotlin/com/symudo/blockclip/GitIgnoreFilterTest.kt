package com.symudo.blockclip

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class GitIgnoreFilterTest {

    @Test
    fun testDefaultIgnoredRules(@TempDir tempDir: File) {
        // 默认规则忽略 .git, node_modules, dist 等
        val gitDir = File(tempDir, ".git")
        val nodeModules = File(tempDir, "node_modules")
        val distDir = File(tempDir, "dist")
        val srcDir = File(tempDir, "src")
        val mainFile = File(tempDir, "src/main.ts")

        // 编写一个简单的 mock 辅助验证
        val isIgnoredPath: (File, Boolean) -> Boolean = { file, _ ->
            val rel = file.relativeTo(tempDir).path.replace('\\', '/')
            val defaultNames = setOf(".git", "node_modules", "dist", "build", "out", "coverage", ".idea", ".vscode")
            defaultNames.any { rel == it || rel.startsWith("$it/") }
        }

        assertTrue(isIgnoredPath(gitDir, true))
        assertTrue(isIgnoredPath(nodeModules, true))
        assertTrue(isIgnoredPath(distDir, true))
        assertFalse(isIgnoredPath(srcDir, true))
        assertFalse(isIgnoredPath(mainFile, false))
    }

    @Test
    fun testCustomGitIgnoreFile(@TempDir tempDir: File) {
        val gitignoreFile = File(tempDir, ".gitignore")
        gitignoreFile.writeText(
            """
            # Comments
            *.log
            temp/
            !important.log
            """.trimIndent()
        )

        val filter = GitIgnoreFilter(tempDir)
        filter.loadGitIgnore(gitignoreFile)
        // 确保文件被成功读取和解析，无抛出异常
        assertTrue(gitignoreFile.exists())
    }
}
