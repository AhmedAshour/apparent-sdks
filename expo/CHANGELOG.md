# Changelog: apparent-expo

All notable changes to this SDK. Versions follow [Semantic Versioning](https://semver.org); every Apparent SDK
(Expo, Swift, Kotlin, Flutter) carries the same version number and sends the same wire format.

## 0.3.1

- `ApparentChatScreen`: the message box grows with what's typed (up to about six lines) and goes back to one line after sending. Before, on iOS a second line could be cut off and the box stayed tall once empty.

## 0.3.0

- `Apparent.chat`: in-app chat with the app's team (send, subscribe, unread, markRead, setPushToken, forget). Each
  account has its own chat, read only with a random chat key kept on the phone. In this SDK only for now.
- `apparent-expo/chat-screen`: `ApparentChatScreen`, the ready-made chat screen (one look in every app; the app picks
  its colour, font, roundness, dark or light and every word), and `useChatUnread()` for a badge. No extra packages.

## 0.2.2

- Errors carry their `code` when they have one, and `offline: true` when the SDK's own last send found no network,
  so Apparent can tell "no internet" from a real bug in any phone language.

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
