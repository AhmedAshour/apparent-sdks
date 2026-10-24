// Deep links, push opens, beforeSend and consent first. Run with `npm test`.
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { ApparentClient, cleanDeepLink, type ApparentConfig, type Storage } from "../src/index.ts";
// @ts-expect-error test fakes are plain JS
import { __linking, __openUrl } from "react-native";
// @ts-expect-error test fakes are plain JS
import { __notifications, __tap } from "expo-notifications";

const missing = (globalThis as unknown as { __missingModules: Set<string> }).__missingModules;
type Sent = { n: string; t: number; p?: Record<string, unknown> };

/** A server that takes everything and keeps what it got. */
function server() {
  const got: Sent[] = [];
  globalThis.fetch = (async (_url: string, init: { body: string }) => {
    got.push(...JSON.parse(init.body).e);
    return { ok: true, status: 200, headers: { get: () => null } } as unknown as Response;
  }) as unknown as typeof fetch;
  return got;
}

function memStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, getItem: async (k) => map.get(k) ?? null, setItem: async (k, v) => { map.set(k, v); } };
}

const clients: ApparentClient[] = [];
async function launch(storage: Storage, extra: Partial<ApparentConfig> = {}) {
  const c = new ApparentClient();
  clients.push(c);
  c.init({ apiUrl: "https://apparent.test", app: "test", key: "k", storage, flushIntervalMs: 3_600_000, captureErrors: false, ...extra });
  await c.ready();
  await new Promise((r) => setTimeout(r, 5)); // the launch URL / launch tap is read asynchronously
  return c;
}
const names = (got: Sent[]) => got.map((e) => e.n);
const named = (got: Sent[], n: string) => got.filter((e) => e.n === n);

afterEach(async () => {
  for (const c of clients.splice(0)) await c.shutdown();
  __linking.initial = null;
  __notifications.last = null;
  missing.add("expo-notifications");
});

test("a link that opens the app is sent as deep_link_opened, with its campaign and without secrets", async () => {
  const got = server();
  __linking.initial = "myapp://reset?token=abc123&utm_source=newsletter&utm_campaign=spring%20sale&lang=de#access_token=xyz&x=1";
  const c = await launch(memStorage());
  __openUrl("https://user:pw@example.com/p/7?code=999&utm_medium=email");
  await c.flush();
  const links = named(got, "deep_link_opened");
  assert.equal(links.length, 2);
  assert.deepEqual(links[0]!.p, {
    url: "myapp://reset?token=[redacted]&utm_source=newsletter&utm_campaign=spring%20sale&lang=de#access_token=[redacted]&x=1",
    utm_source: "newsletter", utm_campaign: "spring sale",
  });
  assert.deepEqual(links[1]!.p, { url: "https://example.com/p/7?code=[redacted]&utm_medium=email", utm_medium: "email" });
});

test("trackDeepLinks: false sends no deep_link_opened; a normal launch sends none either", async () => {
  const got = server();
  __linking.initial = "myapp://home";
  const off = await launch(memStorage(), { trackDeepLinks: false });
  __openUrl("myapp://other");
  await off.flush();
  assert.equal(named(got, "deep_link_opened").length, 0);
  await off.shutdown();
  __linking.initial = null;
  const plain = await launch(memStorage());
  await plain.flush();
  assert.equal(named(got, "deep_link_opened").length, 0);
});

test("cleanDeepLink: long links are cut, links without a query stay as they are", () => {
  assert.equal(cleanDeepLink("myapp://home").url, "myapp://home");
  assert.equal(cleanDeepLink(`https://a.example/?q=${"x".repeat(900)}`).url.length, 500);
  assert.equal(cleanDeepLink("myapp://x?api_key=1&password=2&session_id=3&ok=4").url, "myapp://x?api_key=[redacted]&password=[redacted]&session_id=[redacted]&ok=4");
});

test("push_opened: only with expo-notifications, once per tap, campaign and title from the data only", async () => {
  const got = server();
  const tap = (id: string, data: Record<string, unknown>) => ({ notification: { request: { identifier: id, content: { title: "Ahmed, your streak", body: "private", data } } } });
  // Without expo-notifications nothing happens and nothing breaks.
  const bare = await launch(memStorage());
  await bare.flush();
  assert.equal(named(got, "push_opened").length, 0);
  await bare.shutdown();

  missing.delete("expo-notifications");
  __notifications.last = tap("n1", { campaign: "fajr", title: "Fajr reminder", secret: "x" });
  const c = await launch(memStorage());
  __tap(tap("n1", { campaign: "fajr" })); // the same tap the launch already reported
  __tap(tap("n2", { utm_campaign: "weekly" }));
  await c.flush();
  const pushes = named(got, "push_opened");
  assert.deepEqual(pushes.map((e) => e.p ?? {}), [{ campaign: "fajr", title: "Fajr reminder" }, { campaign: "weekly" }]);
  assert.ok(!JSON.stringify(pushes).includes("private") && !JSON.stringify(pushes).includes("Ahmed"), "no body text, no title the app didn't choose to send");
});

