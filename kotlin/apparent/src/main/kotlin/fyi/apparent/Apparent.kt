package fyi.apparent

import android.app.Activity
import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.WeakHashMap

/**
 * Apparent for Android: product events for the Apparent dashboard, the same as the Expo SDK (`apparent-expo`).
 *
 *     Apparent.start(this, app = "einb", key = "…", disabled = BuildConfig.DEBUG)   // in Application.onCreate
 *     Apparent.track("paywall_view", mapOf("source" to "onboarding"))
 *
 * Every event is saved within a quarter second (right away when the app goes to the background or crashes), sent in
 * batches one request at a time, and only leaves the saved queue once the server has it.
 *
 * Automatic events: `first_open`, `app_open` (each visit), `app_updated`, `app_background` (seconds in the app),
 * `install_source` (Play referrer, if the app has the install-referrer library), `error` (crashes), `deep_link_opened`
 * (a link opened the app) and `push_opened` (a Firebase notification tapped; [trackPushOpened] for your own).
 */
object Apparent {
    const val DEFAULT_API_URL = "https://in.apparent.fyi"
    const val VERSION = SDK_VERSION

    @Volatile
    private var core: ApparentCore? = null

    /** Every public call goes through here: the SDK never throws into the app. */
    private inline fun safe(block: (ApparentCore) -> Unit) {
        val c = core ?: return
        try { block(c) } catch (e: Throwable) { if (c.cfg.debug) Log.w("Apparent", "ignored an internal error", e) }
    }

    /** Start once, in `Application.onCreate`. Later calls are ignored. */
    @JvmStatic
    @JvmOverloads
    fun start(context: Context?, app: String?, key: String?, apiUrl: String? = DEFAULT_API_URL, disabled: Boolean = false) {
        if (app == null || key == null) { warnBadStart(null); return }
        start(context, ApparentConfig(app = app, key = key, apiUrl = apiUrl ?: DEFAULT_API_URL, disabled = disabled))
    }

    /**
     * Start with all the settings. A call without a context, app id, key or server address is ignored (a warning in
     * Logcat), so a later correct one still works. Never throws.
     */
    @JvmStatic
    @Synchronized
    fun start(context: Context?, config: ApparentConfig?) {
        if (core != null) return
        if (context == null || config == null || !config.isUsable) { warnBadStart(config); return }
        try {
            begin(context, config)
        } catch (e: Throwable) {
            core = null
            Log.w("Apparent", "could not start", e)
        }
    }

    private fun warnBadStart(config: ApparentConfig?) {
        try { Log.w("Apparent", "Apparent: start needs a context, app, key and apiUrl" + if (config?.debug == true) " (got $config)" else "") } catch (_: Throwable) {}
    }

