// Capacitor SDK tests: what differs from apparent-expo (the phone through Capacitor's plugins, the app's state,
// links, notification taps, WebView errors, screens from the address). The queue, retries and ids are the Expo SDK's
// code and are tested there and in sdk/conformance/capacitor.test.ts. Run with `npm test`.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { ApparentClient, type ApparentConfig } from "../src/index.ts";
import { screenName, trackScreens } from "../src/screens.ts";
// @ts-expect-error test fakes are plain JS
import { cap, emit, listenerCount, resetCap } from "@capacitor/core";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Batch = { a: string; k: string; v: string; sa: number; d: Record<string, unknown>; e: { n: string; p?: Record<string, unknown>; s: string; t: number }[] };
let batches: Batch[] = [];
const events = () => batches.flatMap((b) => b.e);
const named = (n: string) => events().filter((e) => e.n === n);

beforeEach(() => {
  resetCap();
  batches = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    batches.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null } } as unknown as Response;
  }) as unknown as typeof fetch;
});

const clients: ApparentClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.shutdown();
});

async function start(extra: Partial<ApparentConfig> = {}) {
  const c = new ApparentClient();
  clients.push(c);
  c.init({ apiUrl: "https://in.example/", app: "demo", key: "k", flushIntervalMs: 60_000, captureErrors: false, ...extra });
  await c.ready();
  return c;
}
async function sent(c: ApparentClient) {
  await sleep(5); // let the launch-link lookup land
  await c.flush();
  return batches.at(-1)!;
}

test("an iPhone: version, build, model and language from the plugins; no simulator key", async () => {
  const c = await start();
  const b = await sent(c);
  assert.deepEqual(b.d, { platform: "ios", os: "18.0", app: "1.4.0", build: "42", model: "iPhone15,2", locale: "de-AT", region: "AT", tz: b.d.tz, anon: c.anonymousId, user: null });
  assert.equal(typeof b.d.tz, "string");
  assert.equal(b.a, "demo");
  assert.deepEqual(events().map((e) => e.n), ["first_open", "app_open"]);
  assert.deepEqual(named("app_open")[0]!.p, { cold: true });
});

test("a phone sends through Capacitor's native HTTP (no CORS), a browser through fetch", async () => {
  const phone = await start();
  await sent(phone);
  assert.ok(cap.httpCalls > 0);
  await phone.shutdown();
  resetCap();
  cap.platform = "web";
  const browser = await start();
  await sent(browser);
  assert.equal(cap.httpCalls, 0);
});

test("a 429 through native HTTP waits for its Retry-After", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return { ok: false, status: 429, headers: { get: (k: string) => (k.toLowerCase() === "retry-after" ? "120" : null) } };
  }) as unknown as typeof fetch;
  const c = await start();
  await c.flush();
  await c.flush();
  assert.equal(calls, 1, "no second try inside the two minutes");
});

test("Android sends the API level as os, and simulator: true in an emulator", async () => {
  cap.platform = "android";
  cap.info = { ...cap.info, model: "sdk_gphone64_arm64", osVersion: "14", androidSDKVersion: 34, isVirtual: true };
  const b = await sent(await start());
  assert.equal(b.d.platform, "android");
  assert.equal(b.d.os, "34");
  assert.equal(b.d.model, "sdk_gphone64_arm64");
  assert.equal(b.d.simulator, true);
});

test("in a plain browser it says web and takes the version from init", async () => {
  cap.platform = "web";
  cap.info = { ...cap.info, model: "Macintosh", osVersion: "10.15.7", isVirtual: false };
  const b = await sent(await start({ appVersion: "2.0.0", appBuild: "7" }));
  assert.equal(b.d.platform, "web");
  assert.equal(b.d.app, "2.0.0");
  assert.equal(b.d.build, "7");
  assert.equal("simulator" in b.d, false);
});