test("trackPushOpens: false ignores taps", async () => {
  const got = server();
  missing.delete("expo-notifications");
  const c = await launch(memStorage(), { trackPushOpens: false });
  __tap({ notification: { request: { identifier: "n9", content: { data: { campaign: "x" } } } } });
  await c.flush();
  assert.equal(named(got, "push_opened").length, 0);
});

test("beforeSend can change an event, drop it, and a hook that throws keeps it", async () => {
  const got = server();
  let calls = 0;
  const c = await launch(memStorage(), {
    beforeSend: (e) => {
      calls++;
      if (e.name === "secret_thing") return null;
      if (e.name === "boom") throw new Error("hook bug");
      if (e.props?.email) return { ...e, props: { ...e.props, email: undefined as unknown as string, cleaned: true } };
      return e;
    },
  });
  c.track("signed_up", { email: "a@b.c", plan: "pro" });
  c.track("secret_thing", { x: 1 });
  c.track("boom", { y: 2 });
  await c.flush();
  assert.deepEqual(named(got, "signed_up")[0]!.p, { plan: "pro", cleaned: true });
  assert.equal(named(got, "secret_thing").length, 0);
  assert.deepEqual(named(got, "boom")[0]!.p, { y: 2 });
  assert.ok(names(got).includes("app_open") && calls > 3, "automatic events go through it too");
});

test("beforeSend also sees events tracked before the saved state was read", async () => {
  const got = server();
  const storage = memStorage();
  const first = await launch(storage);
  first.setProperties({ email: "a@b.c" });
  await first.shutdown();
  const c = new ApparentClient();
  clients.push(c);
  c.init({ apiUrl: "https://apparent.test", app: "test", key: "k", storage, flushIntervalMs: 3_600_000, captureErrors: false,
    beforeSend: (e) => ({ ...e, props: Object.fromEntries(Object.entries(e.props ?? {}).filter(([k]) => k !== "email")) }) });
  c.track("early_event", { a: 1 }); // before ready(): the saved email isn't known yet
  await c.ready();
  await c.flush();
  assert.deepEqual(named(got, "early_event")[0]!.p, { a: 1 }, "the saved email was added back, then removed by the hook");
});

test("optOutByDefault: nothing until optIn(), then remembered; optOut() later is remembered too", async () => {
  const got = server();
  const storage = memStorage();
  const c = await launch(storage, { optOutByDefault: true });
  c.track("before_consent");
  await c.flush();
  assert.equal(got.length, 0, "not even first_open or app_open");
  assert.equal(c.isOptedOut, true);
  c.optIn();
  c.track("after_consent");
  await c.flush();
  assert.deepEqual(names(got), ["after_consent"]);
  await c.shutdown();

  const again = await launch(storage, { optOutByDefault: true });
  assert.equal(again.isOptedOut, false, "consent is remembered on the next launch");
  again.optOut();
  await again.shutdown();
  const third = await launch(storage, { optOutByDefault: true });
  assert.equal(third.isOptedOut, true);
});

test("optIn() before the saved state is read wins; apps without optOutByDefault save exactly what they did before", async () => {
  server();
  const storage = memStorage();
  const c = new ApparentClient();
  clients.push(c);
  c.init({ apiUrl: "https://apparent.test", app: "test", key: "k", storage, flushIntervalMs: 3_600_000, captureErrors: false, optOutByDefault: true });
  c.optIn();
  await c.ready();
  assert.equal(c.isOptedOut, false);

  const plain = memStorage();
  const p = await launch(plain);
  await p.shutdown();
  assert.ok(!("consent" in JSON.parse(plain.map.get("apparent:v2")!)), "no new key in the saved state unless optIn() was called");
});

test("every field the SDK saves survives a relaunch (the saved-state check never drops a new one)", async () => {
  server();
  const storage = memStorage();
  const c = await launch(storage, { optOutByDefault: true });
  c.optIn();
  c.identify("user-keep");
  c.setProperties({ plan: "pro" });
  await c.shutdown();
  const first = JSON.parse([...storage.map.values()].at(-1)!);
  const again = await launch(storage, { optOutByDefault: true });
  await again.shutdown();
  const second = JSON.parse([...storage.map.values()].at(-1)!);
  for (const key of Object.keys(first)) if (key !== "queue") assert.deepEqual(second[key], first[key], `"${key}" survives a relaunch`);
});
