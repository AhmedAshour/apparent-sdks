// A chat message's small formatting, the same in every chat (the SDK screen, Apparent's phone app and web):
// "# " (or ##, ###) starts a heading line, "- " / "• " a bullet, **bold**, [words](https://…) and bare addresses tap.
// Anything else stays as written. No imports: Apparent's own apps read this file too.

/** A piece of a line: plain, bold, and/or a link to open. */
export type TextPart = { text: string; url?: string; bold?: true };
/** One line of a message. */
export type TextLine = { kind: "p" | "h" | "li"; parts: TextPart[] };

export function chatLines(text: string): TextLine[] {
  return text.split("\n").map((line) => {
    const h = /^\s{0,3}#{1,3}\s+(.*)$/.exec(line);
    if (h) return { kind: "h", parts: splitLinks(h[1].replace(/\s+#+\s*$/, "")) };
    const li = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (li) return { kind: "li", parts: splitLinks(li[1]) };
    return { kind: "p", parts: line ? splitLinks(line) : [] };
  });
}

/** A line's text with **bold** marked (marks dropped) and its links split out, so they can be tapped. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = [];
  text.split(/\*\*(.+?)\*\*/s).forEach((seg, n) => {
    if (seg) for (const p of linksIn(seg)) parts.push(n % 2 ? { ...p, bold: true } : p);
  });
  return parts.length ? parts : [{ text }];
}

function linksIn(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const re = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|\b(https?:\/\/[^\s<>"]+|www\.[^\s<>"]+\.[a-z]{2,}[^\s<>"]*)/gi;
  let at = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > at) parts.push({ text: text.slice(at, i) });
    if (m[1]) {
      parts.push({ text: m[1], url: m[2] });
      at = i + m[0].length;
      continue;
    }
    let link = m[3];
    // A full stop or bracket right after an address belongs to the sentence.
    const tail = /[.,!?;:)\]]+$/.exec(link)?.[0] ?? "";
    if (tail) link = link.slice(0, -tail.length);
    parts.push({ text: link, url: link.startsWith("www.") ? `https://${link}` : link });
    at = i + link.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}
