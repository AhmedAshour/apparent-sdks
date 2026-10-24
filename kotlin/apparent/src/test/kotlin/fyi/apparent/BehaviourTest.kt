package fyi.apparent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import kotlin.concurrent.thread

class BehaviourTest {
    private fun names(q: List<Map<String, Any?>>) = q.map { it["n"] }

    // ids

    @Test
    fun `the install id is kept across launches, first_open only once`() {
        val phone = Phone()
        val first = phone.launch()
        val id = first.anonymousId
        assertEquals(32, id.length)
        assertEquals(listOf("first_open", "app_open"), names(phone.storage.savedQueue()))
        val second = phone.launch()
        assertEquals(id, second.anonymousId)
        assertEquals(listOf("first_open", "app_open", "app_open"), names(phone.storage.savedQueue()))
    }

    @Test
    fun `app_updated after an update`() {
        val phone = Phone()
        phone.launch()
        phone.launch(device = DEVICE + mapOf("app" to "1.1.0", "build" to "7"))
        val updated = phone.storage.savedQueue().single { it["n"] == "app_updated" }
        assertEquals(mapOf("from_version" to "1.0.0 (1)", "to_version" to "1.1.0 (7)"), updated["p"])
    }

    @Test
    fun `an id from the app is used on first launch, not after a logout`() {
        val phone = Phone()
        val c = phone.launch(Phone.config(anonymousId = { "rc-123" }))
        assertEquals("rc-123", c.anonymousId)
        c.reset()
        phone.settle()
        val again = phone.launch(Phone.config(anonymousId = { "rc-other" }))
        assertNotEquals("rc-123", again.anonymousId)
        assertNotEquals("rc-other", again.anonymousId)
        assertEquals("reset", phone.storage.saved()["anonSource"])
    }

    // login / logout

    @Test
    fun `login keeps the id, logout starts a new one, earlier events keep theirs`() {
        val phone = Phone()
        val c = phone.launch()
        val before = c.anonymousId
        c.identify("user-42")
        c.track("signed_in", null)
        assertEquals(before, c.anonymousId)
        c.setProperties(mapOf("plan" to "pro"))
        c.reset()
        c.track("signed_out", null)
        assertNotEquals(before, c.anonymousId)
        c.flush()
        phone.settle()
        val byName = phone.server.seen.values.associateBy { it["n"] }
        assertEquals(before, byName["signed_in"]!!["anon"])
        assertEquals("user-42", byName["signed_in"]!!["user"])
        assertEquals(c.anonymousId, byName["signed_out"]!!["anon"])
        assertNull(byName["signed_out"]!!["user"])
        assertNull(byName["signed_out"]!!["p"]) // properties are forgotten on logout
        assertNotEquals(byName["signed_in"]!!["s"], byName["signed_out"]!!["s"])
    }

    @Test
    fun `events tracked before the saved state is read still get the saved user and properties`() {
        val phone = Phone()
        phone.server.mode = FakeServer.Mode.OFFLINE
        val first = phone.launch()
        first.identify("user-7")
        first.setProperties(mapOf("plan" to "pro"))
        phone.settle()
        val c = ApparentCore(Phone.config(), phone.storage, phone.server, phone.scheduler, DEVICE, clock = { phone.now })
        c.start(foreground = true)
        c.track("right_away", mapOf("n" to 1)) // before restore() ran
        phone.settle()
        val e = phone.storage.savedQueue().last { it["n"] == "right_away" }
        assertEquals(first.anonymousId, e["a"])
        assertEquals("user-7", e["u"])
        assertEquals(mapOf("plan" to "pro", "n" to 1L), e["p"])
    }

