// The ready-made chat screen's pure parts (src/chat-view.ts): colours from one accent, links, rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHAT_WORDS, chatColors, chatRadius, chatRows, contrast, splitLinks, textOn } from "../src/chat-view.ts";
import { chatLines } from "../src/chat-text.ts";

test("text on the accent always reads (4.5:1 or the better of dark and white)", () => {
  assert.equal(textOn("#FFD54F"), "#111111");
  assert.equal(textOn("#0F7B5F"), "#FFFFFF");
  for (const a of ["#2F6BFF", "#0F7B5F", "#D4AF8C", "#E53935", "#111111", "#FFFFFF"]) {
    const c = chatColors({ accent: a }, false);
    assert.ok(contrast(c.accent, c.onAccent) >= 4.5 || contrast(a, "#FFFFFF") < 4.5 && contrast(a, "#111111") < 4.5, a);
  }
});

test("a bad colour falls back to the default, dark follows the phone unless the app says", () => {
  assert.equal(chatColors({ accent: "green" }, false).accent, "#2F6BFF");
  assert.equal(chatColors({}, true).background, "#0E0F12");
  assert.equal(chatColors({ dark: false }, true).background, "#FFFFFF");
  assert.equal(chatRadius({ radius: 99 }), 24);
  assert.equal(chatRadius({}), 18);
});

test("links are split out, without the sentence's full stop", () => {
  assert.deepEqual(splitLinks("See https://halal.app/help. Thanks"), [
    { text: "See " }, { text: "https://halal.app/help", url: "https://halal.app/help" }, { text: ". Thanks" },
  ]);
  assert.deepEqual(splitLinks("www.apparent.fyi"), [{ text: "www.apparent.fyi", url: "https://www.apparent.fyi" }]);
  assert.deepEqual(splitLinks("no links"), [{ text: "no links" }]);
});

test("**bold** loses its marks, links inside it still tap, a lone ** stays", () => {
  assert.deepEqual(splitLinks("اختر **الصلوات** ثم"), [{ text: "اختر " }, { text: "الصلوات", bold: true }, { text: " ثم" }]);
  assert.deepEqual(splitLinks("**see https://a.io**"), [
    { text: "see ", bold: true }, { text: "https://a.io", url: "https://a.io", bold: true },
  ]);
  assert.deepEqual(splitLinks("2 ** 3"), [{ text: "2 ** 3" }]);
});

test("rows: a day label, groups within 5 minutes, the time under the last of a group", () => {
  const now = new Date(2026, 9, 30, 12, 0).getTime();
  const m = (id: string, from: "user" | "team", ts: number) => ({ id, from, ts, text: id, image: null });
  const rows = chatRows([
    m("a", "user", now - 86_400_000), m("b", "user", now - 600_000), m("c", "user", now - 540_000), m("d", "team", now - 60_000),
  ], CHAT_WORDS, "en-GB", now);
  assert.deepEqual(rows.map((r) => r.kind === "day" ? r.label : `${r.key}${r.first ? "F" : ""}${r.last ? "L" : ""}${r.time ? "t" : ""}`),
    ["Yesterday", "aFLt", "Today", "bF", "cLt", "dFLt"]);
  const sending = chatRows([{ ...m("x", "user", now), state: "sending" as const }], CHAT_WORDS, "en-GB", now);
  assert.equal(sending[1].kind === "message" && sending[1].time, null);
});

test("an app's own background: surfaces follow it and the muted text still reads", async () => {
  const { mix } = await import("../src/chat-view.ts");
  assert.equal(mix("#000000", "#FFFFFF", 0.5), "#808080");
  const c = chatColors({ accent: "#c67139", background: "#f5ead8" }, true);
  assert.equal(c.background, "#f5ead8", "a cream app stays cream even on a dark phone");
  assert.ok(contrast(c.muted, c.background) >= 4.5, `muted ${c.muted}`);
  assert.ok(contrast(c.onTeam, c.team) >= 7);
  assert.equal(c.onAccent, "#111111");
});

test("headings, bullets and [words](link) lines; anything else as written", () => {
  assert.deepEqual(chatLines("## خطوات\n- افتح **الصلوات**\n\nSee [the guide](https://a.io/x)."), [
    { kind: "h", parts: [{ text: "خطوات" }] },
    { kind: "li", parts: [{ text: "افتح " }, { text: "الصلوات", bold: true }] },
    { kind: "p", parts: [] },
    { kind: "p", parts: [{ text: "See " }, { text: "the guide", url: "https://a.io/x" }, { text: "." }] },
  ]);
  assert.deepEqual(chatLines("#hashtag and 5 * 3"), [{ kind: "p", parts: [{ text: "#hashtag and 5 * 3" }] }]);
  assert.deepEqual(chatLines("[x](javascript:alert(1))")[0].parts, [{ text: "[x](javascript:alert(1))" }]);
});
