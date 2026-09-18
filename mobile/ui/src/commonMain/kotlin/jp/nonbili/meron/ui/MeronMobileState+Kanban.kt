package jp.nonbili.meron.ui

import androidx.compose.foundation.layout.size
import androidx.compose.ui.input.key.key
import jp.nonbili.meron.shared.AccountSummary
import jp.nonbili.meron.shared.FolderCreateParams
import jp.nonbili.meron.shared.MobileMailCommandClient
import jp.nonbili.meron.shared.StarredItemSummary
import jp.nonbili.meron.shared.SyncMailParams
import jp.nonbili.meron.shared.ThreadSummary
import jp.nonbili.meron.shared.accountSummaryIsRss
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal fun MeronMobileState.persistKanbanBoards(next: List<KanbanBoardSpec>) {
    kanbanBoards = next
    saveKanbanBoards(kanbanPrefs, next)
    if (activeKanbanBoardId.isBlank() || next.none { it.id == activeKanbanBoardId }) {
        activeKanbanBoardId = next.firstOrNull()?.id.orEmpty()
        saveActiveKanbanBoardId(kanbanPrefs, activeKanbanBoardId)
    }
}

internal fun MeronMobileState.persistKanbanFilter(next: FilterMode) {
    kanbanFilter = next
    saveKanbanFilter(kanbanPrefs, next)
}

internal fun MeronMobileState.persistKanbanSearch(next: String) {
    kanbanSearch = next
    saveKanbanSearch(kanbanPrefs, next)
}

internal fun MeronMobileState.persistKanbanSearchScope(next: String) {
    kanbanSearchScope = next.ifBlank { "all" }
    saveKanbanSearchScope(kanbanPrefs, kanbanSearchScope)
}

internal fun MeronMobileState.kanbanColumnSearchQuery(column: KanbanColumnSpec): String {
    val query = kanbanSearch.trim()
    if (query.isBlank()) return ""
    val scope = kanbanSearchScope.ifBlank { "all" }
    return if (scope == "all" || scope == kanbanColumnKey(column)) query else ""
}

internal fun isUnifiedStarredColumn(column: KanbanColumnSpec): Boolean = column.accountId == UNIFIED_ACCOUNT_ID && column.folderId.equals(STARRED_FOLDER, ignoreCase = true)

internal fun shouldSyncUnfetchedKanbanColumn(
    column: KanbanColumnSpec,
    refresh: Boolean,
    query: String,
    result: MailboxLoadResult,
    accounts: List<AccountSummary>,
): Boolean {
    if (refresh || query.isNotBlank() || result.threads.isNotEmpty() || result.folderSynced != false) return false
    if (column.accountId == UNIFIED_ACCOUNT_ID) return false
    val account = accounts.firstOrNull { it.id == column.accountId } ?: return false
    return !account.paused && !account.needsReconnect && !accountSummaryIsRss(account)
}

internal fun StarredItemSummary.toThreadSummary(): ThreadSummary =
    ThreadSummary(
        id = id,
        threadId = threadId,
        accountId = accountId,
        folder = folder,
        folderRole = folderRole,
        subject = subject,
        sender = sender,
        preview = preview,
        unread = unread,
        starred = true,
        dateEpochSeconds = dateEpochSeconds,
    )

internal fun MeronMobileState.updateKanbanColumn(
    key: String,
    update: (KanbanColumnState) -> KanbanColumnState,
) {
    kanbanColumns = kanbanColumns + (key to update(kanbanColumns[key] ?: KanbanColumnState()))
}

