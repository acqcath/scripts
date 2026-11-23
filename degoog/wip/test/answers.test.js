// Local answer card (files/answers.js): every kind, plus things that must NOT get a card
import { test, expect } from "bun:test";
import * as A from "../files/answers.js";
const now = Date.parse("2026-11-23T10:00:00"); // a Monday
const v = (q) => { const r = A.answer(q, now); return r && (r.value || r.title); };

test("answers: math (safe parser, radians, implicit multiply, factorial)", () => {
  expect(v("12 x 350")).toBe("4,200");
  expect(v("2^10")).toBe("1,024");
  expect(v("sqrt(16)+3!")).toBe("10");
  expect(v("(1+2)*3/4")).toBe("2.25");
  expect(v("what is 7 * 6")).toBe("42");
  expect(v("-3 - -2")).toBe("−1");
  expect(A.answer("12 x 350", now).detail).toBe("12 × 350 = 4,200");
  expect(v("1/0")).toBe(null);
  expect(v("2x+3")).toBe(null);
  for (const q of ["15-213", "412-268-3000", "15213-3890", "2026-11-23", "11/23/2026", "1.2.3", "10-3", "python", "e", "2024"]) expect([q, v(q)]).toEqual([q, null]);
});
test("answers: units, temperature and cooking (US cups)", () => {
  expect(v("5 mi in km")).toBe("8.04672 km");
  expect(v("100 f to c")).toBe("37.78°C");
  expect(v("100 degrees f to c")).toBe("37.78°C");
  expect(v("1 c to ml")).toBe("236.588 ml");
  expect(v("how many ml in 1 cup")).toBe("236.588 ml");
  expect(v("2 cups flour in grams")).toBe("240 g");
  expect(v("200 g sugar to cups")).toBe("1.01 cups");
  expect(v("1 gb in mib")).toBe("953.674 MiB");
  expect(v("5 km")).toBe(null);
  expect(v("100 usd to eur")).toBe(null); // currency is a network answer (M4)
});
test("answers: tip and percent", () => {
  expect(A.answer("20% tip on 85", now)).toMatchObject({ value: "$17.00", detail: "20% of $85.00 · total $102.00", copy: "17.00" });
  expect(v("15% of 200")).toBe("30");
  expect(v("30 is what percent of 120")).toBe("25%");
  expect(v("percent change from 80 to 100")).toBe("+25%");
});
test("answers: date math (local days, next year when this year's date passed)", () => {
  expect(A.answer("days until christmas", now)).toMatchObject({ label: "Until Christmas", value: "32 days", detail: "Friday, December 25, 2026 · 4 weeks 4 days" });
  expect(v("days until thanksgiving")).toBe("3 days");
  expect(A.answer("days until halloween", now).detail).toContain("2027");
  expect(v("days until easter")).toBe(`${Math.round((new Date(2027, 2, 28) - new Date(2026, 10, 23)) / 864e5)} days`);
  expect(v("days since jan 1")).toBe("326 days");
  expect(v("30 days from today")).toBe("Wed, Dec 23, 2026");
  expect(v("2 weeks ago")).toBe("Mon, Nov 9, 2026");
});
test("answers: patterns with checksums; look-alikes get nothing", () => {
  expect(A.answer("1Z999AA10123456784", now)).toMatchObject({ label: "UPS tracking number", href: "https://www.ups.com/track?tracknum=1Z999AA10123456784" });
  expect(v("1Z999AA10123456785")).toBe(null); // wrong check digit
  expect(A.answer("9780140328721", now).href).toBe("https://openlibrary.org/isbn/9780140328721");
  expect(v("9780140328722")).toBe(null);
  expect(v("0306406152")).toBe(null); // 10 digits only after "isbn"
  expect(v("isbn 0306406152")).toBe("Open Library: ISBN 0306406152");
  expect(A.answer("CVE-2021-44228", now).href).toBe("https://nvd.nist.gov/vuln/detail/CVE-2021-44228");
  expect(A.answer("10.1038/nature14539", now).href).toBe("https://doi.org/10.1038/nature14539");
  expect(A.answer("arxiv 1706.03762", now).href).toBe("https://arxiv.org/abs/1706.03762");
  expect(A.answer("0x80070005", now).label).toBe("Windows error code");
  expect(A.answer("8.8.8.8", now).detail).toBe("Public address");
  expect(A.answer("192.168.1.1", now).detail).toBe("Private network address");
  expect(v("256.1.1.1")).toBe(null);
  expect(A.answer("#ff8800", now)).toMatchObject({ value: "#FF8800", swatch: "#FF8800", detail: "rgb(255, 136, 0) · hsl(32, 100%, 50%)" });
  expect(v("c0ffee")).toBe(null);
  expect(A.answer("pip requests", now).href).toBe("https://pypi.org/project/requests/");
  expect(A.answer("npm lodash", now).href).toBe("https://www.npmjs.com/package/lodash");
  expect(A.answer("facebook/react", now).href).toBe("https://github.com/facebook/react");
  for (const q of ["km/h", "and/or", "24/7", "rx 7800", "gt 710", "ps 5", "fedex", "123456789012"]) expect([q, v(q)]).toEqual([q, null]);
  expect(A.answer("UA 123", now).href).toBe("https://www.flightaware.com/live/flight/UA123");
  expect(A.answer("fedex 123456789012", now).label).toBe("FedEx tracking number");
  expect(A.answer("TBA123456789012", now).label).toBe("Amazon tracking number");
  expect(A.answer("9400111899223197428490", now).label).toBe("USPS tracking number");
});
