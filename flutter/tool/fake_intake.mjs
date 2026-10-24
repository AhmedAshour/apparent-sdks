// A fake Apparent intake for the example app: answers POST /i like server/ingest.ts and prints each batch.
//   node tool/fake_intake.mjs [port]      (default 8787, listens on this computer only)
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8787);
createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.method !== "POST" || req.url !== "/i") { res.writeHead(404).end(); return; }
    try {
      const b = JSON.parse(body);
      console.log(`${b.a} ${b.v} ${b.d?.platform} ${b.d?.model} anon=${b.d?.anon} user=${b.d?.user ?? "-"}`);
      for (const e of b.e ?? []) console.log(`  ${e.n} ${e.p ? JSON.stringify(e.p) : ""}`);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, accepted: b.e?.length ?? 0, duplicates: 0, skipped: 0 }));
    } catch {
      res.writeHead(400).end('{"error":"bad json"}');
    }
  });
}).listen(port, "127.0.0.1", () => console.log(`fake Apparent intake on http://127.0.0.1:${port}/i`));
