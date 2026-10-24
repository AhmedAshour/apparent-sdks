// Edge cases the big SDKs' suites test (PostHog, Amplitude, Segment, Mixpanel, RudderStack) and ours didn't:
// identity changes while a batch is out, state saved right away, broken storage, clocks that jump, odd Retry-After
// values, one oversized event, junk properties, calls before init, odd event names. Run with `npm test`.
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { ApparentClient, type ApparentConfig, type Storage } from "../src/index.ts";
// @ts-expect-error test fakes are plain JS
import { AppState } from "react-native";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const realNow = Date.now;
const realRandom = Math.random;

type Sent = { n: string; t: number; s: string; i: string; p?: Record<string, unknown>; anon: string; user: string | null };

/** A fake Apparent server. `answer` can override the reply per request (status + headers). */
function fakeServer() {
  const s = {
    requests: [] as { body: any; at: number }[],
    seen: new Map<string, Sent>(),
    latency: 5,
    answer: null as null | ((body: any) => { status: number; headers?: Record<string, string> } | null),
  };
  const reply = (status: number, headers: Record<string, string> = {}) =>
    ({ ok: status >= 200 && status < 300, status, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } }) as unknown as Response;
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    s.requests.push({ body, at: realNow() });
    await sleep(s.latency);
    const forced = s.answer?.(body);
    if (forced) return reply(forced.status, forced.headers);
    for (const e of body.e) s.seen.set(e.i, { ...e, anon: e.a ?? body.d.anon, user: e.u !== undefined ? e.u : body.d.user });
    return reply(200);
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
const base = (storage: Storage, extra: Partial<ApparentConfig> = {}): ApparentConfig =>
  ({ apiUrl: "https://apparent.test", app: "test", key: "k", storage, flushIntervalMs: 3_600_000, requestTimeoutMs: 300, retryBaseMs: 30, captureErrors: false, ...extra });
async function launch(storage: Storage, extra: Partial<ApparentConfig> = {}) {
  const c = new ApparentClient();
  clients.push(c);
  c.init(base(storage, extra));
  await c.ready();
  return c;
}
const left = (c: ApparentClient) => (c as any).queue.length + (c as any).inflight.length;
async function settle(c: ApparentClient, ms = 2000) {
  const end = realNow() + ms;
  while (realNow() < end) {
    await c.flush();
    if (!left(c)) return;
    await sleep(15);
  }
}
const byName = (srv: ReturnType<typeof fakeServer>, n: string) => [...srv.seen.values()].filter((e) => e.n === n);
const sentTotal = (srv: ReturnType<typeof fakeServer>) => srv.requests.reduce((n, r) => n + r.body.e.length, 0);
const flat = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

afterEach(async () => {
  Date.now = realNow;
  Math.random = realRandom;
  // A storage that never finishes a write must not hang the next test.
  for (const c of clients.splice(0)) await Promise.race([c.shutdown().catch(() => {}), sleep(500)]);
  AppState.currentState = "active";
});