test("events go to the phone's preferences and come back on the next launch", async () => {
  globalThis.fetch = (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
  const one = await start({ retryBaseMs: 60_000 });
  one.identify("u1");
  one.track("lesson_done", { n: 1 });
  await one.flush();
  await one.shutdown();
  const saved = JSON.parse(cap.prefs.get("apparent:v2"));
  assert.deepEqual(saved.queue.map((e: { n: string }) => e.n), ["first_open", "app_open", "lesson_done"]);

  globalThis.fetch = (async (_u: string, init: { body: string }) => {
    batches.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null } };
  }) as unknown as typeof fetch;
  const two = await start();
  assert.equal(two.anonymousId, one.anonymousId);
  await two.flush();
  assert.deepEqual(events().map((e) => e.n), ["first_open", "app_open", "lesson_done", "app_open"]);
  const lesson = batches[0]!.e.find((e) => e.n === "lesson_done") as { u?: string } | undefined;
  assert.equal(lesson?.u ?? batches[0]!.d.user, "u1", "the saved user comes back with its event");
});

test("pause and resume: app_background with seconds, a new visit only after 30 minutes away", async (t) => {
  const c = await start();
  assert.equal(listenerCount("pause"), 1);
  emit("pause");
  emit("resume");
  await c.flush();
  assert.equal(named("app_background").length, 1);
  assert.equal(typeof named("app_background")[0]!.p!.seconds, "number");
  assert.equal(named("app_open").length, 1, "a quick return is the same visit");

  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  emit("pause");
  t.mock.timers.tick(31 * 60_000);
  emit("resume");
  t.mock.timers.reset();
  await c.flush();
  const opens = named("app_open");
  assert.equal(opens.length, 2);
  assert.deepEqual(opens[1]!.p, { cold: false });
  assert.notEqual(opens[1]!.s, opens[0]!.s, "a new session");
});

test("a launch in the background is not a visit until the app comes to the front", async () => {
  cap.active = false;
  const c = await start();
  await c.flush();
  assert.equal(named("app_open").length, 0);
  emit("resume");
  await c.flush();
  assert.equal(named("app_open").length, 1);
});

test("the launch link is sent with secrets redacted; later links come from trackDeepLink", async () => {
  cap.launchUrl = "myapp://invite?code=SECRET&utm_source=reddit";
  const c = await start();
  c.trackDeepLink("https://app.example/p/1?token=abc&utm_campaign=launch");
  await sent(c);
  const links = named("deep_link_opened").map((e) => e.p);
  assert.deepEqual(links, [
    { url: "myapp://invite?code=[redacted]&utm_source=reddit", utm_source: "reddit" },
    { url: "https://app.example/p/1?token=[redacted]&utm_campaign=launch", utm_campaign: "launch" },
  ]);
  assert.equal(listenerCount("appUrlOpen"), 0, "never takes the launch link from the app's own listener");
});

test("the launch link once, when the app's own appUrlOpen listener reports it too", async () => {
  cap.launchUrl = "myapp://open/1";
  const c = new ApparentClient();
  clients.push(c);
  c.init({ apiUrl: "https://in.example", app: "demo", key: "k", flushIntervalMs: 60_000, captureErrors: false });
  c.trackDeepLink("myapp://open/1"); // the app's listener, before the SDK's own lookup lands
  await c.ready();
  await sent(c);
  c.trackDeepLink("myapp://open/1"); // and after
  await c.flush();
  assert.equal(named("deep_link_opened").length, 1);
});

test("trackDeepLinks: false sends no links", async () => {
  cap.launchUrl = "myapp://x";
  const c = await start({ trackDeepLinks: false });
  c.trackDeepLink("myapp://y");
  await sent(c);
  assert.equal(named("deep_link_opened").length, 0);
});

test("trackPushOpened keeps only campaign and title, once per notification", async () => {
  const c = await start();
  c.trackPushOpened({ campaign: "winback", title: "Come back", body: "Hi Sara", userId: "u9" }, 7);
  c.trackPushOpened({ campaign: "winback" }, 7);
  c.trackPushOpened({ utm_campaign: "weekly" }, "8");
  c.trackPushOpened(null);
  await c.flush();
  assert.deepEqual(named("push_opened").map((e) => e.p ?? {}), [{ campaign: "winback", title: "Come back" }, { campaign: "weekly" }, {}]);
});

