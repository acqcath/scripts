// Videos vs Images priority (user, 2026-11-26): the medium the search needs more goes first; nothing is hidden
import { test, expect } from "bun:test";
import * as A from "../files/answers.js";
const top = (vids) => Array.from({ length: 10 }, (_, i) => ({ video: i < vids, title: "x" }));
const first = (q, vids, learn) => (A.mediaOrder(A.mediaNeed(q, top(vids), learn)).video === 1 ? "video" : "image");
test("media: pictures first for looks/notation/facts, video first for hands-on, reviews, songs", () => {
  expect(first("kalimba numbers and variance in pitch", 3)).toBe("image");
  expect(first("black holes", 1)).toBe("image");
  expect(first("how to change a bike tire", 3)).toBe("video");
  expect(first("how to tie a tie", 5)).toBe("video");
  expect(first("sony wh-1000xm6 review", 3)).toBe("video");
  expect(first("taylor swift fortnight", 6)).toBe("video");
  expect(A.mediaNeed("python list comprehension", top(2))).toEqual({ video: 0, image: 0 });
});
test("media: your clicks move a search's medium", () => {
  let m = {};
  for (let i = 0; i < 4; i++) m = A.learnClick(m, "kalimba song tutorial", "video");
  expect(first("kalimba numbers and variance in pitch", 3)).toBe("image");
  expect(A.mediaNeed("kalimba numbers", top(3), m).video).toBeGreaterThan(A.mediaNeed("kalimba numbers", top(3)).video);
  for (let i = 0; i < 500; i++) m = A.learnClick(m, `word${i}`, "image");
  expect(Object.keys(m).length).toBe(400);
});
