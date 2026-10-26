# apparent-capacitor

Event SDK for Capacitor and Ionic apps that report to an [Apparent](https://apparent.fyi) dashboard. No native code of
its own: it uses Capacitor's official `app`, `device` and `preferences` plugins. Capacitor 5 or later.

Docs: https://apparent.fyi/docs/sdk/capacitor

## Install

```sh
npm install apparent-capacitor @capacitor/app @capacitor/device @capacitor/preferences
npx cap sync
```

## Quick start

In `src/main.ts` (or `main.tsx`), before the app mounts:

```ts
import { Apparent, trackScreens } from "apparent-capacitor";

Apparent.init({ apiUrl: "https://in.apparent.fyi", app: "<app id>", key: "<write key>" });
trackScreens(); // a screen_view for every route, any router

Apparent.track("paywall_view", { source: "onboarding" });
Apparent.setProperties({ plan: "free" }); // added to every event
```

Sign-in and sign-out:

```ts
Apparent.identify(user.id); // after sign-in, your own account id
Apparent.reset();           // on sign-out
```

RevenueCat (`@revenuecat/purchases-capacitor`), right after `Purchases.configure`:

```ts
await Apparent.linkRevenueCat((attributes) => Purchases.setAttributes(attributes));
```

## Links and notification taps

The link the app was launched with is sent on its own. Capacitor gives a held launch event only to the first
listener, so the SDK never adds listeners of its own (it would take the event from yours). Add one line to yours:

```ts
App.addListener("appUrlOpen", (e) => {
  Apparent.trackDeepLink(e.url);
  // your routing
});

PushNotifications.addListener("pushNotificationActionPerformed", (a) => {
  Apparent.trackPushOpened(a.notification.data, a.notification.id);
});
```

Only the data's `campaign` (or `utm_campaign`) and `title` are kept from a notification, never what it said. Secrets
in links (`token`, `code`, `password`…) are replaced by `[redacted]`.

## What it sends on its own

`first_open`, `app_open` (each visit; a launch in the background isn't one), `app_updated`, `app_background` (seconds
in the app), `error` (uncaught errors and promise rejections in the WebView), `deep_link_opened` (the launch link).

| Sent with each batch | From |
|---|---|
| Platform | `Capacitor.getPlatform()`: `ios`, `android`, or `web` in a plain browser |
| System version | iOS version; on Android the API level (`"34"`), which is how Google's test phones are spotted |
| App version + build | `App.getInfo()` (`appVersion` / `appBuild` in `init` for a browser build) |
| Model, simulator | `Device.getInfo()` (`simulator: true` only in a simulator or emulator) |
| Language, region, time zone | `Device.getLanguageTag()`, `Intl` |

Not available in Capacitor: the Play install referrer (`install_source`), as there is no official plugin for it.
Crashes in native code aren't caught (only JavaScript errors).

## Options

Same as every Apparent SDK: `disabled` (e.g. `import.meta.env.DEV`), `debug`, `sessionTimeoutMinutes` (30),
`captureErrors`, `trackDeepLinks`, `trackPushOpens`, `beforeSend`, `optOutByDefault` with `optIn()` / `optOut()`,
`getAnonymousId` (e.g. the RevenueCat app user id), `appVersion` / `appBuild`.

## Privacy

No advertising ids, no IDFA, no fingerprinting: no App Tracking Transparency prompt. A random id per install, kept in
the app's own storage. The server keeps the country and throws the IP address away. Details:
https://apparent.fyi/docs/privacy

MIT licensed.
