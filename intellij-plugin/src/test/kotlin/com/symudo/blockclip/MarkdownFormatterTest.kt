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
}
