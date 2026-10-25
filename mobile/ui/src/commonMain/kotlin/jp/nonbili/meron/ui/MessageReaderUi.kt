package jp.nonbili.meron.ui

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Forward
import androidx.compose.material.icons.automirrored.filled.Reply
import androidx.compose.material.icons.automirrored.filled.ReplyAll
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.backhandler.BackHandler
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import dev.chrisbanes.haze.hazeSource
import dev.chrisbanes.haze.rememberHazeState
import jp.nonbili.meron.shared.MessageAttachment
import jp.nonbili.meron.shared.MessageBody
import jp.nonbili.meron.shared.standaloneAttachments
import jp.nonbili.meron.shared.visibleImageAttachments
import kotlinx.coroutines.launch

// Full-screen reader for a single message — the mobile equivalent of the desktop
// "open in new tab" reader, showing the full header plus the message body.
@OptIn(ExperimentalMaterial3Api::class, ExperimentalComposeUiApi::class)
@Composable
internal fun MessageReaderScreen(
    message: MessageBody,
    preferHtml: Boolean,
    isRss: Boolean,
    actionsEnabled: Boolean,
    remoteContent: MessageRemoteContent,
    onBack: () -> Unit,
    onCopy: (String, String) -> Unit,
    onComposeTo: (String) -> Unit,
    onForward: (MessageBody) -> Unit,
    // Reply, reply all, forward and delete move from the overflow menu to a
    // bottom bar, where they are easier to reach (the reader-bottom-actions setting).
    bottomActions: Boolean,
    onReplyToMessage: (MessageBody) -> Unit,
    onReplyAllToMessage: (MessageBody) -> Unit,
    canReplyAllToMessage: (MessageBody) -> Boolean,
    onEditAsNew: (MessageBody) -> Unit,
    onDelete: (MessageBody) -> Unit,
    onOpenAttachment: (MessageAttachment) -> Unit,
    onSaveAttachment: (MessageAttachment) -> Unit,
    loadImageAttachment: suspend (MessageAttachment) -> ImageBitmap?,
    onOpenImageAttachment: (MessageAttachment) -> Unit,
    onOpenHtmlImage: (String) -> Unit,
    onOpenUrl: (String) -> Unit,
) {
    var menuOpen by remember(message.id) { mutableStateOf(false) }
    val scrollState = rememberScrollState()
    val density = LocalDensity.current
    val dismissThresholdPx = remember(density) { with(density) { 120.dp.toPx() } }
    var screenHeightPx by remember { mutableStateOf(0f) }
    var pullDistancePx by remember(message.id) { mutableStateOf(0f) }
    var dismissedByPull by remember(message.id) { mutableStateOf(false) }
    var isAnimating by remember(message.id) { mutableStateOf(false) }
    val coroutineScope = rememberCoroutineScope()
    // The message, captured for the frosted bands under the floating bars.
    val hazeState = rememberHazeState()
    var bottomCardHeightPx by remember { mutableIntStateOf(0) }

    BackHandler(onBack = onBack)

    suspend fun handleDragRelease(velocityY: Float) {
        isAnimating = true
        if (pullDistancePx >= dismissThresholdPx || velocityY > 1000f) {
            val target = if (screenHeightPx > 0f) screenHeightPx else with(density) { 800.dp.toPx() }
            animate(
                initialValue = pullDistancePx,
                targetValue = target,
                initialVelocity = velocityY,
                animationSpec = spring(stiffness = Spring.StiffnessMediumLow),
            ) { value, _ ->
                pullDistancePx = value
            }
            dismissedByPull = true
            onBack()
        } else {
            animate(
                initialValue = pullDistancePx,
                targetValue = 0f,
                initialVelocity = velocityY,
                animationSpec = spring(stiffness = Spring.StiffnessMedium),
            ) { value, _ ->
                pullDistancePx = value
            }
        }
        isAnimating = false
    }

    val pullToConversationConnection =
        remember(message.id, dismissThresholdPx, scrollState, screenHeightPx) {
            object : NestedScrollConnection {
                override fun onPreScroll(
                    available: Offset,
                    source: NestedScrollSource,
                ): Offset {
                    if (dismissedByPull || isAnimating) return Offset.Zero

                    val resistance =
                        if (screenHeightPx > 0f) {
                            (1f - (pullDistancePx / screenHeightPx).coerceIn(0f, 1f)).coerceAtLeast(0.3f)
                        } else {
                            0.8f
                        }

                    // When pulling down (available.y > 0) and at the top of the scrollable content (scrollState.value == 0)
                    if (available.y > 0f && scrollState.value == 0) {
                        pullDistancePx += available.y * resistance
                        return Offset(0f, available.y)
                    }

                    // When pushing back up (available.y < 0) and we have already pulled down (pullDistancePx > 0)
                    if (available.y < 0f && pullDistancePx > 0f) {
                        val consumedY = available.y.coerceAtLeast(-pullDistancePx / resistance)
                        pullDistancePx = (pullDistancePx + consumedY * resistance).coerceAtLeast(0f)
                        return Offset(0f, consumedY)
                    }

                    return Offset.Zero
                }

                override suspend fun onPreFling(available: Velocity): Velocity {
                    if (dismissedByPull || isAnimating || pullDistancePx == 0f) return Velocity.Zero
                    handleDragRelease(available.y)
                    return available
                }
            }
        }

    Box(
        modifier =
            Modifier
                .fillMaxSize()
                .onSizeChanged { size ->
                    screenHeightPx = size.height.toFloat()
                }.graphicsLayer {
                    translationY = pullDistancePx
                    val progress = if (screenHeightPx > 0f) (pullDistancePx / screenHeightPx).coerceIn(0f, 1f) else 0f
                    alpha = 1f - progress * 0.4f
                    scaleX = 1f - progress * 0.05f
                    scaleY = 1f - progress * 0.05f
                }.nestedScroll(pullToConversationConnection)
                .pointerInput(Unit) {
                    detectTapGestures { }
                },
    ) {
        Scaffold(
            topBar = {
                TopAppBar(
                    modifier =
                        Modifier.pointerInput(message.id, screenHeightPx) {
                            detectVerticalDragGestures(
                                onVerticalDrag = { _, dragAmount ->
                                    if (!dismissedByPull && !isAnimating) {
                                        val resistance =
                                            if (screenHeightPx > 0f) {
                                                (1f - (pullDistancePx / screenHeightPx).coerceIn(0f, 1f)).coerceAtLeast(0.3f)
                                            } else {
                                                0.8f
                                            }
                                        pullDistancePx = (pullDistancePx + dragAmount * resistance).coerceAtLeast(0f)
                                    }
                                },
                                onDragEnd = {
                                    if (!dismissedByPull && !isAnimating && pullDistancePx > 0f) {
                                        coroutineScope.launch {
                                            handleDragRelease(0f)
                                        }
                                    }
                                },
                                onDragCancel = {
                                    if (!dismissedByPull && !isAnimating && pullDistancePx > 0f) {
                                        coroutineScope.launch {
                                            handleDragRelease(0f)
                                        }
                                    }
                                },
                            )
                        },
                    // The subject lives in the content area below, so the bar
                    // stays empty and gives the body the full width.
                    title = {},
                    navigationIcon = {
                        FloatingBarChip(CircleShape, Modifier.padding(start = 4.dp).width(FLOATING_BAR_CHIP_HEIGHT)) {
                            IconButton(onClick = onBack) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = tr("buttons.back"))
                            }
                        }
                    },
                    actions = {
                        FloatingBarChip(CircleShape, Modifier.padding(end = 4.dp).width(FLOATING_BAR_CHIP_HEIGHT)) {
                            IconButton(onClick = { menuOpen = true }) {
                                Icon(Icons.Filled.MoreVert, contentDescription = tr("chat.moreMessageActions"))
                            }
                            MessageActionsMenu(
                                expanded = menuOpen,
                                onDismiss = { menuOpen = false },
                                preferHtml = preferHtml,
                                allowRemote = remoteContent.allowRemote,
                                message = message,
                                isRss = isRss,
                                actionsEnabled = actionsEnabled,
                                onForward = onForward,
                                onReplyAllToMessage = onReplyAllToMessage,
                                canReplyAllToMessage = canReplyAllToMessage,
                                onEditAsNew = onEditAsNew,
                                onToggleRead = null,
                                onToggleStarred = null,
                                onDelete = onDelete,
                                onCopyMessageText = onCopy,
                                onOpenUrl = onOpenUrl,
                                mailActionsInBar = bottomActions,
                            )
                        }
                    },
                    // See-through, like the thread's: the message scrolls on
                    // under the bar, between its floating buttons.
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent, scrolledContainerColor = Color.Transparent),
                )
            },
            bottomBar = {
                if (actionsEnabled && bottomActions) {
                    FloatingCard(
                        RoundedCornerShape(24.dp),
                        Modifier
                            .navigationBarsPadding()
                            .padding(start = 12.dp, end = 12.dp, bottom = 12.dp)
                            .onSizeChanged { bottomCardHeightPx = it.height },
                    ) {
                        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                            ReaderBottomAction(Icons.AutoMirrored.Filled.Reply, tr("chat.actions.reply")) {
                                onReplyToMessage(message)
                            }
                            if (canReplyAllToMessage(message)) {
                                ReaderBottomAction(Icons.AutoMirrored.Filled.ReplyAll, tr("chat.actions.replyAll")) {
                                    onReplyAllToMessage(message)
                                }
                            }
                            ReaderBottomAction(Icons.AutoMirrored.Filled.Forward, tr("chat.actions.forward")) {
                                onForward(message)
                            }
                            ReaderBottomAction(
                                Icons.Filled.Delete,
                                tr("buttons.delete"),
                                tint = MaterialTheme.colorScheme.error,
                            ) {
                                onDelete(message)
                            }
                        }
                    }
                }
            },
        ) { innerPadding ->
            Box(Modifier.fillMaxSize()) {
                val htmlBody = preferHtml && message.bodyHtml.isNotBlank()
                // The web view paints mail on white, so a tinted card would frame it
                // as a square white box; a light card goes white to hold it cleanly.
                val surface = MaterialTheme.colorScheme.surface
                val cardColor =
                    if (htmlBody && !LocalDarkMailBodies.current && surface.luminance() > 0.5f) Color.White else surface
                val cardShape = RoundedCornerShape(16.dp)
                val layoutDirection = LocalLayoutDirection.current
                // Runs on under both bars; the scrolled content starts and ends
                // clear of them.
                Column(
                    Modifier
                        .fillMaxSize()
                        .padding(
                            PaddingValues(
                                start = innerPadding.calculateStartPadding(layoutDirection),
                                end = innerPadding.calculateEndPadding(layoutDirection),
                            ),
                        ).background(MaterialTheme.colorScheme.background)
                        .hazeSource(hazeState)
                        .appScrollbar(scrollState)
                        .verticalScroll(scrollState)
                        .padding(
                            start = 12.dp,
                            end = 12.dp,
                            top = innerPadding.calculateTopPadding() + 16.dp,
                            bottom = innerPadding.calculateBottomPadding() + 16.dp,
                        ),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Text(
                        message.subject.ifBlank { tr("threads.noSubject") },
                        modifier = Modifier.padding(horizontal = 4.dp),
                        fontWeight = FontWeight.SemiBold,
                        style = MaterialTheme.typography.headlineSmall,
                    )
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .shadow(3.dp, cardShape, clip = false)
                            .clip(cardShape)
                            .background(cardColor)
                            .padding(horizontal = 14.dp, vertical = 12.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            // The From chip already names the sender, so there is no
                            // separate sender line. Tapping any chip copies the full
                            // `Name <addr>`.
                            MessageAddressDetails(
                                message = message,
                                onCopy = onCopy,
                                onComposeTo = onComposeTo,
                                textColor = MaterialTheme.colorScheme.onSurfaceVariant,
                                labelWidth = 40.dp,
                            )
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    formatMessageFullTimestamp(message.dateEpochSeconds),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                                BlockedRemoteButton(
                                    message = message,
                                    remoteContent = remoteContent,
                                    preferHtml = preferHtml,
                                    searchQuery = "",
                                )
                            }
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        val standaloneAttachmentsForMessage = standaloneAttachments(message)
                        val (imageAttachments, otherAttachments) =
                            standaloneAttachmentsForMessage.partition { it.mimeType.startsWith("image/") }
                        val visibleImages = visibleImageAttachments(imageAttachments, remoteContent.allowRemote)
                        if (htmlBody) {
                            // Only the reader shrinks over-wide mail to fit: it has the
                            // full screen to scale into, where a bubble would render the
                            // same mail as an unreadable thumbnail.
                            HtmlMessageBody(
                                html = message.bodyHtml,
                                mediaMissing = message.mediaMissing,
                                quoteKey = message.id,
                                allowRemote = remoteContent.allowRemote,
                                onOpenUrl = onOpenUrl,
                                onOpenImage = onOpenHtmlImage,
                                fitWideContent = true,
                                darkSurface = cardColor,
                            )
                        } else {
                            SelectableMessageText(
                                text =
                                    message.body.ifBlank {
                                        when {
                                            message.bodyLoading -> tr("common.loading")
                                            message.bodyMissing -> tr("chat.messageLoadFailed")
                                            else -> "(no content)"
                                        }
                                    },
                                onOpenUrl = onOpenUrl,
                                style = messageBodyTextStyle(MaterialTheme.typography.bodyLarge),
                            )
                        }
                        if (visibleImages.isNotEmpty() || otherAttachments.isNotEmpty()) {
                            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                            if (visibleImages.isNotEmpty()) {
                                AttachmentImageGrid(
                                    images = visibleImages,
                                    mediaMissing = message.mediaMissing,
                                    loadImageAttachment = loadImageAttachment,
                                    onOpen = onOpenImageAttachment,
                                )
                            }
                            otherAttachments.forEach { attachment ->
                                AttachmentRow(
                                    attachment = attachment,
                                    textColor = MaterialTheme.colorScheme.onSurface,
                                    onOpen = { onOpenAttachment(attachment) },
                                    onSave = { onSaveAttachment(attachment) },
                                )
                            }
                        }
                    }
                }
                // Frosted under the status bar and the app bar, and around the
                // floating actions down through the navigation bar: from the
                // middle of the card, which covers where the band begins.
                val fadePx = with(density) { 16.dp.toPx() }
                val bottomCardPx = if (actionsEnabled && bottomActions) bottomCardHeightPx else 0
                FrostedBand(
                    hazeState,
                    heightPx = with(density) { innerPadding.calculateTopPadding().roundToPx() },
                    fadeAtBottomPx = fadePx,
                    // A little heavier: the status bar's icons sit on it.
                    tintAlpha = 0.4f,
                    modifier = Modifier.align(Alignment.TopCenter),
                )
                FrostedBand(
                    hazeState,
                    heightPx = with(density) { innerPadding.calculateBottomPadding().roundToPx() } - bottomCardPx / 2,
                    fadeAtTopPx = if (bottomCardPx > 0) 0f else fadePx,
                    modifier = Modifier.align(Alignment.BottomCenter),
                )
            }
        }
    }
}

@Composable
private fun ReaderBottomAction(
    icon: ImageVector,
    label: String,
    tint: Color = LocalContentColor.current,
    onClick: () -> Unit,
) {
    Column(
        Modifier
            .clip(RoundedCornerShape(12.dp))
            .clickable(onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, contentDescription = null, tint = tint)
        Text(label, style = MaterialTheme.typography.labelSmall, color = tint, maxLines = 1)
    }
}
