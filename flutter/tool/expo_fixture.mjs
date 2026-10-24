// Writes test/fixtures/expo_batches.json: what the Expo SDK (sdk/expo/src) sends for one fixed scenario.
// The Dart test (test/fixture_test.dart) runs the same scenario and must send the same JSON.
// Ids, times and stacks are random, so they are replaced by labels before saving.
//
//   node --import ../expo/test/setup.mjs tool/expo_fixture.mjs      (from sdk/flutter)
import { writeFileSync } from "node:fs";

globalThis.expo = { modules: { ExpoDevice: { modelId: "iPhone15,2" } } };
const { ApparentClient } = await import("../../expo/src/index.ts");

const bodies = [];
globalThis.fetch = async (_url, init) => {
  bodies.push(JSON.parse(init.body));
  return { ok: true, status: 200, headers: { get: () => null } };
};
const map = new Map();
const storage = { getItem: async (k) => map.get(k) ?? null, setItem: async (k, v) => void map.set(k, v) };

const a = new ApparentClient();
a.init({ apiUrl: "http://fake", app: "demo", key: "test-key", storage, flushIntervalMs: 1e9, flushAt: 1000 });
await a.ready();
a.setProperties({ plan: "pro", lang: "de" });
a.track("paywall_view", { source: "onboarding", price: 4.99, trial: true, coupon: null, skip: undefined });
a.screen("home");
a.screen("home");
a.screen("settings", { tab: "account" });
a.identify("user-42");
a.track("purchase", { product: "pro_yearly" });
a.setProperties({ lang: null });
a.track("after_unset");
a.captureError(new Error("boom"));
await a.flush();
a.reset();
a.track("after_logout", { n: 1 });
await a.flush();
await a.shutdown();

export function normalize(list) {
  const labels = new Map();
  const label = (kind, v) => {
    if (v == null) return v;
    const key = `${kind}:${v}`;
    if (!labels.has(key)) labels.set(key, `<${kind}${[...labels.keys()].filter((k) => k.startsWith(`${kind}:`)).length + 1}>`);
    return labels.get(key);
  };
  return list.map((b) => ({
    ...b, v: "<v>", sa: "<sa>",
    d: { ...b.d, anon: label("anon", b.d.anon) },
    e: b.e.map((e) => {
      const out = { ...e, t: "<t>", i: "<id>", s: label("session", e.s) };
      if ("a" in e) out.a = label("anon", e.a);
      if (out.p?.stack) out.p = { ...out.p, stack: "<stack>" };
      return out;
    }),
  }));
}

const file = new URL("../test/fixtures/expo_batches.json", import.meta.url);
writeFileSync(file, JSON.stringify(normalize(bodies), null, 2) + "\n");
console.log(`wrote ${bodies.length} batches to ${file.pathname}`);
