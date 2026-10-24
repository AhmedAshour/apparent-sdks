// SDK tests. Run with `npm test` (uses test/setup.mjs to fake React Native and Expo).
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ApparentClient, type ApparentConfig, type Storage } from "../src/index.ts";
import { screenName } from "../src/router.ts";
// @ts-expect-error test fakes are plain JS
import { AppState, __setAppState } from "react-native";
// @ts-expect-error test fakes are plain JS
import { __setVersion, __setReferrer } from "expo-application";
// @ts-expect-error test fakes are plain JS
import { Platform } from "react-native";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Sent = { n: string; t: number; s: string; i: string; p?: Record<string, unknown>; anon: string; user: string | null };

/** A fake Apparent server that records every request and can misbehave on demand. */
function fakeServer() {
  const s = {
    requests: [] as { body: any; at: number }[],
    seen: new Map<string, Sent>(),
    inFlight: 0,
    maxInFlight: 0,
    mode: "ok" as "ok" | "hang" | "500" | "429" | "offline" | "400",
    latency: 5,
    retryAfter: "1",
    maxEvents: Infinity,
  };
  const reply = (status: number, headers: Record<string, string> = {}) =>
    ({ ok: status >= 200 && status < 300, status, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } }) as unknown as Response;
  globalThis.fetch = (async (_url: string, init: { body: string; signal?: AbortSignal }) => {
    const body = JSON.parse(init.body);
    s.requests.push({ body, at: Date.now() });
    s.inFlight++;
    s.maxInFlight = Math.max(s.maxInFlight, s.inFlight);
    try {
      if (s.mode === "hang") {
        await new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }
      await sleep(s.latency);
      if (s.mode === "offline") throw new TypeError("Network request failed");
      if (s.mode === "500") return reply(500);
      if (s.mode === "429") return reply(429, { "retry-after": s.retryAfter });
      if (s.mode === "400") return reply(400);
      if (body.e.length > s.maxEvents) return reply(413);
      for (const e of body.e) {
        s.seen.set(e.i, { ...e, anon: e.a ?? body.d.anon, user: e.u !== undefined ? e.u : body.d.user });
      }
      return reply(200);
    } finally {
      s.inFlight--;
    }
  }) as unknown as typeof fetch;
  return s;
}

function memStorage(): Storage & { map: Map<string, string>; saved(): any } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => { map.set(k, v); },
    saved: () => JSON.parse(map.get("apparent:v2") ?? "{}"),
  };
}

const clients: ApparentClient[] = [];
async function launch(storage: Storage, extra: Partial<ApparentConfig> = {}) {
  const c = new ApparentClient();
  clients.push(c);
  c.init({ apiUrl: "https://apparent.test", app: "test", key: "k", storage, flushIntervalMs: 3_600_000, requestTimeoutMs: 200, retryBaseMs: 30, captureErrors: false, ...extra });
  await c.ready();
  return c;
}

/** Keep sending until nothing is left (or give up after `ms`). */
async function settle(c: ApparentClient, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await c.flush();
    const left = ((c as any).queue as unknown[]).length + ((c as any).inflight as unknown[]).length;
    if (!left) return;
    await sleep(15);
  }
}

const names = (srv: ReturnType<typeof fakeServer>) => [...srv.seen.values()].sort((a, b) => a.t - b.t).map((e) => e.n);

afterEach(async () => {
  for (const c of clients.splice(0)) await c.shutdown();
  AppState.currentState = "active";
  __setVersion("1.0.0", "1");
});

