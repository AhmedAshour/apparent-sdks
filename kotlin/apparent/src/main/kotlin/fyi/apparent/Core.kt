package fyi.apparent

import java.net.URLDecoder
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

/** What the library keeps on the phone, one value (the Expo SDK's `apparent:v2` record). */
interface ApparentStorage {
    fun read(): String?
    fun write(value: String)
}

/** One HTTP POST. Throws an IOException when the network fails (no answer, timeout). */
interface ApparentTransport {
    class Response(val status: Int, val retryAfter: String? = null)

    fun post(url: String, body: String, timeoutMs: Int): Response
}

/** Where work runs: [io] for disk and timers, [net] for sending (one at a time). Tests swap in a manual one. */
internal interface Scheduler {
    fun io(delayMs: Long = 0, task: () -> Unit): Cancellable
    fun net(task: () -> Unit)
    fun every(periodMs: Long, task: () -> Unit)

    fun interface Cancellable { fun cancel() }
}

/** An event in the queue. `a`/`u` = whose event it was when it was tracked (identity can change before it is sent). */
internal data class Queued(
    var n: String, val t: Long, val s: String, val i: String, var p: Map<String, Any?>?, var a: String, var u: String?,
    /** Tracked before the saved state was read, to be completed with the saved properties and user. Not saved. */
    var early: Early? = null,
)

/** What an event tracked before the saved state was read still needs: its properties then, and whether a logout or a sign-in had happened. */
internal class Early(val name: String, val props: Map<String, Any?>, val afterReset: Boolean, val afterIdentify: Boolean)

internal sealed class SendResult {
    object Ok : SendResult()
    data class Drop(val status: Int) : SendResult()
    object TooLarge : SendResult()
    object Network : SendResult()
    data class Server(val status: Int, val retryAfterMs: Long?) : SendResult()
}

internal const val SDK_VERSION = "kotlin-0.2.2"
internal const val MAX_EVENT_AGE_MS = 7L * 24 * 3600_000
internal const val MAX_ERRORS_PER_VISIT = 20
internal const val MAX_BATCH = 100
internal const val MAX_PROPS = 40
internal const val MAX_VALUE = 500
/** A disk write that takes longer than this no longer holds sending or ready (it may still finish). */
internal const val WRITE_WAIT_MS = 1000L
/** Said once per launch, in debug builds, when the server answers 401: events are dropped, retrying can't fix a key. */
internal const val WRONG_KEY = "Apparent: app id or key is wrong — events are not being saved"

/**
 * Everything the SDK does, without Android: the same rules as `sdk/expo/src/index.ts` (ids, visits, queue, batching,
 * retries, the wire format of `POST /i`). [Apparent] wires it to the phone.
 */
