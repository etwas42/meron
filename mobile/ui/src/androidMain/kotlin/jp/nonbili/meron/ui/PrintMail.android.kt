package jp.nonbili.meron.ui

import android.content.Context
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.print.PageRange
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext

// Android requires a strong reference while the document loads and prints.
private val activePrintViews = mutableSetOf<WebView>()

@Composable
internal actual fun rememberMailPrinter(errorText: String): (String, String) -> Unit {
    val context = LocalContext.current
    return remember(context, errorText) {
        { title, html ->
            val webView = WebView(context)
            activePrintViews.add(webView)
            val handler = Handler(Looper.getMainLooper())
            var disposed = false
            var started = false
            lateinit var loadTimeout: Runnable

            fun dispose() {
                if (disposed) return
                disposed = true
                handler.removeCallbacks(loadTimeout)
                activePrintViews.remove(webView)
                webView.stopLoading()
                webView.destroy()
            }

            fun fail() {
                if (disposed) return
                dispose()
                Toast.makeText(context, errorText, Toast.LENGTH_LONG).show()
            }
            loadTimeout = Runnable { if (!started) fail() }
            handler.postDelayed(loadTimeout, 30_000)
            webView.settings.javaScriptEnabled = false
            webView.settings.blockNetworkLoads = true
            webView.webViewClient =
                object : WebViewClient() {
                    override fun onReceivedError(
                        view: WebView,
                        request: WebResourceRequest,
                        error: WebResourceError,
                    ) {
                        if (request.isForMainFrame && !started) fail()
                    }

                    override fun onPageFinished(
                        view: WebView,
                        url: String?,
                    ) {
                        if (started || disposed) return
                        started = true
                        handler.removeCallbacks(loadTimeout)
                        try {
                            val manager = context.getSystemService(Context.PRINT_SERVICE) as PrintManager
                            // Retain the WebView until the print framework finishes, including cancellation.
                            val adapter = view.createPrintDocumentAdapter(title)
                            manager.print(
                                title,
                                object : PrintDocumentAdapter() {
                                    override fun onStart() = adapter.onStart()

                                    override fun onLayout(
                                        oldAttributes: PrintAttributes?,
                                        newAttributes: PrintAttributes?,
                                        cancellationSignal: CancellationSignal?,
                                        callback: LayoutResultCallback?,
                                        extras: Bundle?,
                                    ) = adapter.onLayout(oldAttributes, newAttributes, cancellationSignal, callback, extras)

                                    override fun onWrite(
                                        pages: Array<out PageRange>?,
                                        destination: ParcelFileDescriptor?,
                                        cancellationSignal: CancellationSignal?,
                                        callback: WriteResultCallback?,
                                    ) = adapter.onWrite(pages, destination, cancellationSignal, callback)

                                    // Cancellation is delivered through the signals above;
                                    // PrintDocumentAdapter has no onCancel lifecycle method.
                                    override fun onFinish() {
                                        try {
                                            adapter.onFinish()
                                        } finally {
                                            dispose()
                                        }
                                    }
                                },
                                PrintAttributes.Builder().build(),
                            )
                        } catch (_: Exception) {
                            fail()
                        }
                    }
                }
            try {
                webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null)
            } catch (_: Exception) {
                fail()
            }
        }
    }
}
