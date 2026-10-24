// Test setup: point the SDK's React Native / Expo imports at small fakes, and let
// extensionless relative imports ("./index") resolve to .ts like Metro does.
import { registerHooks } from "node:module";

const mocks = new URL("./mocks/", import.meta.url);
const map = {
  "react-native": "react-native.mjs",
  "@react-native-async-storage/async-storage": "async-storage.mjs",
  "expo-application": "expo-application.mjs",
  "expo-localization": "expo-localization.mjs",
  "expo-router": "expo-router.mjs",
  "react-native-device-info": "react-native-device-info.mjs",
  "expo-notifications": "expo-notifications.mjs",
  react: "react.mjs",
};

registerHooks({
  resolve(specifier, context, next) {
    if (map[specifier]) return { url: new URL(map[specifier], mocks).href, shortCircuit: true };
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/i.test(specifier)) {
      try { return next(`${specifier}.ts`, context); } catch { /* not a .ts file */ }
    }
    return next(specifier, context);
  },
});

globalThis.__DEV__ = false;

// Metro's require() for the optional modules (expo-application, expo-localization, react-native-device-info).
// Tests take a module away with globalThis.__missingModules.add(name) to act like a bare React Native app.
// react-native-device-info is missing unless a test adds it, like in most apps.
const optional = {
  "expo-application": await import("expo-application"),
  "expo-localization": await import("expo-localization"),
  "react-native-device-info": await import("react-native-device-info"),
  "expo-notifications": await import("expo-notifications"),
};
// expo-notifications is missing unless a test adds it (push_opened needs it).
globalThis.__missingModules = new Set(["react-native-device-info", "expo-notifications"]);
globalThis.require = (id) => {
  if (!optional[id] || globalThis.__missingModules.has(id)) throw new Error(`Unable to resolve module ${id}`);
  return optional[id];
};
