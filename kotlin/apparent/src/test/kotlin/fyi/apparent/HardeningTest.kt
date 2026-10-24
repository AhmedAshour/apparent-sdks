package fyi.apparent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.math.BigInteger
import java.util.Date
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The edge cases the Expo SDK's hardening suite (sdk/expo/test/hardening.test.ts) covers, which PostHog, Amplitude,
 * Segment, Mixpanel and RudderStack test in their own SDKs. Each is a MUST in sdk/SPEC.md.
 */
class HardeningTest {
    private fun named(phone: Phone, n: String) = phone.server.seen.values.filter { it["n"] == n }
    private fun flat(v: Any?) = v == null || v is String || v is Number || v is Boolean

    // ---- saved right away (SPEC 2.3) ----

    @Test
    fun `a sign-in is on disk right away, so a kill just after it keeps the user`() {
        val phone = Phone()
        val c = phone.launch()
        c.identify("user-1")
        phone.scheduler.runImmediate() // what is saved before a kill 10 ms later; the 250 ms debounce never ran
        assertEquals("user-1", phone.storage.saved()["userId"])
    }

    @Test
    fun `a logout is on disk right away, so a kill just after it never brings the old user back`() {
        val phone = Phone()
        val c = phone.launch()
        c.identify("user-1")
        phone.settle()
        val before = c.anonymousId
        c.reset()
        phone.scheduler.runImmediate()
        assertNull(phone.storage.saved()["userId"])
        assertTrue(phone.storage.saved()["anon"] != before)
        val again = phone.launch()
        assertNull(again.currentUserId)
    }

    @Test
    fun `identify(null) as a logout is on disk right away too`() {
        val phone = Phone()
        val c = phone.launch()
        c.identify("user-1")
        phone.settle()
        c.identify(null)
        phone.scheduler.runImmediate()
        assertNull(phone.storage.saved()["userId"])
    }

    @Test
    fun `opting out and back in is on disk right away`() {
        val phone = Phone()
        val c = phone.launch()
        c.optOut()
        phone.scheduler.runImmediate()
        assertEquals(true, phone.storage.saved()["optedOut"])
        c.optIn()
        phone.scheduler.runImmediate()
        assertEquals(false, phone.storage.saved()["optedOut"])
    }

    // ---- broken saved state (SPEC 4) ----

    private fun brokenCases(now: Long): List<Pair<String, String>> = listOf(
        "not JSON" to "{not json",
        "a number" to "5",
        "null" to "null",
        "an array" to "[]",
        "fields of the wrong type" to """{"v":2,"anon":123,"anonSource":7,"userId":5,"props":"str","optedOut":"false","queue":"x","app":7}""",
        "a queue with junk in it" to """{"v":2,"anon":"kept-anon","userId":null,"props":{"plan":"pro","bad":{"nested":1}},"optedOut":false,"app":null,
            "queue":[null,5,"x",{"n":7},{"n":"saved_event","t":${now - 1000},"s":"s1","i":"saved-id-1","a":"kept-anon","u":null},{"n":"no_ids","t":${now - 1000}}]}""",
    )

    @Test
    fun `saved state that is broken starts cleanly and keeps working`() {
        for ((what, raw) in brokenCases(1_800_000_000_000L)) {
            val phone = Phone()
            phone.storage.value = raw
            val c = phone.launch()
            c.track("after_corrupt", mapOf("ok" to true))
            c.flush(); phone.settle()
            val e = named(phone, "after_corrupt").singleOrNull()
            assertTrue("$what: the new event arrived", e != null)
            assertTrue("$what: anon is a string", (e!!["anon"] as? String).orEmpty().isNotEmpty())
            assertTrue("$what: user is a string or null", e["user"] == null || e["user"] is String)
            assertFalse("$what: a saved \"false\" string is not an opt-out", c.isOptedOut)
            for (sent in phone.server.seen.values) {
                assertTrue("$what: ${sent["n"]} has an insert id", (sent["i"] as? String).orEmpty().isNotEmpty())
                assertTrue("$what: ${sent["n"]} has a session", (sent["s"] as? String).orEmpty().isNotEmpty())
                @Suppress("UNCHECKED_CAST")
                val p = sent["p"] as Map<String, Any?>?
                if (p != null) assertTrue("$what: ${sent["n"]} has flat props: $p", p.values.all { flat(it) })
            }
            assertEquals("$what: the state on disk is valid again", 2L, phone.storage.saved()["v"])
            assertTrue(phone.storage.saved()["queue"] is List<*>)
            if (what == "a queue with junk in it") {
                assertEquals("the good saved event still went out", 1, named(phone, "saved_event").size)
                assertEquals("an event without ids is dropped", 0, named(phone, "no_ids").size)
                assertEquals("the good saved id is kept", "kept-anon", e["anon"])
            }
        }
    }