describe("does not lose data", () => {
  test("a burst of events is delivered once, one request at a time", async () => {
    const srv = fakeServer();
    srv.latency = 40;
    const c = await launch(memStorage());
    for (let i = 0; i < 60; i++) c.track(`burst_${i}`);
    for (let i = 0; i < 10; i++) { await sleep(10); c.track(`tap_${i}`); }
    await settle(c);
    assert.equal(srv.seen.size, 72, "first_open + app_open + 60 + 10");
    assert.equal(srv.maxInFlight, 1, "never two sends at once");
    const sentTotal = srv.requests.reduce((n, r) => n + r.body.e.length, 0);
    assert.equal(sentTotal, 72, "no event sent twice");
  });

  test("a request that never answers times out, and the events go out later", async () => {
    const srv = fakeServer();
    srv.mode = "hang";
    const c = await launch(memStorage(), { requestTimeoutMs: 60 });
    for (let i = 0; i < 5; i++) c.track(`e${i}`);
    await c.flush();
    assert.equal(srv.seen.size, 0);
    srv.mode = "ok";
    await sleep(80);
    await settle(c);
    assert.equal(srv.seen.size, 7);
  });

  test("events are on disk within a quarter second and survive the app being killed", async () => {
    const srv = fakeServer();
    const storage = memStorage();
    const c = await launch(storage);
    await settle(c);
    for (let i = 0; i < 12; i++) c.track(`before_kill_${i}`);
    await sleep(300);
    assert.equal(storage.saved().queue.length, 12, "all 12 saved without any send");
    // Killed: no shutdown, no flush. A new launch reads the same disk.
    const again = await launch(storage);
    await settle(again);
    assert.equal(names(srv).filter((n) => n.startsWith("before_kill_")).length, 12);
  });

  test("a crash while a batch is being sent keeps that batch", async () => {
    const srv = fakeServer();
    const storage = memStorage();
    srv.mode = "hang";
    const c = await launch(storage, { requestTimeoutMs: 150 });
    c.track("important");
    void c.flush();
    await sleep(30); // the batch is on its way and never answered
    const killedWith = storage.saved().queue.map((e: { n: string }) => e.n);
    assert.ok(killedWith.includes("important"), "still on disk while in flight");
    srv.mode = "ok";
    const again = await launch(storage);
    await settle(again);
    assert.ok(names(srv).includes("important"));
  });

  test("a failing server is retried less and less often", async () => {
    const srv = fakeServer();
    srv.mode = "500";
    const c = await launch(memStorage(), { retryBaseMs: 40 });
    const end = Date.now() + 700;
    while (Date.now() < end) { await c.flush(); await sleep(5); }
    const gaps = srv.requests.slice(1).map((r, i) => r.at - srv.requests[i]!.at);
    assert.ok(srv.requests.length <= 6, `only ${srv.requests.length} tries in 0.7 s, not one per call`);
    for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i]! > gaps[i - 1]! * 1.2, `gaps grow: ${gaps.join(", ")}`);
    srv.mode = "ok";
    await sleep(400);
    await settle(c);
    assert.equal(srv.seen.size, 2, "delivered once the server is back");
  });

  test("Retry-After from the server is respected", async () => {
    const srv = fakeServer();
    srv.mode = "429";
    srv.retryAfter = "2";
    const c = await launch(memStorage());
    const end = Date.now() + 500;
    while (Date.now() < end) { await c.flush(); await sleep(10); }
    assert.equal(srv.requests.length, 1);
  });

  test("batches the server finds too large are split", async () => {
    const srv = fakeServer();
    srv.maxEvents = 10;
    const c = await launch(memStorage(), { flushAt: 1000 });
    for (let i = 0; i < 45; i++) c.track(`e${i}`);
    await settle(c);
    assert.equal(srv.seen.size, 47);
  });

  test("a batch the server refuses is dropped, not retried forever", async () => {
    const srv = fakeServer();
    srv.mode = "400";
    const c = await launch(memStorage());
    await settle(c);
    await c.flush();
    assert.equal(srv.requests.length, 1);
  });

  test("events older than a week are not sent", async () => {
    const srv = fakeServer();
    const storage = memStorage();
    const old = { n: "stale", t: Date.now() - 8 * 24 * 3600_000, s: "s", i: "old1", a: "x", u: null };
    storage.map.set("apparent:v2", JSON.stringify({ v: 2, anon: "x", anonSource: "own", userId: null, props: {}, optedOut: false, app: "1.0.0 (1)", queue: [old] }));
    const c = await launch(storage);
    await settle(c);
    assert.ok(!names(srv).includes("stale"));
  });

  test("the queue keeps the newest events when it is full", async () => {
    const srv = fakeServer();
    srv.mode = "offline";
    const c = await launch(memStorage(), { maxQueue: 50, flushAt: 1000 });
    for (let i = 0; i < 80; i++) c.track(`e${i}`);
    await sleep(300);
    const q = (c as any).queue as { n: string }[];
    assert.equal(q.length, 50);
    assert.equal(q[q.length - 1]!.n, "e79");
  });

  test("an old v1 queue is picked up", async () => {
    const srv = fakeServer();
    const storage = memStorage();
    storage.map.set("apparent:v1", JSON.stringify({ anon: "legacy", userId: null, queue: [{ n: "from_v1", t: Date.now() - 1000, s: "s", i: "v1a" }] }));
    const c = await launch(storage);
    await settle(c);
    assert.ok(names(srv).includes("from_v1"));
    assert.equal(c.anonymousId, "legacy");
  });
});

