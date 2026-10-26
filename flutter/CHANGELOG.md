# Changelog: apparent (Flutter)

All notable changes to this SDK. Versions follow [Semantic Versioning](https://semver.org); every Apparent SDK
(Expo, Swift, Kotlin, Flutter) carries the same version number and sends the same wire format.

## 0.2.2

- No code changes. README: go_router shell and tab routes need their own observer, the store privacy answers link to
  apparent.fyi/docs/privacy, `passwd` added to the list of hidden link values.

## 0.2.1

- Housekeeping release, no code changes: the public source no longer carries a signing team id in the Flutter example.

## 0.2.0

First release on pub.dev as `apparent`.

- Pure Dart, no native code of its own; iOS and Android.
- Same wire format and behaviour as `apparent-expo` 0.2.0 and passes the shared conformance scenario.
- Offline queue, screens (`ApparentNavigatorObserver`), properties, identify/reset, crashes, opt-out, consent, deep
  links, tapped notifications, `beforeSend`, dropped count, wrong-key warning.
- Batches say `"v": "flutter-0.2.0"`.
