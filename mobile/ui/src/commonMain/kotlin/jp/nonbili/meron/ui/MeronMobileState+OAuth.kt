package jp.nonbili.meron.ui

import androidx.compose.material.icons.filled.Add
import jp.nonbili.meron.shared.AddOAuthAccountParams
import jp.nonbili.meron.shared.ExchangeOAuthCodeParams
import jp.nonbili.meron.shared.MobileMailCommandClient
import jp.nonbili.meron.shared.OAuthAuthorizationRequest
import jp.nonbili.meron.shared.UpdateOAuthTokenParams
import jp.nonbili.meron.shared.buildOAuthAuthorizationUrl
import jp.nonbili.meron.shared.coreErrorMessage
import jp.nonbili.meron.shared.defaultOAuthRedirectUri
import jp.nonbili.meron.shared.isOAuthLoginFailure
import jp.nonbili.meron.shared.parseAccountListResponse
import jp.nonbili.meron.shared.parseOAuthCallbackUrlForRedirect
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.uuid.ExperimentalUuidApi
import kotlin.uuid.Uuid

internal fun MeronMobileState.addOAuthAccount() {
    if (!coreLoaded) {
        status = coreUnavailableMessage
        return
    }
    val refreshToken = oauthRefreshToken.trim()
    if (refreshToken.isBlank()) {
        status = "OAuth refresh token is required."
        return
    }
    val params =
        AddOAuthAccountParams(
            email = oauthEmail.trim(),
            provider = oauthProvider,
            displayName = displayName.trim(),
            senderName = senderName.trim(),
            accessToken = oauthAccessToken.trim(),
            refreshToken = refreshToken,
            tokenExpiresAt = oauthExpiresAt.trim().toLongOrNull() ?: 0,
        )
    status = "Adding ${oauthProvider.replaceFirstChar { it.uppercase() }} account..."
    scope.launch {
        runCatching {
            withContext(ioDispatcher) {
                val client = MobileMailCommandClient(core)
                client.addOAuthAccount(params)
                client.listAccounts()
            }
        }.onSuccess {
            applyAccounts(it, preferEmail = params.email)
            screen = Screen.Mail
            errorBanner = null
            status = "Added ${params.email}"
            syncCoreThreads(accountOverride = selectedCoreAccountId, folderOverride = INBOX_FOLDER, syncFirst = true)
        }.onFailure {
            errorBanner = it.message ?: "Add OAuth failed"
            status = "Add OAuth failed: ${it.message}"
        }
    }
}

/**
 * Gmail via the platform's system Google account. The host runs the full system
 * flow (pick account, mint token, read profile name) and returns the result.
 */
internal fun MeronMobileState.connectGoogleDeviceAccount() {
    if (!coreLoaded) {
        status = coreUnavailableMessage
        return
    }
    if (!mobileHost.supportsGoogleDeviceAuth) {
        launchOAuthFlow()
        return
    }
    mobileHost.connectGoogleDeviceAccount { account ->
        when (account) {
            is GoogleDeviceAccountResult.Connected -> {
                addGoogleDeviceAccount(account.account)
            }

            GoogleDeviceAccountResult.Cancelled -> {
                status = "Google sign-in cancelled."
            }

            is GoogleDeviceAccountResult.Failed -> {
                val deviceAuthError = account.message.ifBlank { mobileHost.lastGoogleDeviceAuthError }
                if (mobileHost.googleRedirectUri.isBlank()) {
                    status =
                        listOf(
                            deviceAuthError,
                            "Google browser sign-in requires a configured HTTPS redirect URI.",
                        ).filter { it.isNotBlank() }.joinToString(" ")
                    return@connectGoogleDeviceAccount
                }
                status =
                    listOf(
                        deviceAuthError,
                        "Opening Google sign-in in browser...",
                    ).filter { it.isNotBlank() }.joinToString(" ")
                launchOAuthFlow()
            }
        }
    }
}

private fun MeronMobileState.addGoogleDeviceAccount(account: GoogleDeviceAccount) {
    status = "Connecting ${account.email}..."
    scope.launch {
        runCatching {
            val params =
                AddOAuthAccountParams(
                    email = account.email,
                    provider = "gmail",
                    displayName = account.displayName,
                    senderName = account.displayName,
                    username = account.email,
                    avatarUrl = account.avatarUrl,
                    // No refresh token: the host re-mints access tokens.
                    accessToken = account.accessToken,
                    refreshToken = "",
                    tokenExpiresAt = account.expiresAtEpochSeconds,
                )
            withContext(ioDispatcher) {
                val client = MobileMailCommandClient(core)
                client.addOAuthAccount(params)
                client.listAccounts()
            }
        }.onSuccess { accounts ->
            // meron-core keys accounts by lower-cased email.
            val accountId = account.email.trim().lowercase()
            mobileHost.recordManagedGoogleExpiry(accountId, account.expiresAtEpochSeconds)
            if (googleReauthAccountId == accountId) googleReauthAccountId = null
            applyAccounts(accounts, preferEmail = account.email)
            screen = Screen.Mail
            errorBanner = null
            status = "Connected ${account.email}"
            // Fetch the inbox immediately instead of waiting for a manual sync.
            syncCoreThreads(accountOverride = accountId, folderOverride = INBOX_FOLDER, syncFirst = true)
        }.onFailure {
            errorBanner = it.message ?: "Google sign-in failed"
            status = "Google sign-in failed: ${it.message}"
        }
    }
}

