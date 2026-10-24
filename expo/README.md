# apparent-expo

Event SDK for Expo and bare React Native apps that report to an Apparent dashboard. No native code.

## Install

On npm as [`apparent-expo`](https://www.npmjs.com/package/apparent-expo). Docs: https://apparent.fyi/docs/sdk/expo

**Expo** (managed or prebuild):

```sh
npx expo install apparent-expo @react-native-async-storage/async-storage expo-application expo-localization
```

**Bare React Native** (no Expo modules needed):

```sh
npm install apparent-expo @react-native-async-storage/async-storage
npm install react-native-device-info   # optional: app version + Play install referrer without passing them yourself
cd ios && pod install
```

Only `react-native` and `@react-native-async-storage/async-storage` are required. `expo-application`,
`expo-localization`, `react-native-device-info`, `expo-router` and `react` are optional: each one is used when the
app has it.

| Sent with each batch | Expo app | Bare React Native |
|---|---|---|
| App version + build | expo-application | `appVersion` / `appBuild` in `init`, else react-native-device-info, else none |
| Language + region | expo-localization | iOS Settings (the phone's languages), Android I18nManager, else Intl |
| Time zone | expo-localization | Intl |
| Play install referrer (Android) | expo-application | react-native-device-info |

Without a version, `app_updated` can't be noticed, so pass `appVersion` if you have neither module.

## Quick start: Expo

```ts
import { Apparent } from "apparent-expo";

Apparent.init({ apiUrl: "https://in.apparent.fyi", app: "<app id>", key: "<write key>", disabled: __DEV__ });
Apparent.track("paywall_view", { source: "onboarding" });
Apparent.setProperties({ language: "de", plan: "free" }); // added to every event
await Apparent.linkRevenueCat(Purchases);                   // purchases join to what people did
```

Screens in an expo-router app (call once in the root layout):

```ts
import { useApparentScreens } from "apparent-expo/router";
useApparentScreens();
```

## Quick start: bare React Native

```tsx
import { Apparent } from "apparent-expo";
import { apparentScreens } from "apparent-expo/navigation";
import { NavigationContainer, useNavigationContainerRef } from "@react-navigation/native";
import { version } from "./package.json"; // or leave out appVersion when react-native-device-info is installed

Apparent.init({ apiUrl: "https://in.apparent.fyi", app: "<app id>", key: "<write key>", appVersion: version, disabled: __DEV__ });

export default function App() {
  const ref = useNavigationContainerRef();
  return <NavigationContainer ref={ref} {...apparentScreens(ref)}>{/* … */}</NavigationContainer>;
}
```

`apparentScreens` has no dependency on React Navigation; it names each screen after the focused route. If you already
have `onReady` / `onStateChange`, call `screens.track()` from yours. Any other navigator: `Apparent.screen("Settings")`.

## Everything else (both)

Errors caught by an error boundary: `Apparent.captureError(error)`. Crashes and unhandled
promise rejections are captured automatically (release builds).

Logout: `Apparent.reset()`. Consent: `Apparent.optOut()` / `Apparent.optIn()` (remembered).

## What it promises

- Every event is on the phone within a quarter second, and right away when the app goes to the background or crashes.
- One send at a time; a batch only leaves the saved queue when the server has it. The server ignores duplicates.
- 10-second time limit per request; retries wait longer each time (2 s up to 5 min) and honour `Retry-After`.
- Too-large batches are split; refused batches are dropped instead of retried forever.
- Each batch carries the phone's clock, so the server can correct phones set to the wrong time.
- Up to 1,000 events wait offline; events older than a week are dropped.
- At most 100 events per request: a long queue goes out in several batches, nothing is cut.
- Events tracked right after `init()`, before the saved state is read, still get the saved user and properties, and a
  `reset()` in that moment sticks. You don't need to `await Apparent.ready()`.
- A wrong app id or key (the server answers 401): the batch is dropped, and in development (`__DEV__` or `debug: true`)
  it prints once: `Apparent: app id or key is wrong — events are not being saved`.
- Simulators are marked as test phones even without `expo-device`: in the iOS Simulator (told by where the JS bundle
  was loaded from) and Android emulators (the build fingerprint) the batch says `simulator: true`, so Apparent leaves
  them out. Real phones send exactly what they did before. With `expo-device`, its `isDevice` decides, and iOS also
  gets the model (`"iPhone15,2"`).

Automatic events: `first_open`, `app_open` (each visit, not background launches), `app_updated`,
`app_background` (with seconds in the app), `install_source` (Android, from the Play referrer), `screen_view`, `error`.

## How the optional modules load

The SDK calls `require("expo-application")` (and the others) inside `try` blocks. Metro treats such a require as an
optional dependency (`allowOptionalDependencies`, on by default in React Native's and Expo's Metro configs), so an app
without the package still bundles. Re.Pack / webpack only warn. Expo apps send exactly what 0.2.0 sent
(`test/compat.test.ts` checks the bytes).
