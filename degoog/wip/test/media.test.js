// Videos box / Images row placement (user, 2026-11-26): format share x fit, on one scale with the results
import { test, expect } from "bun:test";
import * as A from "../files/answers.js";
test("media: a box goes above the first result it outweighs, never above the top result", () => {
  const fmt = A.fmtShares({ video: 0.9, image: 0.2, text: 0.4 }); // a how-to: video wins
  const rels = [0.95, 0.9, 0.85, 0.6, 0.5];
  const w = A.boxWorth(fmt, [0.9, 0.8, 0.85, 0.1], "video");
  expect(A.boxAt(fmt, rels, w)).toBe(1);
  const f2 = A.fmtShares({ video: 0.1, image: 0.7, text: 0.8 }); // a notation question: videos sink
  expect(A.boxAt(f2, rels, A.boxWorth(f2, [0.9, 0.8, 0.85], "video"))).toBe(rels.length);
  expect(A.boxAt(f2, rels, A.boxWorth(f2, [0.9, 0.8, 0.85], "image"))).toBeLessThan(rels.length);
  expect(A.boxWorth(null, [0.9], "video")).toBe(null);
});
test("media: taps move a format's share, no data = no change", () => {
  const f = A.fmtShares({ video: 0.5, image: 0.5, text: 0.5 });
  expect(A.tapBias(f, {})).toEqual(f);
  const b = A.tapBias(f, { video: { s: 20, t: 10 }, image: { s: 20, t: 1 } });
  expect(b.video).toBeGreaterThan(b.image);
});