    @Test
    fun `a logout before the saved state is read is not undone by it`() {
        val phone = Phone()
        phone.server.mode = FakeServer.Mode.OFFLINE
        val first = phone.launch()
        first.identify("user-7")
        first.setProperties(mapOf("plan" to "pro"))
        phone.settle()
        val c = ApparentCore(Phone.config(), phone.storage, phone.server, phone.scheduler, DEVICE, clock = { phone.now })
        c.start(foreground = true)
        c.track("before_logout", null)
        c.reset()
        c.track("after_logout", null)
        phone.settle()
        val q = phone.storage.savedQueue().associateBy { it["n"] }
        assertEquals(first.anonymousId, q["before_logout"]!!["a"])
        assertEquals("user-7", q["before_logout"]!!["u"])
        assertEquals(mapOf("plan" to "pro"), q["before_logout"]!!["p"])
        assertNotEquals(first.anonymousId, q["after_logout"]!!["a"])
        assertNull(q["after_logout"]!!["u"])
        assertNull(q["after_logout"]!!["p"])
        assertEquals(c.anonymousId, q["after_logout"]!!["a"])
        assertNull(c.currentUserId)
        assertEquals("reset", phone.storage.saved()["anonSource"])
    }

    @Test
    fun `the signed-in user is remembered across launches`() {
        val phone = Phone()
        phone.launch().identify("user-7")
        phone.settle()
        assertEquals("user-7", phone.launch().currentUserId)
    }

    // queue + retries

    @Test
    fun `offline events stay saved and go out once on the next launch`() {
        val phone = Phone()
        phone.server.mode = FakeServer.Mode.OFFLINE
        val c = phone.launch()
        c.track("offline_thing", null)
        c.flush()
        phone.settle()
        assertTrue(phone.server.seen.isEmpty())
        assertEquals(listOf("first_open", "app_open", "offline_thing"), names(phone.storage.savedQueue()))
        phone.server.mode = FakeServer.Mode.OK
        val next = phone.launch()
        next.flush()
        phone.settle()
        assertEquals(listOf("first_open", "app_open", "offline_thing", "app_open"), phone.server.names())
        assertTrue(phone.storage.savedQueue().isEmpty())
    }

    @Test
    fun `a failing server is retried less and less often`() {
        val phone = Phone()
        phone.server.mode = FakeServer.Mode.E500
        val c = phone.launch()
        val waits = ArrayList<Long>()
        repeat(4) {
            c.flush(); phone.settle()
            val requests = phone.server.bodies.size
            // Nothing goes out before the wait is over.
            c.flush(); phone.settle()
            assertEquals(requests, phone.server.bodies.size)
            var waited = 0L
            while (phone.server.bodies.size == requests && waited < 600_000) { phone.now += 100; waited += 100; c.flush(); phone.settle() }
            waits.add(waited)
        }
        for (i in 1 until waits.size) assertTrue("waits grow: $waits", waits[i] > waits[i - 1])
        phone.server.mode = FakeServer.Mode.OK
        phone.now += 600_000
        c.flush(); phone.settle()
        assertEquals(listOf("first_open", "app_open"), phone.server.names())
    }

    @Test
    fun `Retry-After from the server is respected`() {
        val phone = Phone()
        phone.server.mode = FakeServer.Mode.E429
        phone.server.retryAfter = "60"
        val c = phone.launch()
        c.flush(); phone.settle()
        phone.server.mode = FakeServer.Mode.OK
        phone.now += 40_000
        c.flush(); phone.settle()
        assertTrue(phone.server.seen.isEmpty())
        phone.now += 40_000
        c.flush(); phone.settle()
        assertEquals(2, phone.server.seen.size)
    }

    @Test
    fun `batches the server finds too large are split`() {
        val phone = Phone()
        phone.server.maxEvents = 10
        val c = phone.launch()
        repeat(48) { c.track("e$it", null) }
        c.flush(); phone.settle()
        assertEquals(50, phone.server.seen.size)
    }

    @Test
    fun `at most 100 events per request`() {
        val phone = Phone()
        val c = phone.launch()
        repeat(248) { c.track("e$it", null) }
        c.flush(); phone.settle()
        @Suppress("UNCHECKED_CAST")
        assertEquals(listOf(100, 100, 50), phone.server.bodies.map { (it["e"] as List<*>).size })
        // Every event exactly once: nothing cut, nothing sent twice (the server keeps 500 per batch at most).
        assertEquals(250, phone.server.seen.size)
        assertEquals(250, phone.server.bodies.sumOf { (it["e"] as List<*>).size })
    }

