package com.symudo.blockclip

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.Locale

class MarkdownFormatterTest {

    @Test
    fun testGetCodeFenceWithoutBackticks() {
        val content = "const a = 1;\nconsole.log(a);"
        assertEquals("```", MarkdownFormatter.getCodeFence(content))
    }

    @Test
    fun testGetCodeFenceWithThreeBackticks() {
        val content = "Here is some markdown:\n```js\nconst x = 10;\n```"
        assertEquals("````", MarkdownFormatter.getCodeFence(content))
    }

    @Test
    fun testGetCodeFenceWithFourBackticks() {
        val content = "Nested code:\n````markdown\n```js\nx = 1\n```\n````"
        assertEquals("`````", MarkdownFormatter.getCodeFence(content))
    }

    @Test
    fun testGetCodeFenceWithMixedBackticks() {
        val content = "Inline `code` and triple ```code``` and five `````fence`````."
        assertEquals("``````", MarkdownFormatter.getCodeFence(content))
    }

    @Test
    fun testExtensionlessLanguageDetection() {
        assertEquals("dockerfile", MarkdownFormatter.getLanguageByName("Dockerfile"))
        assertEquals("dockerfile", MarkdownFormatter.getLanguageByName("Dockerfile.prod"))
        assertEquals("makefile", MarkdownFormatter.getLanguageByName("Makefile"))
        assertEquals("cmake", MarkdownFormatter.getLanguageByName("CMakeLists.txt"))
        assertEquals("typescriptreact", MarkdownFormatter.getLanguageByName("App.tsx"))
        assertEquals("plaintext", MarkdownFormatter.getLanguageByName("README"))
    }

    @Test
    fun testNormalizePathKey() {
        assertEquals("d:/proj/src/app.kt", MarkdownFormatter.normalizePathKey("D:\\Proj\\Src\\App.kt", caseInsensitive = true))
        assertEquals("d:/proj/src/app.kt", MarkdownFormatter.normalizePathKey("d:/Proj/Src/App.kt", caseInsensitive = true))
        assertEquals("/proj/Src/App.kt", MarkdownFormatter.normalizePathKey("/proj/Src/App.kt", caseInsensitive = false))
    }

    @Test
    fun testFormatLineRangeAndOffByOneFix() {
        assertEquals("line 1", MarkdownFormatter.formatLineRange(0, 0, 12))
        assertEquals("lines 10-15", MarkdownFormatter.formatLineRange(9, 14, 8))
        assertEquals("lines 10-15", MarkdownFormatter.formatLineRange(9, 15, 0))
        assertEquals("line 10", MarkdownFormatter.formatLineRange(9, 10, 0))
    }

    @Test
    fun testParseStartLineZeroBased() {
        assertEquals(0, MarkdownFormatter.parseStartLineZeroBased(null))
        assertEquals(0, MarkdownFormatter.parseStartLineZeroBased("line 1"))
        assertEquals(49, MarkdownFormatter.parseStartLineZeroBased("lines 50-82"))
    }

    @Test
    fun testIsSensitiveFile() {
        assertTrue(MarkdownFormatter.isSensitiveFile(".env"))
        assertTrue(MarkdownFormatter.isSensitiveFile(".env.local"))
        assertTrue(MarkdownFormatter.isSensitiveFile("config/.env.production"))
        assertTrue(MarkdownFormatter.isSensitiveFile("certs/server.pem"))
        assertTrue(MarkdownFormatter.isSensitiveFile("private.key"))
        assertTrue(MarkdownFormatter.isSensitiveFile("id_rsa"))

        assertFalse(MarkdownFormatter.isSensitiveFile(".env.example"))
        assertFalse(MarkdownFormatter.isSensitiveFile(".env.sample"))
        assertFalse(MarkdownFormatter.isSensitiveFile(".env.template"))
        assertFalse(MarkdownFormatter.isSensitiveFile(".env.dist"))
        assertFalse(MarkdownFormatter.isSensitiveFile("src/App.kt"))
    }

    @Test
    fun testTokenEstimationAndLocaleIndependentFormatting() {
        val originalLocale = Locale.getDefault()
        try {
            // 模拟德语等逗号小数点系统 Locale，确保始终输出标准小数点格式
            Locale.setDefault(Locale.GERMANY)
            assertEquals(0, MarkdownFormatter.estimateTokens(""))
            assertEquals(100, MarkdownFormatter.estimateTokens("a".repeat(400)))
            assertTrue(MarkdownFormatter.estimateTokens("你好世界测试代码") >= 5)

            assertEquals("512 B", MarkdownFormatter.formatBytes(512))
            assertEquals("2.0 KB", MarkdownFormatter.formatBytes(2048))
            assertEquals("2.00 MB", MarkdownFormatter.formatBytes(2L * 1024 * 1024))
            assertEquals("~1.5k tokens", MarkdownFormatter.formatTokenCount(1500))

            val stats = MarkdownFormatter.formatStats("console.log('hello world');")
            assertTrue(stats.contains("B, ~"))
            assertTrue(stats.endsWith("tokens"))
        } finally {
            Locale.setDefault(originalLocale)
        }
    }

    @Test
    fun testResolveMaxContentLengthNoOverflow() {
        assertEquals(50L * 1024L * 1024L, MarkdownFormatter.resolveMaxContentLength(50))
        // 验证 2048MB 不会发生 32 位 Int 溢出变成负数
        assertEquals(2048L * 1024L * 1024L, MarkdownFormatter.resolveMaxContentLength(2048))
        assertTrue(MarkdownFormatter.resolveMaxContentLength(2048) > 0L)
        assertEquals(Long.MAX_VALUE, MarkdownFormatter.resolveMaxContentLength(0))
        assertEquals(Long.MAX_VALUE, MarkdownFormatter.resolveMaxContentLength(-10))
    }

    @Test
    fun testBinaryBytesDetectionAndClipboardSanitization() {
        assertTrue(MarkdownFormatter.isBinaryBytes("SQLite format 3\u0000header".toByteArray(Charsets.UTF_8)))
        assertTrue(MarkdownFormatter.isBinaryBytes(byteArrayOf(0x41, 0x42, 0x00, 0x43)))
        assertFalse(MarkdownFormatter.isBinaryBytes("fun main() { println(\"你好世界\") }".toByteArray(Charsets.UTF_8)))

        assertEquals("abcdef", MarkdownFormatter.sanitizeForClipboard("abc\u0000def"))
        assertEquals("clean", MarkdownFormatter.sanitizeForClipboard("clean"))
    }
}