/**
 * For host-managed Gmail accounts, mint a fresh access token and push it into
 * meron-core before a server-touching command. No-op for browser-flow /
 * non-managed accounts, and — unless [force] — while the last pushed token is
 * comfortably before expiry. Returns true only when a fresh token was pushed
 * into core. Failures are swallowed so a stale token still attempts the
 * command.
 */
internal suspend fun MeronMobileState.ensureManagedGoogleToken(
    client: MobileMailCommandClient,
    accountId: String,
    force: Boolean = false,
): Boolean {
    when (val refresh = mobileHost.refreshManagedGoogleToken(accountId, force)) {
        ManagedTokenRefresh.NotNeeded, ManagedTokenRefresh.StillFresh -> {
            Unit
        }

        is ManagedTokenRefresh.Refreshed -> {
            val pushed =
                runCatching {
                    client.updateOAuthToken(
                        UpdateOAuthTokenParams(
                            accountId = accountId,
                            accessToken = refresh.accessToken,
                            tokenExpiresAt = refresh.expiresAtEpochSeconds,
                        ),
                    )
                }
            if (pushed.isSuccess) {
                mobileHost.recordManagedGoogleExpiry(accountId, refresh.expiresAtEpochSeconds)
                if (googleReauthAccountId == accountId) googleReauthAccountId = null
                return true
            }
        }

        ManagedTokenRefresh.Failed -> {
            // OS could not silently mint a token (e.g. consent revoked).
            googleReauthAccountId = accountId
            errorBanner = "Google sign-in expired. Reconnect the account on this device."
        }

        ManagedTokenRefresh.TransientError -> {
            // Network hiccup while minting — not a reconnect case. Attempt the
            // command with the stored token; it may still be valid.
            Unit
        }
    }
    return false
}

/**
 * Run a server-touching mail command with managed-Gmail token upkeep: refresh
 * the pushed token first when it is near expiry, and if the server still
 * rejects our OAuth credentials (token revoked mid-session, or core state that
 * drifted from the host's expiry record), force-mint a fresh token and retry
 * once. Non-managed accounts run [action] unchanged. Handles both failure
 * shapes: hosts whose core invoke throws on an error payload, and ones that
 * return the payload for the caller to inspect.
 */
internal suspend fun MeronMobileState.withManagedGoogleAuth(
    client: MobileMailCommandClient,
    accountId: String,
    action: suspend () -> String,
): String {
    if (accountId.isBlank()) return action()
    ensureManagedGoogleToken(client, accountId)
    val first = runCatching { action() }
    (first.exceptionOrNull() as? CancellationException)?.let { throw it }
    val errorMessage = first.exceptionOrNull()?.message ?: first.getOrNull()?.let(::coreErrorMessage)
    if (!isOAuthLoginFailure(errorMessage)) return first.getOrThrow()
    if (!ensureManagedGoogleToken(client, accountId, force = true)) return first.getOrThrow()
    return action()
}

internal fun MeronMobileState.exchangeOAuthCode() {
    if (!coreLoaded) {
        status = coreUnavailableMessage
        return
    }
    val code = oauthAuthorizationCode.trim()
    if (code.isBlank()) {
        status = "OAuth authorization code is required."
        return
    }
    val clientId = bakedOAuthClientId()
    if (clientId.isBlank()) {
        status = "OAuth client ID is required."
        return
    }
    val params =
        ExchangeOAuthCodeParams(
            email = oauthEmail.trim(),
            provider = oauthProvider,
            displayName = displayName.trim(),
            senderName = senderName.trim(),
            code = code,
            clientId = clientId,
            clientSecret = "",
            redirectUri = oauthRedirectUri.trim(),
            codeVerifier = oauthVerifier,
            tokenUrl = if (oauthProvider == "gmail") mobileHost.googleTokenUrl else "",
        )
    Log.i(
        "Meron.OAuth",
        "exchange start provider=${params.provider} emailPresent=${params.email.isNotBlank()} " +
            "clientIdPresent=${params.clientId.isNotBlank()} redirectUri=${params.redirectUri} " +
            "tokenUrlPresent=${params.tokenUrl.isNotBlank()} codeLength=${params.code.length} " +
            "verifierPresent=${params.codeVerifier.isNotBlank()}",
    )
    status = "Exchanging OAuth code..."
    val previousAccountIds = coreAccounts.map { it.id }.toSet()
    scope.launch {
        runCatching {
            withContext(ioDispatcher) {
                val client = MobileMailCommandClient(core)
                client.exchangeOAuthCode(params)
                client.listAccounts()
            }
        }.onSuccess { accountsJson ->
            val parsedAccounts = parseAccountListResponse(accountsJson)
            val connectedAccount =
                findOAuthResultAccount(
                    accounts = parsedAccounts,
                    previousAccountIds = previousAccountIds,
                    provider = params.provider,
                    preferredEmail = params.email,
                )
            applyAccounts(accountsJson, preferEmail = connectedAccount?.email ?: params.email.ifBlank { null })
            connectedAccount?.let { selectedCoreAccountId = it.id }
            screen = Screen.Mail
            errorBanner = null
            status = connectedAccount?.email?.takeIf { it.isNotBlank() }?.let { "Connected $it" }
                ?: if (params.email.isBlank()) "Connected account" else "Connected ${params.email}"
            val syncAccountId = connectedAccount?.id ?: selectedCoreAccountId
            Log.i(
                "Meron.OAuth",
                "exchange success provider=${params.provider} selectedAccount=$syncAccountId " +
                    "connectedEmailPresent=${connectedAccount?.email?.isNotBlank() == true}",
            )
            syncCoreThreads(accountOverride = syncAccountId, folderOverride = INBOX_FOLDER, syncFirst = true)
        }.onFailure {
            Log.w("Meron.OAuth", "exchange failed provider=${params.provider}: ${it.message}", it)
            oauthAuthorizationCode = ""
            errorBanner = it.message ?: "OAuth exchange failed"
            status = "OAuth exchange failed: ${it.message}"
        }
    }
}

