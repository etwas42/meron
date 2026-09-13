package jp.nonbili.meron.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.UIKitView
import kotlinx.cinterop.ExperimentalForeignApi
import platform.CoreGraphics.CGRectMake
import platform.Foundation.NSNumber
import platform.WebKit.WKScriptMessage
import platform.WebKit.WKScriptMessageHandlerProtocol
import platform.WebKit.WKUserContentController
import platform.WebKit.WKWebView
import platform.WebKit.WKWebViewConfiguration
import platform.darwin.NSObject

@OptIn(ExperimentalForeignApi::class)
@Composable
actual fun MailWebView(
    html: String,
    modifier: Modifier,
    onContentHeight: (Dp) -> Unit,
    onOpenUrl: (String) -> Unit,
    onOpenImage: (String) -> Unit,
    onLinkLongPress: (String, DpOffset) -> Unit,
    // Unused: shrink-to-fit is driven by Android's useWideViewPort/text
    // autosizing, which WKWebView has no equivalent for. The script's fit pass
    // is gated on the same flag and stays off here, so iOS keeps reflow-only
    // rendering and the height bridge's scale-1 assumption holds.
    @Suppress("UNUSED_PARAMETER") fitWideContent: Boolean,
    onQuoteToggle: (Boolean) -> Unit,
) {
    val latestOnHeight = rememberUpdatedState(onContentHeight)
    val latestOnOpenUrl = rememberUpdatedState(onOpenUrl)
    val latestOnOpenImage = rememberUpdatedState(onOpenImage)
    val latestOnQuoteToggle = rememberUpdatedState(onQuoteToggle)
    // The document last handed to this web view. `update` runs again on
    // recomposition (every height report recomposes), and reloading the same
    // page would reset what the reader did in it — an opened quote, for one.
    val loadedHtml = remember { LoadedHtml() }
    UIKitView(
        modifier = modifier,
        factory = {
            val config = WKWebViewConfiguration()
            // JS runs the height-reporting script; matches the desktop reader,
            // whose iframe also runs email scripts.
            config.defaultWebpagePreferences.allowsContentJavaScript = true
            config.userContentController.addScriptMessageHandler(
                scriptMessageHandler = HeightMessageHandler { cssPx -> latestOnHeight.value(cssPx.dp) },
                name = "meronHeight",
            )
            config.userContentController.addScriptMessageHandler(
                scriptMessageHandler = LinkMessageHandler { url -> latestOnOpenUrl.value(url) },
                name = "meronLink",
            )
            config.userContentController.addScriptMessageHandler(
                scriptMessageHandler = ImageMessageHandler { src -> latestOnOpenImage.value(src) },
                name = "meronImage",
            )
            config.userContentController.addScriptMessageHandler(
                scriptMessageHandler = QuoteMessageHandler { open -> latestOnQuoteToggle.value(open) },
                name = "meronQuote",
            )
            WKWebView(frame = CGRectMake(0.0, 0.0, 0.0, 0.0), configuration = config).apply {
                // Compose owns capped bubble scrolling; the web view is measured
                // to its full content height so its native scroll view would fight
                // the parent LazyColumn for vertical drags.
                scrollView.scrollEnabled = false
                setOpaque(false)
            }
        },
        update = { webView ->
            if (loadedHtml.value != html) {
                loadedHtml.value = html
                webView.loadHTMLString(html, baseURL = null)
            }
        },
    )
}

private class LoadedHtml(
    var value: String? = null,
)

private class QuoteMessageHandler(
    private val onToggle: (Boolean) -> Unit,
) : NSObject(),
    WKScriptMessageHandlerProtocol {
    override fun userContentController(
        userContentController: WKUserContentController,
        didReceiveScriptMessage: WKScriptMessage,
    ) {
        (didReceiveScriptMessage.body as? NSNumber)?.let { onToggle(it.boolValue) }
    }
}

private class HeightMessageHandler(
    private val onHeight: (Int) -> Unit,
) : NSObject(),
    WKScriptMessageHandlerProtocol {
    override fun userContentController(
        userContentController: WKUserContentController,
        didReceiveScriptMessage: WKScriptMessage,
    ) {
        (didReceiveScriptMessage.body as? NSNumber)?.let { onHeight(it.intValue) }
    }
}

private class LinkMessageHandler(
    private val onOpenUrl: (String) -> Unit,
) : NSObject(),
    WKScriptMessageHandlerProtocol {
    override fun userContentController(
        userContentController: WKUserContentController,
        didReceiveScriptMessage: WKScriptMessage,
    ) {
        (didReceiveScriptMessage.body as? String)?.takeIf { it.isNotBlank() }?.let(onOpenUrl)
    }
}

private class ImageMessageHandler(
    private val onOpenImage: (String) -> Unit,
) : NSObject(),
    WKScriptMessageHandlerProtocol {
    override fun userContentController(
        userContentController: WKUserContentController,
        didReceiveScriptMessage: WKScriptMessage,
    ) {
        (didReceiveScriptMessage.body as? String)?.takeIf { it.isNotBlank() }?.let(onOpenImage)
    }
}

internal actual val MailWebViewFollowsSystemFontScale: Boolean = false
