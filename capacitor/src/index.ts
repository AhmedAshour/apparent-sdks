/**
 * Apparent SDK for Capacitor apps (Ionic, Vue, React, Angular, Svelte or plain): product events for the Apparent
 * dashboard. No native code of its own: it reads the phone through @capacitor/app, @capacitor/device and
 * @capacitor/preferences, and sends with Capacitor's native HTTP (fetch in a plain browser).
 *
 *   import { Apparent } from "apparent-capacitor";
 *   Apparent.init({ apiUrl: "https://in.apparent.fyi", app: "einb", key: "…" });
 *   Apparent.track("paywall_view", { source: "onboarding" });
 *
 * Built not to lose data:
 * - every event is saved to the phone (UserDefaults / SharedPreferences through @capacitor/preferences, not the
 *   WebView's localStorage, which iOS may clear) within a quarter second, and right away when the app goes to the
 *   background or an error is caught;
 * - one batch is sent at a time, and a batch only leaves the saved queue once the server has it;
 * - each request has a time limit, and retries wait longer each time (and honour Retry-After);
 * - the batch carries the phone's clock, so the server can correct phones set to the wrong time; it ignores duplicates.
 *
 * Automatic events: first_open, app_open (each visit), app_updated, app_background (seconds in the app), error
 * (uncaught errors and promise rejections in the WebView) and deep_link_opened for the link the app was launched with.
 * Links that bring a running app back and tapped notifications need one line in the app's own listener
 * (trackDeepLink, trackPushOpened): Capacitor hands a held launch event only to the first listener, so the SDK never
 * adds one of its own and takes it from the app.
 */
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { App } from "@capacitor/app";
import { Device } from "@capacitor/device";
import { Preferences } from "@capacitor/preferences";

export const SDK_VERSION = "0.2.2";

type Value = string | number | boolean | null;
export type Props = Record<string, Value | undefined>;

/** A queued event. `a`/`u` = whose event it is at the moment it was tracked (identity can change before it is sent). */
type Queued = { n: string; t: number; s: string; i: string; p?: Record<string, Value>; a: string; u: string | null };

/** What an event tracked before the saved state was read still needs: its own properties, and whether a logout or a
 *  sign-in had already happened (then the saved user and properties aren't its). Kept in memory only. */
type Early = { name: string; props: Record<string, unknown>; afterReset: boolean; afterIdentify: boolean };

/** Printed once in development builds when the server answers 401. */
export const WRONG_KEY_WARNING = "Apparent: app id or key is wrong — events are not being saved";

export type Storage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };

export type ApparentConfig = {
  apiUrl: string;
  app: string;
  key: string;
  /** A stable id you already have (an install id, the RevenueCat app user id) so events and purchases join. */
  getAnonymousId?: () => Promise<string | null | undefined>;
  userId?: string | null;
  debug?: boolean;
  /** Nothing is stored or sent. Use it in development. */
  disabled?: boolean;
  /** Minutes in the background before a visit ends. Default 30. */
  sessionTimeoutMinutes?: number;
  /** Report uncaught JavaScript errors and promise rejections. Default true. */
  captureErrors?: boolean;
  /**
   * The app's version ("1.4.0") and build ("42"). Read from @capacitor/app on a phone; only needed in a plain browser
   * build, where there is no app version. Given here, it wins over what the phone says.
   */
  appVersion?: string;
  appBuild?: string;
  /** Advanced, mostly for tests. */
  storage?: Storage;
  flushIntervalMs?: number;
  flushAt?: number;
  maxQueue?: number;
  requestTimeoutMs?: number;
  retryBaseMs?: number;
  /** Send deep_link_opened for the link the app was launched with, and from trackDeepLink(). Default true. */
  trackDeepLinks?: boolean;
  /** Send push_opened from trackPushOpened(). Default true. */
  trackPushOpens?: boolean;
  /**
   * Runs on every event (automatic ones too) before it is queued, after its properties are cleaned. Return the event,
   * changed, or null to drop it. Use it to remove personal data or skip noisy events. If it throws, the event is kept.
   */
  beforeSend?: (event: ApparentEvent) => ApparentEvent | null | undefined;
  /** Collect nothing until optIn() is called (for apps that ask for consent first). Remembered across launches. */
  optOutByDefault?: boolean;
};

/** An event as beforeSend sees it. */
export type ApparentEvent = { name: string; props?: Record<string, Value>; time: number };

type Saved = {
  v: 2;
  anon: string;
  anonSource: "provider" | "own" | "reset";
  userId: string | null;
  props: Record<string, Value>;
  optedOut: boolean;
  /** Set once optIn() was called: with optOutByDefault, only then is anything collected. Left out until then. */
  consent?: true;
  /** "1.0.6 (42)" the last time the app ran, to spot updates. */
  app: string | null;
  queue: Queued[];
};

type SendResult = { kind: "ok" | "drop" | "too-large" | "network" | "server"; status?: number; retryAfterMs?: number };