describe("identity while a batch is out", () => {
  test("a logout while a batch is in flight: nothing tracked after it is lost, nothing is sent twice", async () => {
    const srv = fakeServer();
    const c = await launch(memStorage());
    await settle(c);
    c.identify("user-before");
    const anonBefore = c.anonymousId;
    for (let i = 0; i < 3; i++) c.track(`before_${i}`);
    srv.latency = 80;
    const out = c.flush(); // the batch with before_* is now in flight
    await sleep(10);
    assert.ok((c as any).inflight.length > 0, "a batch is in flight");
    c.reset();
    for (let i = 0; i < 3; i++) c.track(`after_${i}`);
    await out;
    srv.latency = 5;
    await settle(c);
    for (let i = 0; i < 3; i++) {
      const [b] = byName(srv, `before_${i}`), [a] = byName(srv, `after_${i}`);
      assert.ok(b && a, `before_${i} and after_${i} arrived`);
      assert.deepEqual([b.anon, b.user], [anonBefore, "user-before"], "tracked before the logout: the old person");
      assert.deepEqual([a.anon, a.user], [c.anonymousId, null], "tracked after: the new person");
    }
    assert.notEqual(c.anonymousId, anonBefore);
    assert.equal(sentTotal(srv), srv.seen.size, "no event sent twice");
  });

  test("events tracked while a batch is in flight go out next, once", async () => {
    const srv = fakeServer();
    const c = await launch(memStorage());
    await settle(c);
    srv.latency = 60;
    c.track("first");
    const out = c.flush();
    await sleep(10);
    for (let i = 0; i < 5; i++) c.track(`during_${i}`);
    await out;
    srv.latency = 5;
    await settle(c);
    for (let i = 0; i < 5; i++) assert.equal(byName(srv, `during_${i}`).length, 1);
    assert.equal(sentTotal(srv), srv.seen.size, "no event sent twice");
  });
});

describe("saved right away", () => {
  // "Killed" = a new client reads the same storage at once, without the old one getting to save anything later.
  test("a sign-in is on disk right away, so a kill just after it keeps the user", async () => {
    fakeServer();
    const disk = memStorage();
    const c = await launch(disk);
    await sleep(300);
    c.identify("signed-in-user");
    await Promise.resolve();
    assert.equal(disk.saved().userId, "signed-in-user", "saved without waiting for the debounce");
  });

  test("a logout is on disk right away, so a kill just after it never brings the old user back", async () => {
    fakeServer();
    const disk = memStorage();
    const c = await launch(disk);
    c.identify("leaving-user");
    await sleep(300);
    c.reset();
    const fresh = c.anonymousId;
    await Promise.resolve();
    const killed = new ApparentClient();
    clients.push(killed);
    killed.init(base(disk));
    await killed.ready();
    assert.equal((killed as any).userId, null, "the next launch has nobody signed in");
    assert.equal(killed.anonymousId, fresh, "and the new install id");
  });

  test("identify(null) as a logout is on disk right away too", async () => {
    fakeServer();
    const disk = memStorage();
    const c = await launch(disk);
    c.identify("someone");
    await sleep(300);
    c.identify(null);
    await Promise.resolve();
    assert.equal(disk.saved().userId, null);
  });

  test("opting out and back in is on disk right away", async () => {
    fakeServer();
    const disk = memStorage();
    const c = await launch(disk);
    c.optOut();
    await Promise.resolve();
    assert.equal(disk.saved().optedOut, true);
    c.optIn();
    await Promise.resolve();
    assert.equal(disk.saved().optedOut, false);
  });
});

describe("broken saved state", () => {
  const now = realNow();
  const cases: [string, string][] = [
    ["not JSON", "{not json"],
    ["a number", "5"],
    ["null", "null"],
    ["an array", "[]"],
    ["fields of the wrong type", JSON.stringify({ v: 2, anon: 123, anonSource: 7, userId: 5, props: "str", optedOut: "false", queue: "x", app: 7 })],
    ["a queue with junk in it", JSON.stringify({ v: 2, anon: "kept-anon", userId: null, props: { plan: "pro", bad: { nested: 1 } }, optedOut: false, app: null,
      queue: [null, 5, "x", { n: 7 }, { n: "saved_event", t: now - 1000, s: "s1", i: "saved-id-1", a: "kept-anon", u: null }, { n: "no_ids", t: now - 1000 }] })],
  ];
  for (const [what, raw] of cases) {
    test(`saved state that is ${what} starts cleanly and keeps working`, async () => {
      const srv = fakeServer();
      const disk = memStorage();
      disk.map.set("apparent:v2", raw);
      const c = await launch(disk);
      c.track("after_corrupt", { ok: true });
      await settle(c);
      const [e] = byName(srv, "after_corrupt");
      assert.ok(e, "the new event arrived");
      assert.equal(typeof e.anon, "string");
      assert.ok(e.anon.length > 0);
      assert.ok(e.user === null || typeof e.user === "string", "user is a string or null");
      assert.equal(c.isOptedOut, false, "a saved \"false\" string is not an opt-out");
      for (const sent of srv.seen.values()) {
        assert.equal(typeof sent.n, "string");
        assert.equal(typeof sent.i, "string", `${sent.n} has an insert id`);
        assert.equal(typeof sent.s, "string", `${sent.n} has a session`);
        if (sent.p) assert.ok(Object.values(sent.p).every(flat), `${sent.n} has flat props: ${JSON.stringify(sent.p)}`);
      }
      assert.equal(disk.saved().v, 2, "the state on disk is valid again");
      assert.ok(Array.isArray(disk.saved().queue));
      if (what === "a queue with junk in it") {
        assert.equal(byName(srv, "saved_event").length, 1, "the good saved event still went out");
        assert.equal(e.anon, "kept-anon", "the good saved id is kept");
      }
    });
  }
});

