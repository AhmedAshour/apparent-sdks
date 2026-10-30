/**
 * In-app chat with the app's team (Apparent.chat): people write from inside the app, the team answers from Apparent's
 * Chats, and the answers come back here. No native code, no screen: the app draws its own chat with these calls.
 *
 *   const off = Apparent.chat.subscribe((messages) => setMessages(messages));   // checks every few seconds while open
 *   await Apparent.chat.send("Can I export my data?");
 *   Apparent.chat.markRead();                                                // the newest answers were shown
 *   const n = await Apparent.chat.unread();                                  // for a badge
 *   Apparent.chat.setPushToken(expoPushToken);                               // answers as pushes (data.type "support_message")
 *
 * Each account (or install, before sign-in) has its own chat: a random chat key kept on the phone is the only thing
 * that reads it, so the app's write key alone never shows anyone's messages. A new phone starts a new chat.
 * Chat works even with `disabled` (that only stops events) and after optOut (people write on purpose).
 */
import type { Storage } from "./index";

export type ChatMessage = {
  id: string;
  ts: number;
  /** "user" = the person on this phone; "team" = the app's answer. */
  from: "user" | "team";
  text: string;
  /** Full address of a picture, or null. */
  image: string | null;
};
/** A picture to send: base64 of a JPEG, PNG or WebP under 6 MB (expo-image-picker's `base64: true` gives it). */
export type ChatImage = { base64: string };

export type ChatHost = {
  config(): { apiUrl: string; app: string; key: string } | null;
  who(): { anon: string; user: string | null; device: Record<string, unknown> };
  storage(): Storage;
  ready(): Promise<void>;
  log(message: string, detail?: unknown): void;
};

const POLL_MS = 4000;
const TIMEOUT_MS = 20_000;

function randomKey(): string {
  const bytes = new Uint8Array(24);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let s = "";
  for (const b of bytes) s += abc[b & 63];
  for (let i = 0; i < 8; i++) s += abc[Math.floor(Math.random() * 64)];
  return s;
}

export class ApparentChat {
  private list: ChatMessage[] = [];
  /** Whose chat `list` is (an account or `anon:<install>`): it is emptied when someone else signs in. */
  private owner: string | null = null;
  private newest = 0;
  private seen = 0;
  private unreadCount = 0;
  private push: string | null | undefined = undefined;
  private name: string | null | undefined = undefined;
  private listeners = new Set<(messages: ChatMessage[]) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private syncing: Promise<void> | null = null;
  private host: ChatHost;

  constructor(host: ChatHost) {
    this.host = host;
  }

  /** Messages so far, oldest first (asks the server once if nothing is loaded yet). */
  async messages(): Promise<ChatMessage[]> {
    await this.sync();
    return [...this.list];
  }

  /** Sends a message (text, a picture or both). Resolves with it as saved; throws with a short reason when it can't. */
  async send(text: string, image?: ChatImage): Promise<ChatMessage> {
    const body = (text ?? "").trim();
    if (!body && !image?.base64) throw new Error("Nothing to send");
    const r = await this.call("/chat/send", { text: body, image: image?.base64 ? { data: image.base64 } : undefined }, true);
    const m = this.fromServer(r.message);
    this.add([m]);
    if (typeof r.unread === "number") this.unreadCount = r.unread;
    return m;
  }

  /** Calls `fn` with every message now and whenever new ones arrive; checks every few seconds until unsubscribed. */
  subscribe(fn: (messages: ChatMessage[]) => void): () => void {
    this.listeners.add(fn);
    if (this.list.length) fn([...this.list]);
    void this.sync().catch(() => {});
    if (!this.timer) this.timer = setInterval(() => void this.sync().catch(() => {}), POLL_MS);
    return () => {
      this.listeners.delete(fn);
      if (!this.listeners.size && this.timer) { clearInterval(this.timer); this.timer = null; }
    };
  }

  /** How many answers this person hasn't seen (0 when they never wrote). For a badge. */
  async unread(): Promise<number> {
    if (!(await this.key(false))) return 0;
    await this.sync();
    return this.unreadCount;
  }

