package fyi.apparent

import android.content.Context
import android.os.Build
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ThreadFactory
import java.util.concurrent.TimeUnit

/** The saved state as one file in `noBackupFilesDir`, so a phone restored from a backup counts as a new install. */
internal class FileStorage(context: Context) : ApparentStorage {
    private val dir = File(context.noBackupFilesDir, "apparent")
    private val file = File(dir, "state-v2.json")

    override fun read(): String? = if (file.exists()) file.readText() else null

    override fun write(value: String) {
        dir.mkdirs()
        val tmp = File(dir, "state-v2.json.tmp")
        tmp.writeText(value)
        if (!tmp.renameTo(file)) {
            file.delete()
            if (!tmp.renameTo(file)) throw IOException("could not save ${file.path}")
        }
    }
}

internal class HttpTransport : ApparentTransport {
    override fun post(url: String, body: String, timeoutMs: Int): ApparentTransport.Response {
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = "POST"
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.doOutput = true
            conn.useCaches = false
            conn.setRequestProperty("content-type", "application/json")
            val bytes = body.toByteArray(Charsets.UTF_8)
            conn.setFixedLengthStreamingMode(bytes.size)
            conn.outputStream.use { it.write(bytes) }
            val status = conn.responseCode
            // Read the answer so the connection can be reused.
            try { (if (status >= 400) conn.errorStream else conn.inputStream)?.use { it.readBytes() } } catch (_: IOException) {}
            return ApparentTransport.Response(status, conn.getHeaderField("retry-after"))
        } finally {
            conn.disconnect()
        }
    }
}

internal class ExecutorScheduler : Scheduler {
    private fun factory(name: String) = ThreadFactory { r -> Thread(r, name).apply { isDaemon = true } }
    private val io: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor(factory("apparent-io"))
    private val net = Executors.newSingleThreadExecutor(factory("apparent-net"))

    override fun io(delayMs: Long, task: () -> Unit): Scheduler.Cancellable {
        val f = io.schedule({ runSafely(task) }, delayMs, TimeUnit.MILLISECONDS)
        return Scheduler.Cancellable { f.cancel(false) }
    }

    override fun net(task: () -> Unit) { net.execute { runSafely(task) } }

    override fun every(periodMs: Long, task: () -> Unit) {
        io.scheduleWithFixedDelay({ runSafely(task) }, periodMs, periodMs, TimeUnit.MILLISECONDS)
    }

    /** Stop the threads (tests: a second "launch" in the same process). */
    fun shutdown() { io.shutdownNow(); net.shutdownNow() }

    private fun runSafely(task: () -> Unit) = try { task() } catch (_: Throwable) { /* never take the app down */ }
}

/** platform, os, app, build, model, locale, region, tz: the Expo SDK's `d` fields, in its order; plus
 *  `simulator = true` in an emulator only (left out on real phones, so their batches stay the same). */
internal fun readDevice(context: Context): Map<String, Any?> {
    var version: String? = null
    var build: String? = null
    try {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        version = info.versionName
        @Suppress("DEPRECATION")
        build = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode.toString() else info.versionCode.toString()
    } catch (_: Throwable) { /* unknown */ }
    val locale = Locale.getDefault()
    return linkedMapOf<String, Any?>(
        "platform" to "android",
        "os" to Build.VERSION.SDK_INT.toString(),
        "app" to version,
        "build" to build,
        "model" to Build.MODEL?.takeIf { it.isNotEmpty() },
        "locale" to locale.toLanguageTag().takeIf { it.isNotEmpty() && it != "und" },
        "region" to locale.country.takeIf { it.isNotEmpty() },
        "tz" to TimeZone.getDefault().id,
    ).apply { if (isEmulator()) put("simulator", true) }
}

/** Android's emulators (the SDK's own images, Google Play images, Genymotion), from what Build says about the phone. */
internal fun isEmulator(
    fingerprint: String? = Build.FINGERPRINT, model: String? = Build.MODEL, hardware: String? = Build.HARDWARE,
    product: String? = Build.PRODUCT, manufacturer: String? = Build.MANUFACTURER, brand: String? = Build.BRAND, device: String? = Build.DEVICE,
): Boolean = try {
    val fp = fingerprint.orEmpty().lowercase()
    val m = model.orEmpty().lowercase()
    val hw = hardware.orEmpty().lowercase()
    val pr = product.orEmpty().lowercase()
    hw == "goldfish" || hw == "ranchu" || hw.contains("vbox86") ||
        fp.startsWith("generic") || fp.contains("/sdk_gphone") || fp.contains(":emu") || fp.contains("emulator") ||
        m.contains("emulator") || m.contains("android sdk built for") || m.startsWith("sdk_gphone") ||
        pr.startsWith("sdk_") || pr == "sdk" || pr.contains("emulator") || pr.contains("simulator") || pr.contains("vbox86p") ||
        manufacturer.orEmpty().contains("Genymotion") ||
        (brand.orEmpty().startsWith("generic") && device.orEmpty().startsWith("generic"))
} catch (_: Throwable) {
    false
}
