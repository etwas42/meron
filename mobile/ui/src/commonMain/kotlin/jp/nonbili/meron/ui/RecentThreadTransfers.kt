package jp.nonbili.meron.ui

import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.nonbili.meron.shared.FolderSummary
import jp.nonbili.meron.shared.MobileMailCommandClient
import jp.nonbili.meron.shared.ThreadSummary
import jp.nonbili.meron.shared.accountSummaryIsRss
import jp.nonbili.meron.shared.threadIdIsRss
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

private const val RECENT_TRANSFERS_PREF = "recent_thread_transfers"
private const val RECENT_TRANSFERS_LIMIT = 100
private val transferJson = Json { ignoreUnknownKeys = true }

@Serializable
internal data class RecentThreadTransfer(
    val action: String,
    val sourceAccountId: String,
    val targetAccountId: String,
    val targetFolderId: String,
)

internal fun parseRecentThreadTransfers(raw: String): List<RecentThreadTransfer> =
    runCatching {
        transferJson
            .decodeFromString<List<RecentThreadTransfer>>(raw)
            .filter {
                it.action in listOf("move", "copy") && it.sourceAccountId.isNotBlank() &&
                    it.targetAccountId.isNotBlank() && it.targetFolderId.isNotBlank()
            }.distinct()
            .take(RECENT_TRANSFERS_LIMIT)
    }.getOrDefault(emptyList())

internal fun loadRecentThreadTransfers(prefs: AppPreferences): List<RecentThreadTransfer> = parseRecentThreadTransfers(prefs.cacheStore().getString(RECENT_TRANSFERS_PREF, ""))

internal fun MeronMobileState.rememberThreadTransfer(entry: RecentThreadTransfer) {
    recentThreadTransfers = (listOf(entry) + recentThreadTransfers.filterNot { it == entry }).take(RECENT_TRANSFERS_LIMIT)
    prefs.cacheStore().putString(RECENT_TRANSFERS_PREF, transferJson.encodeToString(recentThreadTransfers))
}

/** A successful RPC with zero affected messages is not a successful transfer. */
internal fun requireTransferAffected(
    response: String,
    action: String,
): String {
    val count =
        runCatching {
            transferJson
                .parseToJsonElement(response)
                .jsonObject[action]
                ?.jsonPrimitive
                ?.intOrNull
        }.getOrNull()
    check(count == null || count > 0) { "No matching messages found" }
    return response
}

internal data class RecentThreadTransferItem(
    val transfer: RecentThreadTransfer,
    val folder: FolderSummary,
    val destination: String,
)

internal fun MeronMobileState.recentTransferItems(thread: ThreadSummary?): List<RecentThreadTransferItem> {
    if (thread == null || threadIdIsRss(thread.id)) return emptyList()
    return recentThreadTransfers
        .mapNotNull { entry ->
            if (entry.sourceAccountId != thread.accountId ||
                (entry.targetAccountId == thread.accountId && kanbanFolderIdsEqual(entry.targetFolderId, thread.folder))
            ) {
                return@mapNotNull null
            }
            val account = coreAccounts.firstOrNull { it.id == entry.targetAccountId && !accountSummaryIsRss(it) } ?: return@mapNotNull null
            val folder = foldersByAccount[entry.targetAccountId]?.firstOrNull { kanbanFolderIdsEqual(it.name, entry.targetFolderId) } ?: return@mapNotNull null
            val destination = if (entry.targetAccountId == thread.accountId) folder.displayName else "${account.displayName.ifBlank { account.email }} / ${folder.displayName}"
            RecentThreadTransferItem(entry, folder, destination)
        }.take(2)
}

/** Load only accounts referenced by this source account's history, without a status toast. */
internal suspend fun MeronMobileState.loadRecentTransferFolders(thread: ThreadSummary?) {
    if (!coreLoaded || thread == null || threadIdIsRss(thread.id)) return
    val targetIds = recentThreadTransfers.filter { it.sourceAccountId == thread.accountId }.map { it.targetAccountId }.toSet()
    for (account in coreAccounts.filter { it.id in targetIds && !accountSummaryIsRss(it) }) {
        if (foldersByAccount[account.id] != null) continue
        val version = folderReadGuard.version
        runCatching {
            withContext(ioDispatcher) { loadAccountFolders(MobileMailCommandClient(core), account) }
        }.onSuccess { folders ->
            if (coreAccounts.any { it.id == account.id }) {
                foldersByAccount = foldersByAccount + (account.id to reconcileFolderUnread(folders, version))
            }
        }.onFailure { Log.w("Mail", "load recent transfer folders failed", it) }
    }
}

internal fun MeronMobileState.runRecentSelectionTransfer(
    thread: ThreadSummary,
    item: RecentThreadTransferItem,
) {
    mailSelectionMenuOpen = false
    if (item.transfer.action == "move") moveThreadToFolder(thread, item.folder.name, item.transfer.targetAccountId) else copyThreadToFolder(thread, item.folder)
    selectedMailThreadIds = emptySet()
}

@Composable
internal fun MeronMobileState.RecentSelectionTransferMenuItems(thread: ThreadSummary) {
    LaunchedEffect(thread.accountId, recentThreadTransfers, coreAccounts) { loadRecentTransferFolders(thread) }
    RecentThreadTransferMenuItems(recentTransferItems(thread)) { runRecentSelectionTransfer(thread, it) }
}

@Composable
internal fun RecentThreadTransferMenuItems(
    items: List<RecentThreadTransferItem>,
    onPick: (RecentThreadTransferItem) -> Unit,
) {
    if (items.isNotEmpty()) HorizontalDivider(Modifier.padding(vertical = 4.dp))
    items.forEach { item ->
        val move = item.transfer.action == "move"
        DropdownMenuItem(
            text = {
                Text(
                    tr(if (move) "threads.actions.moveToRecent" else "threads.actions.copyToRecent", mapOf("folder" to item.destination)),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            },
            leadingIcon = { Icon(if (move) Icons.Outlined.FolderOpen else Icons.Filled.ContentCopy, contentDescription = null) },
            onClick = { onPick(item) },
        )
    }
}
