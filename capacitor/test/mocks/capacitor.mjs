// Fakes of the four Capacitor plugins the SDK uses. Tests change `cap` to act like an iPhone, an Android phone or a
// browser, and call emit("pause") / emit("resume") to move the app.
export const cap = {};
const listeners = new Map();
export function resetCap() {
  Object.assign(cap, {
    platform: "ios",
    debug: false,
    info: { model: "iPhone15,2", platform: "ios", osVersion: "18.0", isVirtual: false, operatingSystem: "ios", manufacturer: "Apple", webViewVersion: "18.0" },
    appInfo: { name: "Test", id: "fyi.test", version: "1.4.0", build: "42" },
    languageTag: "de-AT",
    active: true,
    launchUrl: undefined,
    prefs: new Map(),
    failPrefs: false,
    httpCalls: 0,
  });
  listeners.clear();
}
resetCap();
export function emit(event) {
  for (const fn of [...(listeners.get(event) ?? [])]) fn();
}
export const listenerCount = (event) => listeners.get(event)?.size ?? 0;

/** Capacitor's native HTTP, played by the test's fetch (so tests and the conformance run see the same requests).
 *  cap.httpCalls counts how many went this way. */
export const CapacitorHttp = {
  async request({ url, method, headers, data }) {
    cap.httpCalls++;
    const res = await globalThis.fetch(url, { method, headers, body: JSON.stringify(data) });
    const out = {};
    res.headers?.forEach?.((v, k) => { out[k] = v; });
    if (!res.headers?.forEach) { const ra = res.headers?.get?.("retry-after"); if (ra) out["Retry-After"] = ra; }
    return { status: res.status, headers: out, data: null };
  },
};

export const Capacitor = {
  getPlatform: () => cap.platform,
  get DEBUG() { return cap.debug; },
};
const web = () => cap.platform === "web";
export const App = {
  async getInfo() {
    if (web()) throw new Error("Not implemented on web.");
    return { ...cap.appInfo };
  },
  async getState() { return { isActive: cap.active }; },
  async getLaunchUrl() { return cap.launchUrl === undefined ? (web() ? { url: "" } : undefined) : { url: cap.launchUrl }; },
  async addListener(event, fn) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event).add(fn);
    return { remove: async () => { listeners.get(event)?.delete(fn); } };
  },
};
export const Device = {
  async getInfo() { return { ...cap.info, platform: cap.platform }; },
  async getLanguageTag() { return { value: cap.languageTag }; },
};
export const Preferences = {
  async get({ key }) {
    if (cap.failPrefs) throw new Error("disk");
    return { value: cap.prefs.get(key) ?? null };
  },
  async set({ key, value }) {
    if (cap.failPrefs) throw new Error("disk");
    cap.prefs.set(key, value);
  },
};
