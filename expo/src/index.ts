/**
 * Apparent SDK for Expo and bare React Native: product events for the Apparent dashboard. No native code.
 * expo-application and expo-localization are used when the app has them; without them it reads React Native's own
 * APIs (Settings / I18nManager, Intl) and react-native-device-info if present, or the app version passed to init().
 *
 *   import { Apparent } from "apparent-expo";
 *   Apparent.init({ apiUrl: "https://…", app: "einb", key: "…" });
 *   Apparent.track("paywall_view", { source: "onboarding" });
 *
 * Built not to lose data:
 * - every event is saved to the phone within a quarter second, and right away when the app goes to the background or crashes;
 * - one batch is sent at a time, and a batch only leaves the saved queue once the server has it;
 * - each request has a time limit, and retries wait longer each time (and honour Retry-After);
 * - the batch carries the phone's clock, so the server can correct phones set to the wrong time; it ignores duplicates.
 *
 * Automatic events: first_open, app_open (each visit), app_updated, app_background (seconds in the app), error,
 * deep_link_opened (the app opened by a link) and push_opened (a notification tapped, when the app has expo-notifications).
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { AppState, I18nManager, Platform, Settings, type AppStateStatus } from "react-native";
import * as ReactNative from "react-native";

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
  /** Report JavaScript errors and crashes. Default true. */
  captureErrors?: boolean;
  /**
   * The app's version ("1.4.0") and build ("42"). Only needed in bare React Native apps without expo-application or
   * react-native-device-info; it is how app_updated is noticed. Given here, it wins over what the modules say.
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
  /** Send deep_link_opened when a link opens the app. Default true. */
  trackDeepLinks?: boolean;
  /** Send push_opened when someone taps a notification (needs expo-notifications in the app). Default true. */
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
const LEGACY_KEY = "apparent:v1";
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

// The bundler's require (Metro, Re.Pack). Each call sits directly in a try block, which Metro treats as an optional
// dependency: an app without the package still bundles, and the require throws at run time instead.
declare const require: (id: string) => unknown;

type ExpoApplication = {
  nativeApplicationVersion?: string | null;
  nativeBuildVersion?: string | null;
  getInstallReferrerAsync?: () => Promise<string>;
};
type ExpoLocalization = {
  getLocales(): { languageTag: string; regionCode: string | null }[];
  getCalendars?: () => { timeZone: string | null }[];
};
type DeviceInfo = {
  getVersion?: () => string;
  getBuildNumber?: () => string;
  getInstallReferrer?: () => Promise<string>;
};

function expoApplication(): ExpoApplication | null {
  try { return require("expo-application") as ExpoApplication; } catch { return null; }
}

function expoLocalization(): ExpoLocalization | null {
  try { return require("expo-localization") as ExpoLocalization; } catch { return null; }
}

type NotificationResponse = { notification?: { request?: { identifier?: string; content?: { data?: Record<string, unknown> | null } } }; actionIdentifier?: string };
type ExpoNotifications = {
  addNotificationResponseReceivedListener?: (fn: (r: NotificationResponse) => void) => { remove(): void };
  getLastNotificationResponseAsync?: () => Promise<NotificationResponse | null>;
};

function expoNotifications(): ExpoNotifications | null {
  try { return require("expo-notifications") as ExpoNotifications; } catch { return null; }
}