describe("storage that fails", () => {
  const broken: [string, () => Storage][] = [
    ["throws on read", () => ({ getItem: () => { throw new Error("read"); }, setItem: async () => {} })],
    ["rejects on read", () => ({ getItem: async () => { throw new Error("read"); }, setItem: async () => {} })],
    ["throws on write", () => ({ getItem: async () => null, setItem: () => { throw new Error("write"); } })],
    ["rejects on write", () => ({ getItem: async () => null, setItem: async () => { throw new Error("disk full"); } })],
    ["never finishes a write", () => ({ getItem: async () => null, setItem: () => new Promise<void>(() => {}) })],
  ];
  for (const [what, make] of broken) {
    test(`storage that ${what}: the SDK keeps working in memory and never throws`, async () => {
      const srv = fakeServer();
      const c = new ApparentClient();
      clients.push(c);
      c.init(base(make()));
      await Promise.race([c.ready(), sleep(1000)]);
      c.track("still_works");
      c.identify("u1");
      c.setProperties({ plan: "pro" });
      c.track("still_works_2");
      await settle(c, 3000); // before the opt-out below, which empties the queue by design
      c.reset();
      c.optOut();
      c.optIn();
      c.track("still_works_3");
      await settle(c, 3000);
      for (const n of ["still_works", "still_works_2", "still_works_3"]) assert.equal(byName(srv, n).length, 1, `${n} arrived`);
    });
  }
});

describe("clocks that jump", () => {
  test("the phone's clock jumping back a day during a retry wait doesn't strand the queue", async () => {
    const srv = fakeServer();
    const c = await launch(memStorage());
    await settle(c);
    srv.answer = () => ({ status: 500 });
    c.track("waiting");
    await c.flush();
    assert.ok((c as any).retryAt > realNow(), "a retry is waiting");
    const back = realNow() - 86_400_000;
    const offset = back - realNow();
    Date.now = () => realNow() + offset;
    srv.answer = null;
    await sleep(100);
    await settle(c, 1000);
    assert.equal(byName(srv, "waiting").length, 1, "sent within the normal wait, not a day later");
  });

  test("the clock jumping back during a Retry-After wait doesn't stretch it past the server's wait", async () => {
    const srv = fakeServer();
    const c = await launch(memStorage());
    await settle(c);
    srv.answer = () => ({ status: 429, headers: { "retry-after": "1" } });
    c.track("waiting");
    await c.flush();
    Date.now = () => realNow() - 3_600_000;
    srv.answer = null;
    await sleep(1300);
    await settle(c, 1000);
    assert.equal(byName(srv, "waiting").length, 1);
  });

  test("the clock jumping forward a day just retries sooner, nothing is dropped", async () => {
    const srv = fakeServer();
    const c = await launch(memStorage());
    await settle(c);
    srv.answer = () => ({ status: 500 });
    c.track("waiting");
    await c.flush();
    Date.now = () => realNow() + 86_400_000;
    srv.answer = null;
    await settle(c, 1000);
    assert.equal(byName(srv, "waiting").length, 1);
  });
});

