package fyi.apparent

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Links, tapped notifications, beforeSend and consent first: the Expo SDK's sdk/expo/test/features.test.ts. */
class FeaturesTest {
    private fun named(phone: Phone, n: String) = phone.server.seen.values.filter { it["n"] == n }

    private fun config(
        trackDeepLinks: Boolean = true, trackPushOpens: Boolean = true,
        beforeSend: ((ApparentEvent) -> ApparentEvent?)? = null, optOutByDefault: Boolean = false,
    ) = Phone.config().copy(trackDeepLinks = trackDeepLinks, trackPushOpens = trackPushOpens, beforeSend = beforeSend, optOutByDefault = optOutByDefault)

    // ---- deep_link_opened ----

    @Test
    fun `a link that opens the app is sent as deep_link_opened, with its campaign and without secrets`() {
        val phone = Phone()
        val c = phone.launch(config())
        c.deepLinkOpened("myapp://reset?token=abc123&utm_source=newsletter&utm_campaign=spring%20sale&lang=de#access_token=xyz&x=1")
        c.deepLinkOpened("https://user:pw@example.com/p/7?code=999&utm_medium=email")
        c.flush(); phone.settle()
        val links = named(phone, "deep_link_opened")
        assertEquals(2, links.size)
        assertEquals(mapOf(
            "url" to "myapp://reset?token=[redacted]&utm_source=newsletter&utm_campaign=spring%20sale&lang=de#access_token=[redacted]&x=1",
            "utm_source" to "newsletter", "utm_campaign" to "spring sale",
        ), links[0]["p"])
        assertEquals(mapOf("url" to "https://example.com/p/7?code=[redacted]&utm_medium=email", "utm_medium" to "email"), links[1]["p"])
    }

    @Test
    fun `trackDeepLinks false sends no deep_link_opened`() {
        val phone = Phone()
        val c = phone.launch(config(trackDeepLinks = false))
        c.deepLinkOpened("myapp://other")
        c.flush(); phone.settle()
        assertEquals(0, named(phone, "deep_link_opened").size)
    }

    @Test
    fun `cleanDeepLink - long links are cut, links without a query stay as they are`() {
        assertEquals("myapp://home", ApparentCore.cleanDeepLink("myapp://home")["url"])
        assertEquals(500, (ApparentCore.cleanDeepLink("https://a.example/?q=${"x".repeat(900)}")["url"] as String).length)
        assertEquals("myapp://x?api_key=[redacted]&password=[redacted]&session_id=[redacted]&ok=4",
            ApparentCore.cleanDeepLink("myapp://x?api_key=1&password=2&session_id=3&ok=4")["url"])
    }

    // ---- push_opened ----

    @Test
    fun `push_opened - once per tap, campaign and title from the data only`() {
        val phone = Phone()
        val c = phone.launch(config())
        c.pushOpened(mapOf("campaign" to "fajr", "title" to "Fajr reminder", "secret" to "x", "body" to "Ahmed, private"), "n1")
        c.pushOpened(mapOf("campaign" to "fajr"), "n1") // the same tap reported twice
        c.pushOpened(mapOf("utm_campaign" to "weekly"), "n2")
        c.flush(); phone.settle()
        val pushes = named(phone, "push_opened")
        assertEquals(listOf(mapOf("campaign" to "fajr", "title" to "Fajr reminder"), mapOf("campaign" to "weekly")), pushes.map { it["p"] ?: emptyMap<String, Any?>() })
        assertFalse(pushes.toString().contains("private"))
    }

    @Test
    fun `trackPushOpens false ignores taps`() {
        val phone = Phone()
        val c = phone.launch(config(trackPushOpens = false))
        c.pushOpened(mapOf("campaign" to "x"), "n9")
        c.flush(); phone.settle()
        assertEquals(0, named(phone, "push_opened").size)
    }

    // ---- beforeSend ----

