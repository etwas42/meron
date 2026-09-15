package jp.nonbili.meron.ui

import jp.nonbili.meron.shared.AccountSummary
import jp.nonbili.meron.shared.CloseableHandle
import jp.nonbili.meron.shared.CoreEvent
import jp.nonbili.meron.shared.CoreEventStream
import jp.nonbili.meron.shared.FolderSummary
import jp.nonbili.meron.shared.MeronCore
import jp.nonbili.meron.shared.MobileCommand
import jp.nonbili.meron.shared.ThreadSummary
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The drawer's unread badges are folder totals, not counts of the loaded rows,
 * so marking a mailbox or a column read has to clear them in the same breath as
 * the rows — they used to sit at the pre-mark number until the write came back.
 */
class MarkAllReadFolderBadgeTest {
    @Test
    fun markingTheMailboxReadClearsTheDrawerBadgeBeforeTheWriteAnswers() {
        runBlocking {
            val core = GatedCore()
            val state = state(core, this)

            state.markVisibleMailboxAllRead()

            assertEquals(0, folderUnread(state.foldersByAccount["a"], INBOX_FOLDER))
            assertEquals(0, folderUnread(state.coreFolders, INBOX_FOLDER))
            core.gate.complete(Unit)
        }
    }

    @Test
    fun aFailedMailboxWritePutsTheDrawerBadgeBack() =
        runBlocking {
            val core = GatedCore().apply { gate.complete(Unit) }
            core.markAllReadFails = true
            val state = state(core, this)

            state.markVisibleMailboxAllRead()

            assertEquals(0, folderUnread(state.foldersByAccount["a"], INBOX_FOLDER))
            waitUntil { state.status.startsWith("Mark all read failed") }
            assertEquals(12, folderUnread(state.foldersByAccount["a"], INBOX_FOLDER))
            assertEquals(12, folderUnread(state.coreFolders, INBOX_FOLDER))
        }

    @Test
    fun markingAColumnReadClearsTheDrawerBadgeBeforeTheWriteAnswers() {
        runBlocking {
            val core = GatedCore()
            val state = state(core, this)

            state.markKanbanColumnAllRead(KanbanColumnSpec(accountId = "a", folderId = "INBOX"))

            assertEquals(0, folderUnread(state.foldersByAccount["a"], INBOX_FOLDER))
            core.gate.complete(Unit)
        }
    }

    @Test
    fun aFailedColumnWritePutsTheDrawerBadgeBack() =
        runBlocking {
            val core = GatedCore().apply { gate.complete(Unit) }
            core.markAllReadFails = true
            val state = state(core, this)

            state.markKanbanColumnAllRead(KanbanColumnSpec(accountId = "a", folderId = "INBOX"))

            assertEquals(0, folderUnread(state.foldersByAccount["a"], INBOX_FOLDER))
            waitUntil { !state.kanbanMarkingRead }
            assertEquals(12, folderUnread(state.foldersByAccount["a"], INBOX_FOLDER))
            assertEquals(12, folderUnread(state.coreFolders, INBOX_FOLDER))
        }

    private suspend fun waitUntil(condition: () -> Boolean) {
        withTimeout(5_000) {
            while (!condition()) delay(5)
        }
    }

    private fun state(
        core: MeronCore,
        scope: CoroutineScope,
    ): MeronMobileState {
        val row =
            ThreadSummary(
                id = "a#INBOX#root",
                accountId = "a",
                folder = "INBOX",
                subject = "Release",
                sender = "Sender",
                unread = true,
            )
        val inbox = FolderSummary(accountId = "a", name = "INBOX", role = "inbox", unread = 12)
        return MeronMobileState(
            scope = scope,
            core = core,
            coreLoaded = true,
            prefs = MemoryPreferences(),
            kanbanPrefs = MemoryPreferences(),
            services = NoopPlatformServices(),
            locale = NoopLocaleController(),
            mobileHost = DefaultMobileHost(),
            settingsMirror = SettingsMirror(core, MemoryPreferences()) { true },
        ).apply {
            coreAccounts = listOf(AccountSummary(id = "a", email = "a@example.com"))
            selectedCoreAccountId = "a"
            selectedCoreFolder = "INBOX"
            initialThreadsLoaded = true
            coreThreads = listOf(row)
            coreFolders = listOf(inbox)
            foldersByAccount = mapOf("a" to listOf(inbox))
            kanbanColumns = mapOf("a\nINBOX" to KanbanColumnState(threads = listOf(row), unreadCount = 12))
        }
    }

    /** Holds the mark-read write open until [gate] completes, or fails it. */
    private class GatedCore : MeronCore {
        val gate = CompletableDeferred<Unit>()
        var markAllReadFails = false

        override suspend fun invoke(
            command: String,
            payloadJson: String,
        ): String =
            when (command) {
                MobileCommand.MarkAllRead -> {
                    gate.await()
                    if (markAllReadFails) error("Server rejected the write")
                    "{\"ok\":true}"
                }

                MobileCommand.FolderList -> {
                    """{"folders":[{"account_id":"a","name":"INBOX","role":"inbox"}]}"""
                }

                MobileCommand.ThreadList -> {
                    """{"threads":[]}"""
                }

                else -> {
                    "{}"
                }
            }

        override fun events(): CoreEventStream =
            object : CoreEventStream {
                override fun subscribe(listener: (CoreEvent) -> Unit): CloseableHandle = CloseableHandle {}
            }

        override suspend fun protocolVersion(): Int = 0
    }

    private class MemoryPreferences : AppPreferences {
        private val values = mutableMapOf<String, String>()

        override fun getString(
            key: String,
            default: String,
        ): String = values[key] ?: default

        override fun putString(
            key: String,
            value: String,
        ) {
            values[key] = value
        }

        override fun getBoolean(
            key: String,
            default: Boolean,
        ): Boolean = default

        override fun putBoolean(
            key: String,
            value: Boolean,
        ) {}

        override fun getInt(
            key: String,
            default: Int,
        ): Int = default

        override fun putInt(
            key: String,
            value: Int,
        ) {}

        override fun getStringSet(
            key: String,
            default: Set<String>,
        ): Set<String> = default

        override fun putStringSet(
            key: String,
            value: Set<String>,
        ) {}

        override fun remove(key: String) {
            values.remove(key)
        }
    }

    private class NoopPlatformServices : PlatformServices {
        override fun openUrl(url: String) {}

        override fun openOAuthUrl(
            url: String,
            callbackScheme: String,
            onCallback: (String) -> Unit,
            onFailure: (String) -> Unit,
        ) {}

        override fun copyText(
            label: String,
            value: String,
        ) {}

        override fun copyImage(
            bytes: ByteArray,
            mimeType: String,
            label: String,
        ) {}

        override fun shareFile(
            bytes: ByteArray,
            fileName: String,
            mimeType: String,
        ) {}

        override fun saveFile(
            bytes: ByteArray,
            fileName: String,
            mimeType: String,
        ) {}

        override fun pickFile(
            mimeTypes: List<String>,
            onPicked: (PickedFile?) -> Unit,
        ) {}

        override fun pickImage(onPicked: (PickedFile?) -> Unit) {}
    }

    private class NoopLocaleController : LocaleController {
        override fun systemLanguageTag(): String = ""

        override fun applySystem(tag: String) {}

        override fun deviceLanguageTag(): String = "en-US"

        override fun displayName(tag: String): String = tag
    }
}