    @Test
    fun `a wrong app id or key is said once in debug builds, and the events are dropped`() {
        val phone = Phone()
        phone.server.mode = FakeServer.Mode.E401
        val warnings = ArrayList<String>()
        val c = phone.launch(debuggable = true, warn = { warnings.add(it) })
        c.flush(); phone.settle()
        c.track("again", null)
        c.flush(); phone.settle()
        assertEquals(2, phone.server.bodies.size)
        assertEquals(listOf("Apparent: app id or key is wrong — events are not being saved"), warnings)
        assertTrue(phone.storage.savedQueue().isEmpty())
    }

    @Test
    fun `the wrong-key warning also shows with debug on, and never in a release build without it`() {
        val loud = Phone().apply { server.mode = FakeServer.Mode.E401 }
        val heard = ArrayList<String>()
        loud.launch(cfg = Phone.config(debug = true), warn = { heard.add(it) }).also { it.flush(); loud.settle() }
        assertEquals(1, heard.size)
        val quiet = Phone().apply { server.mode = FakeServer.Mode.E401 }
        val none = ArrayList<String>()
        quiet.launch(warn = { none.add(it) }).also { it.flush(); quiet.settle() }
        assertTrue(none.isEmpty())
        // Other refusals (400) never say it.
        val bad = Phone().apply { server.mode = FakeServer.Mode.E400 }
        val other = ArrayList<String>()
        bad.launch(debuggable = true, warn = { other.add(it) }).also { it.flush(); bad.settle() }
        assertTrue(other.isEmpty())
    }

    @Test
    fun `an emulator says so in d, a real phone sends no simulator key`() {
        val emu = Phone()
        emu.launch(device = DEVICE + mapOf("model" to "sdk_gphone64_arm64", "simulator" to true)).also { it.flush(); emu.settle() }
        @Suppress("UNCHECKED_CAST")
        assertEquals(true, (emu.server.bodies[0]["d"] as Map<String, Any?>)["simulator"])
        val real = Phone()
        real.launch().also { it.flush(); real.settle() }
        @Suppress("UNCHECKED_CAST")
        assertFalse((real.server.bodies[0]["d"] as Map<String, Any?>).containsKey("simulator"))
    }

    @Test
    fun `emulators are recognised from Build`() {
        assertTrue(isEmulator("google/sdk_gphone64_arm64/emu64a:14/UE1A/1:userdebug/dev-keys", "sdk_gphone64_arm64", "ranchu", "sdk_gphone64_arm64", "Google", "google", "emu64a"))
        assertTrue(isEmulator("generic/sdk/generic:7.0/NYC/1:eng/test-keys", "Android SDK built for x86", "goldfish", "sdk", "unknown", "generic", "generic"))
        assertTrue(isEmulator("google/vbox86p/vbox86p:9/PI/1:user/release-keys", "Custom Phone", "vbox86", "vbox86p", "Genymotion", "google", "vbox86p"))
        assertFalse(isEmulator("google/husky/husky:14/AP1A/1:user/release-keys", "Pixel 8 Pro", "husky", "husky", "Google", "google", "husky"))
        assertFalse(isEmulator("OnePlus/OnePlus8Pro_EEA/OnePlus8Pro:11/RP1A/1:user/release-keys", "OnePlus8Pro", "qcom", "OnePlus8Pro_EEA", "OnePlus", "OnePlus", "OnePlus8Pro"))
    }

    @Test
    fun `a batch the server refuses is dropped, not retried forever`() {
        val phone = Phone()
        phone.server.mode = FakeServer.Mode.E400
        val c = phone.launch()
        c.flush(); phone.settle()
        assertEquals(1, phone.server.bodies.size)
        assertTrue(phone.storage.savedQueue().isEmpty())
    }

    @Test
    fun `a crash while a batch is being sent keeps that batch on disk`() {
        val phone = Phone()
        val c = phone.launch()
        c.track("important", null)
        var onDisk: List<Any?> = emptyList()
        phone.server.onRequest = { c.persistNow(); onDisk = names(phone.storage.savedQueue()) }
        phone.server.mode = FakeServer.Mode.OFFLINE
        c.flush(); phone.settle()
        assertEquals(listOf("first_open", "app_open", "important"), onDisk)
    }