const STORAGE_KEY = "apparent:v2";
const MAX_EVENT_AGE_MS = 7 * 24 * 3600_000;
const MAX_ERRORS_PER_VISIT = 20;
const MAX_BATCH = 100;
const MAX_PROPS = 40;
const MAX_VALUE = 500;
const WRITE_WAIT_MS = 1000;

const uid = () => {
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
};

const cut = (s: string) => (s.length > MAX_VALUE ? s.slice(0, MAX_VALUE) : s);

/** One property value, flat. Never throws: a date is its ISO time, a function or symbol is left out (JSON has no text
 *  for them), anything else is its JSON text, or its String() when that fails, or null when both fail. */
function cleanValue(v: unknown): Value | undefined {
  if (v === undefined || typeof v === "function" || typeof v === "symbol") return undefined;
  if (v === null || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") return cut(v);
  if (typeof v === "bigint") return cut(String(v));
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString() : null;
  let s: string | undefined;
  try { s = JSON.stringify(v); } catch { s = undefined; }
  if (s === undefined) {
    try { s = String(v); } catch { return null; }
  }
  return cut(s);
}

/** An object's own [key, value] pairs, or none when it isn't a plain object or reading it throws (a Proxy, a getter). */
function entriesOf(input: unknown): [string, unknown][] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  try { return Object.entries(input); } catch { return []; }
}

const readProps = (input: unknown): Record<string, unknown> => Object.fromEntries(entriesOf(input));

function cleanProps(input?: Record<string, unknown>): Record<string, Value> | undefined {
  const entries = entriesOf(input);
  if (!entries.length) return undefined;
  const out: Record<string, Value> = {};
  let n = 0;
  for (const [k, raw] of entries) {
    const v = cleanValue(raw);
    if (v === undefined) continue;
    if (n >= MAX_PROPS) break;
    out[k.slice(0, 64)] = v;
    n++;
  }
  return n ? out : undefined;
}

/** Query and fragment parameters whose values are never sent: anything that looks like a login or a secret. */
const SECRET_PARAM = /token|code|password|passwd|secret|key|auth|session|sig/i;

/**
 * A link that opened the app, safe to store: secrets in the query or fragment become "[redacted]", a user:password@
 * is dropped, and the whole string is cut to 500 characters. Also returns the utm_ campaign fields when present.
 */
export function cleanDeepLink(raw: string): { url: string; utm_source?: string; utm_medium?: string; utm_campaign?: string } {
  let url = String(raw).replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, "$1");
  const utm: Record<string, string> = {};
  const scrub = (part: string) => part.split("&").map((pair) => {
    const eq = pair.indexOf("=");
    if (eq < 0) return pair;
    const k = pair.slice(0, eq);
    let name = k;
    try { name = decodeURIComponent(k); } catch { /* keep as is */ }
    const v = pair.slice(eq + 1);
    if (/^utm_(source|medium|campaign)$/i.test(name)) {
      let value = v;
      try { value = decodeURIComponent(v.replace(/\+/g, " ")); } catch { /* keep as is */ }
      if (value) utm[name.toLowerCase()] = value.slice(0, 100);
      return pair;
    }
    return SECRET_PARAM.test(name) ? `${k}=[redacted]` : pair;
  }).join("&");
  const hash = url.indexOf("#");
  let fragment = "";
  if (hash >= 0) { fragment = url.slice(hash + 1); url = url.slice(0, hash); }
  const q = url.indexOf("?");
  if (q >= 0) url = `${url.slice(0, q)}?${scrub(url.slice(q + 1))}`;
  if (hash >= 0) url += `#${fragment.includes("=") ? scrub(fragment) : fragment}`;
  return { url: url.slice(0, MAX_VALUE), ...utm };
}

/** Retry-After as seconds or an HTTP date, kept between 1 s and 1 h. */
function retryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) ? Math.min(3600_000, Math.max(1000, ms)) : undefined;
}

const isText = (v: unknown, max = 128): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** Saved state as written by an older version, another tool, or a broken disk: keep what is valid, drop the rest. */
function validSaved(raw: unknown): Partial<Saved> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const anon = isText(s.anon) ? s.anon : undefined;
  const queue: Queued[] = [];
  for (const e of Array.isArray(s.queue) ? s.queue : []) {
    if (!e || typeof e !== "object") continue;
    const q = e as Record<string, unknown>;
    if (!isText(q.n, 80) || typeof q.t !== "number" || !Number.isFinite(q.t) || !isText(q.s, 64) || !isText(q.i, 80)) continue;
    const ev: Queued = { n: q.n, t: q.t, s: q.s, i: q.i, a: isText(q.a) ? q.a : anon ?? "", u: isText(q.u) ? q.u : null };
    const p = cleanProps(q.p as Record<string, unknown>);
    if (p) ev.p = p;
    queue.push(ev);
  }
  return {
    anon,
    anonSource: s.anonSource === "provider" || s.anonSource === "reset" ? s.anonSource : "own",
    userId: isText(s.userId) ? s.userId : null,
    props: cleanProps(s.props as Record<string, unknown>) ?? {},
    optedOut: s.optedOut === true,
    // optIn() with optOutByDefault: dropping it here would forget someone's consent on every launch.
    ...(s.consent === true ? { consent: true as const } : {}),
    app: isText(s.app) ? s.app : null,
    queue,
  };
}