describe("Retry-After", () => {
  /** The wait the SDK chose after one 429 with this header, with the jitter at its lowest or highest. */
  async function waitFor(header: string, random: number) {
    const srv = fakeServer();
    const c = await launch(memStorage(), { retryBaseMs: 30 });
    await settle(c);
    srv.answer = () => ({ status: 429, headers: { "retry-after": header } });
    c.track("x");
    Math.random = () => random;
    const before = realNow();
    await c.flush();
    Math.random = realRandom;
    return (c as any).retryAt - before;
  }
  const H = 3_600_000;
  const cases: [string, string, number, number][] = [
    ["2 seconds is waited in full, never less", "2", 2000, 2000 * 1.25],
    ["more than an hour is cut to an hour", "7200", H - 1000, H + 50],
    ["negative becomes 1 s", "-5", 1000, 1300],
    ["zero becomes 1 s", "0", 1000, 1300],
    ["an HTTP date two hours away is cut to an hour", new Date(realNow() + 2 * H).toUTCString(), H - 2000, H + 50],
    ["an HTTP date in the past becomes 1 s", new Date(realNow() - H).toUTCString(), 1000, 1300],
  ];
  for (const [what, header, min, max] of cases) {
    for (const r of [0, 0.999]) {
      test(`${what} (jitter ${r === 0 ? "low" : "high"})`, async () => {
        const wait = await waitFor(header, r);
        assert.ok(wait >= min - 20 && wait <= max, `waited ${wait} ms, want ${min}..${max}`);
      });
    }
  }
  test("a garbage Retry-After falls back to the normal backoff (never stuck)", async () => {
    const wait = await waitFor("soon-ish", 0.5);
    assert.ok(wait >= 0 && wait < 1000, `waited ${wait} ms`);
  });
});

describe("one event too large", () => {
  test("an event the server refuses on its own is dropped, the rest go out, and batches grow back", async () => {
    const srv = fakeServer();
    const c = await launch(memStorage());
    await settle(c);
    srv.answer = (body) => (body.e.some((e: any) => e.n === "huge") ? { status: 413 } : null);
    for (let i = 0; i < 5; i++) c.track(`small_${i}`);
    c.track("huge");
    for (let i = 5; i < 10; i++) c.track(`small_${i}`);
    await settle(c, 3000);
    for (let i = 0; i < 10; i++) assert.equal(byName(srv, `small_${i}`).length, 1, `small_${i}`);
    assert.equal(byName(srv, "huge").length, 0);
    for (let i = 0; i < 150; i++) c.track(`later_${i}`);
    await settle(c, 3000);
    assert.equal((c as any).batchSize, 100, "back to full batches after the successes");
    assert.equal(byName(srv, "later_149").length, 1);
  });
});

