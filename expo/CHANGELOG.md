# Changelog: apparent-expo

All notable changes to this SDK. Versions follow [Semantic Versioning](https://semver.org); every Apparent SDK
(Expo, Swift, Kotlin, Flutter) carries the same version number and sends the same wire format.

## Unreleased

## 0.2.1

- Housekeeping release, no code changes: the public source no longer carries a signing team id in the Flutter example.

## 0.2.0

First release on npm as `apparent-expo`.

- Saves every event before sending, never sends two batches at once, backs off on errors and retries later.
- Works in bare React Native: `expo-application`, `expo-localization`, `react-native-device-info` and `expo-router`
  are optional and used when the app has them.
- Screens from expo-router (`apparent-expo/router`) or React Navigation (`apparent-expo/navigation`).
- One id per person: the first id is kept after login; a reset lets the next login back in.
- iOS phone model, simulator flag, Play install referrer as `install_source` on Android's first open.
- Deep links, tapped notifications (`push_opened`), `beforeSend`, consent before anything is stored.
- Wrong app id or key prints one warning in development builds; dropped events are counted.
- Published build: ES modules in `dist/` with types and source maps.