    @Test
    fun `beforeSend can change an event, drop it, and a hook that throws keeps it`() {
        val phone = Phone()
        var calls = 0
        val c = phone.launch(config(beforeSend = { e ->
            calls++
            when {
                e.name == "secret_thing" -> null
                e.name == "boom" -> throw IllegalStateException("hook bug")
                e.properties?.containsKey("email") == true -> e.copy(properties = e.properties.filterKeys { it != "email" } + ("cleaned" to true))
                else -> e
            }
        }))
        c.track("signed_up", mapOf("email" to "a@b.c", "plan" to "pro"))
        c.track("secret_thing", mapOf("x" to 1))
        c.track("boom", mapOf("y" to 2))
        c.flush(); phone.settle()
        assertEquals(mapOf("plan" to "pro", "cleaned" to true), named(phone, "signed_up").single()["p"])
        assertEquals(0, named(phone, "secret_thing").size)
        assertEquals(mapOf("y" to 2L), named(phone, "boom").single()["p"])
        assertTrue("automatic events go through it too", phone.server.names().contains("app_open") && calls > 3)
    }

    @Test
    fun `beforeSend also sees events tracked before the saved state was read`() {
        val phone = Phone()
        val first = phone.launch(config())
        first.setProperties(mapOf("email" to "a@b.c"))
        phone.settle()
        val c = ApparentCore(config(beforeSend = { e -> e.copy(properties = e.properties?.filterKeys { it != "email" }) }),
            phone.storage, phone.server, phone.scheduler, DEVICE, clock = { phone.now }, monotonic = { phone.mono })
        c.start(true)
        c.track("early_event", mapOf("a" to 1)) // before the saved state is read: the saved email isn't known yet
        phone.settle()
        c.flush(); phone.settle()
        assertEquals("the saved email was added back, then removed by the hook", mapOf("a" to 1L), named(phone, "early_event").single()["p"])
    }

    // ---- consent first ----

    @Test
    fun `optOutByDefault - nothing until optIn, then remembered, optOut later is remembered too`() {
        val phone = Phone()
        val c = phone.launch(config(optOutByDefault = true))
        c.track("before_consent", null)
        c.flush(); phone.settle()
        assertEquals("not even first_open or app_open", 0, phone.server.bodies.size)
        assertTrue(c.isOptedOut)
        c.optIn()
        c.track("after_consent", null)
        c.flush(); phone.settle()
        assertEquals(listOf("after_consent"), phone.server.names())

        val again = phone.launch(config(optOutByDefault = true))
        assertFalse("consent is remembered on the next launch", again.isOptedOut)
        again.optOut()
        phone.settle()
        val third = phone.launch(config(optOutByDefault = true))
        assertTrue(third.isOptedOut)
    }

    @Test
    fun `optIn before the saved state is read wins, apps without optOutByDefault save exactly what they did before`() {
        val phone = Phone()
        val c = ApparentCore(config(optOutByDefault = true), phone.storage, phone.server, phone.scheduler, DEVICE, clock = { phone.now }, monotonic = { phone.mono })
        c.start(true)
        c.optIn()
        phone.settle()
        assertFalse(c.isOptedOut)

        val plain = Phone()
        plain.launch()
        assertFalse("no new key in the saved state unless optIn() was called", plain.storage.saved().containsKey("consent"))
    }

    @Test
    fun `every field the SDK saves survives a relaunch`() {
        val phone = Phone()
        val c = phone.launch(config(optOutByDefault = true))
        c.optIn()
        c.identify("user-keep")
        c.setProperties(mapOf("plan" to "pro"))
        phone.settle()
        val first = phone.storage.saved()
        assertEquals(true, first["consent"])
        phone.launch(config(optOutByDefault = true))
        val second = phone.storage.saved()
        for (key in first.keys) if (key != "queue") assertEquals("\"$key\" survives a relaunch", first[key], second[key])
    }

    // ---- start ----

    @Test
    fun `a config without an app id, key or address is not usable, so start ignores it`() {
        assertFalse(ApparentConfig(app = "", key = "k").isUsable)
        assertFalse(ApparentConfig(app = "einb", key = "  ").isUsable)
        assertFalse(ApparentConfig(app = "einb", key = "k", apiUrl = "").isUsable)
        assertTrue(ApparentConfig(app = "einb", key = "k").isUsable)
    }
}
