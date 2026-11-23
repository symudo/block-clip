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

        assertTrue(filter.isIgnoredPath(".env", false))
        assertTrue(filter.isIgnoredPath(".env.production", false))
        assertTrue(filter.isIgnoredPath("certs/private.key", false))
        assertFalse(filter.isIgnoredPath(".env.example", false))
        assertFalse(filter.isIgnoredPath("src/main.ts", false))
    }

    @Test
    fun testCustomGitIgnoreRulesWithBracketsAndPathAnchoring(@TempDir tempDir: File) {
        val gitignoreFile = File(tempDir, ".gitignore")
        gitignoreFile.writeText(
            """
            # Comments
            *.log
            temp/
            !important.log
            src/generated/
            cache[1].dat
            **/snapshots/
            """.trimIndent()
        )

        val filter = GitIgnoreFilter(tempDir)
        filter.loadGitIgnore(gitignoreFile)

        assertTrue(filter.isIgnoredPath("debug.log", false))
        assertTrue(filter.isIgnoredPath("logs/error.log", false))
        assertFalse(filter.isIgnoredPath("important.log", false))

        // 目录规则 temp/ 忽略目录本身及其内部文件，不误伤同名普通文件
        assertTrue(filter.isIgnoredPath("temp", true))
        assertTrue(filter.isIgnoredPath("temp/a.txt", false))
        assertFalse(filter.isIgnoredPath("temp", false))

        // 含斜杠规则锚定在根目录
        assertTrue(filter.isIgnoredPath("src/generated", true))
        assertTrue(filter.isIgnoredPath("src/generated/api.ts", false))
        assertFalse(filter.isIgnoredPath("other/src/generated", true))

        // 含方括号文件名正确转义匹配
        assertTrue(filter.isIgnoredPath("cache[1].dat", false))
        assertFalse(filter.isIgnoredPath("cache1.dat", false))

        // **/ 规则同时命中根目录与任意深层目录
        assertTrue(filter.isIgnoredPath("snapshots", true))
        assertTrue(filter.isIgnoredPath("snapshots/a.snap", false))
        assertTrue(filter.isIgnoredPath("packages/ui/snapshots", true))
        assertTrue(filter.isIgnoredPath("packages/ui/snapshots/btn.snap", false))
    }
}
