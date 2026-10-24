package fyi.apparent

/** Settings for [Apparent.start]. Only [app] and [key] are needed; the rest has the Expo SDK's defaults. */
data class ApparentConfig @JvmOverloads constructor(
    /** The app's id in Apparent (e.g. "einb"). */
    val app: String,
    /** The app's write key from Apparent's Connect page. */
    val key: String,
    val apiUrl: String = Apparent.DEFAULT_API_URL,
    /** Nothing is stored or sent. Use it in debug builds: `disabled = BuildConfig.DEBUG`. */
    val disabled: Boolean = false,
    /** Log every event to Logcat (tag "Apparent"). */
    val debug: Boolean = false,
    /** The signed-in user, when you already know it at start. */
    val userId: String? = null,
    /** A stable id you already have (e.g. the RevenueCat app user id), used on first launch only. */
    val anonymousId: (() -> String?)? = null,
    /** Minutes in the background before a visit ends. */
    val sessionTimeoutMinutes: Int = 30,
    /** Report uncaught exceptions (saved before the app goes down, sent on the next launch). */
    val captureErrors: Boolean = true,
    /** A `screen_view` for every Activity that comes to the front (named after its class). Off by default. */
    val trackActivities: Boolean = false,
    val flushIntervalMs: Long = 10_000,
    val flushAt: Int = 20,
    val maxQueue: Int = 1000,
    val requestTimeoutMs: Int = 10_000,
    val retryBaseMs: Long = 2000,
    /** Send `deep_link_opened` when a link opens the app (the launch link on its own; [Apparent.handleIntent] for later ones). */
    val trackDeepLinks: Boolean = true,
    /** Send `push_opened` when someone taps a notification (FCM taps on their own; [Apparent.trackPushOpened] for your own). */
    val trackPushOpens: Boolean = true,
    /**
     * Runs on every event (automatic ones too) before it is queued, after its properties are cleaned. Return the
     * event, changed, or `null` to drop it. Use it to remove personal data or skip noisy events. If it throws, the
     * event is kept as it was. Called on whichever thread tracked the event: keep it quick.
     */
    val beforeSend: ((ApparentEvent) -> ApparentEvent?)? = null,
    /** Collect nothing until [Apparent.optIn] is called (for apps that ask for consent first). Remembered across launches. */
    val optOutByDefault: Boolean = false,
) {
    /** Has what it needs to send: an app id, a key and a server address (SPEC 9). */
    internal val isUsable: Boolean
        @Suppress("SENSELESS_COMPARISON")
        get() = app != null && key != null && apiUrl != null && app.isNotBlank() && key.isNotBlank() && apiUrl.isNotBlank() &&
            app.length <= 128 && key.length <= 512 && apiUrl.length <= 2048

    /** The same settings with numbers that can't work (0 or negative) replaced by the defaults. */
    internal fun sanitized(): ApparentConfig {
        val d = ApparentConfig(app = "", key = "")
        return copy(
            sessionTimeoutMinutes = if (sessionTimeoutMinutes > 0) sessionTimeoutMinutes else d.sessionTimeoutMinutes,
            flushIntervalMs = if (flushIntervalMs > 0) flushIntervalMs else d.flushIntervalMs,
            flushAt = if (flushAt > 0) flushAt else d.flushAt,
            maxQueue = if (maxQueue > 0) maxQueue else d.maxQueue,
            requestTimeoutMs = if (requestTimeoutMs > 0) requestTimeoutMs else d.requestTimeoutMs,
            retryBaseMs = if (retryBaseMs > 0) retryBaseMs else d.retryBaseMs,
        )
    }
}

/** An event as [ApparentConfig.beforeSend] sees it: its name, its cleaned properties, and when it happened (ms). */
data class ApparentEvent(val name: String, val properties: Map<String, Any?>?, val time: Long)