    // ---- storage that fails (SPEC 4) ----

    private fun core(phone: Phone, storage: ApparentStorage) =
        ApparentCore(Phone.config(), storage, phone.server, phone.scheduler, DEVICE, clock = { phone.now }, monotonic = { phone.mono })

    private fun keepsWorking(phone: Phone, c: ApparentCore) {
        c.start(true)
        phone.settle()
        c.track("still_works", null)
        c.identify("u1")
        c.setProperties(mapOf("plan" to "pro"))
        c.track("still_works_2", null)
        c.flush(); phone.settle()
        c.reset(); c.optOut(); c.optIn()
        c.track("still_works_3", null)
        c.flush(); phone.settle()
        for (n in listOf("still_works", "still_works_2", "still_works_3")) assertEquals("$n arrived", 1, named(phone, n).size)
    }

    @Test
    fun `storage that throws on read keeps working in memory`() {
        val phone = Phone()
        keepsWorking(phone, core(phone, object : ApparentStorage {
            override fun read(): String? = throw IOException("read")
            override fun write(value: String) {}
        }))
    }

    @Test
    fun `storage that throws on write keeps working in memory`() {
        val phone = Phone()
        keepsWorking(phone, core(phone, object : ApparentStorage {
            override fun read(): String? = null
            override fun write(value: String) = throw IOException("disk full")
        }))
    }

    @Test(timeout = 20_000)
    fun `storage that never finishes a write doesn't hold ready or sending`() {
        val phone = Phone()
        val never = CountDownLatch(1)
        try {
            val c = core(phone, object : ApparentStorage {
                override fun read(): String? = null
                override fun write(value: String) { never.await(60, TimeUnit.SECONDS) }
            })
            val started = System.currentTimeMillis()
            keepsWorking(phone, c)
            assertTrue(c.awaitReady(0))
            assertTrue("took ${System.currentTimeMillis() - started} ms", System.currentTimeMillis() - started < 10_000)
        } finally {
            never.countDown()
        }
    }

    // ---- clocks that jump (SPEC 1.6) ----

    @Test
    fun `the phone's clock jumping back a day during a retry wait doesn't strand the queue`() {
        val phone = Phone()
        val c = phone.launch()
        c.flush(); phone.settle()
        phone.server.mode = FakeServer.Mode.E500
        c.track("waiting", null)
        c.flush(); phone.settle()
        phone.server.mode = FakeServer.Mode.OK
        phone.jumpClock(-86_400_000)
        phone.now += 3_000 // more than the first wait (2 s + 20 %)
        c.flush(); phone.settle()
        assertEquals("sent within the normal wait, not a day later", 1, named(phone, "waiting").size)
    }

    @Test
    fun `the clock jumping back during a Retry-After wait doesn't stretch it past the server's wait`() {
        val phone = Phone()
        val c = phone.launch()
        c.flush(); phone.settle()
        phone.server.mode = FakeServer.Mode.E429
        phone.server.retryAfter = "1"
        c.track("waiting", null)
        c.flush(); phone.settle()
        phone.server.mode = FakeServer.Mode.OK
        phone.jumpClock(-3_600_000)
        phone.now += 1_100
        c.flush(); phone.settle()
        assertEquals(1, named(phone, "waiting").size)
    }

    @Test
    fun `the clock jumping forward a day just retries sooner, nothing is dropped`() {
        val phone = Phone()
        val c = phone.launch()
        c.flush(); phone.settle()
        phone.server.mode = FakeServer.Mode.E500
        c.track("waiting", null)
        c.flush(); phone.settle()
        phone.server.mode = FakeServer.Mode.OK
        phone.jumpClock(86_400_000)
        c.flush(); phone.settle()
        assertEquals(1, named(phone, "waiting").size)
    }

    // ---- Retry-After exactly, no jitter (SPEC 1.6) ----

    /** After one 429 with [header]: not sent [waitMs] - 1 ms later, sent at [waitMs]. Many times, so jitter would show. */
    private fun waitsExactly(header: String, waitMs: Long, tries: Int = 20) {
        repeat(tries) {
            val phone = Phone()
            val c = phone.launch()
            c.flush(); phone.settle()
            phone.server.mode = FakeServer.Mode.E429
            phone.server.retryAfter = header
            c.track("x", null)
            c.flush(); phone.settle()
            phone.server.mode = FakeServer.Mode.OK
            phone.now += waitMs - 1
            c.flush(); phone.settle()
            assertEquals("Retry-After $header: never sooner than the server asked (try $it)", 0, named(phone, "x").size)
            phone.now += 1
            c.flush(); phone.settle()
            assertEquals("Retry-After $header: right when the wait is over (try $it)", 1, named(phone, "x").size)
        }
    }