  /** The newest answers were shown: they stop counting as unread (sent with the next check, or now). */
  markRead(): void {
    const team = this.list.filter((m) => m.from === "team").at(-1);
    if (!team || team.ts <= this.seen) return;
    this.seen = team.ts;
    this.unreadCount = 0;
    void this.sync().catch(() => {});
  }

  /** The phone's Expo push token, so answers come as pushes (null: no more pushes). Sent with the next check. */
  setPushToken(token: string | null): void {
    this.push = token;
  }

  /** The name the team sees (else Apparent uses the account's name from setProperties). */
  setName(name: string | null): void {
    this.name = name;
  }

  /** Deletes this person's chat on the server and the phone (their account is deleted, or they asked). */
  async forget(): Promise<void> {
    const cfg = this.host.config();
    const ck = await this.key(false);
    if (cfg && ck) await this.call("/chat/forget", {}, false);
    if (cfg) await this.host.storage().setItem(this.storageKey(cfg.app), "");
    this.reset();
  }

  // ---------- inside ----------

  private storageKey(app: string) {
    const w = this.host.who();
    return `apparent:chat:${app}:${w.user ?? `anon:${w.anon}`}`;
  }

  private reset() {
    this.list = [];
    this.newest = 0;
    this.seen = 0;
    this.unreadCount = 0;
    this.emit();
  }

  private async key(create: boolean): Promise<string | null> {
    const cfg = this.host.config();
    if (!cfg) return null;
    await this.host.ready();
    const k = this.storageKey(cfg.app);
    let ck = await this.host.storage().getItem(k);
    if (!ck && create) {
      ck = randomKey();
      await this.host.storage().setItem(k, ck);
    }
    return ck || null;
  }

  /** New messages since the last check (and the push token, name and what was seen). One at a time. */
  private sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      const who = this.host.who();
      const owner = who.user ?? `anon:${who.anon}`;
      if (owner !== this.owner) { this.owner = owner; this.reset(); }
      if (!(await this.key(false))) return;
      const r = await this.call("/chat/sync", { since: this.newest, seen: this.seen || undefined }, false);
      if (this.owner !== owner) return;
      if (Array.isArray(r.messages)) this.add(r.messages.map((m: unknown) => this.fromServer(m)));
      if (typeof r.unread === "number") this.unreadCount = r.unread;
    })().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private add(messages: ChatMessage[]) {
    const known = new Set(this.list.map((m) => m.id));
    const fresh = messages.filter((m) => m.id && !known.has(m.id));
    if (!fresh.length) return;
    this.list = [...this.list, ...fresh].sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    this.newest = Math.max(this.newest, ...fresh.map((m) => m.ts));
    this.emit();
  }

  private emit() {
    const copy = [...this.list];
    for (const fn of this.listeners) {
      try { fn(copy); } catch (e) { this.host.log("a chat listener threw", e); }
    }
  }

  private fromServer(raw: unknown): ChatMessage {
    const m = (raw ?? {}) as Record<string, unknown>;
    const cfg = this.host.config();
    const image = typeof m.image === "string" && m.image ? (/^https?:/.test(m.image) ? m.image : `${(cfg?.apiUrl ?? "").replace(/\/$/, "")}${m.image}`) : null;
    return { id: String(m.id ?? ""), ts: Number(m.ts) || 0, from: m.from === "team" ? "team" : "user", text: typeof m.text === "string" ? m.text : "", image };
  }

  private async call(path: string, extra: Record<string, unknown>, create: boolean): Promise<Record<string, any>> {
    const cfg = this.host.config();
    if (!cfg) throw new Error("Apparent isn't set up (init first)");
    const ck = await this.key(create);
    if (!ck) throw new Error("No chat yet");
    const who = this.host.who();
    const d = { ...who.device, anon: who.anon, user: who.user };
    const body = JSON.stringify({ a: cfg.app, k: cfg.key, ck, d, push: this.push, name: this.name, ...extra });
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
    try {
      const res = await fetch(`${cfg.apiUrl.replace(/\/$/, "")}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body, signal: ctrl?.signal });
      const json = (await res.json().catch(() => ({}))) as Record<string, any>;
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : `Chat: ${res.status}`);
      return json;
    } finally {
      if (t) clearTimeout(t);
    }
  }
}
