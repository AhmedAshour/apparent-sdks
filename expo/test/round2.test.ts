// Round 2 of the spec (sdk/SPEC.md): simulators without expo-device, a wrong key, batch size, and events tracked in
// the first milliseconds after init (before the saved state is read).
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ApparentClient, WRONG_KEY_WARNING, isSimulator, type ApparentConfig, type Storage } from "../src/index.ts";
// @ts-expect-error test fakes are plain JS
import { AppState, Platform, __source } from "react-native";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PHONE_BUNDLE = __source.url as string;

type Sent = { n: string; p?: Record<string, unknown>; anon: string; user: string | null };

function fakeServer(status = 200) {
  const s = { requests: [] as any[], seen: [] as Sent[], status };
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    s.requests.push(body);
    if (s.status === 200) for (const e of body.e) s.seen.push({ ...e, anon: e.a ?? body.d.anon, user: e.u !== undefined ? e.u : body.d.user });
    return { ok: s.status === 200, status: s.status, headers: { get: () => null } } as unknown as Response;
  }) as unknown as typeof fetch;
  return s;
}

function memStorage(initial?: object): Storage & { saved(): any } {
  const map = new Map<string, string>();
  if (initial) map.set("apparent:v2", JSON.stringify(initial));
  // A slow disk, like AsyncStorage on a busy launch: reads take a few milliseconds.
  return {
    getItem: async (k) => { await sleep(5); return map.get(k) ?? null; },
    setItem: async (k, v) => { map.set(k, v); },
    saved: () => JSON.parse(map.get("apparent:v2") ?? "{}"),
  };
}

const SAVED = { v: 2, anon: "saved-anon", anonSource: "own", userId: "u1", props: { plan: "free" }, optedOut: false, app: "1.0.0 (1)", queue: [] };

const clients: ApparentClient[] = [];
function start(storage: Storage, extra: Partial<ApparentConfig> = {}) {
  const c = new ApparentClient();
  clients.push(c);
  c.init({ apiUrl: "https://apparent.test", app: "test", key: "k", storage, flushIntervalMs: 3_600_000, retryBaseMs: 30, captureErrors: false, ...extra });
  return c;
}
async function sendAll(c: ApparentClient) {
  await c.ready();
  for (let i = 0; i < 20 && ((c as any).queue.length || (c as any).inflight.length); i++) await c.flush();
}

afterEach(async () => {
  for (const c of clients.splice(0)) await c.shutdown();
  AppState.currentState = "active";
  Platform.OS = "ios";
  Platform.constants = {};
  __source.url = PHONE_BUNDLE;
  delete (globalThis as { expo?: unknown }).expo;
});

describe("events in the first milliseconds after init", () => {
  test("get the saved user and properties", async () => {
    const srv = fakeServer();
    const c = start(memStorage(SAVED));
    c.track("early", { n: 1 });
    await sendAll(c);
    const e = srv.seen.find((x) => x.n === "early")!;
    assert.equal(e.anon, "saved-anon");
    assert.equal(e.user, "u1");
    assert.deepEqual(e.p, { plan: "free", n: 1 });
  });

  test("an event's own properties win over the saved ones", async () => {
    const srv = fakeServer();
    const c = start(memStorage(SAVED));
    c.track("early", { plan: "pro" });
    await sendAll(c);
    assert.equal(srv.seen.find((x) => x.n === "early")!.p?.plan, "pro");
  });

  test("a logout right after init is not undone by the saved state", async () => {
    const srv = fakeServer();
    const storage = memStorage(SAVED);
    const c = start(storage);
    c.track("before");
    c.reset();
    c.track("after");
    await sendAll(c);
    const before = srv.seen.find((x) => x.n === "before")!;
    const after = srv.seen.find((x) => x.n === "after")!;
    assert.equal(before.anon, "saved-anon");
    assert.equal(before.user, "u1");
    assert.notEqual(after.anon, "saved-anon");
    assert.equal(after.user, null);
    assert.equal(after.p?.plan, undefined);
    assert.equal(c.anonymousId, after.anon);
    assert.equal(storage.saved().anon, after.anon);
    assert.equal(storage.saved().userId, null);
    assert.deepEqual(storage.saved().props, {});
    // And on the next launch it is still the new person.
    await c.shutdown();
    const next = start(storage);
    next.track("next_launch");
    await sendAll(next);
    const n = srv.seen.find((x) => x.n === "next_launch")!;
    assert.equal(n.anon, after.anon);
    assert.equal(n.user, null);
  });

  test("a sign-in right after init wins over the saved user", async () => {
    const srv = fakeServer();
    const c = start(memStorage(SAVED));
    c.track("before");
    c.identify("u2");
    c.track("after");
    await sendAll(c);
    assert.equal(srv.seen.find((x) => x.n === "before")!.user, "u1");
    assert.equal(srv.seen.find((x) => x.n === "after")!.user, "u2");
    assert.equal(srv.seen.find((x) => x.n === "app_open")!.user, "u2");
  });

  test("a fresh install still works the same", async () => {
    const srv = fakeServer();
    const c = start(memStorage());
    c.track("early");
    await sendAll(c);
    const e = srv.seen.find((x) => x.n === "early")!;
    assert.equal(e.user, null);
    assert.equal(e.p, undefined);
    assert.equal(e.anon, c.anonymousId);
  });
});