internal fun MeronMobileState.updateThreadEverywhere(
    thread: ThreadSummary,
    update: (ThreadSummary) -> ThreadSummary,
) {
    val next = update(thread)
    val beforeUnread = if (thread.unread) thread.unreadCount.coerceAtLeast(1) else 0
    val afterUnread = if (next.unread) next.unreadCount.coerceAtLeast(1) else 0
    val unreadDelta = afterUnread - beforeUnread
    coreThreads = coreThreads.map { if (it.id == thread.id) next else it }.forStarredView(selectedCoreAccountId, selectedCoreFolder)
    selectedCoreThread = selectedCoreThread?.let { if (it.id == thread.id) next else it }
    kanbanColumns =
        kanbanColumns.mapValues { (key, state) ->
            if (state.threads.none { it.id == thread.id }) {
                state
            } else {
                state.copy(
                    threads = state.threads.map { if (it.id == thread.id) next else it }.forStarredView(key.substringBefore("\n"), key.substringAfter("\n")),
                    unreadCount = state.unreadCount?.let { (it + unreadDelta).coerceAtLeast(0) },
                )
            }
        }
}

internal fun MeronMobileState.removeThreadEverywhere(threadId: String) {
    coreThreads = coreThreads.filterNot { it.id == threadId }
    kanbanColumns =
        kanbanColumns.mapValues { (_, state) ->
            state.copy(threads = state.threads.filterNot { it.id == threadId })
        }
    if (selectedCoreThread?.id == threadId) {
        selectedCoreThread = null
        messages = emptyList()
    }
}

internal suspend fun MeronMobileState.fetchKanbanColumn(
    client: MobileMailCommandClient,
    column: KanbanColumnSpec,
    refresh: Boolean,
    beforeCursor: String? = null,
    accountCursors: Map<String, String> = emptyMap(),
): MailboxLoadResult {
    val columnQuery = kanbanColumnSearchQuery(column)
    if (isUnifiedStarredColumn(column)) {
        // The column applies its own filter to the loaded cards, so the load
        // itself asks for all of them.
        return loadUnifiedStarred(
            client = client,
            query = columnQuery,
            filter = FilterMode.All,
            beforeCursor = beforeCursor,
        )
    }
    return if (column.accountId == UNIFIED_ACCOUNT_ID) {
        val unifiedAccounts = coreAccounts.filter { it.includedInUnified }
        loadUnifiedInbox(
            client = client,
            accounts = unifiedAccounts,
            query = columnQuery,
            filter = kanbanFilter,
            syncFirst = refresh,
            beforeCursor = beforeCursor,
            folderRole = column.folderId,
        )
    } else {
        val account =
            coreAccounts.firstOrNull { it.id == column.accountId }
                ?: return MailboxLoadResult(emptyList(), column.folderId, emptyList())
        loadAccountInbox(
            client,
            account,
            column.folderId,
            query = columnQuery,
            filter = kanbanFilter,
            syncFirst = refresh,
            beforeCursor = beforeCursor,
        )
    }
}

internal fun MeronMobileState.loadKanbanColumn(
    column: KanbanColumnSpec,
    refresh: Boolean = false,
) {
    if (!coreLoaded) {
        status = coreUnavailableMessage
        return
    }
    val key = kanbanColumnKey(column)
    val query = kanbanColumnSearchQuery(column)
    val token = (kanbanColumnLoadTokens[key] ?: 0L) + 1
    kanbanColumnLoadTokens[key] = token
    updateKanbanColumn(key) { it.copy(loading = true, error = null) }
    scope.launch {
        val folderReadVersion = folderReadGuard.version
        runCatching {
            withContext(ioDispatcher) {
                val client = MobileMailCommandClient(core)
                val cached = fetchKanbanColumn(client, column, refresh)
                if (shouldSyncUnfetchedKanbanColumn(column, refresh, query, cached, coreAccounts)) {
                    fetchKanbanColumn(client, column, refresh = true)
                } else {
                    cached
                }
            }
        }.onSuccess { result ->
            // A newer load of this column is out or has landed; its rows are the
            // answer, and it clears the loading flag itself.
            if (kanbanColumnLoadTokens[key] != token) return@onSuccess
            val columnQuery = kanbanColumnSearchQuery(column)
            if (result.folders.isNotEmpty()) {
                foldersByAccount = foldersByAccount + reconcileFolderUnread(result.folders, folderReadVersion).groupBy { it.accountId }
            }
            updateKanbanColumn(key) {
                it.copy(
                    threads = withLocalDraftFlags(withoutLocallyDiscardedThreads(result.threads)),
                    unreadCount = result.unreadCount,
                    loading = false,
                    loadingMore = false,
                    error = null,
                    nextCursor = if (columnQuery.isBlank()) result.nextCursor else "",
                    accountCursors = if (columnQuery.isBlank()) result.accountCursors else emptyMap(),
                )
            }
        }.onFailure {
            if (kanbanColumnLoadTokens[key] != token) return@onFailure
            updateKanbanColumn(key) { state -> state.copy(loading = false, error = it.message ?: "Load failed") }
            status = "Kanban load failed: ${it.message}"
        }
    }
}

