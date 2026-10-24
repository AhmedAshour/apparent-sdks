// Bare React Native: the Expo modules are optional. With them missing, a batch still carries the same fields.
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Apparent, ApparentClient, parseLocale, type ApparentConfig, type Storage } from "../src/index.ts";
import { apparentScreens } from "../src/navigation.ts";
// @ts-expect-error test fakes are plain JS
import { AppState, Platform, __settings } from "react-native";
// @ts-expect-error test fakes are plain JS
import { __setDeviceInfo } from "react-native-device-info";

const missing = (globalThis as unknown as { __missingModules: Set<string> }).__missingModules;
const EXPO = ["expo-application", "expo-localization"];
const FIELDS = ["platform", "os", "app", "build", "model", "locale", "region", "tz", "anon", "user"];

const bodies: any[] = [];
globalThis.fetch = (async (_url: string, init: { body: string }) => {
  bodies.push(JSON.parse(init.body));
  return { ok: true, status: 200, headers: { get: () => null } } as unknown as Response;
}) as unknown as typeof fetch;

function memStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: async (k) => map.get(k) ?? null, setItem: async (k, v) => { map.set(k, v); } };
}

const clients: ApparentClient[] = [];
/** One launch: returns the first batch it sends. */
async function batch(storage: Storage = memStorage(), extra: Partial<ApparentConfig> = {}) {
  const c = new ApparentClient();
  clients.push(c);
  c.init({ apiUrl: "https://apparent.test", app: "test", key: "k", storage, flushIntervalMs: 3_600_000, captureErrors: false, ...extra });
  await c.ready();
  await new Promise((r) => setTimeout(r, 5)); // let the referrer lookup land
  bodies.length = 0;
  await c.flush();
  await c.shutdown();
  return bodies[0];
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.shutdown();
  missing.clear();
  missing.add("react-native-device-info");
  Platform.OS = "ios";
  AppState.currentState = "active";
  __setDeviceInfo({ version: "3.2.1", build: "321", referrer: "unknown" });
});

describe("bare React Native (no Expo modules)", () => {
  test("a batch has the same fields as an Expo app's, from React Native's own APIs", async () => {
    const expo = await batch();
    for (const m of EXPO) missing.add(m);
    const bare = await batch();
    assert.deepEqual(Object.keys(expo.d), FIELDS);
    assert.deepEqual(Object.keys(bare.d), FIELDS);
    assert.deepEqual(Object.keys(bare), Object.keys(expo));
    assert.deepEqual(bare.e.map((e: any) => e.n), ["first_open", "app_open"]);
    assert.equal(bare.d.platform, "ios");
    assert.equal(bare.d.locale, "de-AT", "first of the phone's languages");
    assert.equal(bare.d.region, "AT");
    assert.equal(bare.d.tz, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(bare.d.app, null, "no version source: null, never a guess");
    assert.equal(bare.d.build, null);
  });

  test("the app version passed to init is sent, and an update is noticed", async () => {
    for (const m of EXPO) missing.add(m);
    const storage = memStorage();
    const first = await batch(storage, { appVersion: "2.0.0", appBuild: "20" });
    assert.equal(first.d.app, "2.0.0");
    assert.equal(first.d.build, "20");
    const next = await batch(storage, { appVersion: "2.1.0", appBuild: "21" });
    const updated = next.e.find((e: any) => e.n === "app_updated");
    assert.deepEqual(updated?.p, { from_version: "2.0.0 (20)", to_version: "2.1.0 (21)" });
  });

  test("react-native-device-info gives the version when the app has it", async () => {
    for (const m of EXPO) missing.add(m);
    missing.delete("react-native-device-info");
    const b = await batch();
    assert.equal(b.d.app, "3.2.1");
    assert.equal(b.d.build, "321");
  });

  test("Android: locale from I18nManager, install_source from react-native-device-info's referrer", async () => {
    for (const m of EXPO) missing.add(m);
    missing.delete("react-native-device-info");
    Platform.OS = "android";
    __setDeviceInfo({ referrer: "utm_source=reddit&utm_medium=social&utm_campaign=launch" });
    const b = await batch();
    assert.equal(b.d.locale, "en-US");
    assert.equal(b.d.region, "US");
    const src = b.e.find((e: any) => e.n === "install_source");
    assert.deepEqual(src?.p, { utm_source: "reddit", utm_medium: "social", utm_campaign: "launch" });
  });

  test("Android without any referrer source: no install_source, nothing breaks", async () => {
    for (const m of EXPO) missing.add(m);
    Platform.OS = "android";
    const b = await batch();
    assert.deepEqual(b.e.map((e: any) => e.n), ["first_open", "app_open"]);
    __setDeviceInfo({ referrer: "unknown" });
    missing.delete("react-native-device-info");
    const b2 = await batch();
    assert.equal(b2.e.some((e: any) => e.n === "install_source"), false, "device-info's 'unknown' is no referrer");
  });

  test("no native locale at all falls back to Intl", async () => {
    for (const m of EXPO) missing.add(m);
    const saved = { ...__settings };
    delete __settings.AppleLanguages;
    delete __settings.AppleLocale;
    try {
      const b = await batch();
      const intl = parseLocale(Intl.DateTimeFormat().resolvedOptions().locale);
      assert.equal(b.d.locale, intl?.tag ?? null);
    } finally { Object.assign(__settings, saved); }
  });

  test("Expo apps keep expo-application's version unless init passes one", async () => {
    const b = await batch(memStorage(), { appVersion: "9.9.9" });
    assert.equal(b.d.app, "9.9.9");
    assert.equal(b.d.build, "1", "build still from expo-application");
  });

  test("locale strings from iOS and Android become BCP 47 tags", () => {
    assert.deepEqual(parseLocale("en_US"), { tag: "en-US", region: "US" });
    assert.deepEqual(parseLocale("en_DE@rg=atzzzz"), { tag: "en-DE", region: "AT" });
    assert.deepEqual(parseLocale("zh-Hans-CN"), { tag: "zh-Hans-CN", region: "CN" });
    assert.deepEqual(parseLocale("es-419"), { tag: "es-419", region: "419" });
    assert.deepEqual(parseLocale("de"), { tag: "de", region: null });
    assert.equal(parseLocale(""), null);
    assert.equal(parseLocale(undefined), null);
  });
});

describe("React Navigation screens", () => {
  test("each focused route is reported by name; refs that are not ready are skipped", async () => {
    const seen: [string, unknown][] = [];
    const real = Apparent.screen;
    Apparent.screen = ((name: string, props?: unknown) => { seen.push([name, props]); }) as typeof Apparent.screen;
    try {
      let route: { name: string } | undefined;
      const container = { getCurrentRoute: () => route };
      const fromRef = apparentScreens(container);
      fromRef.onReady(); // not ready: nothing
      route = { name: "Home" };
      fromRef.onReady();
      route = { name: "Settings" };
      fromRef.onStateChange();
      const fromUseRef = apparentScreens({ current: container });
      route = { name: "Paywall" };
      fromUseRef.onStateChange();
      apparentScreens({ current: null }).onReady();
      apparentScreens({ getCurrentRoute: () => { throw new Error("not mounted"); } }).onReady();
      assert.deepEqual(seen.map(([n]) => n), ["Home", "Settings", "Paywall"]);
    } finally {
      Apparent.screen = real;
    }
  });
});
