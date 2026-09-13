package jp.nonbili.meron.ui

import androidx.compose.foundation.Image
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.type
import jp.nonbili.meron.shared.AttachmentReadParams
import jp.nonbili.meron.shared.MessageAttachment
import jp.nonbili.meron.shared.MobileMailCommandClient
import jp.nonbili.meron.shared.parseAttachmentDataResponse
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.io.encoding.Base64
import kotlin.io.encoding.ExperimentalEncodingApi

@OptIn(ExperimentalEncodingApi::class)
internal suspend fun MeronMobileState.readAttachmentBytes(attachment: MessageAttachment): ByteArray {
    val client = MobileMailCommandClient(core)
    val response =
        withManagedGoogleAuth(client, selectedCoreThread?.accountId.orEmpty()) {
            client.readAttachment(AttachmentReadParams(attachment.key))
        }
    val data = parseAttachmentDataResponse(response)
    if (data.isBlank()) error("Attachment data is empty")
    return Base64.Default.decode(data)
}

internal fun MeronMobileState.saveMessageAttachment(attachment: MessageAttachment) {
    if (attachment.key.isBlank()) {
        status =
            if (attachment.url.isNotBlank()) "Remote attachments can be opened but are not cached for saving." else "Attachment is not cached."
        return
    }
    if (!coreLoaded) {
        status = coreUnavailableMessage
        return
    }
    pendingAttachmentSave = attachment
    launchAttachmentSave(safeAttachmentFilename(attachment.filename))
}

internal fun MeronMobileState.openMessageAttachment(attachment: MessageAttachment) {
    if (attachment.url.isNotBlank()) {
        services.openUrl(attachment.url)
        return
    }
    if (attachment.key.isBlank()) {
        status = "Attachment is not cached."
        return
    }
    if (!coreLoaded) {
        status = coreUnavailableMessage
        return
    }
    scope.launch {
        runCatching {
            withContext(ioDispatcher) {
                val bytes = readAttachmentBytes(attachment)
                val image = if (attachment.mimeType.startsWith("image/")) decodeImageBitmap(bytes) else null
                bytes to image
            }
        }.onSuccess { (bytes, image) ->
            if (attachment.mimeType.startsWith("image/")) {
                if (image == null) {
                    status = "Attachment image could not be decoded"
                    return@onSuccess
                }
                imagePreview =
                    ImagePreview(
                        title = attachment.filename.ifBlank { "Image" },
                        image = image,
                        bytes = bytes,
                        mimeType = attachment.mimeType.ifBlank { "image/*" },
                        fileName = safeAttachmentFilename(attachment.filename),
                    )
            } else {
                when (
                    services.openFile(
                        bytes,
                        safeAttachmentFilename(attachment.filename),
                        attachment.mimeType.ifBlank { "application/octet-stream" },
                    )
                ) {
                    AttachmentOpenResult.Opened -> Unit
                    AttachmentOpenResult.Unsupported -> status = "No app can open this attachment."
                    AttachmentOpenResult.Blocked -> status = "This attachment type is blocked for safety."
                }
            }
        }.onFailure {
            status = "Attachment open failed: ${it.message}"
        }
    }
}

internal fun MeronMobileState.shareImagePreview(preview: ImagePreview) {
    services.shareFile(preview.bytes, preview.fileName, preview.mimeType.ifBlank { "image/*" })
}

internal fun MeronMobileState.copyImagePreview(preview: ImagePreview) {
    services.copyImage(preview.bytes, preview.mimeType.ifBlank { "image/*" }, preview.title.ifBlank { "Image" })
    status = "Image copied."
}

internal fun MeronMobileState.shareImageAttachment(attachment: MessageAttachment) {
    if (attachment.url.isNotBlank()) {
        services.openUrl(attachment.url)
        return
    }
    if (attachment.key.isBlank()) {
        status = "Attachment is not cached."
        return
    }
    scope.launch {
        runCatching {
            withContext(ioDispatcher) { readAttachmentBytes(attachment) }
        }.onSuccess { bytes ->
            services.shareFile(
                bytes,
                safeAttachmentFilename(attachment.filename),
                attachment.mimeType.ifBlank { "image/*" },
            )
        }.onFailure {
            status = "Image share failed: ${it.message}"
        }
    }
}

internal fun MeronMobileState.copyImageAttachment(attachment: MessageAttachment) {
    if (attachment.key.isBlank()) {
        status = "Attachment is not cached."
        return
    }
    scope.launch {
        runCatching {
            withContext(ioDispatcher) { readAttachmentBytes(attachment) }
        }.onSuccess { bytes ->
            services.copyImage(bytes, attachment.mimeType.ifBlank { "image/*" }, attachment.filename.ifBlank { "Image" })
            status = "Image copied."
        }.onFailure {
            status = "Image copy failed: ${it.message}"
        }
    }
}
