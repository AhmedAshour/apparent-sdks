// Records what the Expo SDK sends for one scripted session, as the fixture the Kotlin SDK must match.
//   node --import ./sdk/expo/test/setup.mjs sdk/kotlin/fixtures/make-expo-fixture.ts > sdk/kotlin/fixtures/expo-batch.json
// The clock is fixed; ids are random and get normalised by the Kotlin test (first seen → <id1>, <id2>, …).
// @ts-expect-error test fakes are plain JS
import { Platform } from "react-native";
import { ApparentClient, type Storage } from "../../expo/src/index.ts";

const NOW = 1_800_000_000_000;
Date.now = () => NOW;
Platform.OS = "android";
Platform.Version = 34;
Platform.constants = { Model: "Pixel 8" };

const bodies: unknown[] = [];
globalThis.fetch = (async (_url: string, init: { body: string }) => {
  bodies.push(JSON.parse(init.body));
  return { ok: true, status: 200, headers: { get: () => null } };
}) as unknown as typeof fetch;

const map = new Map<string, string>();
const storage: Storage = { getItem: async (k) => map.get(k) ?? null, setItem: async (k, v) => { map.set(k, v); } };

const c = new ApparentClient();
c.init({ apiUrl: "https://apparent.test", app: "einb", key: "k_test", storage, flushIntervalMs: 3_600_000, flushAt: 1000, captureErrors: false });
await c.ready();
c.setProperties({ plan: "free", language: "de" });
c.track("paywall_view", { source: "onboarding", price: 4.99, count: 3, whole: 2.0, ok: true, none: null, gone: undefined, long: "x".repeat(600) });
c.screen("home");
c.screen("home");
c.screen("practice/[topic]", { path: "/practice/recht" });
c.identify("user-42");
c.track("purchase_success", { product: "pro" });
c.setProperties({ language: null });
c.track("after_unset");
c.reset();
c.track("after_logout");
c.captureError(new Error("boom"));
await c.flush();
await c.shutdown();
const body = bodies[0] as { e: { p?: { stack?: string } }[] };
// JS and JVM stacks differ; only the fact that one is there is compared.
for (const e of body.e) if (e.p?.stack) e.p.stack = "<stack>";
process.stdout.write(JSON.stringify(body, null, 2) + "\n");
