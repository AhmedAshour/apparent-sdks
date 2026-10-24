# Apparent for Android (Kotlin)

Product events for your Apparent dashboard from a native Android app. Same behaviour and wire format as the Expo SDK
(`sdk/expo`): one random install id, the signed-in user when you set one, screens, properties, crashes, an offline
queue, opt-out. No advertising id, no Google Play services, no dependencies. minSdk 24, about 65 KB.

## Install

On Maven Central (`mavenCentral()` is in every new Android project's repositories):

```kotlin
// app/build.gradle.kts
implementation("fyi.apparent:apparent-android:0.2.1")
implementation("fyi.apparent:apparent-compose:0.2.1")   // only with Compose: TrackScreen("home")
implementation("com.android.installreferrer:installreferrer:2.2")   // optional: which link brought each install
```

## Quick start

```kotlin
class MyApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Apparent.start(this, app = "einb", key = "<write key>", disabled = BuildConfig.DEBUG)
    }
}

Apparent.track("paywall_view", mapOf("source" to "onboarding"))
Apparent.setProperties(mapOf("language" to "de", "plan" to "free"))   // on every event; null removes one
Apparent.identify(user.id)   // signed in (the install id stays the same)
Apparent.logout()            // signed out: new anonymous id
Apparent.linkRevenueCat { Purchases.sharedInstance.setAttributes(it) }   // purchases join to what people did
```

Screens with Compose (`apparent-compose`):

```kotlin
@Composable fun Paywall() { TrackScreen("paywall"); … }

// Jetpack Navigation, without a Navigation dependency: "practice/{topic}" → "practice/[topic]"
val entry by navController.currentBackStackEntryAsState()
TrackNavigation(entry?.destination?.route)
```

Without Compose: `Apparent.screen("paywall")`, or `ApparentConfig(…, trackActivities = true)` for one screen per Activity.

More: `Apparent.start(this, ApparentConfig(app, key, debug = true, userId = …, anonymousId = { … }))`,
`Apparent.captureError(e)` for errors you caught, `Apparent.trackPurchase("pro_yearly", 29.99, "EUR")` from Play
Billing's `onPurchasesUpdated` when you don't use RevenueCat, `Apparent.optOut()` / `optIn()` (remembered),
`Apparent.flush()`. Calls from any thread; nothing blocks the main thread.

Automatic: `first_open`, `app_open` (each visit; not for launches by a push or a background job), `app_updated`,
`app_background` (seconds in the app), `install_source` (Play referrer, with the optional library), `error` with
`fatal: true, how: "crash"` for uncaught exceptions (saved before the app goes down, sent on the next launch),
`deep_link_opened` and `push_opened` (below).

## Links, notifications, your own filter, consent

```kotlin
// The link or Firebase tap that launched an Activity is seen on its own. For the ones that bring it back:
override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); Apparent.handleIntent(intent) }

Apparent.trackDeepLink(url)                                    // links you route yourself
Apparent.trackPushOpened(message.data, message.messageId)      // notifications you show yourself (foreground FCM, local)

Apparent.start(this, ApparentConfig(app, key,
    beforeSend = { e -> if (e.name == "debug_tap") null else e.copy(properties = e.properties?.minus("email")) },
    optOutByDefault = true,   // nothing collected until Apparent.optIn(); remembered
))
```

- `deep_link_opened`: an `ACTION_VIEW` link (App Link or your scheme) that opens the app: `url` with every query or
  fragment parameter named like `token`, `code`, `password`, `secret`, `key`, `auth`, `session`, `sig` replaced by
  `[redacted]` and any `user:password@` removed, plus `utm_source` / `utm_medium` / `utm_campaign` when the link has
  them. A first-day link with `utm_source` counts as where that install came from. Off: `trackDeepLinks = false`.
- `push_opened`: a tapped notification, one per tap (deduped by its id). A Firebase notification tapped while the app
  is in the background opens it with the data as extras (and `google.message_id`), so that is seen with no code. Only
  `campaign` (else `utm_campaign`) and `title` from the **data** are sent, never the shown title or the body. Off:
  `trackPushOpens = false`. No Firebase dependency.
- `beforeSend`: runs on every event (automatic ones too, and early ones again once the saved properties are added)
  after its properties are cleaned. Return it changed, or `null` to drop it. A hook that throws keeps the event.
- `optOutByDefault = true`: nothing is stored or sent until `optIn()`, on later launches too; `optIn()` is saved
  (`"consent": true` in the state), `optOut()` stops it again.

## What it promises

Every event is on disk within 250 ms and before it is sent; `identify`, `logout`/`reset`, `optOut` and `optIn` are
saved at once, so a kill right after a sign-in or a sign-out keeps it. One request at a time, 100 events at most, and a
batch leaves the queue only once the server has it. 10 s time limit; retries back off from 2 s to 5 min (±20 %), and a
`Retry-After` is waited exactly (1 s to 1 h, no jitter, never sooner). Waits run on a clock that only goes forward, so
the phone's clock going back never strands the queue (forward just ends the wait sooner). Too-large batches are split,
refused ones dropped. Up to 1,000 events wait offline for a week. The
state lives in `noBackupFilesDir`, so a phone restored from a backup is a new install. R8 rules come with the library.

Test phones: in an Android emulator (`Build.HARDWARE` goldfish/ranchu, an `sdk_*` product, a `generic` fingerprint,
Genymotion…) every batch says `"simulator": true` in `d`, so Apparent leaves it out of your numbers whatever the model
is called; real phones never send the key. A wrong app id or key (the server answers 401) is said once per launch in
debug builds (or with `debug = true`) as `Apparent: app id or key is wrong — events are not being saved` (Logcat tag
`Apparent`); those events are dropped, since sending them again can't fix a key. Events tracked in the first
milliseconds after `start`, before the saved state is read, still get the saved user and properties, and a `logout()`
in that moment stays a logout.

Never throws into the app: a `start` without an app id, key or address is ignored (a Logcat warning; a later correct
one works), settings of 0 or less fall back to the defaults, and property values are always made flat (dates as ISO
time, big integers as digits, functions left out, a list that holds itself or a `toString()` that throws → `null`; a
map that throws when read counts as empty). Blank event and screen names are ignored, longer ones cut to 80. Saved
state is read field by field: a broken file, wrong-typed fields or junk in the queue keep what is valid and saving
goes on. A disk write that takes more than a second no longer holds sending or the saved-state read.

Tests: `./gradlew :apparent:testDebugUnitTest` (JDK 17, `ANDROID_HOME` set). `HardeningTest` and `FeaturesTest`
mirror the Expo SDK's `hardening.test.ts` and `features.test.ts`. `fixtures/expo-batch.json` is what the Expo SDK sends for a
scripted session (`fixtures/make-expo-fixture.ts`); the test checks the Kotlin SDK sends the same bytes.
Example app: `./gradlew :example:assembleDebug` (sends to a local Apparent at `http://10.0.2.2:4216`).
Conformance (`sdk/SPEC.md`, `sdk/conformance`): `./conformance.sh` runs the scenario on the JVM against the local
intake (`PORT=4302 ./conformance.sh` for another port), `./conformance.sh --device` runs the example app on an emulator (`am start … --es apparentConformance
http://10.0.2.2:4299 --ei step 1`, then `step 2`). Both pass all the rules (27 on the JVM, 2026-10-24); launch 2 tracks and logs out without waiting for the saved state.

Differences from the spec's suggestions, on purpose: the state is one file in `noBackupFilesDir` (not
SharedPreferences, which Auto Backup would copy to a new phone); no WorkManager for the last send on background (the
process normally lives long enough; the queue is saved either way and goes out on the next launch).

## Play Console: Data safety answers

| Question | Answer |
|---|---|
| Does your app collect or share user data? | Yes, collects. Not shared: Apparent processes it for you. |
| Is all data encrypted in transit? | Yes (HTTPS). |
| Can users ask for their data to be deleted? | Yes, if your app gives a way (Apparent deletes on request). |
| **App activity → App interactions** | Collected. Analytics. (Events, screens, time in the app.) |
| **App info and performance → Crash logs** | Collected. Analytics. (Error message, type, first stack lines.) |
| **App info and performance → Diagnostics** | Collected. Analytics. (Android version, phone model, app version.) |
| **Device or other IDs** | Collected. Analytics. (A random id made by the SDK; not the advertising id.) |
| **Personal info → User IDs** | Only if you call `identify()`. Analytics. |
| **Financial info → Purchase history** | Only if you call `trackPurchase()`. Analytics. |
| Location | Not collected. The server turns the IP address into a country and doesn't keep the IP. |
| Required or optional? | Optional if you offer `optOut()`, otherwise required. |

The SDK never reads the advertising id, so you don't need the `AD_ID` permission for it.