function safe<T>(fn: () => T): T | undefined {
  try { return fn(); } catch { return undefined; }
}

async function safeAsync<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn(); } catch { return undefined; }
}

const text = (v: unknown): string | null => (typeof v === "string" && v.length > 0 && v !== "unknown" ? v : null);

/** "en_DE@rg=atzzzz" / "en-DE" → { tag: "en-DE", region: "AT" } (the rg= override is the region the phone is set to). */
export function parseLocale(raw: unknown): { tag: string; region: string | null } | null {
  if (typeof raw !== "string" || !raw) return null;
  const [base = "", ext = ""] = raw.split("@");
  const tag = base.replace(/_/g, "-");
  if (!tag) return null;
  const rg = /(?:^|;)rg=([a-z]{2})/i.exec(ext)?.[1];
  const region = rg ?? tag.split("-").slice(1).find((p) => /^[A-Za-z]{2}$|^\d{3}$/.test(p));
  return { tag, region: region ? region.toUpperCase() : null };
}

function intlOptions(): { locale?: string; timeZone?: string } {
  return safe(() => Intl.DateTimeFormat().resolvedOptions()) ?? {};
}

/** "ios", "android" or "web" (a plain browser: Capacitor's web build or a PWA). */
const platform = (): string => safe(() => Capacitor.getPlatform()) ?? "web";
const isNative = () => platform() !== "web";

/**
 * The phone, read once at start. Capacitor's plugins answer asynchronously, so sending waits for this.
 * os: the iOS version, or the Android API level ("34"), which is how Google's test phones are recognised.
 * model: what @capacitor/device gives: utsname's "iPhone15,2" on an iPhone (the simulated model's id in the
 * Simulator, with simulator: true), Build.MODEL on Android.
 */
async function readDevice(cfg: ApparentConfig): Promise<Record<string, string | boolean | null>> {
  const os = platform();
  const info = await safeAsync(() => Device.getInfo());
  // App.getInfo isn't there in a plain browser; the version passed to init() is used then.
  const appInfo = isNative() ? await safeAsync(() => App.getInfo()) : undefined;
  const tag = await safeAsync(() => Device.getLanguageTag());
  const intl = intlOptions();
  const lang = parseLocale(tag?.value) ?? parseLocale(safe(() => navigator.languages?.[0])) ?? parseLocale(intl.locale);
  const sdk = info?.androidSDKVersion;
  const device: Record<string, string | boolean | null> = {
    platform: os,
    os: os === "android" && typeof sdk === "number" && sdk > 0 ? String(sdk) : text(info?.osVersion) ?? "",
    app: text(cfg.appVersion) ?? text(appInfo?.version),
    build: text(cfg.appBuild) ?? text(appInfo?.build),
    model: text(info?.model),
    locale: lang?.tag ?? null,
    region: lang?.region ?? null,
    tz: text(intl.timeZone),
  };
  // Only in a simulator or emulator: real phones send exactly what they always did.
  if (os !== "web" && info?.isVirtual === true) device.simulator = true;
  return device;
}

/** Storage that outlives the WebView: @capacitor/preferences (UserDefaults on iOS, SharedPreferences on Android). */
const preferences: Storage = {
  getItem: async (key) => (await Preferences.get({ key })).value ?? null,
  setItem: async (key, value) => { await Preferences.set({ key, value }); },
};

/** Event and screen names: a string that isn't blank. Anything else is ignored (SPEC 3.3). */
const isName = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** A debug build: Capacitor sets DEBUG from the native project's build type. */
const isDev = () => safe(() => (Capacitor as unknown as { DEBUG?: boolean }).DEBUG === true) === true;

type AppStateStatus = "active" | "background";
type Handle = { remove(): unknown };

export class ApparentClient {
  private cfg: ApparentConfig | null = null;
  private storage: Storage = preferences;
  private anon = "";
  private anonSource: Saved["anonSource"] = "own";
  private userId: string | null = null;
  private props: Record<string, Value> = {};
  private optedOut = false;
  private appVersion: string | null = null;
  private queue: Queued[] = [];
  private inflight: Queued[] = [];
  private sessionId = uid();
  private device: Record<string, string | boolean | null> = {};
  private loading: Promise<void> = Promise.resolve();
  /** The saved state has been read; until then nothing may be written over it. */
  private loaded = false;
  private sending: Promise<void> | null = null;
  private sendAgain = false;
  private failures = 0;
  private retryAt = 0;
  /** How long the current wait was meant to be, to spot a clock that jumped back since. */
  private retryWait = 0;
  private retryReason: "network" | "server" | null = null;
  private batchSize = MAX_BATCH;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private subs: Handle[] = [];
  private stopped = false;
  /** A pause or resume arrived, so the state asked for at start may be old. */
  private sawState = false;
  private appState: AppStateStatus = "active";
  private activeSince: number | null = null;
  private backgroundAt: number | null = null;
  private pendingOpen = false;
  private screenName: string | null = null;
  private errorsThisVisit = 0;
  /** Events tracked before the saved state was read (see restore). */
  private early = new WeakMap<Queued, Early>();
  private resetBeforeLoad = false;
  private identifiedBeforeLoad = false;
  private warnedKey = false;
  /** optIn() or optOut() before the saved state was read: that choice wins over the saved one. */
  private consentBeforeLoad: "in" | "out" | null = null;
  private consented = false;
  private warnedHook = false;
  private lastPush: string | null = null;
  private lastLink: { url: string; at: number } | null = null;