    private fun begin(context: Context, config: ApparentConfig) {
        val appContext = context.applicationContext ?: context
        val log: (String) -> Unit = { if (config.debug) Log.d("Apparent", it) }
        val debuggable = try { (appContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0 } catch (_: Throwable) { false }
        val c = ApparentCore(config, FileStorage(appContext), HttpTransport(), ExecutorScheduler(), readDevice(appContext), log = log,
            debuggable = debuggable, warn = { Log.w("Apparent", it) })
        core = c
        // A launch by a push or a background job is not a visit: wait until an Activity is really in front.
        c.start(foreground = isForeground(appContext), installReferrer = { InstallReferrer.read(appContext) })
        (appContext as? Application)?.registerActivityLifecycleCallbacks(Lifecycle(c, c.cfg.trackActivities))
        if (config.captureErrors && !config.disabled) installCrashHandler(c)
    }

    /** Record something a person did. Names: lowercase_snake. Properties: flat values (String, Number, Boolean, null). */
    @JvmStatic
    @JvmOverloads
    fun track(name: String?, properties: Map<String, Any?>? = null) { safe { it.track(name, properties) } }

    /** Record that a screen was shown. Repeats of the current screen are ignored. */
    @JvmStatic
    @JvmOverloads
    fun screen(name: String?, properties: Map<String, Any?>? = null) { safe { it.screen(name, properties) } }

    /** Properties added to every event from now on, e.g. `mapOf("language" to "de", "plan" to "pro")`. `null` removes one. */
    @JvmStatic
    fun setProperties(properties: Map<String, Any?>?) { safe { it.setProperties(properties) } }

    @JvmStatic
    fun unsetProperty(key: String?) { safe { it.unsetProperty(key) } }

    /** Who is using the app, once they sign in. The anonymous id stays the same. `null` = signed out. */
    @JvmStatic
    fun identify(userId: String?) { safe { it.identify(userId) } }

    /** Someone signed out: forget who they were and start a new anonymous id. */
    @JvmStatic
    fun logout() { safe { it.reset() } }

    /** Same as [logout] (the Expo SDK's name). */
    @JvmStatic
    fun reset() { safe { it.reset() } }

    /** Report an error you caught yourself. */
    @JvmStatic
    @JvmOverloads
    fun captureError(error: Throwable?, properties: Map<String, Any?>? = null) {
        safe { it.captureError(error ?: Throwable("Unknown error"), fatal = false, how = "reported", extra = properties, type = if (error == null) "Error" else null) }
    }

    /** Report a problem by message (the event's `type` is "Error", like `captureError("…")` in the Expo SDK). */
    @JvmStatic
    @JvmOverloads
    fun captureError(message: String?, properties: Map<String, Any?>? = null) {
        safe { it.captureError(Throwable(message ?: "Unknown error"), fatal = false, how = "reported", extra = properties, type = "Error") }
    }

    /**
     * A purchase you saw yourself (e.g. Play Billing's `onPurchasesUpdated`), as `purchase_success`. Send it with
     * RevenueCat too: RevenueCat's sales come in on their own, but this event is the "Bought" step of a visit and of
     * "Where new people stop"; use [linkRevenueCat] so RevenueCat's sales join to the person.
     */
    @JvmStatic
    @JvmOverloads
    fun trackPurchase(productId: String, price: Double? = null, currency: String? = null, orderId: String? = null, properties: Map<String, Any?>? = null) {
        val p = LinkedHashMap<String, Any?>()
        properties?.let { p.putAll(it) }
        p["product"] = productId
        if (price != null) p["price"] = price
        if (currency != null) p["currency"] = currency
        if (orderId != null) p["order_id"] = orderId
        safe { it.track("purchase_success", p) }
    }

    /** Stop collecting (someone declined analytics). Queued events are dropped. Remembered across launches. */
    @JvmStatic
    fun optOut() { safe { it.optOut() } }

    /** Start collecting again, or for the first time with `optOutByDefault = true`. Remembered across launches. */
    @JvmStatic
    fun optIn() { safe { it.optIn() } }

    /**
     * Call from your Activity's `onNewIntent` (the SDK sees the Intent that launched an Activity on its own, not the
     * ones that bring it back): a link becomes `deep_link_opened`, a tapped Firebase notification `push_opened`.
     * The same Intent is only counted once, so calling it from `onCreate` too is fine.
     *
     *     override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); Apparent.handleIntent(intent) }
     */
    @JvmStatic
    fun handleIntent(intent: Intent?) { safe { handle(it, intent) } }

    /** A link opened the app, when you route links yourself: `deep_link_opened`, with secrets in it redacted. */
    @JvmStatic
    fun trackDeepLink(url: String?) { safe { it.deepLinkOpened(url) } }

    /**
     * Someone tapped a notification you showed yourself (a Firebase message in the foreground, a local notification):
     * pass its data. Only `campaign` (else `utm_campaign`) and `title` from it are sent, never what it said. [id] = the
     * notification's id (for Firebase, `message.messageId`), so one tap reported twice is one event.
     */
    @JvmStatic
    @JvmOverloads
    fun trackPushOpened(data: Map<String, Any?>?, id: String? = null) { safe { it.pushOpened(data, id) } }

    @JvmStatic
    val isOptedOut: Boolean get() = core?.isOptedOut ?: false

    /** This install's id ("" until the saved state is read, a few milliseconds after [start]). */
    @JvmStatic
    val anonymousId: String get() = core?.anonymousId ?: ""

    /**
     * Store this person's Apparent id on their RevenueCat customer, so purchases join to what they did. No RevenueCat
     * dependency: you get the attributes to set.
     *
     *     Apparent.linkRevenueCat { Purchases.sharedInstance.setAttributes(it) }
     *
     * Runs on a background thread once the id is known. Call it again after [logout].
     */
    @JvmStatic
    fun linkRevenueCat(setAttributes: (Map<String, String?>) -> Unit) {
        val c = core ?: return
        ready { setAttributes(mapOf("apparent_id" to c.anonymousId)) }
    }

    /** Runs [block] on a background thread once the saved state is read ([anonymousId] is final from then on). */
    @JvmStatic
    fun ready(block: () -> Unit) {
        val c = core ?: return
        Thread({ c.awaitReady(); try { block() } catch (e: Throwable) { if (c.cfg.debug) Log.w("Apparent", "ready callback failed", e) } }, "apparent-ready")
            .apply { isDaemon = true }.start()
    }

    /** Events on the phone the server doesn't have yet (queued or being sent). */
    @JvmStatic
    val pendingEvents: Int get() = core?.pending ?: 0

    /** Send what is queued now. Safe to call any time. */
    @JvmStatic
    fun flush() { safe { it.flush() } }

    /** A Jetpack Navigation route as a screen name like the Expo router's: `practice/{topic}` → `practice/[topic]`. */
    @JvmStatic
    fun screenNameForRoute(route: String?): String = ApparentCore.screenNameForRoute(route)

    /** Intents already counted (launch + onNewIntent + onCreate may all pass the same one). */
    private val handled = WeakHashMap<Intent, Boolean>()

    private fun handle(c: ApparentCore, intent: Intent?) {
        if (intent == null) return
        synchronized(handled) {
            if (handled.containsKey(intent)) return
            handled[intent] = true
        }
        // Back from the recents screen: the old Intent again, not a new tap or link.
        if ((intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return
        val data = intent.dataString
        if (intent.action == Intent.ACTION_VIEW && !data.isNullOrEmpty()) c.deepLinkOpened(data)
        val extras = intent.extras ?: return
        // A tapped Firebase notification opens the app with its data as extras, plus google.message_id.
        val id = extras.getString("google.message_id") ?: return
        c.pushOpened(listOf("campaign", "utm_campaign", "title").associateWith { extras.getString(it) }, id)
    }

    private fun isForeground(context: Context): Boolean = try {
        val info = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(info)
        info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
    } catch (_: Throwable) {
        false
    }

    private fun installCrashHandler(c: ApparentCore) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                c.captureError(error, fatal = true, how = "crash", extra = null)
                c.persistNow() // saved now, sent on the next launch
            } catch (_: Throwable) { /* never make it worse */ }
            previous?.uncaughtException(thread, error)
        }
    }

    /** Foreground = at least one Activity started; background 700 ms after the last one stops (not on rotation). */
    private class Lifecycle(private val c: ApparentCore, private val trackActivities: Boolean) : Application.ActivityLifecycleCallbacks {
        private val main = Handler(Looper.getMainLooper())
        private var started = 0
        private var inFront = false
        private val goBackground = Runnable {
            if (started == 0 && inFront) {
                inFront = false
                c.onBackground()
            }
        }

        override fun onActivityStarted(activity: Activity) {
            started++
            main.removeCallbacks(goBackground)
            if (!inFront) {
                inFront = true
                c.onForeground()
            }
        }

        override fun onActivityStopped(activity: Activity) {
            started = Math.max(0, started - 1)
            if (started == 0 && !activity.isChangingConfigurations) main.postDelayed(goBackground, 700)
        }

        override fun onActivityResumed(activity: Activity) {
            if (trackActivities) c.screen(activity.javaClass.simpleName, null)
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
            // A new Activity (not one restored after rotation or a process restart): the link or tap that opened it.
            if (savedInstanceState == null) try { handle(c, activity.intent) } catch (_: Throwable) {}
        }
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {}
    }
}
