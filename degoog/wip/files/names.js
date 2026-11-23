// Names from Wikipedia's article titles: words that aren't in the English word list but appear in 3+ titles
// ("Asura Scans", "OpenAI Five"), or are a one-word title written like a name (PuTTY, NASA, iPhone, R2-D2)
const fs = require("fs"), zlib = require("zlib"), readline = require("readline");
const DIR = "/app/data/plugins/clean-titles", GZ = "/tmp/ct-titles.gz";
const SRC = process.env.CT_TITLES_URL || "https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-all-titles-in-ns0.gz";
const words = new Set();
for (const l of fs.readFileSync(`${DIR}/words.txt`, "utf8").split("\n")) { const w = l.replace(/^﻿/, "").split(" ")[0]; if (w) words.add(w); }
const r = await fetch(SRC);
if (!r.ok) { console.log(`Wikipedia names: download failed (${r.status}), skipped; next update tries again`); process.exit(0); }
await Bun.write(GZ, r);
// Counting ~5 million different words in little memory: two 32 MB tables of counts, the smaller one wins
const N = 1 << 25, A = new Uint8Array(N), B = new Uint8Array(N);
const h = (s, seed) => { let x = seed; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0) & (N - 1); };
const each = async (fn) => {
  const rl = readline.createInterface({ input: fs.createReadStream(GZ).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) {
    const title = line.replace(/_\([^)]*\)$/, "");
    const parts = title.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (!parts.length || line === "page_title") continue;
    fn(title, parts);
  }
};
// 2-letter words only when written in capitals ("AI", "TV"), so "de", "la", "jr" stay out
const cand = (x) => x.length >= 2 && x.length <= 24 && !/^\d+$/.test(x) && !words.has(x);
await each((title, parts) => {
  if (parts.length < 2) return;
  for (const x of new Set(parts.filter((p) => p.length > 2 || p === p.toUpperCase()).map((p) => p.toLowerCase()))) if (cand(x)) { const i = h(x, 2166136261), j = h(x, 374761393); if (A[i] < 255) A[i]++; if (B[j] < 255) B[j]++; }
});
const out = new Set();
await each((title, parts) => {
  if (parts.length === 1) {
    const x = parts[0];
    if (cand(x.toLowerCase()) && (/\p{Ll}\p{Lu}/u.test(x) || (x.length >= 2 && x === x.toUpperCase() && /\p{L}/u.test(x)) || (/\d/.test(x) && /\p{L}/u.test(x)))) out.add(x.toLowerCase());
    return;
  }
  for (const p of parts) { const x = p.toLowerCase(); if ((p.length > 2 || p === p.toUpperCase()) && cand(x) && Math.min(A[h(x, 2166136261)], B[h(x, 374761393)]) >= 3) out.add(x); }
});
fs.writeFileSync(`${DIR}/names.txt`, [...out].join("\n"));
fs.rmSync(GZ, { force: true });
console.log(`Wikipedia names: ${out.size} saved`);