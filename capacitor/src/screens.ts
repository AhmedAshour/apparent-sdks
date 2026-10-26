/**
 * Screens from any router (Ionic, Vue Router, React Router, Angular, or none): watches the address the WebView shows
 * (history.pushState / replaceState, back and forward, #/hash routes) and sends a screen_view for each new one.
 *
 *   import { trackScreens } from "apparent-capacitor";
 *   trackScreens();
 *
 * The name is the route, not the address: "/practice/17" and "/practice/18" are both "practice/:id" (the real path
 * goes in `path`), so screens group. "/" is "home". Pass `name` to choose names yourself (return null to skip one).
 */
import { Apparent, type ApparentClient } from "./index";

/** "/orders/8f14e45f-ceea-467a-9575-6e0b3ad3cfa1/items/42?x=1" → "orders/:id/items/:id". */
export function screenName(path: string): string {
  const clean = String(path).split(/[?#]/)[0]!.replace(/\/{2,}/g, "/").replace(/^\/|\/$/g, "");
  if (!clean) return "home";
  return clean.split("/").map((seg) => {
    let s = seg;
    try { s = decodeURIComponent(seg); } catch { /* keep as is */ }
    const id = /^\d+$/.test(s) // 42
      || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) // uuid
      || /^[0-9a-f]{12,}$/i.test(s) // hashes, Mongo ids
      || (s.length >= 16 && /\d/.test(s) && /^[A-Za-z0-9_-]+$/.test(s) && !/^[a-z]+(?:[-_][a-z]+)*$/.test(s)); // Firebase-style ids
    return id ? ":id" : seg;
  }).join("/").slice(0, 80);
}

type Options = {
  /** Your own name for a path; return null to send nothing for it. Default: screenName(path). */
  name?: (path: string) => string | null | undefined;
  /** The client, for tests. Default: Apparent. */
  client?: Pick<ApparentClient, "screen">;
};

/** Start sending screen_view on every route change. Returns a function that stops it. */
export function trackScreens(options: Options = {}): () => void {
  const w = globalThis as unknown as {
    location?: { pathname: string; hash: string; search: string };
    history?: History;
    addEventListener?: (t: string, f: () => void) => void;
    removeEventListener?: (t: string, f: () => void) => void;
  };
  const loc = w.location;
  const history = w.history;
  if (!loc || !history || typeof w.addEventListener !== "function") return () => {};
  const client = options.client ?? Apparent;
  let last: string | null = null;
  const seen = () => {
    try {
      // Hash routers (#/settings) keep the page at "/".
      const path = loc.hash.startsWith("#/") ? loc.hash.slice(1) : loc.pathname;
      const bare = path.split(/[?#]/)[0] || "/";
      if (bare === last) return;
      last = bare;
      const name = options.name ? options.name(bare) : screenName(bare);
      if (name) client.screen(name, { path: bare.slice(0, 200) });
    } catch { /* never break navigation */ }
  };
  const push = history.pushState;
  const replace = history.replaceState;
  // Routers call these after changing the address; ours runs after theirs, so location is already the new one.
  history.pushState = function (this: History, ...args: Parameters<History["pushState"]>) {
    const out = push.apply(this, args);
    seen();
    return out;
  };
  history.replaceState = function (this: History, ...args: Parameters<History["replaceState"]>) {
    const out = replace.apply(this, args);
    seen();
    return out;
  };
  w.addEventListener("popstate", seen);
  w.addEventListener("hashchange", seen);
  seen();
  return () => {
    history.pushState = push;
    history.replaceState = replace;
    w.removeEventListener?.("popstate", seen);
    w.removeEventListener?.("hashchange", seen);
  };
}
