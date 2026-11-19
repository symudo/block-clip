package com.symudo.blockclip

import com.intellij.openapi.vfs.VirtualFile
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.InputStream
import java.io.OutputStream

class ClipStackTest {

    private class DummyVirtualFile(private val fileName: String) : VirtualFile() {
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
        override fun contentsToByteArray(): ByteArray = byteArrayOf()
        override fun getTimeStamp(): Long = 0
        override fun getLength(): Long = 0
        override fun refresh(asynchronous: Boolean, recursive: Boolean, postRunnable: Runnable?) {}
        override fun getInputStream(): InputStream = throw UnsupportedOperationException()
        override fun getExtension(): String = fileName.substringAfterLast('.', "")
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
    fun testStackBasicOperations() {
        val mockFile1 = DummyVirtualFile("A.ts")
        val mockFile2 = DummyVirtualFile("B.ts")

        val items = mutableListOf<ClipItem>()

        val item1 = ClipItem(
            file = mockFile1,
            relativePath = "src/A.ts",
            language = "typescript",
            isSnippet = false
        )
        val snippetA = ClipItem(
            file = mockFile1,
            relativePath = "src/A.ts",
            language = "typescript",
            isSnippet = true,
            lineRange = "lines 1-10",
            snippetContent = "export const x = 1;"
        )
        val item2 = ClipItem(
            file = mockFile2,
            relativePath = "src/B.ts",
            language = "typescript",
            isSnippet = false
        )

        items.add(item1)
        items.add(snippetA)
        items.add(item2)
        assertEquals(3, items.size)

        // 验证 pop LIFO
        val popped = items.removeAt(items.size - 1)
        assertEquals("src/B.ts", popped.relativePath)
        assertEquals(2, items.size)

        // 验证根据 ID 删除单条
        val removed = items.removeIf { it.id == snippetA.id }
        assertTrue(removed)
        assertEquals(1, items.size)
        assertEquals(item1.id, items[0].id)
    }
}
