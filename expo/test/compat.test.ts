// Backward compatibility: an Expo app (expo-application + expo-localization installed) must send and save
// exactly the same bytes as apparent-expo 0.2.0 did before the Expo modules became optional.
// test/fixtures/expo-0.2.0.json was recorded from that code. Re-record only on purpose: UPDATE_FIXTURE=1 npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { ApparentClient, SDK_VERSION, type Storage } from "../src/index.ts";
// @ts-expect-error test fakes are plain JS
import { AppState, Platform, __setAppState } from "react-native";
// @ts-expect-error test fakes are plain JS
import { __setReferrer } from "expo-application";

const FIXTURE = new URL("./fixtures/expo-0.2.0.json", import.meta.url);

/** One scripted session with a seeded random and a frozen clock, so every id and time is the same each run. */
async function record(os: "ios" | "android") {
  const realRandom = Math.random;
  const realNow = Date.now;
  const realFetch = globalThis.fetch;
  let seed = 42;
  Math.random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  let now = 1_790_000_000_000;
  Date.now = () => now;
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    bodies.push(init.body);
    return { ok: true, status: 200, headers: { get: () => null } } as unknown as Response;
  }) as unknown as typeof fetch;
  const map = new Map<string, string>();
  const storage: Storage = { getItem: async (k) => map.get(k) ?? null, setItem: async (k, v) => { map.set(k, v); } };
  const g = globalThis as { expo?: unknown };
  g.expo = { modules: { ExpoDevice: { modelId: "iPhone15,2", modelName: "iPhone 14 Pro" } } };
  Platform.OS = os;
  if (os === "android") __setReferrer("utm_source=reddit&utm_medium=social&utm_campaign=launch");
  try {
    const c = new ApparentClient();
    c.init({ apiUrl: "https://apparent.test/", app: "einb", key: "k", storage, flushIntervalMs: 3_600_000, captureErrors: false });
    await c.ready();
    now += 1000;
    c.track("paywall_view", { source: "onboarding", price: 4.99, gone: undefined, none: null, long: "x".repeat(600), obj: { a: 1 } });
    now += 1000;
    c.setProperties({ language: "de", plan: "free" });
    c.screen("home");
    now += 1000;
    c.screen("practice/[topic]", { path: "/practice/recht" });
    c.identify("user-1");
    now += 1000;
    c.captureError(new TypeError("boom"), { how: "boundary" });
    c.track("purchase", { product: "pro" });
    now += 65_000;
    __setAppState("background");
    await c.flush();
    await c.shutdown();
    return { requests: bodies, saved: map.get("apparent:v2") ?? null, legacy: map.get("apparent:v1") ?? null };
  } finally {
    Math.random = realRandom;
    Date.now = realNow;
    globalThis.fetch = realFetch;
    delete g.expo;
    Platform.OS = "ios";
    __setReferrer("");
    AppState.currentState = "active";
  }
}

/** Stack lines name files on this machine; keep only the first line so the fixture is the same everywhere. The version
 * number is the only byte allowed to change between releases. */
function stable(r: Awaited<ReturnType<typeof record>>) {
  const fix = (s: string) => s.replaceAll(`"v":"${SDK_VERSION}"`, `"v":"0.2.0"`).replace(/"stack":"((?:[^"\\]|\\.)*)"/g, (_m, st: string) => `"stack":"${st.split("\\n")[0]}"`);
  return { requests: r.requests.map(fix), saved: r.saved && fix(r.saved), legacy: r.legacy };
}

test("an Expo app's batches and saved state are byte-for-byte the same as 0.2.0", async () => {
  const got = { ios: stable(await record("ios")), android: stable(await record("android")) };
  if (process.env.UPDATE_FIXTURE) writeFileSync(FIXTURE, JSON.stringify(got, null, 2) + "\n");
  const want = JSON.parse(readFileSync(FIXTURE, "utf8"));
  assert.equal(got.ios.requests.length, 1);
  assert.equal(got.ios.requests[0], want.ios.requests[0]);
  assert.equal(got.ios.saved, want.ios.saved);
  assert.deepEqual(got.android, want.android);
  assert.deepEqual(got, want);
});