  init(cfg: ApparentConfig): void {
    if (this.cfg) return;
    if (!cfg || typeof cfg !== "object" || !isText(cfg.apiUrl, 2048) || !isText(cfg.app) || !isText(cfg.key, 512)) {
      // Not this one: a later init with apiUrl, app and key still works.
      if (isDev() || cfg?.debug) console.warn("Apparent: init needs apiUrl, app and key");
      return;
    }
    try {
      this.start(cfg);
    } catch (e) {
      this.log("could not start", e);
    }
  }

  private start(cfg: ApparentConfig): void {
    this.cfg = cfg;
    if (cfg.storage) this.storage = cfg.storage;
    if (cfg.userId) this.userId = String(cfg.userId).slice(0, 128);
    this.loading = this.restore(cfg).catch((e) => this.log("could not read saved events", e));
    // pause / resume, not appStateChange: that one also fires for Control Center or a call banner on iOS, which isn't
    // leaving the app. In a plain browser @capacitor/app sends them on visibilitychange.
    this.listen("pause", () => this.onAppState("background"));
    this.listen("resume", () => this.onAppState("active"));
    this.interval = setInterval(() => void this.flush(), cfg.flushIntervalMs ?? 10_000);
    if (cfg.captureErrors !== false && !cfg.disabled) this.installErrorHandlers();
    // The WebView can be torn down without a pause (a reload, the app swiped away): save what's queued.
    const g = globalThis as unknown as { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void };
    if (typeof g.addEventListener === "function") {
      const onHide = () => { void this.persistNow(); };
      g.addEventListener("pagehide", onHide);
      this.subs.push({ remove: () => g.removeEventListener?.("pagehide", onHide) });
    }
    // Consent first: nothing is collected until the saved state says they agreed, or optIn() is called.
    if (cfg.optOutByDefault) this.optedOut = true;
    if (!cfg.disabled && cfg.trackDeepLinks !== false) {
      // Only the launch link: asking for it doesn't take it from the app's own appUrlOpen listener.
      void safeAsync(() => App.getLaunchUrl()).then((launch) => { if (launch?.url) this.trackDeepLink(launch.url); });
    }
  }

  private listen(event: "pause" | "resume", fn: () => void) {
    const sub = safe(() => (App.addListener as (e: string, f: () => void) => Promise<Handle> | Handle)(event, () => {
      this.sawState = true;
      fn();
    }));
    if (sub) void Promise.resolve(sub).then((h) => { if (this.stopped) void safeAsync(async () => h.remove()); else this.subs.push(h); }, () => {});
  }

  /** A link that opened the app or brought it back. Call it from your own App.addListener("appUrlOpen", …). */
  trackDeepLink(url: string): void {
    if (!this.cfg || this.cfg.trackDeepLinks === false || typeof url !== "string" || !url) return;
    this.guard(() => {
      // The launch link reaches both the SDK (getLaunchUrl) and the app's listener: count it once.
      const now = Date.now();
      if (this.lastLink && this.lastLink.url === url && now - this.lastLink.at < 5000) return;
      this.lastLink = { url, at: now };
      this.enqueue("deep_link_opened", cleanDeepLink(url));
    });
  }

  /**
   * Someone tapped a notification. Call it from your own pushNotificationActionPerformed (or
   * localNotificationActionPerformed) listener with the notification's data and id. Only the data's campaign
   * (or utm_campaign) and title are kept, never what the notification said.
   */
  trackPushOpened(data: Record<string, unknown> | null | undefined, id?: string | number | null): void {
    if (!this.cfg || this.cfg.trackPushOpens === false) return;
    this.guard(() => {
      const key = id == null || id === "" ? null : String(id);
      if (key && key === this.lastPush) return; // one tap reported twice (launch + listener)
      this.lastPush = key;
      const d = readProps(data);
      const pick = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      this.enqueue("push_opened", { campaign: pick(d.campaign) ?? pick(d.utm_campaign), title: pick(d.title) });
    });
  }

