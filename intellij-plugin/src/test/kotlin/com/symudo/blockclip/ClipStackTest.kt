package com.symudo.blockclip

import com.intellij.openapi.vfs.VirtualFile
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.InputStream
import java.io.OutputStream

class ClipStackTest {

    private class DummyVirtualFile(private val fileName: String, private val rawContent: String = "") : VirtualFile() {
        override fun getName(): String = fileName
        override fun getFileSystem() = throw UnsupportedOperationException()
        override fun getPath(): String = "/project/$fileName"
        override fun isWritable(): Boolean = false
        override fun isDirectory(): Boolean = false
        override fun isValid(): Boolean = true
        override fun getParent(): VirtualFile? = null
        override fun getChildren(): Array<VirtualFile> = emptyArray()
        override fun getOutputStream(requestor: Any?, newModificationStamp: Long, newTimeStamp: Long): OutputStream =
            throw UnsupportedOperationException()
        override fun contentsToByteArray(): ByteArray = rawContent.toByteArray(Charsets.UTF_8)
        override fun getTimeStamp(): Long = 0
        override fun getLength(): Long = rawContent.length.toLong()
        override fun refresh(asynchronous: Boolean, recursive: Boolean, postRunnable: Runnable?) {}
        override fun getInputStream(): InputStream = throw UnsupportedOperationException()
        override fun getExtension(): String = fileName.substringAfterLast('.', "")
    }

    @Test
    fun testFormatSelectionDirectCopy() {
        val mockFile = DummyVirtualFile("App.tsx")
        val formatted = MarkdownFormatter.formatSelection(mockFile, null, "return <div />;", "lines 12-14")
        assertTrue(formatted.startsWith("File: App.tsx (lines 12-14)\n\n```typescriptreact\n"))
        assertTrue(formatted.contains("return <div />;"))
        assertTrue(formatted.endsWith("```\n"))
    }

    @Test
    fun testFormatClipItemSnippet() {
        val mockFile = DummyVirtualFile("User.kt")
        val item = ClipItem(
            file = mockFile,
            relativePath = "src/User.kt",
            language = "kotlin",
            isSnippet = true,
            lineRange = "lines 10-25",
            snippetContent = "fun getUser(): User = User()",
            previewText = "fun getUser()..."
        )

        val formatted = MarkdownFormatter.formatClipItem(item, null)
        assertTrue(formatted.startsWith("File: src/User.kt (lines 10-25)\n\n```kotlin\n"))
        assertTrue(formatted.contains("fun getUser(): User = User()"))
        assertTrue(formatted.endsWith("```\n"))
    }

    @Test
    fun testFormatClipItemWithBackticks() {
        val mockFile = DummyVirtualFile("README.md")
        val item = ClipItem(
            file = mockFile,
            relativePath = "README.md",
            language = "markdown",
            isSnippet = true,
            lineRange = "lines 5-8",
            snippetContent = "```bash\npnpm install\n```",
            previewText = "```bash..."
        )

        val formatted = MarkdownFormatter.formatClipItem(item, null)
        assertTrue(formatted.startsWith("File: README.md (lines 5-8)\n\n````markdown\n"))
        assertTrue(formatted.endsWith("````\n"))
    }

    @Test
    fun testProcessClipItemsAndMaxLengthTruncation() {
        val mockFile = DummyVirtualFile("A.ts", "export const a = 1;")
        val item1 = ClipItem(
            file = mockFile,
            relativePath = "src/A.ts",
            language = "typescript",
            isSnippet = false
        )
        val item2 = ClipItem(
            file = mockFile,
            relativePath = "src/A.ts",
            language = "typescript",
            isSnippet = true,
            lineRange = "line 5",
            snippetContent = "export const b = 2;"
        )

        val fullResult = MarkdownFormatter.processClipItems(listOf(item1, item2), null)
        assertEquals(2, fullResult.processedCount)
        assertFalse(fullResult.stoppedEarly)
        assertTrue(fullResult.content.contains("export const a = 1;"))
        assertTrue(fullResult.content.contains("File: src/A.ts (line 5)"))

        // 限制长度触发提前截断
        val truncated = MarkdownFormatter.processClipItems(listOf(item1, item2), null, maxLength = 70)
        assertEquals(1, truncated.processedCount)
        assertTrue(truncated.stoppedEarly)
    }
}