    @Test
    fun `a Retry-After of 2 seconds is waited in full, never less, never more`() = waitsExactly("2", 2_000)

    @Test
    fun `a Retry-After of more than an hour is cut to an hour`() = waitsExactly("7200", 3_600_000, tries = 5)

    @Test
    fun `a Retry-After of zero or less becomes 1 s`() { waitsExactly("0", 1_000, tries = 5); waitsExactly("-5", 1_000, tries = 5) }

    @Test
    fun `a garbage Retry-After falls back to the normal backoff`() {
        val phone = Phone()
        val c = phone.launch()
        c.flush(); phone.settle()
        phone.server.mode = FakeServer.Mode.E429
        phone.server.retryAfter = "soon-ish"
        c.track("x", null)
        c.flush(); phone.settle()
        phone.server.mode = FakeServer.Mode.OK
        phone.now += 2_400
        c.flush(); phone.settle()
        assertEquals(1, named(phone, "x").size)
    }

    // ---- properties that aren't plain values (SPEC 3.3, 6) ----

    @Test
    fun `circular lists, big integers, functions, dates, NaN and values that can't be printed never throw`() {
        val phone = Phone()
        val c = phone.launch()
        val loop = ArrayList<Any?>().apply { add(1) }
        loop.add(loop)
        val deep = HashMap<String, Any?>().apply { put("me", this) }
        val unprintable = object { override fun toString(): String = throw IllegalStateException("no") }
        c.track("weird", linkedMapOf(
            "loop" to loop, "deep" to deep, "big" to BigInteger("123456789012345678901234567890"), "fn" to { 1 },
            "date" to Date(0), "nan" to Double.NaN, "inf" to Float.NEGATIVE_INFINITY, "unprintable" to unprintable,
            "char" to 'x', "ok" to "fine",
        ))
        c.setProperties(mapOf("loop" to loop))
        c.flush(); phone.settle()
        @Suppress("UNCHECKED_CAST")
        val p = named(phone, "weird").single()["p"] as Map<String, Any?>
        assertTrue("flat: $p", p.values.all { flat(it) })
        assertEquals("123456789012345678901234567890", p["big"])
        assertEquals("1970-01-01T00:00:00.000Z", p["date"])
        assertFalse("functions are left out", p.containsKey("fn"))
        assertTrue(p.containsKey("nan") && p["nan"] == null)
        assertNull(p["inf"])
        assertNull(p["unprintable"])
        assertEquals("fine", p["ok"])
        assertEquals("x", p["char"])
    }

    @Test
    fun `a properties map that throws when read never throws into the app`() {
        val phone = Phone()
        val c = phone.launch()
        val throwing = object : AbstractMap<String, Any?>() {
            override val entries: Set<Map.Entry<String, Any?>> get() = throw IllegalStateException("boom")
        }
        c.track("with_bad_props", throwing)
        c.screen("home", throwing)
        c.setProperties(throwing)
        c.captureError(Throwable("x"), fatal = false, how = "reported", extra = throwing)
        @Suppress("UNCHECKED_CAST")
        val nullKeys = hashMapOf<String?, Any?>(null to 1, "k" to 2) as Map<String, Any?>
        c.track("null_key", nullKeys)
        c.flush(); phone.settle()
        assertEquals(1, named(phone, "with_bad_props").size)
        assertEquals(1, named(phone, "screen_view").size)
        assertEquals(1, named(phone, "error").size)
        assertEquals(2L, (named(phone, "null_key").single()["p"] as Map<*, *>)["k"])
    }

    // ---- event names (SPEC 3.3) ----

    @Test
    fun `blank names are ignored, long names are cut to 80, emoji and spaces are kept`() {
        val phone = Phone()
        val c = phone.launch()
        c.track("", null)
        c.track("   ", null)
        c.screen(" ", null)
        c.track("x".repeat(100), null)
        c.track("Café 🎉 time", null)
        c.flush(); phone.settle()
        assertEquals(listOf("first_open", "app_open", "x".repeat(80), "Café 🎉 time"), phone.server.names())
    }

    // ---- bad settings (SPEC 6) ----

    @Test
    fun `settings out of range never break saving or sending`() {
        val phone = Phone()
        val cfg = ApparentConfig(app = "einb", key = "k_test", apiUrl = "https://apparent.test", maxQueue = -5, flushAt = 0,
            flushIntervalMs = 0, requestTimeoutMs = -1, retryBaseMs = -1, sessionTimeoutMinutes = -3, captureErrors = false)
        val c = phone.launch(cfg)
        c.track("still_saved", null)
        phone.settle()
        assertTrue(phone.storage.savedQueue().isNotEmpty() || phone.server.names().contains("still_saved"))
        c.flush(); phone.settle()
        assertTrue(phone.server.names().contains("still_saved"))
    }
}
