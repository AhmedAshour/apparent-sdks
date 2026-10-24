package fyi.apparent.compose

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import fyi.apparent.Apparent

/**
 * Records a `screen_view` when this composable is shown (and again when [name] changes).
 *
 *     @Composable fun Paywall() { TrackScreen("paywall"); … }
 */
@Composable
fun TrackScreen(name: String, properties: Map<String, Any?>? = null) {
    LaunchedEffect(name) { Apparent.screen(name, properties) }
}

/**
 * Screens for a Jetpack Navigation app, without depending on Navigation: pass the current route.
 * `practice/{topic}` becomes `practice/[topic]`, the same name the Expo router gives.
 *
 *     val entry by navController.currentBackStackEntryAsState()
 *     TrackNavigation(entry?.destination?.route)
 */
@Composable
fun TrackNavigation(route: String?) {
    if (route == null) return
    val name = Apparent.screenNameForRoute(route)
    LaunchedEffect(name) { Apparent.screen(name) }
}
