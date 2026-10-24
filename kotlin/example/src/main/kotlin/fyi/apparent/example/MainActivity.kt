package fyi.apparent.example

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import fyi.apparent.Apparent
import fyi.apparent.ApparentConfig
import fyi.apparent.compose.TrackScreen

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val conformance = intent.getStringExtra("apparentConformance")
        if (conformance != null) {
            // sdk/conformance scenario, run by ../conformance.sh: launch with --ei step 1, kill, then --ei step 2.
            Apparent.start(this, ApparentConfig(app = "conformance", key = "conformance-key", apiUrl = conformance, captureErrors = false, debug = true))
            val step = intent.getIntExtra("step", 1)
            Thread { if (step == 1) Conformance.launch1() else Conformance.launch2() }.start()
            setContent { MaterialTheme { Text("Apparent conformance, launch $step", Modifier.padding(24.dp)) } }
            return
        }
        // Real apps: in Application.onCreate.
        Apparent.start(this, ApparentConfig(app = "example", key = "example-key", apiUrl = BuildConfig.APPARENT_URL, debug = true))
        Apparent.setProperties(mapOf("plan" to "free"))
        // With RevenueCat: Apparent.linkRevenueCat { Purchases.sharedInstance.setAttributes(it) }
        setContent { MaterialTheme { ExampleScreen() } }
    }
}

private object Conformance {
    private fun waitUntilSent() {
        while (Apparent.pendingEvents > 0) {
            Apparent.flush()
            Thread.sleep(500)
        }
    }

    fun launch1() {
        Apparent.screen("home")
        Apparent.screen("home")
        Apparent.screen("settings")
        Apparent.track("conformance_step", linkedMapOf("step" to 1, "ok" to true, "ratio" to 1.5, "text" to "héllo wörld", "nothing" to null))
        Apparent.setProperties(mapOf("plan" to "free"))
        Apparent.identify("conformance-user")
        Apparent.track("logged_in")
        for (n in 0 until 25) Apparent.track("burst", mapOf("n" to n))
        Apparent.captureError("conformance test error")
        Apparent.track("launch1_done")
        Apparent.flush()
        // Stays open; the runner kills the app once launch1_done has arrived.
    }

    fun launch2() {
        Apparent.track("second_launch")
        Apparent.logout()
        Apparent.track("logged_out")
        Apparent.track("launch2_done")
        Apparent.flush()
        Thread.sleep(300)
        waitUntilSent()
        Apparent.optOut()
        Apparent.track("opted_out_event")
        Apparent.flush()
    }
}

@Composable
private fun ExampleScreen() {
    var screen by remember { mutableStateOf("home") }
    TrackScreen(screen)
    Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Apparent example: $screen", style = MaterialTheme.typography.titleLarge)
        Text("id ${Apparent.anonymousId}")
        Button(onClick = { screen = if (screen == "home") "paywall" else "home" }) { Text("Switch screen") }
        Button(onClick = { Apparent.track("paywall_view", mapOf("source" to "example")) }) { Text("Track paywall_view") }
        Button(onClick = { Apparent.trackPurchase("pro_yearly", 29.99, "EUR") }) { Text("Track a purchase") }
        Button(onClick = { Apparent.identify("user-42") }) { Text("Sign in as user-42") }
        Button(onClick = { Apparent.logout() }) { Text("Sign out") }
        Button(onClick = { Apparent.flush() }) { Text("Send now") }
        Button(onClick = { throw IllegalStateException("Example crash") }) { Text("Crash (sent next launch)") }
    }
}