@OptIn(ExperimentalUuidApi::class)
internal fun MeronMobileState.launchOAuthFlow() {
    val clientId = bakedOAuthClientId()
    if (clientId.isBlank()) {
        status = "OAuth client ID is required."
        return
    }
    val redirectUri = resolvedOAuthRedirectUri()
    oauthRedirectUri = redirectUri
    oauthState = Uuid.random().toString()
    oauthVerifier = Uuid.random().toString() + Uuid.random().toString()
    savePendingOAuthFlow(
        prefs,
        PendingOAuthFlow(
            provider = oauthProvider,
            state = oauthState,
            verifier = oauthVerifier,
            redirectUri = redirectUri,
            email = oauthEmail.trim(),
        ),
    )
    val url =
        buildOAuthAuthorizationUrl(
            OAuthAuthorizationRequest(
                provider = oauthProvider,
                clientId = clientId,
                redirectUri = redirectUri,
                state = oauthState,
                codeChallenge = pkceChallenge(oauthVerifier),
                loginHint = oauthEmail.trim(),
            ),
        )
    status = "Opened ${oauthProvider.replaceFirstChar { it.uppercase() }} sign-in"
    services.openOAuthUrl(
        url = url,
        callbackScheme = redirectUri.substringBefore(':', missingDelimiterValue = ""),
        onCallback = ::handleOAuthCallback,
        onFailure = { message -> status = "OAuth browser launch failed: $message" },
    )
}

internal fun MeronMobileState.handleOAuthCallback(rawUrl: String) {
    Log.i("Meron.OAuth", "callback received length=${rawUrl.length}")
    val pending = loadPendingOAuthFlow(prefs)
    if (pending == null || pending.state.isBlank() || pending.redirectUri.isBlank()) {
        Log.w("Meron.OAuth", "callback ignored without a pending flow")
        return
    }
    Log.i(
        "Meron.OAuth",
        "pending flow provider=${pending.provider} redirectUri=${pending.redirectUri} emailPresent=${pending.email.isNotBlank()}",
    )
    oauthProvider = pending.provider
    oauthState = pending.state
    oauthVerifier = pending.verifier
    oauthRedirectUri = pending.redirectUri
    oauthEmail = pending.email
    runCatching {
        parseOAuthCallbackUrlForRedirect(
            rawUrl = rawUrl,
            expectedState = oauthState,
            redirectUri = oauthRedirectUri.trim(),
        )
    }.onSuccess { result ->
        if (result != null) {
            Log.i("Meron.OAuth", "callback parsed provider=$oauthProvider codeLength=${result.code.length}")
            oauthAuthorizationCode = result.code
            addSection = 0
            passwordServerSettingsOpen = false
            screen = Screen.AddAccount
            status = "Finishing ${oauthProvider.replaceFirstChar { it.uppercase() }} sign-in..."
            clearPendingOAuthFlow(prefs)
            exchangeOAuthCode()
        } else {
            Log.w("Meron.OAuth", "callback did not match redirectUri=$oauthRedirectUri")
            status = "OAuth callback did not match expected redirect URI."
        }
    }.onFailure {
        Log.w("Meron.OAuth", "callback parse failed: ${it.message}", it)
        status = "OAuth callback failed: ${it.message}"
    }
}

private fun MeronMobileState.bakedOAuthClientId(): String =
    when (oauthProvider) {
        "outlook" -> mobileHost.outlookClientId
        "gmail" -> mobileHost.googleClientId
        else -> ""
    }.trim()

private fun MeronMobileState.resolvedOAuthRedirectUri(): String =
    when (oauthProvider) {
        "outlook" -> mobileHost.outlookRedirectUri
        "gmail" -> mobileHost.googleRedirectUri.ifBlank { oauthRedirectUri.ifBlank { defaultOAuthRedirectUri() } }
        else -> oauthRedirectUri.ifBlank { defaultOAuthRedirectUri() }
    }.trim()