describe("simulators without expo-device", () => {
  const device = async () => {
    const srv = fakeServer();
    const c = start(memStorage());
    await sendAll(c);
    return srv.requests[0].d;
  };

  test("a phone sends no simulator key at all", async () => {
    const d = await device();
    assert.equal("simulator" in d, false);
    assert.equal(isSimulator(), false);
  });

  test("the iOS Simulator is told by where the bundle lives", async () => {
    __source.url = "file:///Users/dev/Library/Developer/CoreSimulator/Devices/6AB3/data/Containers/Bundle/Application/1/App.app/main.jsbundle";
    assert.equal((await device()).simulator, true);
  });

  test("Metro on localhost means the Simulator", async () => {
    __source.url = "http://localhost:8081/index.bundle?platform=ios&dev=true";
    assert.equal(isSimulator(), true);
    __source.url = "http://192.168.1.20:8081/index.bundle?platform=ios&dev=true";
    assert.equal(isSimulator(), false);
  });

  test("expo-device's isDevice wins when the app has it", async () => {
    (globalThis as { expo?: unknown }).expo = { modules: { ExpoDevice: { isDevice: false, modelId: "arm64" } } };
    assert.equal((await device()).simulator, true);
  });

  test("an Android emulator is told by its build fingerprint", async () => {
    Platform.OS = "android";
    Platform.constants = { Model: "sdk_gphone64_arm64", Fingerprint: "google/sdk_gphone64_arm64/emu64a:14/UE1A.230829.036/1:userdebug/dev-keys" };
    assert.equal(isSimulator(), true);
    Platform.constants = { Model: "Pixel 8", Fingerprint: "google/shiba/shiba:14/AP1A.240305.019/1:user/release-keys" };
    assert.equal(isSimulator(), false);
  });
});

describe("a wrong app id or key", () => {
  const capture = () => {
    const lines: string[] = [];
    const real = console.warn;
    console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
    return { lines, restore: () => { console.warn = real; } };
  };

  test("warns once in development, and drops the batches", async () => {
    const srv = fakeServer(401);
    const out = capture();
    try {
      const c = start(memStorage(), { debug: true });
      await sendAll(c);
      c.track("again");
      await c.flush();
      assert.equal(srv.requests.length, 2);
      assert.equal(out.lines.filter((l) => l === WRONG_KEY_WARNING).length, 1);
      assert.equal((c as any).queue.length, 0);
    } finally {
      out.restore();
    }
  });

  test("in __DEV__ without debug it still warns; in release it stays quiet", async () => {
    fakeServer(401);
    const out = capture();
    const g = globalThis as { __DEV__?: boolean };
    try {
      g.__DEV__ = true;
      await sendAll(start(memStorage()));
      g.__DEV__ = false;
      await sendAll(start(memStorage()));
      assert.deepEqual(out.lines, [WRONG_KEY_WARNING]);
    } finally {
      g.__DEV__ = false;
      out.restore();
    }
  });
});

test("a long queue goes out in batches of at most 100, nothing lost", async () => {
  const srv = fakeServer();
  const c = start(memStorage(), { flushAt: 10_000 });
  await c.ready();
  for (let n = 0; n < 250; n++) c.track("burst", { n });
  await sendAll(c);
  assert.ok(srv.requests.every((b) => b.e.length <= 100), srv.requests.map((b) => b.e.length).join(","));
  const burst = srv.seen.filter((e) => e.n === "burst").map((e) => e.p?.n);
  assert.equal(burst.length, 250);
  assert.equal(new Set(burst).size, 250);
});