internal fun MeronMobileState.loadMoreKanbanColumn(column: KanbanColumnSpec) {
    if (!coreLoaded || kanbanColumnSearchQuery(column).isNotBlank()) return
    val key = kanbanColumnKey(column)
    val state = kanbanColumns[key] ?: return
    val hasCursor = state.nextCursor.isNotBlank()
    if (state.loadingMore || !hasCursor) return
    updateKanbanColumn(key) { it.copy(loadingMore = true, error = null) }
    scope.launch {
        val folderReadVersion = folderReadGuard.version
        runCatching {
            withContext(ioDispatcher) {
                val client = MobileMailCommandClient(core)
                fetchKanbanColumn(
                    client = client,
                    column = column,
                    refresh = false,
                    beforeCursor = state.nextCursor,
                    accountCursors = state.accountCursors,
                )
            }
        }.onSuccess { result ->
            if (result.folders.isNotEmpty()) {
                foldersByAccount = foldersByAccount + reconcileFolderUnread(result.folders, folderReadVersion).groupBy { it.accountId }
            }
            updateKanbanColumn(key) { current ->
                val existingIds = current.threads.map { it.id }.toSet()
                val appended = withLocalDraftFlags(result.threads).filterNot { it.id in existingIds }
                current.copy(
                    threads = (current.threads + appended).sortedByDescending { it.dateEpochSeconds },
                    loadingMore = false,
                    error = null,
                    nextCursor = result.nextCursor,
                    accountCursors = result.accountCursors,
                )
            }
        }.onFailure {
            updateKanbanColumn(key) { state -> state.copy(loadingMore = false, error = it.message ?: "Load failed") }
            status = "Kanban load more failed: ${it.message}"
        }
    }
}

// Every column an account-wide cache change can touch. A change that names no
// folder (a late Sent copy) has nothing for folder matching to work with — the
// conversation it belongs to sits in whichever mailbox holds it — so each of
// the account's columns re-reads. Unified columns only count when the account
// is part of Unified, as elsewhere in this file.
internal fun MeronMobileState.refreshKanbanColumnsForAccount(accountId: String) {
    if (accountId.isBlank()) return
    val board = kanbanBoards.firstOrNull { it.id == activeKanbanBoardId } ?: return
    val accountIncludedInUnified =
        coreAccounts.firstOrNull { it.id == accountId }?.includedInUnified == true
    board.columns
        .filter { column ->
            column.accountId == accountId ||
                (column.accountId == UNIFIED_ACCOUNT_ID && accountIncludedInUnified)
        }.distinctBy(::kanbanColumnKey)
        .forEach { column -> loadKanbanColumn(column, refresh = false) }
}