  private async restore(cfg: ApparentConfig) {
    const [raw, device, state] = await Promise.all([
      safeAsync(() => this.storage.getItem(STORAGE_KEY)),
      readDevice(cfg),
      safeAsync(() => App.getState()),
    ]);
    this.device = device;
    // A launch by a silent push or background fetch is not a visit: wait until the app is really in front.
    if (!this.sawState && state && state.isActive === false) this.appState = "background";
    let saved: Partial<Saved> | null = null;
    try {
      if (raw) saved = validSaved(JSON.parse(raw));
    } catch { /* unreadable: start fresh */ }
    const fresh = !saved?.anon;
    let anon = saved?.anon ?? "";
    let anonSource: Saved["anonSource"] = saved?.anonSource ?? "own";
    // Only on first launch: Mixpanel's distinct_id turns into the user id after login, and following it would split one
    // person into two ids. The server matches logged-in people by user id instead.
    if (fresh && cfg.getAnonymousId) {
      try {
        const id = await cfg.getAnonymousId();
        if (id) { anon = String(id).slice(0, 128); anonSource = "provider"; }
      } catch { /* keep the saved id */ }
    }
    if (!anon) { anon = uid(); anonSource = "own"; }
    const savedProps = saved?.props ?? {};
    const savedUser = saved?.userId ?? null;
    // A logout before the disk was read already started a new person: keep that, not the saved one.
    if (!this.resetBeforeLoad) {
      this.anon = anon;
      this.anonSource = anonSource;
      if (!this.userId && !this.identifiedBeforeLoad && savedUser) this.userId = savedUser;
      this.props = { ...savedProps, ...this.props };
    }
    if (this.consentBeforeLoad) {
      this.optedOut = this.consentBeforeLoad === "out";
    } else {
      this.consented = saved?.consent === true;
      this.optedOut = Boolean(saved?.optedOut) || (Boolean(cfg.optOutByDefault) && !this.consented);
    }
    const now = Date.now();
    const old = (saved?.queue ?? []).filter((e) => e && typeof e.n === "string" && typeof e.t === "number" && now - e.t < MAX_EVENT_AGE_MS);
    // Events tracked while we were reading the disk belong after the saved ones, with the saved id, user and
    // properties (they weren't known yet), unless a logout came first.
    const dropped = new Set<Queued>();
    for (const e of this.queue) {
      if (!e.a) e.a = anon;
      const early = this.early.get(e);
      if (!early) continue;
      this.early.delete(e);
      if (early.afterReset) continue;
      // The saved properties weren't known when it was tracked: clean it again, and let beforeSend see it again.
      const kept = this.hook(early.name, cleanProps({ ...savedProps, ...early.props }), e.t);
      if (!kept) { dropped.add(e); continue; }
      e.n = kept.n;
      if (kept.p) e.p = kept.p; else delete e.p;
      if (e.u == null && !early.afterIdentify && savedUser) e.u = savedUser;
    }
    this.queue = [...old, ...this.queue.filter((e) => !dropped.has(e))];
    this.loaded = true;

    const current = this.device.app ? `${this.device.app} (${this.device.build ?? "?"})` : null;
    if (fresh) this.enqueue("first_open");
    else if (saved?.app && current && saved.app !== current) this.enqueue("app_updated", { from_version: saved.app, to_version: current });
    this.appVersion = current;
    if (this.appState === "active") this.open(true);
    else this.pendingOpen = true;
    if (this.optedOut) this.queue = [];
    await this.persistNow();
  }

  private open(cold: boolean) {
    this.pendingOpen = false;
    this.activeSince = Date.now();
    this.backgroundAt = null;
    this.errorsThisVisit = 0;
    this.enqueue("app_open", { cold });
  }

  private onAppState(next: AppStateStatus) {
    const prev = this.appState;
    this.appState = next;
    if (!this.loaded) return; // restore() looks at the latest state when it finishes
    if (next === "active") {
      if (this.pendingOpen) this.open(true);
      else if (this.backgroundAt != null) {
        const away = Date.now() - this.backgroundAt;
        if (away > (this.cfg?.sessionTimeoutMinutes ?? 30) * 60_000) {
          this.sessionId = uid();
          this.open(false);
        } else {
          this.activeSince = Date.now();
          this.backgroundAt = null;
        }
      }
      if (this.retryReason === "network") this.retryAt = 0; // the network may be back
      void this.flush();
    } else if (next === "background") {
      if (prev !== "background" && this.activeSince != null) {
        this.enqueue("app_background", { seconds: Math.max(0, Math.round((Date.now() - this.activeSince) / 1000)) });
        this.activeSince = null;
        this.backgroundAt = Date.now();
      }
      void this.persistNow();
      void this.flush();
    }
  }

  private enqueue(name: string, props?: Record<string, unknown>) {
    const cfg = this.cfg;
    if (!cfg) return;
    if (cfg.disabled) {
      if (cfg.debug) console.log("[apparent]", name, props ?? "");
      return;
    }
    if (this.optedOut) return;
    const merged = { ...this.props, ...readProps(props) };
    const t = Date.now();
    const kept = this.hook(String(name).slice(0, 80), cleanProps(merged), t);
    if (!kept) return;
    const e: Queued = { n: kept.n, t, s: this.sessionId, i: uid(), a: this.anon, u: this.userId };
    if (kept.p) e.p = kept.p;
    if (!this.loaded) this.early.set(e, { name: String(name).slice(0, 80), props: merged, afterReset: this.resetBeforeLoad, afterIdentify: this.identifiedBeforeLoad });
    this.queue.push(e);
    const max = cfg.maxQueue ?? 1000;
    const over = this.queue.length + this.inflight.length - max;
    if (over > 0) this.queue.splice(0, over);
    if (cfg.debug) console.log("[apparent]", e.n, e.p ?? "");
    this.schedulePersist();
    if (this.queue.length >= (cfg.flushAt ?? 20)) void this.flush();
  }

