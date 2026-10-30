/**
 * What the ready-made chat screen (./chat-screen.tsx) shows, worked out without React so it can be tested: the look
 * from an app's few colours, links in a message, the rows (day labels, times, pending sends) and the default words.
 */
import type { ChatMessage } from "./chat";

/** The few things an app may change. Everything else (layout, sizes, bubbles, motion) is the same in every app. */
export type ChatTheme = {
  /** The app's main colour: your bubbles and the send button. */
  accent?: string;
  /** Text on the accent (default: dark or white, whichever reads better). */
  onAccent?: string;
  /** Font family for every text (the app's own); `fontBold` for the title, else the same with weight 600. */
  font?: string;
  fontBold?: string;
  /** Corner roundness of bubbles and the box, 0-24 (default 18). */
  radius?: number;
  /** Dark or light; default follows the phone. */
  dark?: boolean;
  /** Only if the app's screens aren't plain white / near black: the other surfaces follow it (and it decides dark). */
  background?: string;
};

export type ChatColors = {
  accent: string; onAccent: string; background: string; team: string; onTeam: string; muted: string; line: string;
  input: string; danger: string; link: string; linkOnAccent: string;
};

const DEFAULT_ACCENT = "#2F6BFF";

function rgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, "$&$&") : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const c = rgb(hex);
  if (!c) return 0.5;
  const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** Dark or white text on a colour, whichever reads better. */
export const textOn = (hex: string) => (contrast(hex, "#FFFFFF") >= contrast(hex, "#111111") ? "#FFFFFF" : "#111111");

/** `a` moved toward `b` by `t` (0-1), as #RRGGBB. */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a), y = rgb(b);
  if (!x || !y) return a;
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export function chatColors(theme: ChatTheme, phoneDark: boolean): ChatColors {
  const dark = theme.dark ?? phoneDark;
  const accent = theme.accent && rgb(theme.accent) ? theme.accent : DEFAULT_ACCENT;
  const onAccent = theme.onAccent ?? textOn(accent);
  const base = { accent, onAccent, linkOnAccent: onAccent };
  // An app's own background: the other surfaces are that colour a little darker (or lighter), so a cream app stays cream.
  if (theme.background && rgb(theme.background)) {
    const bg = theme.background, ink = textOn(bg) === "#FFFFFF" ? "#FFFFFF" : "#111111";
    const lightBg = ink === "#111111";
    return { ...base, background: bg, team: mix(bg, ink, 0.08), onTeam: lightBg ? "#16181D" : "#F2F3F5", muted: mix(bg, ink, 0.64),
      line: mix(bg, ink, 0.14), input: mix(bg, ink, 0.05), danger: lightBg ? "#C62828" : "#FF7A70", link: lightBg ? "#1D4ED8" : "#8FB4FF" };
  }
  return dark
    ? { ...base, background: "#0E0F12", team: "#24262C", onTeam: "#F2F3F5", muted: "#9A9EA8", line: "#2C2F36", input: "#1A1C21", danger: "#FF7A70", link: "#8FB4FF" }
    : { ...base, background: "#FFFFFF", team: "#F0F1F4", onTeam: "#16181D", muted: "#6B7079", line: "#E4E6EA", input: "#F6F7F9", danger: "#C62828", link: "#1D4ED8" };
}

export const chatRadius = (theme: ChatTheme) => Math.max(0, Math.min(24, theme.radius ?? 18));

/** A message's text with its web addresses split out, so they can be tapped. */
export type TextPart = { text: string; url?: string };
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const re = /\b(https?:\/\/[^\s<>"]+|www\.[^\s<>"]+\.[a-z]{2,}[^\s<>"]*)/gi;
  let at = 0;
  for (const m of text.matchAll(re)) {
    let link = m[0];
    // A full stop or bracket right after an address belongs to the sentence.
    const tail = /[.,!?;:)\]]+$/.exec(link)?.[0] ?? "";
    if (tail) link = link.slice(0, -tail.length);
    const i = m.index ?? 0;
    if (i > at) parts.push({ text: text.slice(at, i) });
    parts.push({ text: link, url: link.startsWith("www.") ? `https://${link}` : link });
    at = i + link.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts.length ? parts : [{ text }];
}

/** A message on this phone: sent, on its way, or not sent (tap to try again). */
export type ShownMessage = ChatMessage & { state?: "sending" | "failed"; localImage?: string | null };

export type ChatRow =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; message: ShownMessage; first: boolean; last: boolean; time: string | null };

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** Rows top to bottom: a day label when the day changes, bubbles grouped by who wrote (within 5 minutes), and the time
 *  under the last bubble of each group. */
export function chatRows(messages: ShownMessage[], words: ChatWords, locale?: string, now = Date.now()): ChatRow[] {
  const rows: ChatRow[] = [];
  const time = (ts: number) => { try { return new Date(ts).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }); } catch { return new Date(ts).toTimeString().slice(0, 5); } };
  const day = (ts: number) => {
    if (sameDay(ts, now)) return words.today;
    if (sameDay(ts, now - 86_400_000)) return words.yesterday;
    try { return new Date(ts).toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" }); } catch { return new Date(ts).toDateString(); }
  };
  messages.forEach((m, i) => {
    const prev = messages[i - 1], next = messages[i + 1];
    if (!prev || !sameDay(prev.ts, m.ts)) rows.push({ kind: "day", key: `d${m.ts}`, label: day(m.ts) });
    const together = (a?: ShownMessage, b?: ShownMessage) => Boolean(a && b && a.from === b.from && sameDay(a.ts, b.ts) && Math.abs(b.ts - a.ts) < 300_000);
    const first = !together(prev, m), last = !together(m, next);
    rows.push({ kind: "message", key: m.id, message: m, first, last, time: last && !m.state ? time(m.ts) : null });
  });
  return rows;
}

/** Every word the screen says. English by default; pass your own (any language) through `words`. */
export type ChatWords = {
  title: string;
  /** Under the title: when to expect an answer. */
  subtitle: string;
  placeholder: string;
  send: string;
  addPhoto: string;
  close: string;
  emptyTitle: string;
  emptyBody: string;
  sending: string;
  failed: string;
  today: string;
  yesterday: string;
};

export const CHAT_WORDS: ChatWords = {
  title: "Help",
  subtitle: "We usually answer within a few hours",
  placeholder: "Write a message",
  send: "Send",
  addPhoto: "Add a photo",
  close: "Close",
  emptyTitle: "Ask us anything",
  emptyBody: "Something not working, or an idea? Write it here and we'll answer in this chat.",
  sending: "Sending…",
  failed: "Not sent. Tap to try again",
  today: "Today",
  yesterday: "Yesterday",
};