// Re-read the active board's columns whose card stands for [threadId] after a
// change inside the conversation the card's message count and Draft badge
// reflect — a quick reply's post-send draft discard. The mailbox reload that
// runs alongside feeds the list behind the board, not the board; and the Sent
// copy event that does re-read the account's columns fires from the send,
// before the discard, so the card kept counting the draft until some later
// sync happened to touch its column. The discard already dropped the cached
// draft rows, so a cache read is enough.
internal fun MeronMobileState.refreshKanbanColumnsHoldingThread(threadId: String) {
    if (threadId.isBlank()) return
    val board = kanbanBoards.firstOrNull { it.id == activeKanbanBoardId } ?: return
    val keys =
        kanbanColumns
            .filterValues { state -> state.threads.any { it.id == threadId || it.backendThreadId() == threadId } }
            .keys
    if (keys.isEmpty()) return
    board.columns
        .filter { kanbanColumnKey(it) in keys }
        .distinctBy(::kanbanColumnKey)
        .forEach { column -> loadKanbanColumn(column, refresh = false) }
}

internal fun MeronMobileState.refreshKanbanColumnsForMailEvent(
    accountId: String,
    folderId: String,
    refresh: Boolean = false,
) {
    val board = kanbanBoards.firstOrNull { it.id == activeKanbanBoardId } ?: return
    val folder = folderId.ifBlank { INBOX_FOLDER }
    val accountIncludedInUnified =
        coreAccounts.firstOrNull { it.id == accountId }?.includedInUnified == true
    board.columns
        .filter { column ->
            val directFolderMatch =
                column.accountId == accountId &&
                    column.folderId.equals(folder, ignoreCase = true)
            val unifiedFolderMatch =
                column.accountId == UNIFIED_ACCOUNT_ID &&
                    accountIncludedInUnified &&
                    unifiedColumnMatchesFolder(column.folderId, foldersByAccount[accountId].orEmpty(), folderId)
            directFolderMatch || unifiedFolderMatch
        }.distinctBy(::kanbanColumnKey)
        .forEach { column ->
            // The IDLE/event path has already synced the core DB, so callers can
            // re-read the affected active Kanban columns from cache without
            // another IMAP pass. Callers whose own action (e.g. discarding a
            // draft) didn't go through that sync must pass refresh = true.
            loadKanbanColumn(column, refresh = refresh)
        }
}

internal fun MeronMobileState.loadKanbanBoard(refresh: Boolean = false) {
    val board = kanbanBoards.firstOrNull { it.id == activeKanbanBoardId } ?: return
    if (kanbanSearchScope != "all" && board.columns.none { kanbanColumnKey(it) == kanbanSearchScope }) {
        persistKanbanSearchScope("all")
    }
    board.columns.forEach { column -> loadKanbanColumn(column, refresh) }
}

/** Append a board holding [columns] and make it the active one. */
private fun MeronMobileState.addKanbanBoard(columns: List<KanbanColumnSpec>): KanbanBoardSpec {
    val board =
        defaultKanbanBoard(coreAccounts).copy(
            name = "Kanban board ${kanbanBoards.size + 1}",
            columns = columns,
        )
    persistKanbanBoards(kanbanBoards + board)
    activeKanbanBoardId = board.id
    saveActiveKanbanBoardId(kanbanPrefs, board.id)
    return board
}

internal fun MeronMobileState.createKanbanBoard(): String {
    val board = addKanbanBoard(defaultKanbanBoard(coreAccounts).columns)
    loadKanbanBoard(refresh = false)
    return board.id
}

internal fun MeronMobileState.updateKanbanBoard(
    boardId: String,
    name: String,
    avatarUrl: String,
    wallpaperPresetId: String,
    wallpaperUrl: String,
) {
    val trimmedName = name.trim()
    if (trimmedName.isBlank()) return
    persistKanbanBoards(
        kanbanBoards.map { board ->
            if (board.id == boardId) {
                board.copy(
                    name = trimmedName,
                    avatarUrl = avatarUrl.trim(),
                    wallpaperPresetId = wallpaperPresetId.trim(),
                    wallpaperUrl = wallpaperUrl.trim(),
                )
            } else {
                board
            }
        },
    )
}

