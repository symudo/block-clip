package com.symudo.blockclip

import com.intellij.openapi.vfs.VirtualFile
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.io.OutputStream

class ClipStackTest {

    private class DummyVirtualFile(
        private val fileName: String,
        private val rawContent: String = "",
        private val valid: Boolean = true,
        private val fakeLength: Long? = null,
        private val failOnRead: Boolean = false,
        private val headerBytes: ByteArray? = null
    ) : VirtualFile() {
        override fun getName(): String = fileName
        override fun getFileSystem() = throw UnsupportedOperationException()
        override fun getPath(): String = "/project/$fileName"
        override fun isWritable(): Boolean = false
        override fun isDirectory(): Boolean = false
        override fun isValid(): Boolean = valid
        override fun getParent(): VirtualFile? = null
        override fun getChildren(): Array<VirtualFile> = emptyArray()
        override fun getOutputStream(requestor: Any?, newModificationStamp: Long, newTimeStamp: Long): OutputStream =
            throw UnsupportedOperationException()
        override fun contentsToByteArray(): ByteArray {
            if (failOnRead) {
                throw AssertionError("Should not read oversized file into memory!")
            }
            return rawContent.toByteArray(Charsets.UTF_8)
        }
        override fun getTimeStamp(): Long = 0
        override fun getLength(): Long = fakeLength ?: rawContent.length.toLong()
        override fun refresh(asynchronous: Boolean, recursive: Boolean, postRunnable: Runnable?) {}
        override fun getInputStream(): InputStream =
            headerBytes?.let { ByteArrayInputStream(it) } ?: throw UnsupportedOperationException()
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
    fun testSkipsInvalidDeletedFilesAndPreChecksOversizedFiles() {
        val deletedFile = DummyVirtualFile("deleted.ts", valid = false)
        val aliveFile = DummyVirtualFile("alive.ts", rawContent = "export const ok = 1;")
        val res = MarkdownFormatter.processClipItems(
            listOf(
                ClipItem(file = deletedFile, relativePath = "deleted.ts", language = "typescript", isSnippet = false),
                ClipItem(file = aliveFile, relativePath = "alive.ts", language = "typescript", isSnippet = false)
            ),
            null
        )
        assertEquals(1, res.processedCount)
        assertEquals(1, res.skippedMissingCount)
        assertEquals("alive.ts", res.firstProcessedFileName)
        assertFalse(res.content.contains("deleted.ts"))
        assertTrue(res.content.contains("alive.ts"))

        // 验证超大文件在预检阶段即中止，不会触发 contentsToByteArray() 读取到内存
        val hugeFile = DummyVirtualFile("huge.sql", fakeLength = 60L * 1024 * 1024, failOnRead = true)
        val hugeRes = MarkdownFormatter.processFiles(listOf(hugeFile), null)
        assertEquals(0, hugeRes.processedCount)
        assertTrue(hugeRes.stoppedEarly)
        assertEquals("", hugeRes.content)

        // 验证设置为无限制（0MB -> Long.MAX_VALUE）时允许复制超过默认上限的文件
        val customAllowed = DummyVirtualFile("big.sql", rawContent = "SELECT 1;", fakeLength = 100L * 1024 * 1024)
        val unlimitedRes = MarkdownFormatter.processFiles(
            listOf(customAllowed),
            null,
            maxLength = MarkdownFormatter.resolveMaxContentLength(0)
        )
        assertEquals(1, unlimitedRes.processedCount)
        assertFalse(unlimitedRes.stoppedEarly)
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

        val truncated = MarkdownFormatter.processClipItems(listOf(item1, item2), null, maxLength = 70)
        assertEquals(1, truncated.processedCount)
        assertTrue(truncated.stoppedEarly)
    }

    @Test
    fun testUnknownExtensionBinaryFileDoesNotTruncateSubsequentFiles() {
        val pluginDataFile = DummyVirtualFile("cache_data", rawContent = "SQLite format 3\u0000\u0001\u0002binary")
        val normalCodeFile = DummyVirtualFile("Main.kt", rawContent = "fun main() = println(\"OK\")")

        val res = MarkdownFormatter.processFiles(listOf(pluginDataFile, normalCodeFile), null)
        assertEquals(2, res.processedCount)
        assertFalse(res.stoppedEarly)
        assertTrue(res.content.contains("File: cache_data\n"))
        assertTrue(res.content.contains("fun main() = println(\"OK\")"))
        assertFalse(res.content.contains("\u0000"))

        // 验证超大未知后缀二进制文件通过前 8KB 流式头探测跳过，不触发全量读盘，也不误中断后续正常源码
        val hugeBinary = DummyVirtualFile(
            fileName = "huge_unknown_cache",
            fakeLength = 80L * 1024 * 1024,
            failOnRead = true,
            headerBytes = byteArrayOf(0x53, 0x51, 0x4C, 0x00, 0x01, 0x02)
        )
        val resWithHuge = MarkdownFormatter.processFiles(listOf(hugeBinary, normalCodeFile), null, maxLength = 1024)
        assertEquals(2, resWithHuge.processedCount)
        assertFalse(resWithHuge.stoppedEarly)
        assertTrue(resWithHuge.content.contains("File: huge_unknown_cache\n"))
        assertTrue(resWithHuge.content.contains("fun main() = println(\"OK\")"))
    }
}
