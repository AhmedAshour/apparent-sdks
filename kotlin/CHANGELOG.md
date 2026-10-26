# Changelog: Apparent for Android

All notable changes to this SDK. Versions follow [Semantic Versioning](https://semver.org); every Apparent SDK
(Expo, Swift, Kotlin, Flutter) carries the same version number and sends the same wire format.

## 0.2.2

- No code changes. README and `trackPurchase`'s doc: send purchases with RevenueCat too (they are the "Bought" step);
  the README no longer turns the SDK off in debug builds (that hid the wrong-key warning).

## 0.2.1

- Housekeeping release, no code changes: the public source no longer carries a signing team id in the Flutter example.

## 0.2.0

First release on Maven Central as `fyi.apparent:apparent-android` and `fyi.apparent:apparent-compose`.

- Android library, minSdk 24, no dependencies; `apparent-compose` adds `TrackScreen` for Jetpack Compose.
- Same wire format and behaviour as `apparent-expo` 0.2.0 and passes the shared conformance scenario.
- Offline queue, screens, properties, identify/reset, crashes, opt-out, consent, deep links, tapped notifications,
  `beforeSend`, Play install referrer (when the app has the library), dropped count, wrong-key warning.
- Batches say `"v": "kotlin-0.2.0"`.