internal fun MeronMobileState.deleteKanbanBoard(boardId: String) {
    // Deleting the last board leaves no board at all; the kanban screen and the
    // drawer both render that empty state, and reseeding a default here would
    // make the delete look like it did nothing.
    val wasActive = boardId == activeKanbanBoardId
    persistKanbanBoards(kanbanBoards.filterNot { it.id == boardId })
    // persistKanbanBoards has already moved the selection off the deleted board,
    // so drop the cached columns and load whatever it landed on (if anything).
    if (wasActive) {
        kanbanColumns = emptyMap()
        loadKanbanBoard(refresh = false)
    }
}

internal fun MeronMobileState.addKanbanColumn(column: KanbanColumnSpec) {
    val board = kanbanBoards.firstOrNull { it.id == activeKanbanBoardId } ?: return
    if (board.columns.any { kanbanColumnKey(it) == kanbanColumnKey(column) }) return
    persistKanbanBoards(
        kanbanBoards.map {
            if (it.id == board.id) it.copy(columns = it.columns + column) else it
        },
    )
    loadKanbanColumn(column, refresh = true)
}

/**
 * Replace the active board's columns with [columns] (the selection from the add-column
 * dialog), preserving the relative order of existing columns and appending new ones.
 * Loads any newly added column and drops cached data for removed ones. With no board
 * left at all, the selection creates one.
 */
internal fun MeronMobileState.applyKanbanColumns(columns: List<KanbanColumnSpec>) {
    val deduped = columns.distinctBy(::kanbanColumnKey)
    // Every board can be deleted, and the empty kanban screen still offers "Add
    // column", so a selection made with no board left has to bring one with it.
    val active = kanbanBoards.firstOrNull { it.id == activeKanbanBoardId }
    if (active == null && deduped.isEmpty()) return
    val board = active ?: addKanbanBoard(emptyList())
    val nextKeys = deduped.map(::kanbanColumnKey).toSet()
    val existingKeys = board.columns.map(::kanbanColumnKey).toSet()
    if (nextKeys == existingKeys) return
    // Keep existing columns in their current order, then append newly selected ones.
    val ordered =
        board.columns.filter { kanbanColumnKey(it) in nextKeys } +
            deduped.filter { kanbanColumnKey(it) !in existingKeys }
    persistKanbanBoards(
        kanbanBoards.map { if (it.id == board.id) it.copy(columns = ordered) else it },
    )
    (existingKeys - nextKeys).forEach { kanbanColumns = kanbanColumns - it }
    ordered
        .filter { kanbanColumnKey(it) !in existingKeys }
        .forEach { loadKanbanColumn(it, refresh = true) }
}

internal fun MeronMobileState.removeKanbanColumn(column: KanbanColumnSpec) {
    val key = kanbanColumnKey(column)
    persistKanbanBoards(
        kanbanBoards.map {
            if (it.id ==
                activeKanbanBoardId
            ) {
                it.copy(columns = it.columns.filterNot { existing -> kanbanColumnKey(existing) == key })
            } else {
                it
            }
        },
    )
    kanbanColumns = kanbanColumns - key
}

/**
 * Drop every column showing a folder, on all boards. Used once the folder is gone
 * from the server: a column left behind would only fail to load.
 */
internal fun MeronMobileState.removeKanbanColumnsForFolder(
    accountId: String,
    folderId: String,
) {
    val key = kanbanColumnKey(KanbanColumnSpec(accountId, folderId))
    persistKanbanBoards(
        kanbanBoards.map { board ->
            board.copy(columns = board.columns.filterNot { kanbanColumnKey(it) == key })
        },
    )
    kanbanColumns = kanbanColumns - key
}

/**
 * Point an existing column at another folder of the same account, keeping its slot
 * on the board. Does nothing when the folder is unchanged or already has its own
 * column here — the board must not end up with duplicates.
 */
