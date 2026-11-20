package com.symudo.blockclip

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

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
    fun testFormatLineRangeAndOffByOneFix() {
        assertEquals("line 1", MarkdownFormatter.formatLineRange(0, 0, 12))
        assertEquals("lines 10-15", MarkdownFormatter.formatLineRange(9, 14, 8))
        // 拖选停在下一行第 0 列时不多算一行
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
    fun testTokenEstimationAndStats() {
        assertEquals(0, MarkdownFormatter.estimateTokens(""))
        assertEquals(100, MarkdownFormatter.estimateTokens("a".repeat(400)))
        assertTrue(MarkdownFormatter.estimateTokens("你好世界测试代码") >= 5)

        assertEquals("512 B", MarkdownFormatter.formatBytes(512))
        assertEquals("2.0 KB", MarkdownFormatter.formatBytes(2048))
        assertEquals("2.00 MB", MarkdownFormatter.formatBytes(2L * 1024 * 1024))

        val stats = MarkdownFormatter.formatStats("console.log('hello world');")
        assertTrue(stats.contains("B, ~"))
        assertTrue(stats.endsWith("tokens"))
    }
}
