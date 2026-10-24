# apparent (Flutter)

Product events for Flutter apps that report to [Apparent](https://apparent.fyi). Pure Dart, no native code of its own.
It sends exactly what the Expo SDK sends (`POST /i`, same fields, same rules), so both look the same in Apparent.

## Install

```sh
flutter pub add apparent
```

Android: release builds need the internet permission in `android/app/src/main/AndroidManifest.xml`
(Flutter's template only has it for debug): `<uses-permission android:name="android.permission.INTERNET"/>`.

## Quick start

```dart
import 'package:apparent/apparent.dart';
import 'package:flutter/foundation.dart';

void main() {
  Apparent.start(app: 'einb', key: '<write key>', disabled: kDebugMode); // no await needed
  runApp(MaterialApp(navigatorObservers: [ApparentNavigatorObserver()], routes: {...}));
}

Apparent.track('paywall_view', {'source': 'onboarding'});   // lowercase_snake, flat values
Apparent.setProperties({'language': 'de', 'plan': 'pro'});  // on every event; null removes one
Apparent.identify('user-42');                                // after login (same install id)
Apparent.logout();                                           // forgets the user, new install id
await Apparent.linkRevenueCat((attrs) => Purchases.setAttributes(attrs)); // purchases join to what people did
```

- **Screens**: `ApparentNavigatorObserver` sends `screen_view` for each page route by its name (`/settings/account` →
  `settings/account`, `/` → `home`). Dialogs, sheets and unnamed routes are skipped; pass `screenName: (route) => …`
  for your own names (go_router: pass it in `GoRouter(observers: [...])`).
  Or call `Apparent.screen('checkout')` yourself.
- **Errors**: Flutter errors (`FlutterError.onError`) and uncaught Dart errors (`PlatformDispatcher.onError`) are sent as
  `error` events (`message`, `type`, `stack`, `how: "uncaught"`, the screen). They're saved at once, so they arrive even
  if the app is killed right after (on the next launch at the latest). Your own handlers (Crashlytics, Sentry) still
  run. Caught ones: `Apparent.captureError(e, stack: s)`. Native iOS/Android crashes are not caught.
- **Automatic events**: `first_open`, `app_open` (each visit, not background launches), `app_updated`,
  `app_background` (seconds in the app), `screen_view`, `error`. A visit ends after 30 minutes in the background.
- **Links**: Flutter can't see the links that open your app by itself, so pass them from your link package:
  `AppLinks().uriLinkStream.listen(Apparent.trackDeepLink)` (app_links; it also gives the launch link). Each one is
  sent as `deep_link_opened` with the link (any query or fragment value whose name has `token`, `code`, `password`,
  `secret`, `key`, `auth`, `session` or `sig` in it becomes `[redacted]`, a `user:password@` is dropped) and its
  `utm_source` / `utm_medium` / `utm_campaign`. A campaign link that opens the app on its first day counts as where
  that person came from. Off with `trackDeepLinks: false`.
- **Notifications**: with firebase_messaging, call `Apparent.trackPushOpened(message.data, id: message.messageId)` from
  `getInitialMessage()` and `onMessageOpenedApp`. It sends `push_opened` with only the `campaign` (or `utm_campaign`)
  and `title` you put in the data, never the text people saw; the same id twice counts once. Off with
  `trackPushOpens: false`.
- **Your own filter**: `beforeSend: (event) => …` sees every event (automatic ones too) before it is saved. Change
  `event.name` / `event.props` and return it, or return `null` to drop it. If it throws, the event is kept as it was.
- **Consent**: `Apparent.optOut()` / `optIn()` (remembered, saved at once). Asking first? `optOutByDefault: true`
  collects nothing until `optIn()`, also on later launches until then. `disabled: true` stores and sends nothing.
- `anonymousId: () async => …` uses an id you already have (the RevenueCat app user id) on the first launch.

What it promises (each one is a test in `test/`): every event is on the phone within a quarter second and right away
when the app goes to the background; one send at a time, and a batch leaves the queue only once the server has it;
10-second request limit; retries back off from 2 s to 5 min (±20 %) and wait a `Retry-After` exactly (1 s to 1 h, never
sooner), on a clock that the phone's clock changing can't stretch; too-large batches are split,
refused ones dropped; up to 1,000 events wait offline for a week; each batch carries the phone's clock.
At most 100 events per request (a long queue goes out in several, nothing is cut). Events tracked right after
`start()`, before the saved state is read, still get the saved user and properties, and a `logout()` / `reset()` in that
moment sticks, so there's no need to await `start()`. A wrong app id or key (401): the batch is dropped and debug builds
print once `Apparent: app id or key is wrong — events are not being saved`. `identify`, `logout` and `optOut` / `optIn`
are saved at once, so an app killed right after a sign-in or logout wakes up as that person. Broken saved state is read
field by field (what's valid is kept), a storage write that hangs never holds sending (it stops waiting after a
second), and odd values never throw into the app: dates go out as ISO time, functions are left out, `NaN` is `null`,
something that can't be turned into text is `null`, blank names are ignored and names are cut to 80 characters. A
`start` without an app id or key is ignored, so a later correct one still works. In the iOS Simulator or an Android emulator
(`device_info_plus`' `isPhysicalDevice`) the batch says `simulator: true`, so Apparent leaves it out of the counts. On
macOS the platform is `macos`.

## Privacy answers

What the SDK sends: a random install id it makes itself, the user id you pass to `identify`, event names and the
properties you add, screens, errors, the app version, iOS/Android version, phone model, language and region setting.
No advertising id (IDFA/GAID), no contacts, no location. Apparent works out the country from the IP address and doesn't
keep the address. Nothing needs Apple's tracking prompt.

**Apple (App Privacy)**, data used for Analytics (and App Functionality if you use it to fix problems), not for tracking:

| Type | Collected | Linked to the user |
|---|---|---|
| Identifiers › Device ID (the install id) | Yes | Yes |
| Identifiers › User ID | Only if you call `identify` | Yes |
| Usage Data › Product Interaction | Yes | Yes |
| Diagnostics › Crash Data, Other Diagnostic Data | Yes (unless `captureErrors: false`) | Yes |

"Used to track you": **No**. The package has no `PrivacyInfo.xcprivacy` of its own (it's Dart; the plugins it uses,
`path_provider`, `package_info_plus` and `device_info_plus`, ship theirs), so add the rows above to your app's.

**Google Play (Data safety)**: collected, not shared (Apparent processes it for you), encrypted in transit (HTTPS):
Device or other IDs; App activity › App interactions; App info and performance › Crash logs and Diagnostics; Personal
info › User IDs only if you call `identify`. Purpose: Analytics. Collection is required unless you offer `optOut`.

## Develop

```bash
flutter test                                              # unit + widget tests
./conformance.sh                                          # the conformance scenario against the real intake (PORT=4303 for another port)
node --import ../expo/test/setup.mjs tool/expo_fixture.mjs # remake test/fixtures/expo_batches.json from the Expo SDK
cd example && flutter build ios --simulator --no-codesign  # the sample app; node tool/fake_intake.mjs to watch it send
```

The example and the tests never send to Apparent: the example talks to `tool/fake_intake.mjs` on this computer.