  /** The app's beforeSend: the event it returns (cleaned again), or null when it drops it. A hook that throws keeps it. */
  private hook(n: string, p: Record<string, Value> | undefined, t: number): { n: string; p?: Record<string, Value> } | null {
    const fn = this.cfg?.beforeSend;
    if (!fn) return { n, p };
    let out: ApparentEvent | null | undefined;
    try {
      out = fn({ name: n, props: p ? { ...p } : undefined, time: t });
    } catch (err) {
      if (!this.warnedHook) { this.warnedHook = true; this.log("beforeSend threw; the event is sent as it was", err); }
      return { n, p };
    }
    if (!out || typeof out !== "object" || typeof out.name !== "string" || !out.name) return null;
    return { n: out.name.slice(0, 80), p: cleanProps(out.props) };
  }

  /** Record something a person did. Names: lowercase_snake. Props: flat values. */
  track(name: string, props?: Props): void {
    if (!this.cfg || !isName(name)) return;
    this.guard(() => this.enqueue(name, props));
  }

  /** Record that a screen was shown. Repeats of the current screen are ignored. */
  screen(name: string, props?: Props): void {
    if (!this.cfg || !isName(name) || name === this.screenName) return;
    this.guard(() => {
      const from = this.screenName;
      this.screenName = name;
      this.enqueue("screen_view", { ...readProps(props), screen: name, from: from ?? undefined });
    });
  }