    @Test
    fun `events older than a week are not sent`() {
        val phone = Phone()
        phone.server.mode = FakeServer.Mode.OFFLINE
        val c = phone.launch()
        c.flush(); phone.settle()
        phone.server.mode = FakeServer.Mode.OK
        phone.now += 8L * 24 * 3600_000
        c.track("fresh", null)
        phone.now += 600_000
        c.flush(); phone.settle()
        assertEquals(listOf("fresh"), phone.server.names())
    }

    @Test
    fun `the queue keeps the newest events when it is full`() {
        val phone = Phone()
        phone.server.mode = FakeServer.Mode.OFFLINE
        val c = phone.launch(Phone.config(maxQueue = 10))
        repeat(30) { c.track("e$it", null) }
        phone.settle()
        assertEquals((20 until 30).map { "e$it" }, names(phone.storage.savedQueue()))
    }

    @Test
    fun `a full queue sends without waiting for the timer`() {
        val phone = Phone()
        val c = phone.launch(Phone.config(flushAt = 5))
        repeat(3) { c.track("e$it", null) }
        phone.settle()
        assertEquals(5, phone.server.seen.size)
    }

    @Test
    fun `each batch carries the phone's clock`() {
        val phone = Phone()
        val c = phone.launch()
        phone.now += 5000
        c.flush(); phone.settle()
        assertEquals(phone.now, phone.server.bodies[0]["sa"])
    }

    // visits

    @Test
    fun `a launch in the background is not a visit until the app is opened`() {
        val phone = Phone()
        phone.server.mode = FakeServer.Mode.OFFLINE
        val c = phone.launch(foreground = false)
        assertEquals(listOf("first_open"), names(phone.storage.savedQueue()))
        c.onForeground(); phone.settle()
        assertEquals(listOf("first_open", "app_open"), names(phone.storage.savedQueue()))
    }

    @Test
    fun `time in the app is sent on background, a long break starts a new visit`() {
        val phone = Phone()
        phone.server.mode = FakeServer.Mode.OFFLINE
        val c = phone.launch()
        phone.now += 42_000
        c.onBackground(); phone.settle()
        val bg = phone.storage.savedQueue().last()
        assertEquals("app_background", bg["n"])
        assertEquals(mapOf("seconds" to 42L), bg["p"])
        phone.now += 5 * 60_000
        c.onForeground(); phone.settle()
        assertEquals("app_background", phone.storage.savedQueue().last()["n"]) // a short break is the same visit
        c.onBackground()
        phone.now += 31 * 60_000
        c.onForeground(); phone.settle()
        val q = phone.storage.savedQueue()
        assertEquals(mapOf("cold" to false), q.last()["p"])
        assertNotEquals(q.first()["s"], q.last()["s"])
    }

    @Test
    fun `screens - repeats are ignored and each view says where it came from`() {
        val phone = Phone()
        val c = phone.launch()
        c.screen("home", null); c.screen("home", null); c.screen("paywall", mapOf("from" to "x"))
        phone.settle()
        val views = phone.storage.savedQueue().filter { it["n"] == "screen_view" }.map { it["p"] }
        assertEquals(listOf(mapOf("screen" to "home"), mapOf("screen" to "paywall", "from" to "home")), views)
    }

    @Test
    fun `install_source from the Play referrer on first open only`() {
        val phone = Phone()
        phone.launch(referrer = { "utm_source=reddit&utm_campaign=launch%20week" })
        val src = phone.storage.savedQueue().single { it["n"] == "install_source" }
        assertEquals(mapOf("utm_source" to "reddit", "utm_medium" to null, "utm_campaign" to "launch week"), src["p"])
        phone.launch(referrer = { "utm_source=reddit" })
        assertEquals(1, phone.storage.savedQueue().count { it["n"] == "install_source" })
        val other = Phone()
        other.launch(referrer = { "gclid=abc" })
        assertTrue(other.storage.savedQueue().none { it["n"] == "install_source" })
    }

