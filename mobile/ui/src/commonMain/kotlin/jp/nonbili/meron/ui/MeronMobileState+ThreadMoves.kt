package jp.nonbili.meron.ui

import androidx.compose.foundation.layout.size
import jp.nonbili.meron.shared.CopyThreadParams
import jp.nonbili.meron.shared.FolderCreateParams
import jp.nonbili.meron.shared.FolderSummary
import jp.nonbili.meron.shared.MobileMailCommandClient
import jp.nonbili.meron.shared.MoveRssFeedParams
import jp.nonbili.meron.shared.MoveThreadParams
import jp.nonbili.meron.shared.SyncMailParams
import jp.nonbili.meron.shared.ThreadSummary
import jp.nonbili.meron.shared.accountSummaryIsRss
import jp.nonbili.meron.shared.requireCoreOk
import jp.nonbili.meron.shared.threadIdIsRss
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private fun List<FolderSummary>.hasOnlyBootstrapInbox(): Boolean = size == 1 && first().name.equals(INBOX_FOLDER, ignoreCase = true)

internal fun MeronMobileState.ensureThreadActionFolders(
    thread: ThreadSummary,
    includeAllMailAccounts: Boolean,
    onReady: () -> Unit,
) {
    if (threadIdIsRss(thread.id)) {
        status = "RSS feeds move between RSS accounts from Kanban."
        return
    }
    if (!coreLoaded) {
        status = coreUnavailableMessage
        return
    }
    val accounts =
        if (includeAllMailAccounts) {
            coreAccounts.filterNot { accountSummaryIsRss(it) }
        } else {
            coreAccounts.filter { it.id == thread.accountId && !accountSummaryIsRss(it) }
        }
    if (accounts.isEmpty()) {
        status = "No mail folders available."
        return
    }
    status = "Loading folders..."
    scope.launch {
        val folderReadVersion = folderReadGuard.version
        runCatching {
            withContext(ioDispatcher) {
                val client = MobileMailCommandClient(core)
                accounts.associate { account ->
                    var folders = loadAccountFolders(client, account)
                    if (folders.hasOnlyBootstrapInbox()) {
                        withManagedGoogleAuth(client, account.id) {
                            client.sync(
                                SyncMailParams(
                                    accountId = account.id,
                                    folderId = INBOX_FOLDER,
                                    limit = 1,
                                    folders = true,
                                    deferTail = true,
                                ),
                            )
                        }
                        folders = loadAccountFolders(client, account)
                    }
                    account.id to folders
                }
            }
        }.onSuccess { loadedFolders ->
            foldersByAccount = foldersByAccount + loadedFolders.mapValues { (_, folders) -> reconcileFolderUnread(folders, folderReadVersion) }
            status = "Loaded folders"
            onReady()
        }.onFailure {
            status = "Load folders failed: ${it.message}"
        }
    }
}

internal fun MeronMobileState.moveThreadToFolder(
    thread: ThreadSummary,
    targetFolderId: String,
    onMoved: () -> Unit = {},
) {
    if (threadIdIsRss(thread.id)) {
        status = "RSS feeds move between RSS accounts from Kanban."
        return
    }
    if (targetFolderId.equals(thread.folder, ignoreCase = true)) {
        status = "Already in ${targetFolderId.replaceFirstChar { it.uppercase() }}."
        return
    }
    if (!coreLoaded) {
        status = coreUnavailableMessage
        return
    }
    val threadsBefore = coreThreads
    val kanbanBefore = kanbanColumns
    val selectedBefore = selectedCoreThread
    val messagesBefore = messages
    // Remove the row optimistically, but keep an open conversation selected
    // until the move succeeds. Clearing it here makes the thread-route fallback
    // pop immediately, then the success callback pops the origin route too.
    coreThreads = coreThreads.filterNot { it.id == thread.id }
    kanbanColumns =
        kanbanColumns.mapValues { (_, state) ->
            state.copy(threads = state.threads.filterNot { it.id == thread.id })
        }
    status = "Moving..."
    scope.launch {
        runCatching {
            requireCoreOk(
                withContext(ioDispatcher) {
                    MobileMailCommandClient(core).move(
                        MoveThreadParams(threadId = thread.id, targetFolderId = targetFolderId),
                    )
                },
            )
        }.onSuccess {
            if (selectedCoreThread?.id == thread.id) {
                selectedCoreThread = null
                messages = emptyList()
            }
            status = "Move complete"
            onMoved()
        }.onFailure {
            Log.w("Mail", "move thread failed", it)
            coreThreads = threadsBefore
            kanbanColumns = kanbanBefore
            selectedCoreThread = selectedBefore
            messages = messagesBefore
            status = "Move failed: ${it.message}"
        }
    }
}

