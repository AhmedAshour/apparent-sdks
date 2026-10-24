package fyi.apparent

import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * The sdk/conformance scenario (sdk/conformance/README.md) with the real HTTP sender, real threads and default
 * timers, against a running intake. `node sdk/conformance/check.ts <url>` judges it afterwards (../conformance.sh).
 */
class ConformanceRunTest {
    private val url = System.getProperty("apparent.conformance").orEmpty()

    /** [wait] = wait for the saved state first. Launch 2 doesn't: a real app tracks in its first milliseconds. */
    private fun launch(storage: MemStorage, wait: Boolean = true): Pair<ApparentCore, ExecutorScheduler> {
        val scheduler = ExecutorScheduler()
        val cfg = ApparentConfig(app = "conformance", key = "conformance-key", apiUrl = url, captureErrors = false)
        val core = ApparentCore(cfg, storage, HttpTransport(), scheduler, DEVICE + mapOf("model" to "sdk_gphone64_arm64", "simulator" to true))
        core.start(foreground = true)
        if (wait) core.awaitReady()
        return core to scheduler
    }

    private fun drain(c: ApparentCore, ms: Long = 60_000) {
        val end = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < end) {
            c.flush()
            if (c.pending == 0) return
            Thread.sleep(100)
        }
        throw AssertionError("queue never emptied")
    }

    @Test
    fun `the conformance scenario against a local intake`() {
        assumeTrue("set -PapparentConformance=<intake url> to run", url.isNotEmpty())
        val disk = MemStorage()

        val (one, s1) = launch(disk)
        one.screen("home", null)
        one.screen("home", null)
        one.screen("settings", null)
        one.track("conformance_step", linkedMapOf("step" to 1, "ok" to true, "ratio" to 1.5, "text" to "héllo wörld", "nothing" to null))
        one.setProperties(mapOf("plan" to "free"))
        one.identify("conformance-user")
        one.track("logged_in", null)
        for (n in 0 until 25) one.track("burst", mapOf("n" to n))
        one.captureError(Throwable("conformance test error"), fatal = false, how = "reported", extra = null)
        one.track("launch1_done", null)
        drain(one)
        s1.shutdown() // the app is killed

        val (two, s2) = launch(disk, wait = false)
        two.track("second_launch", null)
        two.reset()
        two.track("logged_out", null)
        two.track("launch2_done", null)
        drain(two)
        two.optOut()
        two.track("opted_out_event", null)
        two.flush()
        Thread.sleep(500)
        s2.shutdown()
    }
}