    // consent, dev mode

    @Test
    fun `opting out stops collection and is remembered`() {
        val phone = Phone()
        val c = phone.launch()
        c.optOut(); phone.settle()
        c.track("nope", null); c.flush(); phone.settle()
        assertTrue(phone.server.seen.isEmpty())
        val again = phone.launch()
        assertTrue(again.isOptedOut)
        again.track("still_nope", null); again.flush(); phone.settle()
        assertTrue(phone.server.seen.isEmpty())
        again.optIn(); again.track("yes", null); again.flush(); phone.settle()
        assertEquals(listOf("yes"), phone.server.names())
    }

    @Test
    fun `disabled stores and sends nothing`() {
        val phone = Phone()
        val c = phone.launch(Phone.config(disabled = true))
        c.track("x", null); c.flush(); phone.settle()
        assertNull(phone.storage.value)
        assertTrue(phone.server.bodies.isEmpty())
    }

    // errors

    @Test
    fun `a crash is saved before the app goes down, then sent on the next launch`() {
        val phone = Phone()
        phone.server.mode = FakeServer.Mode.OFFLINE
        val c = phone.launch()
        c.screen("exam/result", null)
        // What the uncaught-exception handler does: capture, then save right away on the crashing thread.
        c.captureError(IllegalStateException("score was null"), fatal = true, how = "crash", extra = null)
        c.persistNow()
        @Suppress("UNCHECKED_CAST")
        val p = phone.storage.savedQueue().single { it["n"] == "error" }["p"] as Map<String, Any?>
        assertEquals(true, p["fatal"]); assertEquals("crash", p["how"]); assertEquals("java.lang.IllegalStateException", p["type"])
        assertEquals("score was null", p["message"]); assertEquals("exam/result", p["screen"])
        assertTrue((p["stack"] as String).startsWith("java.lang.IllegalStateException: score was null\nat "))
        phone.server.mode = FakeServer.Mode.OK
        val nextPhone = Phone(phone.storage, phone.server, phone.now)
        nextPhone.launch().flush()
        nextPhone.settle()
        assertTrue(phone.server.names().contains("error"))
    }

    @Test
    fun `an error loop is capped per visit`() {
        val phone = Phone()
        val c = phone.launch()
        repeat(50) { c.captureError(RuntimeException("again"), false, "reported", null) }
        c.flush(); phone.settle()
        assertEquals(20, phone.server.names().count { it == "error" })
    }

    // RevenueCat-style lambda and the real HTTP path

    @Test
    fun `the real HTTP transport posts JSON and reads status and Retry-After`() {
        // A one-request HTTP server on a plain socket (com.sun.net.httpserver isn't on the Android test classpath).
        val socket = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        var got = ""
        var type = ""
        val t = thread {
            socket.accept().use { conn ->
                val input = conn.getInputStream().bufferedReader()
                var length = 0
                while (true) {
                    val line = input.readLine() ?: break
                    if (line.isEmpty()) break
                    val (k, v) = line.split(":", limit = 2).let { it[0].lowercase() to it.getOrElse(1) { "" }.trim() }
                    if (k == "content-length") length = v.toInt()
                    if (k == "content-type") type = v
                }
                got = CharArray(length).also { input.read(it, 0, length) }.concatToString()
                conn.getOutputStream().write("HTTP/1.1 429 Too Many Requests\r\nRetry-After: 7\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
            }
        }
        try {
            val res = HttpTransport().post("http://127.0.0.1:${socket.localPort}/i", "{\"a\":\"x\"}", 2000)
            assertEquals(429, res.status)
            assertEquals("7", res.retryAfter)
            t.join(2000)
            assertEquals("{\"a\":\"x\"}", got)
            assertEquals("application/json", type)
        } finally {
            socket.close()
        }
        var failed = false
        try { HttpTransport().post("http://127.0.0.1:1/i", "{}", 500) } catch (_: IOException) { failed = true }
        assertTrue(failed)
        assertFalse(got.isEmpty())
    }
}
