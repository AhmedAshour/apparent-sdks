const listeners = new Set();
export const AppState = {
  currentState: "active",
  addEventListener(_type, fn) {
    listeners.add(fn);
    return { remove: () => listeners.delete(fn) };
  },
};
/** Test helper: move the fake app to "active" / "background" / "inactive". */
export function __setAppState(state) {
  AppState.currentState = state;
  for (const fn of [...listeners]) fn(state);
}
export const Platform = { OS: "ios", Version: "18.0", constants: {} };
/** iOS user defaults, as React Native's Settings reads them. */
export const __settings = { AppleLanguages: ["de-AT", "en-AT"], AppleLocale: "de_AT" };
export const Settings = { get: (key) => __settings[key] };
export const __i18n = { localeIdentifier: "en_US" };
export const I18nManager = { getConstants: () => ({ isRTL: false, doLeftAndRightSwapInRTL: true, localeIdentifier: __i18n.localeIdentifier }) };
/** Where the JS bundle was loaded from (React Native's SourceCode module). Tests change it: a phone by default. */
export const __source = { url: "file:///private/var/containers/Bundle/Application/0A1B/App.app/main.jsbundle" };
export const NativeModules = { SourceCode: { getConstants: () => ({ scriptURL: __source.url }) } };
/** Deep links: the URL the app was launched with, and links that arrive while it runs (__openUrl). */
const urlListeners = new Set();
export const __linking = { initial: null };
export const Linking = {
  getInitialURL: async () => __linking.initial,
  addEventListener(_type, fn) {
    urlListeners.add(fn);
    return { remove: () => urlListeners.delete(fn) };
  },
};
export function __openUrl(url) {
  for (const fn of [...urlListeners]) fn({ url });
}