function deviceInfo(): DeviceInfo | null {
  let mod: { default?: DeviceInfo } & DeviceInfo;
  try { mod = require("react-native-device-info") as typeof mod; } catch { return null; }
  return mod ? (mod.default ?? mod) : null;
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

/** Without expo-localization: iOS Settings (the phone's languages), Android I18nManager, else Intl. */
function rnLocale(): { languageTag: string | null; regionCode: string | null } {
  let first: string | undefined;
  let locale: string | undefined;
  if (Platform.OS === "ios") {
    const langs = safe(() => Settings.get("AppleLanguages")) as unknown;
    first = Array.isArray(langs) && typeof langs[0] === "string" ? langs[0] : undefined;
    locale = safe(() => Settings.get("AppleLocale")) as string | undefined;
  } else if (Platform.OS === "android") {
    locale = safe(() => I18nManager.getConstants?.().localeIdentifier) ?? undefined;
  }
  const lang = parseLocale(first) ?? parseLocale(locale) ?? parseLocale(intlOptions().locale);
  const region = parseLocale(locale)?.region ?? lang?.region ?? null;
  return { languageTag: lang?.tag ?? null, regionCode: region };
}

/** The bundle's address: in the iOS Simulator it is a file in the Mac's CoreSimulator folder (release builds and
 *  expo-updates bundles alike), on a phone it is under /private/var or /var. In development it is Metro's address. */
function scriptUrl(): string | null {
  const rn = ReactNative as unknown as {
    NativeModules?: Record<string, { scriptURL?: unknown; getConstants?: () => { scriptURL?: unknown } } | undefined>;
    TurboModuleRegistry?: { get?: (name: string) => { getConstants?: () => { scriptURL?: unknown } } | null };
  };
  const mod = safe(() => rn.TurboModuleRegistry?.get?.("SourceCode")) ?? safe(() => rn.NativeModules?.SourceCode);
  const url = safe(() => mod?.getConstants?.().scriptURL) ?? (mod as { scriptURL?: unknown } | undefined)?.scriptURL;
  return typeof url === "string" && url ? url : null;
}

/**
 * True in the iOS Simulator or an Android emulator, so Apparent leaves it out of the counts. expo-device's isDevice when
 * the app has it; otherwise React Native's own: the bundle's path on iOS, the build fingerprint on Android.
 */
export function isSimulator(): boolean {
  const expoDevice = safe(() => (globalThis as { expo?: { modules?: Record<string, Record<string, unknown> | undefined> } }).expo?.modules?.ExpoDevice);
  if (typeof expoDevice?.isDevice === "boolean") return !expoDevice.isDevice;
  const constants = ((Platform as unknown as { constants?: Record<string, unknown> }).constants ?? {}) as Record<string, unknown>;
  if (Platform.OS === "ios") {
    const url = scriptUrl();
    if (!url) return false;
    if (/\/CoreSimulator\//.test(url)) return true;
    // Metro on this Mac: only the Simulator reaches it as localhost (a phone uses the Mac's address).
    return /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/i.test(url);
  }
  if (Platform.OS === "android") {
    const fingerprint = typeof constants.Fingerprint === "string" ? constants.Fingerprint : "";
    const model = typeof constants.Model === "string" ? constants.Model : "";
    return /^generic|\/sdk_g?phone|\/emu64|emulator|genymotion|vbox86/i.test(fingerprint) || /Android SDK built for|Emulator/i.test(model);
  }
  return false;
}

function readDevice(cfg: ApparentConfig): Record<string, string | boolean | null> {
  const expoLoc = expoLocalization();
  const locale = expoLoc ? safe(() => expoLoc.getLocales()[0]) : rnLocale();
  const calendar = expoLoc ? safe(() => expoLoc.getCalendars?.()?.[0]) : { timeZone: text(intlOptions().timeZone) };
  const expoApp = expoApplication();
  const info = expoApp ? null : deviceInfo();
  const app = text(cfg.appVersion) ?? (expoApp ? expoApp.nativeApplicationVersion ?? null : text(safe(() => info?.getVersion?.())));
  const build = text(cfg.appBuild) ?? (expoApp ? expoApp.nativeBuildVersion ?? null : text(safe(() => info?.getBuildNumber?.())));
  const constants = ((Platform as unknown as { constants?: Record<string, unknown> }).constants ?? {}) as Record<string, unknown>;
  // iOS has no Platform.constants.Model; expo-device's native module (when the app has it) gives "iPhone15,2" like Mixpanel's $model.
  const expoDevice = safe(() => (globalThis as { expo?: { modules?: Record<string, Record<string, unknown> | undefined> } }).expo?.modules?.ExpoDevice);
  const model = [constants.Model, expoDevice?.modelId, expoDevice?.modelName].find((m): m is string => typeof m === "string" && m.length > 0);
  const device: Record<string, string | boolean | null> = {
    platform: Platform.OS,
    os: String(Platform.Version ?? ""),
    app,
    build,
    model: model ?? null,
    locale: locale?.languageTag ?? null,
    region: locale?.regionCode ?? null,
    tz: calendar?.timeZone ?? null,
  };
  // Only in a simulator: real phones send exactly what they always did.
  if (safe(isSimulator)) device.simulator = true;
  return device;
}

/** Android's Play install referrer, from expo-application or react-native-device-info. */
async function installReferrer(): Promise<string | null> {
  const expoApp = expoApplication();
  if (expoApp?.getInstallReferrerAsync) return (await safeAsync(() => expoApp.getInstallReferrerAsync!())) ?? null;
  const info = deviceInfo();
  if (info?.getInstallReferrer) return text(await safeAsync(() => info.getInstallReferrer!()));
  return null;
}

/** Event and screen names: a string that isn't blank. Anything else is ignored (SPEC 3.3). */
const isName = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

const isDev = () => typeof (globalThis as { __DEV__?: boolean }).__DEV__ === "boolean" && (globalThis as { __DEV__?: boolean }).__DEV__ === true;

export class ApparentClient {
  private cfg: ApparentConfig | null = null;
  private storage: Storage = AsyncStorage as unknown as Storage;
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
  private appStateSub: { remove(): void } | null = null;
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
  private linkSub: { remove(): void } | null = null;
  private pushSub: { remove(): void } | null = null;
  private lastPush: string | null = null;

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
    this.device = readDevice(cfg);
    const now = AppState.currentState;
    // A launch by a silent push or background fetch is not a visit: wait until the app is really in front.
    this.appState = now === "background" || now === "inactive" ? now : "active";
    this.loading = this.restore(cfg).catch((e) => this.log("could not read saved events", e));
    this.appStateSub = AppState.addEventListener("change", (s) => this.onAppState(s));
    this.interval = setInterval(() => void this.flush(), cfg.flushIntervalMs ?? 10_000);
    if (cfg.captureErrors !== false && !cfg.disabled) this.installErrorHandlers();
    // Consent first: nothing is collected until the saved state says they agreed, or optIn() is called.
    if (cfg.optOutByDefault) this.optedOut = true;
    if (!cfg.disabled && cfg.trackDeepLinks !== false) this.watchDeepLinks();
    if (!cfg.disabled && cfg.trackPushOpens !== false) this.watchPushOpens();
  }

  /** deep_link_opened for the link the app was launched with, and for each link that brings it back to the front. */
  private watchDeepLinks() {
    const linking = (ReactNative as unknown as { Linking?: { getInitialURL?: () => Promise<string | null>; addEventListener?: (t: "url", fn: (e: { url: string }) => void) => { remove(): void } } }).Linking;
    if (!linking) return;
    const opened = (url: unknown) => { if (typeof url === "string" && url) this.enqueue("deep_link_opened", cleanDeepLink(url)); };
    safe(() => { void linking.getInitialURL?.().then(opened, () => {}); });
    this.linkSub = safe(() => linking.addEventListener?.("url", (e) => opened(e?.url))) ?? null;
  }

  /** push_opened when a notification is tapped, with only the campaign and title the app put in its data. */
  private watchPushOpens() {
    const n = expoNotifications();
    if (!n) return;
    const tapped = (r: NotificationResponse | null | undefined) => {
      const req = r?.notification?.request;
      if (!req) return;
      const id = req.identifier ?? null;
      if (id && id === this.lastPush) return; // the launch response and the listener can both report one tap
      this.lastPush = id;
      const data = req.content?.data ?? {};
      const pick = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      this.enqueue("push_opened", { campaign: pick(data.campaign) ?? pick(data.utm_campaign), title: pick(data.title) });
    };
    safe(() => { void n.getLastNotificationResponseAsync?.().then(tapped, () => {}); });
    this.pushSub = safe(() => n.addNotificationResponseReceivedListener?.(tapped)) ?? null;
  }

  private async restore(cfg: ApparentConfig) {
    let saved: Partial<Saved> | null = null;
    try {
      const raw = await this.storage.getItem(STORAGE_KEY);
      if (raw) saved = validSaved(JSON.parse(raw));
    } catch { /* unreadable: start fresh */ }
    if (!saved) {
      try {
        const raw = await this.storage.getItem(LEGACY_KEY);
        if (raw) {
          const v1 = JSON.parse(raw) as { anon?: string; userId?: string | null; queue?: Omit<Queued, "a" | "u">[] };
          saved = validSaved({ anon: v1?.anon, anonSource: "own", userId: v1?.userId ?? null, props: {}, optedOut: false, app: null,
            queue: (Array.isArray(v1?.queue) ? v1.queue : []).map((e) => ({ ...e, a: v1.anon ?? "", u: v1.userId ?? null })) });
        }
      } catch { /* ignore */ }
    }
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
    if (fresh) { this.enqueue("first_open"); void this.recordInstallSource(); }
    else if (saved?.app && current && saved.app !== current) this.enqueue("app_updated", { from_version: saved.app, to_version: current });
    this.appVersion = current;
    if (this.appState === "active") this.open(true);
    else this.pendingOpen = true;
    if (this.optedOut) this.queue = [];
    await this.persistNow();
  }

  /** Android only: the Play install referrer (what the store link carried, e.g. "utm_source=reddit&utm_campaign=launch"). iOS has none. */
  private async recordInstallSource() {
    if (Platform.OS !== "android") return;
    const referrer = await installReferrer();
    if (!referrer) return;
    const q = new URLSearchParams(referrer);
    const source = q.get("utm_source");
    if (!source) return;
    this.enqueue("install_source", { utm_source: source, utm_medium: q.get("utm_medium"), utm_campaign: q.get("utm_campaign") });
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

  /** Store this person's Apparent id on their RevenueCat customer, so purchases join to what they did. */
  async linkRevenueCat(purchases: { setAttributes(attributes: Record<string, string | null>): unknown }): Promise<void> {
    await this.loading;
    try {
      await purchases.setAttributes({ apparent_id: this.anon });
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
    const body = JSON.stringify({ a: cfg.app, k: cfg.key, v: SDK_VERSION, sa: Date.now(), d, e });
    const ms = cfg.requestTimeoutMs ?? 10_000;
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
        fetch(`${cfg.apiUrl.replace(/\/$/, "")}/i`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: ctrl?.signal }),
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

  private installErrorHandlers() {
    const g = globalThis as unknown as {
      ErrorUtils?: { getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined; setGlobalHandler?: (fn: (error: unknown, isFatal?: boolean) => void) => void };
      HermesInternal?: { enablePromiseRejectionTracker?: (o: { allRejections: boolean; onUnhandled: (id: number, rejection: unknown) => void; onHandled: () => void }) => void };
      __apparentErrors?: boolean;
    };
    if (g.__apparentErrors) return;
    g.__apparentErrors = true;
    const eu = g.ErrorUtils;
    if (eu?.getGlobalHandler && eu.setGlobalHandler) {
      const previous = eu.getGlobalHandler();
      eu.setGlobalHandler((error, isFatal) => {
        try { this.captureError(error, { fatal: Boolean(isFatal), how: isFatal ? "crash" : "uncaught" }); } catch { /* never make it worse */ }
        if (!isFatal) {
          previous?.(error, isFatal);
          return;
        }
        // The app is about to die: give the save a moment, then let the crash continue.
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          previous?.(error, isFatal);
        };
        this.persistNow().then(finish, finish);
        setTimeout(finish, 300);
      });
    }
    // In development React Native shows its own warnings for these; only take over in release builds.
    const tracker = g.HermesInternal?.enablePromiseRejectionTracker;
    if (typeof tracker === "function" && !isDev()) {
      try {
        tracker({ allRejections: true, onUnhandled: (_id, rejection) => this.captureError(rejection, { how: "promise" }), onHandled: () => {} });
      } catch { /* not supported */ }
    }
  }

  /** Stop timers and listeners, after saving what is queued. For tests and hot reload. */
  async shutdown(): Promise<void> {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.appStateSub?.remove();
    this.appStateSub = null;
    this.linkSub?.remove();
    this.linkSub = null;
    this.pushSub?.remove();
    this.pushSub = null;
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
export default Apparent;
