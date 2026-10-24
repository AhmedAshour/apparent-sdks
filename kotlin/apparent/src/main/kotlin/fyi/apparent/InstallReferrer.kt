package fyi.apparent

import android.content.Context
import com.android.installreferrer.api.InstallReferrerClient
import com.android.installreferrer.api.InstallReferrerStateListener
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The Play install referrer, only when the app has `com.android.installreferrer:installreferrer` (an optional
 * dependency: without it this returns null and nothing else changes). Blocks up to 5 s; called on the io thread.
 */
internal object InstallReferrer {
    /** Without the library the first call throws NoClassDefFoundError, caught here. */
    fun read(context: Context): String? = try { readWithLibrary(context) } catch (_: Throwable) { null }

    private fun readWithLibrary(context: Context): String? {
        val client = InstallReferrerClient.newBuilder(context.applicationContext).build()
        val done = CountDownLatch(1)
        var referrer: String? = null
        client.startConnection(object : InstallReferrerStateListener {
            override fun onInstallReferrerSetupFinished(code: Int) {
                try {
                    if (code == InstallReferrerClient.InstallReferrerResponse.OK) referrer = client.installReferrer.installReferrer
                } catch (_: Throwable) {
                } finally {
                    done.countDown()
                }
            }

            override fun onInstallReferrerServiceDisconnected() { done.countDown() }
        })
        done.await(5, TimeUnit.SECONDS)
        try { client.endConnection() } catch (_: Throwable) {}
        return referrer
    }
}