internal fun MeronMobileState.switchKanbanColumnFolder(
    column: KanbanColumnSpec,
    folderId: String,
) {
    if (folderId.isBlank() || kanbanFolderIdsEqual(folderId, column.folderId)) return
    val board = kanbanBoards.firstOrNull { it.id == activeKanbanBoardId } ?: return
    val fromKey = kanbanColumnKey(column)
    val target = KanbanColumnSpec(column.accountId, folderId)
    val toKey = kanbanColumnKey(target)
    if (board.columns.none { kanbanColumnKey(it) == fromKey }) return
    if (board.columns.any { it.accountId == target.accountId && kanbanFolderIdsEqual(it.folderId, target.folderId) }) return
    persistKanbanBoards(
        kanbanBoards.map { existing ->
            if (existing.id != board.id) {
                existing
            } else {
                existing.copy(columns = existing.columns.map { if (kanbanColumnKey(it) == fromKey) target else it })
            }
        },
    )
    if (kanbanSearchScope == fromKey) persistKanbanSearchScope(toKey)
    // Keep the old folder's cached page only while another board still shows it.
    if (kanbanBoards.none { it.columns.any { existing -> kanbanColumnKey(existing) == fromKey } }) {
        kanbanColumns = kanbanColumns - fromKey
    }
    loadKanbanColumn(target, refresh = true)
}

/**
 * Fetch an account's folder list for a folder picker (a kanban column's or the
 * mail list's) when only the bootstrap inbox is cached, so the picker isn't
 * limited to what a sync happened to surface.
 */
internal fun MeronMobileState.ensureAccountFolders(accountId: String) {
    if (!coreLoaded || accountId == UNIFIED_ACCOUNT_ID) return
    val account = coreAccounts.firstOrNull { it.id == accountId } ?: return
    if (accountSummaryIsRss(account)) return
    if (foldersByAccount[accountId].orEmpty().size > 1) return
    scope.launch {
        val folderReadVersion = folderReadGuard.version
        runCatching {
            withContext(ioDispatcher) {
                val client = MobileMailCommandClient(core)
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
                loadAccountFolders(client, account)
            }
        }.onSuccess { folders ->
            if (folders.isNotEmpty()) foldersByAccount = foldersByAccount + (accountId to reconcileFolderUnread(folders, folderReadVersion))
        }
    }
}

internal fun MeronMobileState.moveKanbanColumn(
    column: KanbanColumnSpec,
    delta: Int,
) {
    persistKanbanBoards(
        kanbanBoards.map { board ->
            if (board.id != activeKanbanBoardId) return@map board
            val columns = board.columns.toMutableList()
            val index = columns.indexOfFirst { kanbanColumnKey(it) == kanbanColumnKey(column) }
            val target = (index + delta).coerceIn(0, columns.lastIndex)
            if (index < 0 || index == target) {
                board
            } else {
                val item = columns.removeAt(index)
                columns.add(target, item)
                board.copy(columns = columns)
            }
        },
    )
}

internal fun MeronMobileState.createFolderForKanban(
    account: AccountSummary,
    name: String,
) {
    val trimmed = name.trim()
    if (trimmed.isBlank()) {
        status = "Folder name is required."
        return
    }
    if (!coreLoaded) {
        status = coreUnavailableMessage
        return
    }
    scope.launch {
        val folderReadVersion = folderReadGuard.version
        runCatching {
            withContext(ioDispatcher) {
                val client = MobileMailCommandClient(core)
                withManagedGoogleAuth(client, account.id) {
                    client.createFolder(FolderCreateParams(accountId = account.id, name = trimmed))
                }
                loadAccountFolders(client, account)
            }
        }.onSuccess { folders ->
            foldersByAccount = foldersByAccount + (account.id to reconcileFolderUnread(folders, folderReadVersion))
            val created = folders.folderCreatedAs(trimmed)?.name ?: trimmed
            addKanbanColumn(KanbanColumnSpec(account.id, created))
            showKanbanCreateFolderDialog = null
            kanbanFolderNameInput = ""
            status = "Folder created"
        }.onFailure {
            status = "Create folder failed: ${it.message}"
        }
    }
}