test("linkRevenueCat takes a setAttributes function or the Capacitor Purchases plugin", async () => {
  const c = await start();
  const got: unknown[] = [];
  await c.linkRevenueCat((attributes) => { got.push(attributes); });
  await c.linkRevenueCat({ setAttributes: async (o) => { got.push(o); } });
  assert.deepEqual(got, [{ apparent_id: c.anonymousId }, { attributes: { apparent_id: c.anonymousId } }]);
  await c.linkRevenueCat(() => { throw new Error("not configured"); }); // never throws into the app
});

test("uncaught errors and promise rejections in the WebView become error events", async () => {
  const target = new EventTarget();
  const g = globalThis as unknown as Record<string, unknown>;
  g.addEventListener = target.addEventListener.bind(target);
  g.removeEventListener = target.removeEventListener.bind(target);
  try {
    const c = await start({ captureErrors: true });
    target.dispatchEvent(Object.assign(new Event("error"), { error: new TypeError("x is undefined"), message: "x is undefined" }));
    target.dispatchEvent(Object.assign(new Event("error"), { error: null, message: "Script error." }));
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("load failed") }));
    await c.flush();
    assert.deepEqual(named("error").map((e) => [e.p!.type, e.p!.message, e.p!.how, e.p!.fatal]), [
      ["TypeError", "x is undefined", "uncaught", false],
      ["Error", "load failed", "promise", false],
    ]);
  } finally {
    delete g.addEventListener;
    delete g.removeEventListener;
  }
});

test("storage that fails keeps the SDK working in memory", async () => {
  cap.failPrefs = true;
  const c = await start();
  c.track("still_works");
  await c.flush();
  assert.ok(named("still_works").length === 1);
});

test("screen names group ids: numbers, uuids, hashes", () => {
  assert.equal(screenName("/"), "home");
  assert.equal(screenName(""), "home");
  assert.equal(screenName("/tabs/tab1"), "tabs/tab1");
  assert.equal(screenName("/practice/17/"), "practice/:id");
  assert.equal(screenName("/orders/8f14e45f-ceea-467a-9575-6e0b3ad3cfa1/items/42?x=1"), "orders/:id/items/:id");
  assert.equal(screenName("/u/5f2b1c9e8d7a6b5c4d3e2f1a"), "u/:id");
  assert.equal(screenName("/chat/Xk3pQ9rT2mWv8Ls1Yz"), "chat/:id");
  assert.equal(screenName("/settings/notification-preferences"), "settings/notification-preferences");
});

test("trackScreens follows pushState, back/forward and #/ routes", () => {
  const target = new EventTarget();
  const loc = { pathname: "/", hash: "", search: "" };
  const history = {
    pushState(_s: unknown, _t: string, url: string) { Object.assign(loc, parse(url)); },
    replaceState(_s: unknown, _t: string, url: string) { Object.assign(loc, parse(url)); },
  };
  const parse = (url: string) => { const [p = "", h = ""] = url.split("#"); return { pathname: p || loc.pathname, hash: h ? `#${h}` : "" }; };
  const g = globalThis as unknown as Record<string, unknown>;
  Object.assign(g, { location: loc, history, addEventListener: target.addEventListener.bind(target), removeEventListener: target.removeEventListener.bind(target) });
  const shown: [string, unknown][] = [];
  try {
    const stop = trackScreens({ client: { screen: (name, props) => { shown.push([name, props]); } } });
    (g.history as History).pushState(null, "", "/orders/42");
    (g.history as History).replaceState(null, "", "/orders/42"); // same screen: nothing
    (g.history as History).pushState(null, "", "/settings");
    Object.assign(loc, { pathname: "/orders/42" });
    target.dispatchEvent(new Event("popstate"));
    Object.assign(loc, { pathname: "/", hash: "#/tabs/tab2" });
    target.dispatchEvent(new Event("hashchange"));
    stop();
    (g.history as History).pushState(null, "", "/after");
    assert.deepEqual(shown, [
      ["home", { path: "/" }],
      ["orders/:id", { path: "/orders/42" }],
      ["settings", { path: "/settings" }],
      ["orders/:id", { path: "/orders/42" }],
      ["tabs/tab2", { path: "/tabs/tab2" }],
    ]);
  } finally {
    for (const k of ["location", "history", "addEventListener", "removeEventListener"]) delete g[k];
  }
});
