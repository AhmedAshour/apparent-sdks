package fyi.apparent

import java.io.IOException

/** Runs nothing on its own: tests decide when disk and network work happens. */
internal class ManualScheduler : Scheduler {
    val io = ArrayList<() -> Unit>()
    val net = ArrayList<() -> Unit>()
    /** io tasks asked to run at once (no delay), so a test can tell "saved now" from "saved in 250 ms". */
    private val immediate = HashSet<() -> Unit>()

    override fun io(delayMs: Long, task: () -> Unit): Scheduler.Cancellable {
        io.add(task)
        if (delayMs <= 0) immediate.add(task)
        return Scheduler.Cancellable { io.remove(task); immediate.remove(task) }
    }

    /** Run only the io work that was asked to run right away (what a kill 10 ms later would still have saved). */
    fun runImmediate() {
        repeat(100) {
            val next = io.firstOrNull { it in immediate } ?: return
            io.remove(next); immediate.remove(next)
            next()
        }
    }

    override fun net(task: () -> Unit) { net.add(task) }
    override fun every(periodMs: Long, task: () -> Unit) {}

    /** Run everything queued (and what that queues) until nothing is left. */
    fun settle() {
        repeat(100) {
            if (io.isEmpty() && net.isEmpty()) return
            while (io.isNotEmpty()) { val t = io.removeAt(0); immediate.remove(t); t() }
            while (net.isNotEmpty()) net.removeAt(0)()
        }
    }
}

class MemStorage : ApparentStorage {
    var value: String? = null
    var writes = 0
    override fun read(): String? = value
    override fun write(value: String) { this.value = value; writes++ }

    @Suppress("UNCHECKED_CAST")
    fun saved(): Map<String, Any?> = (value?.let { Json.parse(it) } ?: emptyMap<String, Any?>()) as Map<String, Any?>

    @Suppress("UNCHECKED_CAST")
    fun savedQueue(): List<Map<String, Any?>> = saved()["queue"] as List<Map<String, Any?>>? ?: emptyList()
}

/** A fake Apparent server: records each request, can misbehave on demand. */
class FakeServer : ApparentTransport {
    enum class Mode { OK, OFFLINE, E500, E429, E400, E401 }

    var mode = Mode.OK
    var retryAfter: String? = "1"
    var maxEvents = Int.MAX_VALUE
    val bodies = ArrayList<Map<String, Any?>>()
    /** Every accepted event, by insert id, with whose it is resolved like the server does. */
    val seen = LinkedHashMap<String, Map<String, Any?>>()
    var onRequest: () -> Unit = {}

    @Suppress("UNCHECKED_CAST")
    override fun post(url: String, body: String, timeoutMs: Int): ApparentTransport.Response {
        val b = Json.parse(body) as Map<String, Any?>
        bodies.add(b)
        onRequest()
        val events = b["e"] as List<Map<String, Any?>>
        return when {
            mode == Mode.OFFLINE -> throw IOException("offline")
            mode == Mode.E500 -> ApparentTransport.Response(500)
            mode == Mode.E429 -> ApparentTransport.Response(429, retryAfter)
            mode == Mode.E400 -> ApparentTransport.Response(400)
            mode == Mode.E401 -> ApparentTransport.Response(401)
            events.size > maxEvents -> ApparentTransport.Response(413)
            else -> {
                val d = b["d"] as Map<String, Any?>
                for (e in events) {
                    seen[e["i"] as String] = e + mapOf("anon" to (e["a"] ?: d["anon"]), "user" to (if (e.containsKey("u")) e["u"] else d["user"]))
                }
                ApparentTransport.Response(200)
            }
        }
    }

    fun names(): List<String> = seen.values.map { it["n"] as String }
}

val DEVICE: Map<String, String?> = linkedMapOf(
    "platform" to "android", "os" to "34", "app" to "1.0.0", "build" to "1", "model" to "Pixel 8",
    "locale" to "en-DE", "region" to "DE", "tz" to "Europe/Berlin",
)

internal class Phone(
    val storage: MemStorage = MemStorage(),
    val server: FakeServer = FakeServer(),
    now: Long = 1_800_000_000_000L,
) {
    val scheduler = ManualScheduler()
    private var wall = now
    /** Time since boot (never jumps). Moving [now] moves it too; [jumpClock] moves only the wall clock. */
    var mono = 5_000_000L

    /** The wall clock. Moving it is time passing (the monotonic clock moves the same). */
    var now: Long
        get() = wall
        set(v) { mono += v - wall; wall = v }

    /** Someone changes the phone's clock: the wall clock jumps, time since boot doesn't. */
    fun jumpClock(byMs: Long) { wall += byMs }

    fun launch(
        cfg: ApparentConfig = config(),
        device: Map<String, Any?> = DEVICE,
        foreground: Boolean = true,
        referrer: (() -> String?)? = null,
        debuggable: Boolean = false,
        warn: (String) -> Unit = {},
    ): ApparentCore {
        val c = ApparentCore(cfg, storage, server, scheduler, device, clock = { now }, debuggable = debuggable, warn = warn, monotonic = { mono })
        c.start(foreground, referrer)
        scheduler.settle()
        return c
    }

    fun settle() = scheduler.settle()

    companion object {
        fun config(
            flushAt: Int = 1000, maxQueue: Int = 1000, disabled: Boolean = false,
            anonymousId: (() -> String?)? = null, retryBaseMs: Long = 2000, debug: Boolean = false,
        ) = ApparentConfig(app = "einb", key = "k_test", apiUrl = "https://apparent.test", flushAt = flushAt, maxQueue = maxQueue,
            disabled = disabled, anonymousId = anonymousId, retryBaseMs = retryBaseMs, captureErrors = false, debug = debug)
    }
}
