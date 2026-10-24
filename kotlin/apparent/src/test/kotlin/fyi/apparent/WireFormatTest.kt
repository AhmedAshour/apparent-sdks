package fyi.apparent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The batch must be what the Expo SDK sends (fixtures/expo-batch.json, made by fixtures/make-expo-fixture.ts). */
class WireFormatTest {
    private val hexId = Regex("^[0-9a-f]{32}$")

    /** Random ids → <id1>, <id2>… by first appearance; the stack is compared as "there is one". */
    private fun normalise(v: Any?, ids: MutableMap<String, String>): Any? = when (v) {
        is Map<*, *> -> v.entries.associate { (k, x) ->
            k as String to if (k == "stack" && x is String) "<stack>" else normalise(x, ids)
        }
        is List<*> -> v.map { normalise(it, ids) }
        is String -> if (hexId.matches(v)) ids.getOrPut(v) { "<id${ids.size + 1}>" } else v
        else -> v
    }

    @Test
    fun `the batch matches what the Expo SDK sends for the same session`() {
        val phone = Phone()
        val c = phone.launch()
        c.setProperties(linkedMapOf("plan" to "free", "language" to "de"))
        c.track("paywall_view", linkedMapOf("source" to "onboarding", "price" to 4.99, "count" to 3, "whole" to 2.0, "ok" to true, "none" to null, "long" to "x".repeat(600)))
        c.screen("home", null)
        c.screen("home", null)
        c.screen("practice/[topic]", mapOf("path" to "/practice/recht"))
        c.identify("user-42")
        c.track("purchase_success", mapOf("product" to "pro"))
        c.setProperties(mapOf("language" to null))
        c.track("after_unset", null)
        c.reset()
        c.track("after_logout", null)
        c.captureError(Throwable("boom"), fatal = false, how = "reported", extra = null, type = "Error")
        c.flush()
        phone.settle()

        assertEquals(1, phone.server.bodies.size)
        val fixture = Json.parse(File("../fixtures/expo-batch.json").readText()) as Map<*, *>
        val ours = phone.server.bodies[0]
        assertEquals(SDK_VERSION, ours["v"])
        val strip = { m: Map<*, *> -> m.filterKeys { it != "v" } }
        // Same keys in the same order, too: compare the written JSON, not just the maps.
        assertEquals(Json.write(normalise(strip(fixture), HashMap())), Json.write(normalise(strip(ours), HashMap())))
    }

    @Test
    fun `json writes like JSON stringify and reads back`() {
        val text = Json.write(linkedMapOf("s" to "a\"b\\c\n\u0001é", "w" to 2.0, "f" to 0.5, "n" to null, "l" to listOf(1, true), "nan" to Double.NaN))
        assertEquals("{\"s\":\"a\\\"b\\\\c\\n\\u0001é\",\"w\":2,\"f\":0.5,\"n\":null,\"l\":[1,true],\"nan\":null}", text)
        val back = Json.parse(text) as Map<*, *>
        assertEquals("a\"b\\c\n\u0001é", back["s"])
        assertEquals(2L, back["w"])
        assertEquals(0.5, back["f"])
    }

    @Test
    fun `values are cleaned like the Expo SDK`() {
        assertEquals(4.99, ApparentCore.cleanValue(4.99f))
        assertEquals("[1,2]", ApparentCore.cleanValue(listOf(1, 2)))
        assertEquals(null, ApparentCore.cleanValue(Double.POSITIVE_INFINITY))
        val many = (1..50).associate { "k$it" to it }
        assertEquals(40, ApparentCore.cleanProps(many)!!.size)
        assertEquals(64, ApparentCore.cleanProps(mapOf("x".repeat(100) to 1))!!.keys.first().length)
    }

    @Test
    fun `navigation routes become Expo router screen names`() {
        assertEquals("practice/[topic]", ApparentCore.screenNameForRoute("practice/{topic}?tab={tab}"))
        assertEquals("home", ApparentCore.screenNameForRoute(null))
        assertEquals("settings", ApparentCore.screenNameForRoute("/settings/"))
    }

    @Test
    fun `retry-after is read as seconds or a date, between 1 s and 1 h`() {
        assertEquals(5000L, ApparentCore.retryAfterMs("5", 0))
        assertEquals(1000L, ApparentCore.retryAfterMs("0", 0))
        assertEquals(3600_000L, ApparentCore.retryAfterMs("99999", 0))
        val now = 1_800_000_000_000L
        assertTrue(ApparentCore.retryAfterMs("Fri, 15 Jan 2027 08:00:30 GMT", now)!! in 1000L..3600_000L)
        assertEquals(null, ApparentCore.retryAfterMs("soon", now))
    }
}
