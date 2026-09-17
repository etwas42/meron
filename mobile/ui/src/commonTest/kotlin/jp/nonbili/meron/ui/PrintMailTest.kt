package jp.nonbili.meron.ui

import jp.nonbili.meron.shared.MessageBody
import jp.nonbili.meron.shared.ThreadReadPage
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PrintMailTest {
    @Test
    fun escapesMailAndIncludesCompleteBodyAndAddresses() {
        val message =
            MessageBody(
                id = "m",
                from = "Alice <alice@example.com>",
                to = "bob@example.com",
                cc = "cc@example.com",
                bcc = "bcc@example.com",
                subject = "A & B",
                body = "<img src=x onerror=bad()>\n\n> quoted tail",
                bodyQuoteStart = 10,
            )
        val html = mailPrintHtml(message, "From", "To", "Cc", "Bcc", "Reply-To", "Attachments", "No subject")
        assertTrue(html.contains("Alice &lt;alice@example.com&gt;"))
        assertTrue(html.contains("A &amp; B"))
        assertTrue(html.contains("Cc: cc@example.com"))
        assertTrue(html.contains("Bcc: bcc@example.com"))
        assertTrue(html.contains("&gt; quoted tail"))
        assertFalse(html.contains("<img"))
    }

    @Test
    fun htmlOnlyMailOmitsStylesAndScriptsAndUsesSubjectFallback() {
        val message =
            MessageBody(
                id = "m",
                from = "Alice",
                to = "Bob",
                subject = " ",
                body = "",
                bodyHtml = "<STYLE>raw css\nbody { color: red; }</STYLE><script type='text/javascript'>raw js</script><p>Newsletter</p>",
            )
        val html = mailPrintHtml(message, "From", "To", "Cc", "Bcc", "Reply-To", "Attachments", "No subject")
        assertTrue(html.contains("<pre>No subject\n"))
        assertTrue(html.contains("Newsletter"))
        assertFalse(html.contains("raw css"))
        assertFalse(html.contains("raw js"))
    }

    @Test
    fun unterminatedMarkupPreservesTrailingTextAndReaderTextIsUnchanged() {
        for (prefix in listOf("<!--", "<script>", "<style>")) {
            val message = MessageBody(id = "m", from = "Alice", to = "Bob", subject = "Topic", body = "", bodyHtml = "$prefix trailing text")
            assertTrue(printMessagePlainText(message).contains("trailing text"))
        }
        val message = MessageBody(id = "m", from = "Alice", to = "Bob", subject = "Topic", body = "", bodyHtml = "<style>reader text</style><p>Body</p>")
        assertTrue(messagePlainText(message).contains("reader text"))
        assertFalse(printMessagePlainText(message).contains("reader text"))
    }

    @Test
    fun loadsEveryPageInOrderWithoutDuplicates() =
        runBlocking<Unit> {
            val newest = MessageBody(id = "new", from = "Alice", to = "Bob", subject = "Topic", body = "New", dateEpochSeconds = 2)
            val oldest = newest.copy(id = "old", body = "Old", dateEpochSeconds = 1)
            val cursors = mutableListOf<String?>()
            val result =
                loadPrintThread { cursor ->
                    cursors += cursor
                    if (cursor == null) {
                        ThreadReadPage(listOf(newest), "older")
                    } else {
                        ThreadReadPage(listOf(oldest, newest), "")
                    }
                }
            assertEquals(listOf(null, "older"), cursors)
            assertEquals(listOf(oldest, newest), result)
            val html = printHtmlDocument(result.map { it.body })
            assertTrue(html.indexOf("<pre>Old</pre>") < html.indexOf("<pre>New</pre>"))
            assertTrue(html.contains("break-before: page"))
        }

    @Test
    fun preservesMissingBodiesAndRejectsEmptyThreadsAndRepeatedCursors() =
        runBlocking<Unit> {
            val message = MessageBody(id = "m", from = "Alice", to = "Bob", subject = "Topic", body = "Text")
            assertTrue(loadPrintThread { ThreadReadPage(listOf(message.copy(bodyMissing = true)), "") }.single().bodyMissing)
            assertFailsWith<IllegalStateException> {
                loadPrintThread { ThreadReadPage(emptyList(), "") }
            }
            assertFailsWith<IllegalStateException> {
                loadPrintThread { ThreadReadPage(listOf(message), "same") }
            }
        }
}
