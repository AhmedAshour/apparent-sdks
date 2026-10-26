# Changelog: apparent-capacitor

All notable changes to this SDK. Versions follow [Semantic Versioning](https://semver.org); every Apparent SDK
(Expo, Capacitor, Swift, Kotlin, Flutter) carries the same version number and sends the same wire format.

## 0.2.2

- `linkRevenueCat(Purchases)` passes the attributes as `@revenuecat/purchases-capacitor` takes them
  (`setAttributes(attributes)`); 0.2.1 wrapped them in `{ attributes }`. The documented
  `linkRevenueCat((attributes) => Purchases.setAttributes(attributes))` works on 0.2.1 already.
- README: the RevenueCat line is `Purchases.setAttributes(attributes)`.

## 0.2.1

First release on npm as `apparent-capacitor`, for Capacitor 5 and later (Ionic, Vue, React, Angular, Svelte or plain).

- The same client as `apparent-expo`: saves every event before sending, one batch at a time, backs off on errors,
  honours Retry-After, keeps the first id after login, consent before anything is stored, `beforeSend`.
- Reads the phone through `@capacitor/app`, `@capacitor/device` and `@capacitor/preferences`: store version and
  build, the Android API level, the model, `simulator` in a simulator or emulator, the phone's language.
- Saves in the phone's preferences (UserDefaults / SharedPreferences), not the WebView's localStorage.
- `app_open` / `app_background` from Capacitor's pause and resume; a launch in the background isn't a visit.
- `deep_link_opened` for the launch link on its own; `trackDeepLink(url)` and `trackPushOpened(data, id)` for the
  app's own listeners.
- Uncaught errors and promise rejections in the WebView as `error` events.
- `trackScreens()`: screens from any router, ids folded (`orders/:id`).
- `linkRevenueCat` takes a `setAttributes` function or `@revenuecat/purchases-capacitor`'s `Purchases`.