describe("properties that aren't plain values", () => {
  test("circular, BigInt, functions, symbols, dates, NaN, deep nesting and too many keys never throw", async () => {
    const srv = fakeServer();
    const c = await launch(memStorage());
    await settle(c);
    const circular: any = { a: 1 };
    circular.self = circular;
    let deep: any = {};
    for (let i = 0; i < 5000; i++) deep = { d: deep };
    const date = new Date("2026-10-24T10:00:00.000Z");
    const props: Record<string, unknown> = {
      circular, big: BigInt(10), fn: () => 1, sym: Symbol("s"), date, nan: NaN, inf: Infinity, ninf: -Infinity,
      deep, arr: [1, 2], nullproto: Object.create(null),
      badJson: { toJSON() { throw new Error("no"); }, toString() { throw new Error("no"); } },
    };
    for (let i = 0; i < 60; i++) props[`k${i}`] = i;
    assert.doesNotThrow(() => c.track("junk_props", props as any));
    assert.doesNotThrow(() => c.setProperties(props as any));
    assert.doesNotThrow(() => c.screen("junk_screen", props as any));
    assert.doesNotThrow(() => c.captureError(circular, props as any));
    await settle(c);
    const [e] = byName(srv, "junk_props");
    assert.ok(e, "the event still went out");
    assert.ok(Object.keys(e.p ?? {}).length <= 40, "at most 40 properties");
    assert.ok(Object.values(e.p ?? {}).every(flat), `flat values only: ${JSON.stringify(e.p)}`);
    assert.equal(e.p?.nan, null);
    assert.equal(e.p?.big, "10");
    assert.equal(e.p?.date, "2026-10-24T10:00:00.000Z", "a date is its ISO time, not JSON with quotes");
    assert.equal("fn" in (e.p ?? {}), false, "a function is left out (JSON has no text for it)");
    assert.equal("sym" in (e.p ?? {}), false, "so is a symbol");
  });

  test("a properties object that throws when read, or setProperties(null), never throws into the app", async () => {
    const srv = fakeServer();
    const c = await launch(memStorage());
    const hostile = new Proxy({}, { ownKeys() { throw new Error("no keys"); } });
    const getter = Object.defineProperty({}, "boom", { enumerable: true, get() { throw new Error("getter"); } });
    assert.doesNotThrow(() => c.track("hostile", hostile as any));
    assert.doesNotThrow(() => c.track("getter", getter as any));
    assert.doesNotThrow(() => c.setProperties(null as any));
    assert.doesNotThrow(() => c.setProperties(hostile as any));
    assert.doesNotThrow(() => c.identify(Object.create(null)));
    c.track("still_alive");
    await settle(c);
    assert.equal(byName(srv, "still_alive").length, 1);
  });
});

describe("calls before init, and init twice", () => {
  test("calls before init never throw: events are dropped, a sign-in is kept", async () => {
    const srv = fakeServer();
    const c = new ApparentClient();
    clients.push(c);
    assert.doesNotThrow(() => {
      c.track("too_early");
      c.screen("early_screen");
      c.captureError(new Error("early"));
      c.setProperties({ plan: "early" });
      c.identify("early-user");
      void c.flush();
    });
    c.init(base(memStorage()));
    await c.ready();
    c.track("after_init");
    await settle(c);
    assert.equal(byName(srv, "too_early").length, 0, "nothing is queued before init");
    const [e] = byName(srv, "after_init");
    assert.equal(e?.user, "early-user", "identify before init is kept");
  });

  test("a second init is ignored, and a broken first init doesn't block a good one", async () => {
    const srv = fakeServer();
    const c = new ApparentClient();
    clients.push(c);
    assert.doesNotThrow(() => c.init(undefined as any));
    assert.doesNotThrow(() => c.init({} as any));
    c.init(base(memStorage()));
    c.init({ ...base(memStorage()), key: "second-key" });
    await c.ready();
    c.track("after_inits");
    await settle(c);
    assert.equal(byName(srv, "after_inits").length, 1, "the good init works");
    assert.ok(srv.requests.every((r) => r.body.k === "k"), "the second init changed nothing");
  });
});

describe("event names", () => {
  test("empty, blank and non-string names are ignored; long names are cut to 80; emoji and spaces are kept", async () => {
    const srv = fakeServer();
    const c = await launch(memStorage());
    await settle(c);
    const before = srv.seen.size;
    for (const bad of ["", "   ", null, undefined, 123, {}, Object.create(null), Symbol("x")]) {
      assert.doesNotThrow(() => c.track(bad as any));
      assert.doesNotThrow(() => c.screen(bad as any));
    }
    c.track("x".repeat(200));
    c.track("Paywall View 🎉");
    await settle(c);
    const names = [...srv.seen.values()].slice(before).map((e) => e.n);
    assert.deepEqual(names, ["x".repeat(80), "Paywall View 🎉"]);
  });
});
