package com.symudo.blockclip

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File

class GitIgnoreFilterTest {

    @Test
    fun testDefaultIgnoredAndSensitiveRules(@TempDir tempDir: File) {
        val filter = GitIgnoreFilter(tempDir)

        assertTrue(filter.isIgnoredPath(".git", true))
        assertTrue(filter.isIgnoredPath("node_modules", true))
        assertTrue(filter.isIgnoredPath("packages/web/dist", true))
        assertTrue(filter.isIgnoredPath(".idea", true))
        assertTrue(filter.isIgnoredPath("pnpm-lock.yaml", false))

        // 敏感文件默认保护，但保留示例模板
        assertTrue(filter.isIgnoredPath(".env", false))
        assertTrue(filter.isIgnoredPath(".env.production", false))
        assertTrue(filter.isIgnoredPath("certs/private.key", false))
        assertFalse(filter.isIgnoredPath(".env.example", false))
        assertFalse(filter.isIgnoredPath("src/main.ts", false))
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

        assertTrue(filter.isIgnoredPath("debug.log", false))
        assertTrue(filter.isIgnoredPath("logs/error.log", false))
        assertFalse(filter.isIgnoredPath("important.log", false))
        assertTrue(filter.isIgnoredPath("temp", true))
        assertFalse(filter.isIgnoredPath("temp", false))
    }
}