describe("what it sends", () => {
  test("each batch carries the phone's clock so the server can correct it", async () => {
    const srv = fakeServer();
    const c = await launch(memStorage());
    await settle(c);
    const sa = srv.requests[0]!.body.sa;
    assert.ok(Math.abs(sa - Date.now()) < 2000);
  });

  test("install_source from the Play referrer on Android only", async () => {
    __setReferrer("utm_source=reddit&utm_medium=social&utm_campaign=launch");
    try {
      Platform.OS = "android";
      const srv = fakeServer();
      const c = await launch(memStorage());
      await settle(c);
      const e = [...srv.seen.values()].find((x) => x.n === "install_source");
      assert.deepEqual(e?.p, { utm_source: "reddit", utm_medium: "social", utm_campaign: "launch" });
      await c.shutdown();
      Platform.OS = "ios";
      const srv2 = fakeServer();
      const c2 = await launch(memStorage());
      await settle(c2);
      assert.equal(names(srv2).includes("install_source"), false);
      await c2.shutdown();
    } finally { Platform.OS = "ios"; __setReferrer(""); }
  });

  test("first_open once, app_updated after an update", async () => {
    const srv = fakeServer();
    const storage = memStorage();
    const c = await launch(storage);
    await settle(c);
    assert.deepEqual(names(srv), ["first_open", "app_open"]);
    await c.shutdown();
    __setVersion("1.0.1", "2");
    const again = await launch(storage);
    await settle(again);
    const update = [...srv.seen.values()].find((e) => e.n === "app_updated");
    assert.deepEqual(update?.p, { from_version: "1.0.0 (1)", to_version: "1.0.1 (2)" });
    assert.equal(names(srv).filter((n) => n === "first_open").length, 1);
  });

  test("a launch in the background is not a visit until the app is opened", async () => {
    const srv = fakeServer();
    AppState.currentState = "background";
    const c = await launch(memStorage());
    await settle(c);
    assert.deepEqual(names(srv), ["first_open"]);
    __setAppState("active");
    await settle(c);
    assert.deepEqual(names(srv), ["first_open", "app_open"]);
  });

  test("time in the app is sent when it goes to the background, and a long break starts a new visit", async () => {
    const srv = fakeServer();
    const c = await launch(memStorage(), { sessionTimeoutMinutes: 0.002 });
    await sleep(1100);
    __setAppState("background");
    await settle(c);
    const bg = [...srv.seen.values()].find((e) => e.n === "app_background");
    assert.ok(bg && (bg.p!.seconds as number) >= 1);
    await sleep(200);
    __setAppState("active");
    await settle(c);
    const opens = [...srv.seen.values()].filter((e) => e.n === "app_open");
    assert.equal(opens.length, 2);
    assert.equal(opens[1]!.p!.cold, false);
    assert.notEqual(opens[0]!.s, opens[1]!.s, "new visit id");
  });

  test("properties set once go on every event, and null removes them", async () => {
    const srv = fakeServer();
    const c = await launch(memStorage());
    c.setProperties({ plan: "pro", language: "de" });
    c.track("a", { language: "en" });
    c.setProperties({ plan: null });
    c.track("b");
    await settle(c);
    const ev = (n: string) => [...srv.seen.values()].find((e) => e.n === n)!;
    assert.deepEqual(ev("a").p, { plan: "pro", language: "en" });
    assert.deepEqual(ev("b").p, { language: "de" });
  });

  test("long values are cut on the phone, before they are saved", async () => {
    const srv = fakeServer();
    const c = await launch(memStorage());
    c.track("long", { note: "x".repeat(5000), nested: { a: 1 } as unknown as string });
    await settle(c);
    const p = [...srv.seen.values()].find((e) => e.n === "long")!.p!;
    assert.equal((p.note as string).length, 500);
    assert.equal(p.nested, '{"a":1}');
  });

  test("screens: repeats are ignored and each view says where it came from", async () => {
    const srv = fakeServer();
    const c = await launch(memStorage());
    c.screen("home");
    c.screen("home");
    c.screen("practice");
    await settle(c);
    const views = [...srv.seen.values()].filter((e) => e.n === "screen_view");
    assert.equal(views.length, 2);
    assert.deepEqual(views[1]!.p, { screen: "practice", from: "home" });
    assert.equal(screenName(["(tabs)", "practice", "[topic]"]), "practice/[topic]");
    assert.equal(screenName(["(tabs)"]), "home");
  });
});

