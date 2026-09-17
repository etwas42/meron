package jp.nonbili.meron.ui

import androidx.compose.runtime.Composable
import jp.nonbili.meron.shared.MessageBody
import jp.nonbili.meron.shared.ThreadReadPage

@Composable
internal expect fun rememberMailPrinter(errorText: String): (String, String) -> Unit

// Print only text: message markup never runs or loads remote tracking images.
internal fun mailPrintHtml(
    message: MessageBody,
    fromLabel: String,
    toLabel: String,
    ccLabel: String,
    bccLabel: String,
    replyToLabel: String,
    attachmentsLabel: String,
    noSubject: String,
): String = printHtmlDocument(listOf(mailPrintText(message, fromLabel, toLabel, ccLabel, bccLabel, replyToLabel, attachmentsLabel, noSubject)))

private fun mailPrintText(
    message: MessageBody,
    fromLabel: String,
    toLabel: String,
    ccLabel: String,
    bccLabel: String,
    replyToLabel: String,
    attachmentsLabel: String,
    noSubject: String,
): String {
    val text =
        buildString {
            appendLine(message.subject.ifBlank { noSubject })
            appendLine("$fromLabel: ${fullFromAddress(message)}")
            if (message.to.isNotBlank()) appendLine("$toLabel: ${message.to}")
            if (message.cc.isNotBlank()) appendLine("$ccLabel: ${message.cc}")
            if (message.bcc.isNotBlank()) appendLine("$bccLabel: ${message.bcc}")
            if (message.replyTo.isNotBlank()) appendLine("$replyToLabel: ${message.replyTo}")
            if (message.dateEpochSeconds != 0L) appendLine(formatMessageFullTimestamp(message.dateEpochSeconds))
            appendLine()
            append(printMessagePlainText(message))
            if (message.attachments.isNotEmpty()) {
                appendLine()
                appendLine()
                appendLine("$attachmentsLabel:")
                message.attachments.forEach { appendLine(it.filename) }
            }
        }
    return text
}

internal fun printMessagePlainText(message: MessageBody): String =
    messagePlainText(
        message.copy(
            bodyHtml =
                message.bodyHtml
                    .replace(Regex("<!--.*?-->", RegexOption.DOT_MATCHES_ALL), "")
                    .replace(Regex("<(script|style)\\b[^>]*>.*?</\\1\\s*>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL)), ""),
        ),
    )

internal fun printHtmlDocument(messages: List<String>): String {
    val sections =
        messages.joinToString("\n") { text ->
            "<pre>" + text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;") + "</pre>"
        }
    return """<!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>@page { margin: 15mm; } body { color: black; background: white; }
        pre + pre { break-before: page; page-break-before: always; }
        pre { white-space: pre-wrap; overflow-wrap: anywhere; font: 11pt/1.5 sans-serif; }</style>
        </head><body>$sections</body></html>"""
}

@Composable
internal fun rememberPrintMessage(): (MessageBody) -> Unit {
    val print = rememberMailPrinter(tr("chat.couldNotPrintMessage"))
    val from = tr("composer.fields.from")
    val to = tr("composer.fields.to")
    val cc = tr("composer.fields.cc")
    val bcc = tr("composer.fields.bcc")
    val replyTo = tr("chat.replyTo")
    val attachments = tr("chat.printAttachments")
    val noSubject = tr("threads.noSubject")
    return { message ->
        print(message.subject.ifBlank { noSubject }, mailPrintHtml(message, from, to, cc, bcc, replyTo, attachments, noSubject))
    }
}

internal suspend fun loadPrintThread(fetchPage: suspend (String?) -> ThreadReadPage): List<MessageBody> {
    val messages = linkedMapOf<String, MessageBody>()
    val cursors = mutableSetOf<String?>()
    var cursor: String? = null
    do {
        check(cursors.add(cursor)) { "Repeated thread cursor" }
        val page = fetchPage(cursor)
        page.messages.forEach { message ->
            if (message.id !in messages) messages[message.id] = message
        }
        cursor = page.nextCursor.takeIf { it.isNotBlank() }
    } while (cursor != null)
    check(messages.isNotEmpty()) { "Thread is empty" }
    return messages.values.sortedBy { it.dateEpochSeconds }
}

@Composable
internal fun rememberPrintThread(): (String, List<MessageBody>) -> Unit {
    val print = rememberMailPrinter(tr("chat.couldNotPrintThread"))
    val unavailableBody = tr("chat.couldNotPrintMessage")
    val from = tr("composer.fields.from")
    val to = tr("composer.fields.to")
    val cc = tr("composer.fields.cc")
    val bcc = tr("composer.fields.bcc")
    val replyTo = tr("chat.replyTo")
    val attachments = tr("chat.printAttachments")
    val noSubject = tr("threads.noSubject")
    return { subject, messages ->
        print(
            subject.ifBlank { noSubject },
            printHtmlDocument(
                messages.map {
                    mailPrintText(if (it.bodyMissing) it.copy(body = unavailableBody) else it, from, to, cc, bcc, replyTo, attachments, noSubject)
                },
            ),
        )
    }
}