internal class ApparentCore(
    config: ApparentConfig,
    private val storage: ApparentStorage,
    private val transport: ApparentTransport,
    private val scheduler: Scheduler,
    /** platform, os, app, build, model, locale, region, tz, in that order; `simulator = true` only in an emulator. */
    private val device: Map<String, Any?>,
    private val clock: () -> Long = System::currentTimeMillis,
    private val log: (String) -> Unit = {},
    /** The app is a debug build: a wrong app id or key is reported even without `debug`. */
    private val debuggable: Boolean = false,
    /** Where that one warning goes (Log.w on Android). */
    private val warn: (String) -> Unit = log,
    /** Milliseconds that only go forward (time since boot): retry waits use it, so a clock change never stretches one. */
    private val monotonic: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    val cfg: ApparentConfig = config.sanitized()
    private val lock = Any()
    private val writeLock = Any()
    private val ready = CountDownLatch(1)
    private val flushQueued = AtomicBoolean(false)

    private var anon = ""
    private var anonSource = "own"
    private var userId: String? = cfg.userId?.take(128)
    private val props = LinkedHashMap<String, Any?>()
    private var optedOut = false
    private var appVersion: String? = null
    private val queue = ArrayList<Queued>()
    private var inflight: List<Queued> = emptyList()
    private var sessionId = uid()
    private var loaded = false
    private var failures = 0
    /** When the retry wait ends, on both clocks: over when either says so (SPEC 1.6). null = no wait. */
    private var retryAtMono: Long? = null
    private var retryAtWall = 0L
    private var retryReason: String? = null
    private var batchSize = MAX_BATCH
    private var persistTimer: Scheduler.Cancellable? = null
    private var active = false
    private var activeSince: Long? = null
    private var backgroundAt: Long? = null
    private var pendingOpen = false
    private var screenName: String? = null
    private var errorsThisVisit = 0
    private var identified = false
    private var resetBeforeLoad = false
    private val warnedKey = AtomicBoolean(false)
    private val warnedHook = AtomicBoolean(false)
    /** Set once optIn() was called: with optOutByDefault, only then is anything collected. Saved as "consent". */
    private var consented = false
    /** optIn() or optOut() before the saved state was read: that choice wins over the saved one. */
    private var consentBeforeLoad: Boolean? = null
    private var lastPush: String? = null
    private val disk: ExecutorService by lazy {
        Executors.newSingleThreadExecutor { r -> Thread(r, "apparent-disk").apply { isDaemon = true } }
    }
    private var lastWrite: Future<*>? = null

    init {
        // Consent first: nothing is collected until the saved state says they agreed, or optIn() is called.
        if (cfg.optOutByDefault) optedOut = true
    }

    /** Begin: read what was saved (off the caller's thread). [foreground] = the app is on screen now. */
    fun start(foreground: Boolean, installReferrer: (() -> String?)? = null) {
        active = foreground
        scheduler.io { restore(installReferrer) }
        scheduler.every(cfg.flushIntervalMs) { flush() }
    }

    fun awaitReady(timeoutMs: Long = 5_000): Boolean = ready.await(timeoutMs, TimeUnit.MILLISECONDS)

    internal fun restore(installReferrer: (() -> String?)? = null) {
        try {
            restoreState()
        } catch (e: Throwable) {
            log("could not read saved events: $e")
            synchronized(lock) { if (!loaded) { if (anon.isEmpty()) anon = uid(); loaded = true } }
        } finally {
            ready.countDown()
        }
        if (synchronized(lock) { firstOpenPending }) {
            firstOpenPending = false
            recordInstallSource(installReferrer)
        }
    }

    private var firstOpenPending = false

    private fun restoreState() {
        // Read field by field: one bad field (another version, a broken write) never stops the rest (SPEC 4).
        val saved: Map<*, *>? = try { storage.read()?.let { Json.parse(it) as? Map<*, *> } } catch (_: Throwable) { null }
        val savedAnon = text(saved?.get("anon"))
        val fresh = savedAnon == null
        var newAnon = savedAnon ?: ""
        var newSource = (saved?.get("anonSource") as? String)?.takeIf { it == "provider" || it == "reset" } ?: "own"
        // Only on first launch: an id that changes after login would split one person in two.
        if (fresh && cfg.anonymousId != null) {
            try {
                val id = cfg.anonymousId.invoke()
                if (!id.isNullOrEmpty()) { newAnon = id.take(128); newSource = "provider" }
            } catch (_: Throwable) { /* keep the saved id */ }
        }
        if (newAnon.isEmpty()) { newAnon = uid(); newSource = "own" }
        val now = clock()
        val old = (saved?.get("queue") as? List<*>).orEmpty().mapNotNull { decodeQueued(it, newAnon) }.filter { now - it.t < MAX_EVENT_AGE_MS }
        val current = device["app"]?.let { "$it (${device["build"] ?: "?"})" }
        synchronized(lock) {
            val savedProps = cleanProps(entriesOf(saved?.get("props"))).orEmpty()
            val savedUser = text(saved?.get("userId"))
            // A logout before the disk was read already started a new person: keep that, not the saved one.
            if (!resetBeforeLoad) {
                anon = newAnon
                anonSource = newSource
                if (!identified && userId == null) userId = savedUser
                val merged = LinkedHashMap<String, Any?>(savedProps)
                merged.putAll(props)
                props.clear(); props.putAll(merged)
            }
            val before = consentBeforeLoad
            if (before != null) {
                optedOut = !before
            } else {
                consented = saved?.get("consent") == true
                optedOut = saved?.get("optedOut") == true || (cfg.optOutByDefault && !consented)
            }
            // Events tracked while the disk was read belong after the saved ones, with the saved id, user and
            // properties (they weren't known yet), unless a logout came first.
            val dropped = HashSet<Queued>()
            for (e in queue) {
                if (e.a.isEmpty()) e.a = newAnon
                val early = e.early ?: continue
                e.early = null
                if (early.afterReset) continue
                // The saved properties weren't known when it was tracked: clean it again, and let beforeSend see it again.
                val kept = hook(early.name, cleanProps(LinkedHashMap<String, Any?>(savedProps).apply { putAll(early.props) }), e.t)
                if (kept == null) { dropped.add(e); continue }
                e.n = kept.first
                e.p = kept.second
                if (e.u == null && !early.afterIdentify) e.u = savedUser
            }
            val earlier = queue.filter { it !in dropped }
            queue.clear(); queue.addAll(old); queue.addAll(earlier)
            loaded = true
            val savedApp = text(saved?.get("app"))
            if (fresh) { enqueueLocked("first_open", null); firstOpenPending = true }
            else if (savedApp != null && current != null && savedApp != current) {
                enqueueLocked("app_updated", linkedMapOf("from_version" to savedApp, "to_version" to current))
            }
            appVersion = current
            if (active) open(true) else pendingOpen = true
            if (optedOut) queue.clear()
        }
        persistNow()
    }

    /** A saved event, if it has what the server needs: a name, a time, a session and an insert id (SPEC 4). */
    private fun decodeQueued(raw: Any?, anon: String): Queued? {
        val m = raw as? Map<*, *> ?: return null
        val n = text(m["n"], 80) ?: return null
        val t = (m["t"] as? Number)?.toDouble()?.takeIf { it.isFinite() }?.toLong() ?: return null
        val s = text(m["s"], 64) ?: return null
        val i = text(m["i"], 80) ?: return null
        return Queued(n, t, s, i, cleanProps(entriesOf(m["p"])), text(m["a"]) ?: anon, text(m["u"]))
    }

    /** Android only: what the Play Store link carried (`utm_source=reddit&utm_campaign=launch`). */
    private fun recordInstallSource(installReferrer: (() -> String?)?) {
        val referrer = try { installReferrer?.invoke() } catch (_: Throwable) { null } ?: return
        val q = parseQuery(referrer)
        val source = q["utm_source"] ?: return
        enqueue("install_source", linkedMapOf("utm_source" to source, "utm_medium" to q["utm_medium"], "utm_campaign" to q["utm_campaign"]))
    }

    private fun open(cold: Boolean) {
        pendingOpen = false
        activeSince = clock()
        backgroundAt = null
        errorsThisVisit = 0
        enqueueLocked("app_open", linkedMapOf("cold" to cold))
    }

    fun onForeground() {
        synchronized(lock) {
            val was = active
            active = true
            if (!loaded) return // restore() opens the visit when it finishes
            if (pendingOpen) open(true)
            else if (!was && backgroundAt != null) {
                val away = clock() - backgroundAt!!
                if (away > cfg.sessionTimeoutMinutes * 60_000L) {
                    sessionId = uid()
                    open(false)
                } else {
                    activeSince = clock()
                    backgroundAt = null
                }
            }
            if (retryReason == "network") retryAtMono = null // the network may be back
        }
        flush()
    }

    fun onBackground() {
        synchronized(lock) {
            val was = active
            active = false
            if (!loaded) return
            val since = activeSince
            if (was && since != null) {
                enqueueLocked("app_background", linkedMapOf("seconds" to Math.max(0L, Math.round((clock() - since) / 1000.0))))
                activeSince = null
                backgroundAt = clock()
            }
        }
        scheduler.io { persistNow() }
        flush()
    }

    fun enqueue(name: String, extra: Map<String, Any?>?) {
        val flushNow = synchronized(lock) { enqueueLocked(name, extra) }
        if (flushNow) flush()
    }

    /** Returns true when the queue is long enough to send now. */
    private fun enqueueLocked(name: String, extra: Map<String, Any?>?): Boolean {
        if (cfg.disabled) {
            if (cfg.debug) log("$name ${extra ?: ""}")
            return false
        }
        if (optedOut) return false
        val merged = LinkedHashMap<String, Any?>(props)
        merged.putAll(entriesOf(extra))
        val t = clock()
        val kept = hook(name.take(80), cleanProps(merged), t) ?: return false
        val e = Queued(kept.first, t, sessionId, uid(), kept.second, anon, userId,
            early = if (loaded) null else Early(name.take(80), merged, afterReset = resetBeforeLoad, afterIdentify = identified))
        queue.add(e)
        val over = queue.size + inflight.size - cfg.maxQueue
        if (over > 0) repeat(Math.min(over, queue.size)) { queue.removeAt(0) }
        if (cfg.debug) log("${e.n} ${e.p ?: ""}")
        schedulePersist()
        return queue.size >= cfg.flushAt
    }

    /** The app's beforeSend: the event it returns (cleaned again), or null when it drops it. A hook that throws keeps it. */
    private fun hook(n: String, p: Map<String, Any?>?, t: Long): Pair<String, Map<String, Any?>?>? {
        val fn = cfg.beforeSend ?: return n to p
        val out = try {
            fn(ApparentEvent(n, p?.let { LinkedHashMap(it) }, t))
        } catch (e: Throwable) {
            if (warnedHook.compareAndSet(false, true)) log("beforeSend threw; the event is sent as it was: $e")
            return n to p
        } ?: return null
        val name = (out.name as String?)?.takeIf { it.isNotBlank() } ?: return null
        return name.take(80) to cleanProps(entriesOf(out.properties))
    }

    fun track(name: String?, props: Map<String, Any?>?) {
        if (!isName(name)) return
        enqueue(name!!, props)
    }

    fun screen(name: String?, props: Map<String, Any?>?) {
        if (!isName(name)) return
        val extra = synchronized(lock) {
            if (name == screenName) return
            val from = screenName
            screenName = name
            LinkedHashMap<String, Any?>().apply {
                putAll(entriesOf(props))
                remove("screen"); remove("from")
                put("screen", name)
                if (from != null) put("from", from)
            }
        }
        enqueue("screen_view", extra)
    }

    fun captureError(error: Throwable, fatal: Boolean, how: String, extra: Map<String, Any?>?, type: String? = null) {
        val p = synchronized(lock) {
            if (errorsThisVisit >= MAX_ERRORS_PER_VISIT) return
            errorsThisVisit++
            val lines = ArrayList<String>()
            lines.add(if (type != null) "$type: ${safeText { error.message } ?: ""}" else safeText { error.toString() } ?: error.javaClass.name)
            (safeValue { error.stackTrace } ?: emptyArray()).take(7).forEach { lines.add("at $it") }
            val stack = lines.joinToString("\n") { it.trim() }.take(1500)
            LinkedHashMap<String, Any?>().apply {
                putAll(entriesOf(extra))
                listOf("message", "type", "fatal", "how", "stack", "screen").forEach { remove(it) }
                put("message", (safeText { error.message } ?: safeText { error.toString() } ?: "Error").take(300))
                put("type", type ?: error.javaClass.name)
                put("fatal", fatal)
                put("how", how)
                if (stack.isNotEmpty()) put("stack", stack)
                screenName?.let { put("screen", it) }
            }
        }
        enqueue("error", p)
    }

    /** Saved now, not in a quarter second: an app killed right after a sign-in or a logout wakes up as that person (SPEC 2.3). */
    fun identify(id: String?) {
        synchronized(lock) { userId = if (id.isNullOrEmpty()) null else id.take(128); identified = true }
        scheduler.io { persistNow() }
    }

    fun setProperties(values: Map<String, Any?>?) {
        synchronized(lock) {
            for ((k, v) in entriesOf(values)) {
                val key = k.take(64)
                val value = cleanOrOmit(v)
                if (value == null || value === OMIT) props.remove(key) else props[key] = value
            }
        }
        schedulePersistSafe()
    }

    fun unsetProperty(key: String?) {
        if (key == null) return
        synchronized(lock) { props.remove(key.take(64)) }
        schedulePersistSafe()
    }

    /** Logged out: forget who they were, start a new anonymous id. Events already queued keep the old one. */
    fun reset() {
        synchronized(lock) {
            if (!loaded) resetBeforeLoad = true
            anon = uid()
            anonSource = "reset"
            userId = null
            props.clear()
            sessionId = uid()
            screenName = null
        }
        scheduler.io { persistNow() }
    }

    fun optOut() {
        synchronized(lock) {
            optedOut = true; consented = false; queue.clear()
            if (!loaded) consentBeforeLoad = false
        }
        scheduler.io { persistNow() }
    }

    /** Start collecting again, or for the first time with optOutByDefault. Remembered across launches. */
    fun optIn() {
        synchronized(lock) {
            optedOut = false; consented = true
            if (!loaded) consentBeforeLoad = true
        }
        scheduler.io { persistNow() }
    }

    /** A link opened the app: `deep_link_opened` with secrets redacted and the utm_ fields split out (SPEC 3.1). */
    fun deepLinkOpened(url: String?) {
        if (!cfg.trackDeepLinks || url.isNullOrEmpty()) return
        enqueue("deep_link_opened", cleanDeepLink(url))
    }

    /**
     * A notification was tapped: `push_opened` with only the `campaign` (else `utm_campaign`) and `title` from its
     * data, never what it said. [id] = the notification's id, so one tap reported twice is one event.
     */
    fun pushOpened(data: Map<String, Any?>?, id: String?) {
        if (!cfg.trackPushOpens) return
        synchronized(lock) {
            if (id != null && id == lastPush) return
            lastPush = id
        }
        val d = entriesOf(data)
        val pick = { k: String -> (d[k] as? String)?.takeIf { it.isNotEmpty() }?.take(100) }
        val p = LinkedHashMap<String, Any?>()
        (pick("campaign") ?: pick("utm_campaign"))?.let { p["campaign"] = it }
        pick("title")?.let { p["title"] = it }
        enqueue("push_opened", p)
    }

    val isOptedOut: Boolean get() = synchronized(lock) { optedOut }
    val anonymousId: String get() = synchronized(lock) { anon }
    val currentUserId: String? get() = synchronized(lock) { userId }
    internal val queued: List<Queued> get() = synchronized(lock) { ArrayList(queue) }
    /** Events not yet accepted by the server (queued + being sent). */
    val pending: Int get() = synchronized(lock) { queue.size + inflight.size }

    /** Send what is queued. Safe to call any time: sends run one at a time on the net thread. */
    fun flush() {
        if (flushQueued.compareAndSet(false, true)) scheduler.net { flushQueued.set(false); drain() }
    }

    internal fun drain() {
        awaitReady(30_000)
        synchronized(lock) {
            if (cfg.disabled || optedOut) { queue.clear(); return }
            val cutoff = clock() - MAX_EVENT_AGE_MS
            queue.removeAll { it.t < cutoff }
        }
        var sent = false
        while (true) {
            val batch = synchronized(lock) {
                if (queue.isEmpty() || !due()) null
                else ArrayList(queue.subList(0, Math.min(batchSize, queue.size))).also {
                    repeat(it.size) { queue.removeAt(0) }
                    inflight = it
                }
            } ?: break
            // Nothing may be in flight without being on disk: a crash mid-send must not lose it.
            if (synchronized(lock) { persistTimer != null }) persistNow()
            val result = send(batch)
            sent = true
            val stop = synchronized(lock) {
                inflight = emptyList()
                when (result) {
                    is SendResult.Ok, is SendResult.Drop -> {
                        if (result is SendResult.Drop) {
                            log("server refused ${batch.size} events (${result.status})")
                            if (result.status == 401 && (cfg.debug || debuggable) && warnedKey.compareAndSet(false, true)) warn(WRONG_KEY)
                        }
                        failures = 0; retryAtMono = null; retryReason = null
                        if (result is SendResult.Ok && batchSize < MAX_BATCH) batchSize = Math.min(MAX_BATCH, batchSize * 2)
                        false
                    }
                    is SendResult.TooLarge -> {
                        if (batch.size == 1) log("dropped one event the server says is too large")
                        else { batchSize = Math.max(1, batch.size / 2); queue.addAll(0, batch) }
                        false
                    }
                    else -> {
                        queue.addAll(0, batch)
                        failures++
                        retryReason = if (result is SendResult.Network) "network" else "server"
                        // The server's Retry-After exactly (already 1 s .. 1 h), never sooner; our own backoff with ±20 % jitter.
                        val wait = (result as? SendResult.Server)?.retryAfterMs
                            ?: Math.round(Math.min(5 * 60_000L, cfg.retryBaseMs * (1L shl Math.min(20, failures - 1))) * (0.8 + random.nextDouble() * 0.4))
                        retryAtMono = monotonic() + wait
                        retryAtWall = clock() + wait
                        log("send failed ($result), next try in ${wait / 1000} s")
                        true
                    }
                }
            }
            if (stop) break
        }
        if (sent) persistNow()
    }

    /**
     * True once the retry wait is over. Timed on the clock that only goes forward, so the phone's clock going back
     * never holds the queue; the wall clock jumping forward ends it sooner (SPEC 1.6). Call with [lock] held.
     */
    private fun due(): Boolean {
        val at = retryAtMono ?: return true
        if (monotonic() >= at || clock() >= retryAtWall) { retryAtMono = null; return true }
        return false
    }

    /** The `POST /i` body for [batch], exactly as the Expo SDK writes it. */
    internal fun encode(batch: List<Queued>): String {
        val first = batch[0]
        val d = LinkedHashMap<String, Any?>(device)
        d["anon"] = first.a.ifEmpty { anonymousId }
        d["user"] = first.u
        val events = batch.map { q ->
            LinkedHashMap<String, Any?>().apply {
                put("n", q.n); put("t", q.t); put("s", q.s); put("i", q.i)
                if (q.p != null) put("p", q.p)
                if (q.a.isNotEmpty() && q.a != d["anon"]) put("a", q.a)
                if (q.u != d["user"]) put("u", q.u)
            }
        }
        return Json.write(linkedMapOf("a" to cfg.app, "k" to cfg.key, "v" to SDK_VERSION, "sa" to clock(), "d" to d, "e" to events))
    }

    private fun send(batch: List<Queued>): SendResult {
        return try {
            val res = transport.post("${cfg.apiUrl.trimEnd('/')}/i", encode(batch), cfg.requestTimeoutMs)
            when {
                res.status in 200..299 -> SendResult.Ok
                res.status == 413 -> SendResult.TooLarge
                res.status == 408 || res.status == 429 || res.status >= 500 -> SendResult.Server(res.status, retryAfterMs(res.retryAfter, clock()))
                else -> SendResult.Drop(res.status)
            }
        } catch (_: Throwable) {
            SendResult.Network
        }
    }

    private fun schedulePersistSafe() = synchronized(lock) { schedulePersist() }

    /** Within a quarter second. Call with [lock] held. */
    private fun schedulePersist() {
        if (persistTimer != null || !loaded) return
        persistTimer = scheduler.io(250) {
            synchronized(lock) { persistTimer = null }
            persistNow()
        }
    }

    /** Save ids, properties and the queue (including what is being sent) now. Safe from any thread. */
    fun persistNow() {
        synchronized(writeLock) {
            val text = synchronized(lock) {
                persistTimer?.cancel()
                persistTimer = null
                if (cfg.disabled || !loaded) return
                val all = ArrayList<Queued>(inflight.size + queue.size).apply { addAll(inflight); addAll(queue) }
                val kept = if (all.size > cfg.maxQueue) all.subList(all.size - cfg.maxQueue, all.size) else all
                Json.write(linkedMapOf<String, Any?>(
                    "v" to 2, "anon" to anon, "anonSource" to anonSource, "userId" to userId, "props" to LinkedHashMap(props),
                    "optedOut" to optedOut,
                ).apply {
                    if (consented) put("consent", true)
                    put("app", appVersion)
                    put("queue", kept.map { q ->
                        linkedMapOf<String, Any?>("n" to q.n, "t" to q.t, "s" to q.s, "i" to q.i).apply {
                            if (q.p != null) put("p", q.p)
                            put("a", q.a); put("u", q.u)
                        }
                    })
                })
            }
            write(text)
        }
    }

    /**
     * One write on the disk thread. A write that hasn't finished after a second stops being waited for, and while it
     * hangs later ones aren't waited for at all, so a stuck disk never holds sending or ready (SPEC 4). Writes stay
     * in order. Call with [writeLock] held.
     */
    private fun write(text: String) {
        val stuck = lastWrite?.isDone == false
        val f = try {
            disk.submit { try { storage.write(text) } catch (e: Throwable) { log("could not save events: $e") } }
        } catch (e: Throwable) {
            try { storage.write(text) } catch (e2: Throwable) { log("could not save events: $e2") }
            return
        }
        lastWrite = f
        if (stuck) return
        try { f.get(WRITE_WAIT_MS, TimeUnit.MILLISECONDS) } catch (_: TimeoutException) { log("saving takes long; not waiting for it") } catch (_: Throwable) {}
    }

    internal companion object {
        private val random = SecureRandom()
        private const val HEX = "0123456789abcdef"

        fun uid(): String {
            val bytes = ByteArray(16).also { random.nextBytes(it) }
            val sb = StringBuilder(32)
            for (b in bytes) { sb.append(HEX[(b.toInt() shr 4) and 15]); sb.append(HEX[b.toInt() and 15]) }
            return sb.toString()
        }

        /** A property value that is left out (a function: JSON has no text for it). */
        internal val OMIT = Any()

        /** Flat values only: strings (cut at 500), numbers, booleans, null; anything else becomes its JSON text. */
        fun cleanValue(v: Any?): Any? = cleanOrOmit(v).let { if (it === OMIT) null else it }

        /**
         * One property value, flat (SPEC 3.3). Never throws: a date is its ISO time, a big integer its digits, a
         * function is [OMIT], a list or map its JSON text, anything else its toString(), or null when that fails too
         * (a list that holds itself, a toString() that throws).
         */
        internal fun cleanOrOmit(v: Any?): Any? = try {
            when (v) {
                null -> null
                is Boolean -> v
                is String -> v.take(MAX_VALUE)
                is Int, is Long, is Short, is Byte -> (v as Number).toLong()
                is Float -> if (v.isFinite()) v.toString().toDouble() else null
                is java.math.BigInteger -> v.toString().take(MAX_VALUE)
                is java.math.BigDecimal -> v.toDouble().let { if (it.isFinite()) it else null }
                is Number -> v.toDouble().let { if (it.isFinite()) it else null }
                is Function<*> -> OMIT
                is Date -> isoTime(v.time)
                is Calendar -> isoTime(v.timeInMillis)
                is Map<*, *>, is Iterable<*>, is Array<*> -> safeText { Json.write(v) }?.take(MAX_VALUE)
                else -> safeText { v.toString() }?.take(MAX_VALUE)
            }
        } catch (_: Throwable) {
            null
        }

        /** "2026-10-24T10:00:00.000Z", like JavaScript's toISOString(). */
        fun isoTime(ms: Long): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
            .apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(ms))

        fun cleanProps(input: Map<String, Any?>?): Map<String, Any?>? {
            val entries = entriesOf(input)
            if (entries.isEmpty()) return null
            val out = LinkedHashMap<String, Any?>()
            for ((k, raw) in entries) {
                val v = cleanOrOmit(raw)
                if (v === OMIT) continue
                if (out.size >= MAX_PROPS) break
                out[k.take(64)] = v
            }
            return out.ifEmpty { null }
        }

        /** A map's entries with text keys, or none when it isn't a map or reading it throws (SPEC 6). Null keys are left out. */
        fun entriesOf(input: Any?): Map<String, Any?> {
            val m = input as? Map<*, *> ?: return emptyMap()
            return try {
                val out = LinkedHashMap<String, Any?>()
                for ((k, v) in m) {
                    val key = (k as? String) ?: k?.let { safeText { it.toString() } } ?: continue
                    out[key] = v
                }
                out
            } catch (_: Throwable) {
                emptyMap()
            }
        }

        /** A non-empty string of at most [max] characters, or null. */
        fun text(v: Any?, max: Int = 128): String? = (v as? String)?.takeIf { it.isNotEmpty() && it.length <= max }

        /** Event and screen names: a string that isn't blank (SPEC 3.3). */
        fun isName(v: String?): Boolean = v != null && v.isNotBlank()

        inline fun safeText(block: () -> String?): String? = try { block() } catch (_: Throwable) { null }
        inline fun <T> safeValue(block: () -> T): T? = try { block() } catch (_: Throwable) { null }

        /** Query and fragment parameters whose values are never sent: anything that looks like a login or a secret. */
        private val SECRET_PARAM = Regex("token|code|password|passwd|secret|key|auth|session|sig", RegexOption.IGNORE_CASE)
        private val USER_INFO = Regex("^([a-z][a-z0-9+.-]*://)[^/?#@]*@", RegexOption.IGNORE_CASE)
        private val UTM = Regex("^utm_(source|medium|campaign)$", RegexOption.IGNORE_CASE)

        private fun decode(s: String, plusIsSpace: Boolean): String? = try {
            URLDecoder.decode(if (plusIsSpace) s else s.replace("+", "%2B"), "UTF-8")
        } catch (_: Throwable) {
            null
        }

        /**
         * A link that opened the app, safe to store (the Expo SDK's `cleanDeepLink`): secrets in the query or fragment
         * become "[redacted]", a user:password@ is dropped, and it is cut to 500 characters. Also the utm_ fields.
         */
        fun cleanDeepLink(raw: String): Map<String, Any?> {
            var url = USER_INFO.replaceFirst(raw, "$1")
            val utm = LinkedHashMap<String, Any?>()
            fun scrub(part: String) = part.split('&').joinToString("&") { pair ->
                val eq = pair.indexOf('=')
                if (eq < 0) return@joinToString pair
                val k = pair.substring(0, eq)
                val name = decode(k, plusIsSpace = false) ?: k
                val v = pair.substring(eq + 1)
                if (UTM.matches(name)) {
                    val value = decode(v, plusIsSpace = true) ?: v
                    if (value.isNotEmpty()) utm[name.lowercase(Locale.ROOT)] = value.take(100)
                    pair
                } else if (SECRET_PARAM.containsMatchIn(name)) "$k=[redacted]" else pair
            }
            val hash = url.indexOf('#')
            var fragment = ""
            if (hash >= 0) { fragment = url.substring(hash + 1); url = url.substring(0, hash) }
            val q = url.indexOf('?')
            if (q >= 0) url = "${url.substring(0, q)}?${scrub(url.substring(q + 1))}"
            if (hash >= 0) url += "#${if (fragment.contains('=')) scrub(fragment) else fragment}"
            val out = LinkedHashMap<String, Any?>()
            out["url"] = url.take(MAX_VALUE)
            // The Expo SDK's key order: utm_ fields in the order the link has them.
            out.putAll(utm)
            return out
        }

        /** Retry-After as seconds or an HTTP date, kept between 1 s and 1 h. */
        fun retryAfterMs(header: String?, now: Long): Long? {
            if (header.isNullOrBlank()) return null
            val ms = header.trim().toDoubleOrNull()?.let { (it * 1000).toLong() } ?: try {
                SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss zzz", Locale.US).parse(header.trim())!!.time - now
            } catch (_: Throwable) { return null }
            return Math.min(3600_000L, Math.max(1000L, ms))
        }

        fun parseQuery(q: String): Map<String, String> {
            val out = LinkedHashMap<String, String>()
            for (part in q.removePrefix("?").split('&')) {
                if (part.isEmpty()) continue
                val eq = part.indexOf('=')
                val k = if (eq < 0) part else part.substring(0, eq)
                val v = if (eq < 0) "" else part.substring(eq + 1)
                val key = try { URLDecoder.decode(k, "UTF-8") } catch (_: Throwable) { k }
                if (key !in out) out[key] = try { URLDecoder.decode(v, "UTF-8") } catch (_: Throwable) { v }
            }
            return out
        }

        /** A navigation route to a screen name like the Expo router's: `practice/{topic}?tab={tab}` → `practice/[topic]`. */
        fun screenNameForRoute(route: String?): String {
            if (route.isNullOrEmpty()) return "home"
            val path = route.substringBefore('?').trim('/')
            val name = path.split('/').filter { it.isNotEmpty() }.joinToString("/") {
                if (it.startsWith("{") && it.endsWith("}")) "[${it.substring(1, it.length - 1)}]" else it
            }
            return name.ifEmpty { "home" }
        }
    }
}