describe("privacy and people", () => {
  test("opting out stops collection and is remembered", async () => {
    const srv = fakeServer();
    const storage = memStorage();
    const c = await launch(storage);
    await settle(c);
    c.optOut();
    c.track("secret");
    await settle(c);
    await c.shutdown();
    const again = await launch(storage);
    assert.equal(again.isOptedOut, true);
    again.track("still_secret");
    await settle(again);
    assert.ok(!names(srv).some((n) => n.includes("secret")));
    again.optIn();
    again.track("back");
    await settle(again);
    assert.ok(names(srv).includes("back"));
  });

  test("reset gives a new id; earlier events keep the old one", async () => {
    const srv = fakeServer();
    const c = await launch(memStorage(), { flushAt: 1000 });
    c.identify("user-1");
    c.track("before");
    const oldId = c.anonymousId;
    c.reset();
    c.track("after");
    await settle(c);
    const ev = (n: string) => [...srv.seen.values()].find((e) => e.n === n)!;
    assert.equal(ev("before").anon, oldId);
    assert.equal(ev("before").user, "user-1");
    assert.notEqual(ev("after").anon, oldId);
    assert.equal(ev("after").user, null);
  });

  test("an id from the app (install id) is used, but not after a reset", async () => {
    const srv = fakeServer();
    const storage = memStorage();
    const c = await launch(storage, { getAnonymousId: async () => "inst_abc" });
    assert.equal(c.anonymousId, "inst_abc");
    c.reset();
    await c.shutdown();
    const again = await launch(storage, { getAnonymousId: async () => "inst_abc" });
    assert.notEqual(again.anonymousId, "inst_abc");
    void srv;
  });

  test("the id stays the same after login, even when the app's id changes", async () => {
    fakeServer();
    const storage = memStorage();
    let provider = "$device:abc";
    const c = await launch(storage, { getAnonymousId: async () => provider });
    c.identify("user-1");
    provider = "user-1"; // Mixpanel's distinct_id after identify()
    await c.shutdown();
    const again = await launch(storage, { getAnonymousId: async () => provider });
    assert.equal(again.anonymousId, "$device:abc");
  });

  test("development mode stores and sends nothing", async () => {
    const srv = fakeServer();
    const storage = memStorage();
    const c = await launch(storage, { disabled: true });
    c.track("dev");
    await settle(c);
    assert.equal(srv.requests.length, 0);
    assert.equal(storage.map.size, 0);
  });

  test("linkRevenueCat stores the id on the RevenueCat customer", async () => {
    fakeServer();
    const c = await launch(memStorage());
    let attrs: Record<string, string | null> = {};
    await c.linkRevenueCat({ setAttributes: async (a) => { attrs = a; } });
    assert.deepEqual(attrs, { apparent_id: c.anonymousId });
  });
});

describe("errors", () => {
  test("a crash is saved before the app goes down, then sent on the next launch", async () => {
    const srv = fakeServer();
    srv.mode = "offline";
    const storage = memStorage();
    let previousCalledWith: unknown = null;
    const g = globalThis as any;
    delete g.__apparentErrors;
    let handler: ((e: unknown, fatal?: boolean) => void) | undefined = (e) => { previousCalledWith = e; };
    g.ErrorUtils = { getGlobalHandler: () => handler, setGlobalHandler: (fn: typeof handler) => { handler = fn; } };
    const c = await launch(storage, { captureErrors: true });
    c.screen("exam/result");
    handler!(new TypeError("Cannot read property 'score' of undefined"), true);
    await sleep(350);
    assert.ok(previousCalledWith instanceof TypeError, "the original crash handler still runs");
    const saved = storage.saved().queue.find((e: { n: string }) => e.n === "error");
    assert.equal(saved.p.fatal, true);
    assert.equal(saved.p.screen, "exam/result");
    assert.equal(saved.p.type, "TypeError");
    srv.mode = "ok";
    const again = await launch(storage);
    await settle(again);
    assert.ok(names(srv).includes("error"));
    delete g.ErrorUtils;
    delete g.__apparentErrors;
  });

  test("an error loop is capped per visit", async () => {
    const srv = fakeServer();
    const c = await launch(memStorage(), { flushAt: 1000 });
    for (let i = 0; i < 50; i++) c.captureError(new Error("again"));
    await settle(c);
    assert.equal([...srv.seen.values()].filter((e) => e.n === "error").length, 20);
  });
});

describe("device", () => {
  test("iOS sends the phone model from expo-device, like Mixpanel's $model", async () => {
    const g = globalThis as { expo?: unknown };
    g.expo = { modules: { ExpoDevice: { modelId: "iPhone15,2", modelName: "iPhone 14 Pro" } } };
    try {
      const srv = fakeServer();
      const c = await launch(memStorage());
      await settle(c);
      assert.equal(srv.requests[0]?.body.d.model, "iPhone15,2");
    } finally {
      delete g.expo;
    }
  });

  test("no model without expo-device, and nothing breaks", async () => {
    const srv = fakeServer();
    const c = await launch(memStorage());
    await settle(c);
    assert.equal(srv.requests[0]?.body.d.model ?? null, null);
  });
});