  /** Report an error you caught yourself (an error boundary, a failed request). */
  captureError(error: unknown, extra: { fatal?: boolean; how?: string; [key: string]: Value | undefined } = {}): void {
    if (!this.cfg || this.errorsThisVisit >= MAX_ERRORS_PER_VISIT) return;
    this.errorsThisVisit++;
    this.guard(() => {
      const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : String(cleanValue(error) ?? "Unknown error"));
      const stack = String(err.stack ?? "").split("\n").slice(0, 8).map((l) => l.trim()).join("\n").slice(0, 1500);
      const { fatal, how, ...rest } = readProps(extra) as typeof extra;
      // The OS's message is in the phone's language; its code ("-1009", "ENOTFOUND") is the same everywhere.
      const raw = err as { code?: unknown; cause?: { code?: unknown } };
      const code = [raw.code, raw.cause?.code].find((c) => typeof c === "string" || typeof c === "number");
      this.enqueue("error", {
        ...rest, message: String(err.message || "Error").slice(0, 300), type: String(err.name || "Error"), fatal: Boolean(fatal), how: typeof how === "string" ? how : "reported", stack: stack || undefined, screen: this.screenName ?? undefined,
        code: code === undefined ? undefined : String(code).slice(0, 64),
        // Our own last send couldn't reach the internet either: the phone is offline, not the app broken.
        offline: this.retryReason === "network" ? true : undefined,
      });
    });
  }

  /** Who is using the app, once they log in. `null` when they log out (or call reset()). */
  identify(userId: string | null): void {
    this.guard(() => {
      this.userId = userId ? String(userId).slice(0, 128) : null;
      if (!this.loaded) this.identifiedBeforeLoad = true;
      // Saved now, not in a quarter second: an app killed right after a sign-in or logout must wake up as that person.
      void this.persistNow();
    });
  }

  /** Properties added to every event from now on, e.g. { language: "de", plan: "pro" }. `null` removes one. */
  setProperties(props: Props): void {
    for (const [k, v] of entriesOf(props)) {
      const key = k.slice(0, 64);
      const value = cleanValue(v);
      if (value === undefined || value === null) delete this.props[key];
      else this.props[key] = value;
    }
    this.schedulePersist();
  }

  unsetProperty(key: string): void {
    delete this.props[key];
    this.schedulePersist();
  }

  /** Someone logged out: forget who they were and start a new anonymous id. */
  reset(): void {
    if (!this.loaded) this.resetBeforeLoad = true;
    this.anon = uid();
    this.anonSource = "reset";
    this.userId = null;
    this.props = {};
    this.sessionId = uid();
    this.screenName = null;
    void this.persistNow();
  }

  /** Stop collecting (for example when someone declines analytics). Remembered across launches. */
  optOut(): void {
    this.optedOut = true;
    this.consented = false;
    if (!this.loaded) this.consentBeforeLoad = "out";
    this.queue = [];
    void this.persistNow();
  }

  /** Start collecting again, or for the first time with optOutByDefault. Remembered across launches. */
  optIn(): void {
    this.optedOut = false;
    this.consented = true;
    if (!this.loaded) this.consentBeforeLoad = "in";
    void this.persistNow();
  }

  /** Resolves once saved events and ids are loaded (anonymousId is final from then on). */
  ready(): Promise<void> {
    return this.loading;
  }

  get isOptedOut(): boolean {
    return this.optedOut;
  }

  get anonymousId(): string {
    return this.anon;
  }

  /**
   * Store this person's Apparent id on their RevenueCat customer, so purchases join to what they did. Right after
   * Purchases.configure (and again after reset()):
   *   await Apparent.linkRevenueCat((attributes) => Purchases.setAttributes(attributes));
   * Passing @revenuecat/purchases-capacitor's Purchases itself works too.
   */
  async linkRevenueCat(
    setAttributes: ((attributes: Record<string, string>) => unknown) | { setAttributes(attributes: Record<string, string>): unknown },
  ): Promise<void> {
    await this.loading;
    try {
      const attributes = { apparent_id: this.anon };
      if (typeof setAttributes === "function") await setAttributes(attributes);
      else await setAttributes.setAttributes(attributes);
    } catch (e) {
      this.log("could not link RevenueCat", e);
    }
  }

  /** Send what is queued now. Safe to call any time: only one send runs at once. */
  flush(): Promise<void> {
    if (!this.cfg) return Promise.resolve();
    if (this.sending) {
      this.sendAgain = true;
      return this.sending;
    }
    this.sending = this.drain().finally(() => {
      this.sending = null;
      if (this.sendAgain) {
        this.sendAgain = false;
        if (this.queue.length && this.due()) void this.flush();
      }
    });
    return this.sending;
  }

  private async drain(): Promise<void> {
    await this.loading;
    const cfg = this.cfg!;
    if (cfg.disabled || this.optedOut) {
      this.queue = [];
      return;
    }
    const cutoff = Date.now() - MAX_EVENT_AGE_MS;
    if (this.queue.some((e) => e.t < cutoff)) this.queue = this.queue.filter((e) => e.t >= cutoff);
    let sent = false;
    while (this.queue.length && this.due()) {
      const batch = this.queue.splice(0, this.batchSize);
      this.inflight = batch;
      // Nothing may be in flight without being on disk: a crash mid-send must not lose it.
      if (this.persistTimer) await this.persistNow();
      const result = await this.send(batch);
      this.inflight = [];
      sent = true;
      if (result.kind === "ok" || result.kind === "drop") {
        if (result.kind === "drop") {
          this.log(`server refused ${batch.length} events (${result.status})`);
          // Retrying never fixes a wrong key, so the batch is dropped; say so once, loudly, while developing.
          if (result.status === 401 && !this.warnedKey && (cfg.debug || isDev())) {
            this.warnedKey = true;
            console.warn(WRONG_KEY_WARNING);
          }
        }
        this.failures = 0;
        this.retryAt = 0;
        this.retryWait = 0;
        this.retryReason = null;
        if (result.kind === "ok" && this.batchSize < MAX_BATCH) this.batchSize = Math.min(MAX_BATCH, this.batchSize * 2);
        continue;
      }
      if (result.kind === "too-large") {
        if (batch.length === 1) { this.log("dropped one event the server says is too large"); continue; }
        this.batchSize = Math.max(1, Math.floor(batch.length / 2));
        this.queue.unshift(...batch);
        continue;
      }
      this.queue.unshift(...batch);
      this.failures++;
      this.retryReason = result.kind === "network" ? "network" : "server";
      const base = cfg.retryBaseMs ?? 2000;
      // The server's Retry-After exactly (already 1 s .. 1 h), never earlier; our own backoff with +-20 % jitter.
      this.retryWait = result.retryAfterMs ?? Math.round(Math.min(5 * 60_000, base * 2 ** (this.failures - 1)) * (0.8 + Math.random() * 0.4));
      this.retryAt = Date.now() + this.retryWait;
      this.log(`send failed (${result.status ?? result.kind}), next try in ${Math.round((this.retryAt - Date.now()) / 1000)} s`);
      break;
    }
    if (sent) await this.persistNow();
  }

  /** True once the retry wait is over. A wait that is now longer than it was set to means the phone's clock went back:
   *  it's over too, so a clock change never holds the queue (PostHog and Amplitude test the same). */
  private due(): boolean {
    const now = Date.now();
    if (this.retryAt - now > this.retryWait) this.retryAt = now;
    return now >= this.retryAt;
  }

  private async send(batch: Queued[]): Promise<SendResult> {
    const cfg = this.cfg!;
    const first = batch[0]!;
    const d = { ...this.device, anon: first.a || this.anon, user: first.u };
    const e = batch.map(({ a, u, ...rest }) => {
      const out: Record<string, unknown> = rest;
      if (a && a !== d.anon) out.a = a;
      if (u !== d.user) out.u = u;
      return out;
    });
    const batchBody = { a: cfg.app, k: cfg.key, v: SDK_VERSION, sa: Date.now(), d, e };
    const url = `${cfg.apiUrl.replace(/\/$/, "")}/i`;
    const ms = cfg.requestTimeoutMs ?? 10_000;
    // On a phone the page runs at capacitor://localhost (iOS) or https://localhost (Android), so a fetch to the intake
    // is cross-origin. Capacitor's own native HTTP (in @capacitor/core) sends it from the app instead, with no CORS.
    if (isNative()) return this.sendNative(url, batchBody, ms);
    const body = JSON.stringify(batchBody);
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        ctrl?.abort();
        reject(new Error("timeout"));
      }, ms);
    });
    try {
      const res = await Promise.race([
        fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: ctrl?.signal }),
        timeout,
      ]);
      if (res.ok) return { kind: "ok" };
      if (res.status === 413) return { kind: "too-large", status: 413 };
      if (res.status === 408 || res.status === 429 || res.status >= 500) {
        return { kind: "server", status: res.status, retryAfterMs: retryAfterMs(res.headers?.get?.("retry-after")) };
      }
      return { kind: "drop", status: res.status };
    } catch {
      return { kind: "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  private async sendNative(url: string, data: Record<string, unknown>, ms: number): Promise<SendResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); });
    try {
      const res = await Promise.race([
        CapacitorHttp.request({ url, method: "POST", headers: { "Content-Type": "application/json" }, data, connectTimeout: ms, readTimeout: ms }),
        timeout,
      ]);
      const status = Number(res?.status) || 0;
      if (status >= 200 && status < 300) return { kind: "ok" };
      if (status === 413) return { kind: "too-large", status };
      if (status === 0) return { kind: "network" };
      if (status === 408 || status === 429 || status >= 500) {
        // Header names come back as the server wrote them on iOS, lower-cased on Android.
        const headers = (res?.headers ?? {}) as Record<string, unknown>;
        const key = Object.keys(headers).find((k) => k.toLowerCase() === "retry-after");
        return { kind: "server", status, retryAfterMs: retryAfterMs(key ? String(headers[key]) : null) };
      }
      return { kind: "drop", status };
    } catch {
      return { kind: "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  private schedulePersist() {
    if (this.persistTimer || !this.loaded) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow();
    }, 250);
  }

  private async persistNow(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.cfg || this.cfg.disabled || !this.loaded) return;
    const state: Saved = {
      v: 2, anon: this.anon, anonSource: this.anonSource, userId: this.userId, props: this.props, optedOut: this.optedOut,
      ...(this.consented ? { consent: true as const } : {}),
      app: this.appVersion, queue: [...this.inflight, ...this.queue].slice(-(this.cfg.maxQueue ?? 1000)),
    };
    try {
      // A disk that never answers must not hold sending or ready(): stop waiting after a second (the write goes on).
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.storage.setItem(STORAGE_KEY, JSON.stringify(state)),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, WRITE_WAIT_MS); }),
      ]).finally(() => clearTimeout(timer));
    } catch (e) {
      this.log("could not save events", e);
    }
  }

  /** Uncaught errors and promise rejections in the WebView. Other handlers (Sentry…) still see them: nothing is stopped. */
  private installErrorHandlers() {
    const w = globalThis as unknown as {
      addEventListener?: (type: string, fn: (e: unknown) => void) => void;
      removeEventListener?: (type: string, fn: (e: unknown) => void) => void;
      __apparentErrors?: boolean;
    };
    if (w.__apparentErrors || typeof w.addEventListener !== "function") return;
    w.__apparentErrors = true;
    const onError = (e: unknown) => {
      const ev = e as { error?: unknown; message?: unknown };
      // A script from another origin only says "Script error." with nothing to group by: not worth a row.
      if (ev.error == null && (typeof ev.message !== "string" || /^Script error\.?$/.test(ev.message))) return;
      this.captureError(ev.error ?? ev.message, { how: "uncaught" });
      void this.persistNow();
    };
    const onRejection = (e: unknown) => {
      this.captureError((e as { reason?: unknown }).reason, { how: "promise" });
      void this.persistNow();
    };
    w.addEventListener("error", onError);
    w.addEventListener("unhandledrejection", onRejection);
    this.subs.push({ remove: () => {
      w.removeEventListener?.("error", onError);
      w.removeEventListener?.("unhandledrejection", onRejection);
      w.__apparentErrors = false;
    } });
  }

  /** Stop timers and listeners, after saving what is queued. For tests and hot reload. */
  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    for (const h of this.subs.splice(0)) safe(() => { void h.remove(); });
    await this.loading;
    await this.persistNow();
  }

  /** Public methods never throw into the app (SPEC 6). */
  private guard(fn: () => void) {
    try { fn(); } catch (e) { this.log("ignored a call that failed", e); }
  }

  private log(message: string, detail?: unknown) {
    if (this.cfg?.debug) console.warn(`[apparent] ${message}`, detail ?? "");
  }
}

export const Apparent = new ApparentClient();
export { trackScreens, screenName } from "./screens";
export default Apparent;