internal fun MeronMobileState.copyThreadToFolder(
    thread: ThreadSummary,
    target: FolderSummary,
) {
    if (threadIdIsRss(thread.id)) {
        status = "RSS feeds can't be copied to mail folders."
        return
    }
    val targetAccountId = target.accountId.ifBlank { thread.accountId }
    val targetAccount = coreAccounts.firstOrNull { it.id == targetAccountId }
    if (targetAccount == null || accountSummaryIsRss(targetAccount)) {
        status = "Choose a mail account folder."
        return
    }
    if (!coreLoaded) {
        status = coreUnavailableMessage
        return
    }
    status = "Copying..."
    scope.launch {
        runCatching {
            withContext(ioDispatcher) {
                MobileMailCommandClient(core).copy(
                    CopyThreadParams(
                        threadId = thread.id,
                        targetAccountId = targetAccountId,
                        targetFolderId = target.name,
                    ),
                )
            }
        }.onSuccess {
            status = "Copy complete"
        }.onFailure {
            status = "Copy failed: ${it.message}"
        }
    }
}

internal fun MeronMobileState.createFolderAndMoveThread(
    thread: ThreadSummary,
    name: String,
    onMoved: () -> Unit = {},
) {
    val trimmed = name.trim()
    if (threadIdIsRss(thread.id)) {
        status = "RSS feeds move between RSS accounts from Kanban."
        return
    }
    if (trimmed.isBlank()) {
        status = "Folder name is required."
        return
    }
    val account = coreAccounts.firstOrNull { it.id == thread.accountId }
    if (account == null) {
        status = "Account not found."
        return
    }
    if (!coreLoaded) {
        status = coreUnavailableMessage
        return
    }
    status = "Creating folder..."
    scope.launch {
        val folderReadVersion = folderReadGuard.version
        runCatching {
            withContext(ioDispatcher) {
                val client = MobileMailCommandClient(core)
                withManagedGoogleAuth(client, thread.accountId) {
                    client.createFolder(FolderCreateParams(accountId = thread.accountId, name = trimmed))
                }
                val folders = loadAccountFolders(client, account)
                val createdFolder = folders.folderCreatedAs(trimmed)
                val created = createdFolder?.name ?: trimmed
                if (created.equals(thread.folder, ignoreCase = true)) {
                    throw IllegalStateException("Already in ${createdFolder?.displayName ?: trimmed}.")
                }
                withManagedGoogleAuth(client, thread.accountId) {
                    client.move(MoveThreadParams(threadId = thread.id, targetFolderId = created))
                }
                folders to created
            }
        }.onSuccess { (folders, _) ->
            foldersByAccount = foldersByAccount + (account.id to reconcileFolderUnread(folders, folderReadVersion))
            removeThreadEverywhere(thread.id)
            if (selectedCoreThread?.id == thread.id) {
                selectedCoreThread = null
                messages = emptyList()
            }
            status = "Folder created and move complete"
            onMoved()
        }.onFailure {
            status = "Create folder failed: ${it.message}"
        }
    }
}

internal fun MeronMobileState.moveThreadToColumn(
    thread: ThreadSummary,
    target: KanbanColumnSpec,
) {
    if (target.accountId == UNIFIED_ACCOUNT_ID) {
        status = "Move to an account folder column."
        return
    }
    val targetAccount = coreAccounts.firstOrNull { it.id == target.accountId }
    if (targetAccount == null) {
        status = "Target account not found."
        return
    }
    if (threadIdIsRss(thread.id)) {
        if (!accountSummaryIsRss(targetAccount)) {
            status = "RSS feeds can only move to RSS accounts."
            return
        }
        scope.launch {
            runCatching {
                withContext(ioDispatcher) {
                    MobileMailCommandClient(core).moveRssFeed(
                        MoveRssFeedParams(threadId = thread.id, targetAccountId = target.accountId),
                    )
                }
            }.onSuccess {
                removeThreadEverywhere(thread.id)
                loadKanbanColumn(target, refresh = false)
                status = "Move complete"
            }.onFailure {
                status = "Move failed: ${it.message}"
            }
        }
        return
    }
    if (accountSummaryIsRss(targetAccount)) {
        status = "Mail threads can't move into RSS feeds."
        return
    }
    scope.launch {
        runCatching {
            withContext(ioDispatcher) {
                MobileMailCommandClient(core).move(
                    MoveThreadParams(threadId = thread.id, targetFolderId = target.folderId),
                )
            }
        }.onSuccess {
            removeThreadEverywhere(thread.id)
            loadKanbanColumn(target, refresh = false)
            status = "Move complete"
        }.onFailure {
            status = "Move failed: ${it.message}"
        }
    }
}
