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

test("answers: currency from the ECB copy (none without it)", () => {
  const fx = { date: "2026-11-20", rates: { USD: 1.05, GBP: 0.83, JPY: 160.5, CAD: 1.47 } };
  expect(A.answer("100 usd to eur", now, { fx })).toMatchObject({ label: "Currency · ECB rate of Nov 20", value: "€95.24", detail: "$100.00 · 1 USD = 0.95238 EUR", copy: "95.24" });
  expect(A.answer("€50 in dollars", now, { fx }).value).toBe("$52.50");
  expect(A.answer("50 euros to yen", now, { fx }).value).toBe("¥8,025");
  expect(A.answer("100 usd to eur", now)).toBe(null);
  expect(A.answer("100 to eur", now, { fx })).toBe(null);
});

test("answers: versions and support from endoflife.date cycles", () => {
  const win = [{ cycle: "11-25h2-e", eol: "2028-10-10", latest: "10.0.26200" }, { cycle: "11-25h2-w", eol: "2027-10-12", latest: "10.0.26200" }, { cycle: "10-22h2-e", eol: "2025-10-14", latest: "10.0.19045" }, { cycle: "10-22h2-w", eol: "2025-10-14", latest: "10.0.19045" }, { cycle: "10-21h2-iot-lts", eol: "2032-01-13" }];
  expect(A.eolAnswer(A.eolQuery("is windows 10 supported"), win, now)).toMatchObject({ label: "Windows 10 support", value: "No", detail: "Ended Oct 14, 2025 · 22H2 · latest 10.0.19045" });
  expect(A.eolAnswer(A.eolQuery("is windows 11 supported"), win, now)).toMatchObject({ value: "Yes", detail: "Supported until Oct 12, 2027 · 25H2 · latest 10.0.26200" });
  const py = [{ cycle: "3.14", releaseDate: "2025-10-07", eol: "2030-10-31", latest: "3.14.1", latestReleaseDate: "2026-11-18" }, { cycle: "3.8", eol: "2024-10-07", latest: "3.8.20" }];
  expect(A.eolAnswer(A.eolQuery("latest python"), py, now)).toMatchObject({ value: "Python 3.14.1", detail: "Released 5 days ago · supported until Oct 31, 2030", copy: "3.14.1" });
  expect(A.eolAnswer(A.eolQuery("python 3.8 end of life"), py, now).value).toBe("No");
  expect(A.eolAnswer(A.eolQuery("is python 2.7 supported"), py, now)).toBe(null); // unknown cycle: nothing
  expect(A.eolQuery("node latest version").slug).toBe("nodejs");
  for (const q of ["latest news", "is it supported", "python tutorial", "latest"]) expect([q, A.eolQuery(q)]).toEqual([q, null]);
});

test("answers: Wikidata facts (query shapes, metric + imperial, as-of, age, distance)", () => {
  expect(A.wdQuery("how tall is the eiffel tower")).toEqual({ fact: "height", s: "eiffel tower" });
  expect(A.wdQuery("pittsburgh population")).toEqual({ fact: "population", s: "pittsburgh" });
  expect(A.wdQuery("distance between pittsburgh and new york")).toEqual({ fact: "distance", s: "pittsburgh", s2: "new york" });
  expect(A.wdQuery("nvidia ceo")).toEqual({ fact: "ceo", s: "nvidia" });
  for (const q of ["jaguar", "python", "taylor swift", "react useEffect cleanup"]) expect([q, A.wdQuery(q)]).toEqual([q, null]);
  expect(A.wdAnswer(A.wdQuery("eiffel tower height"), { label: "Eiffel Tower", desc: "tower in Paris, France", v: [{ amount: "+330", unit: "Q11573" }] }, now)).toMatchObject({ value: "330 m", detail: "1,083 ft · tower in Paris, France", src: "Wikidata" });
  expect(A.wdAnswer(A.wdQuery("pittsburgh population"), { label: "Pittsburgh", desc: "city in Pennsylvania", v: [{ amount: "+302971", asOf: "+2020-04-01T00:00:00Z" }] }, now)).toMatchObject({ value: "302,971", detail: "as of 2020 · city in Pennsylvania" });
  expect(A.wdAnswer(A.wdQuery("how old is taylor swift"), { label: "Taylor Swift", desc: "American singer-songwriter", v: [{ time: "+1989-12-13T00:00:00Z", prec: 11 }] }, now)).toMatchObject({ value: "36 years", detail: "born December 13, 1989 · American singer-songwriter" });
  expect(A.wdAnswer(A.wdQuery("distance between pittsburgh and new york"), { label: "Pittsburgh", v: [{ lat: 40.4397, lon: -79.9764 }], b: { label: "New York City", v: [{ lat: 40.7127, lon: -74.0059 }] } }, now)).toMatchObject({ value: "505 km", detail: "314 mi as the crow flies" });
  expect(A.wdAnswer(A.wdQuery("eiffel tower height"), { label: "Eiffel Tower", v: [{ amount: "+330", unit: "Q99999" }] }, now)).toBe(null); // unknown unit: nothing
});

test("answers: CMU course numbers by CMU Courses' method (2 recent fall/spring semesters, weighted, Pittsburgh, no 0% rows)", () => {
  const r = (year, semester, instructor, n, hrs, t, c, extra = {}) => ({ year, semester, instructor, numRespondents: n, responseRate: "50%", hrsPerWeek: hrs, rating: [0, 0, 0, 0, 0, 0, 0, t, c], location: "Pittsburgh, Pennsylvania", ...extra });
  const rows = [r(2026, "spring", "RAILING, BRIAN", 100, 14, 4.4, 4.1), r(2026, "spring", "GIBBONS, PHILLIP", 80, 15, 4.2, 3.9), r(2026, "spring", "GIBBONS, PHILLIP", 80, 15, 4.2, 3.9), r(2025, "fall", "RAILING, BRIAN", 120, 13, 4.2, 4.0), r(2025, "summer", "X, Y", 10, 30, 1, 1), r(2025, "spring", "OLD, PROF", 100, 20, 2, 2), r(2025, "fall", "QATAR, PROF", 20, 10, 5, 5, { location: "Doha, Qatar" }), r(2025, "fall", "ZERO, RESP", 50, 10, 1, 1, { responseRate: "0%" })];
  const g = A.cmuAgg(rows);
  expect(g.n).toBe(300); // duplicate merged; summer, older semester, Qatar and 0% rows left out
  expect(g.hrs).toBeCloseTo((14 * 100 + 15 * 80 + 13 * 120) / 300, 6);
  expect(g.sem).toBe("Spring 2026");
  expect(g.profs.map((p) => [p.full, p.last])).toEqual([["Brian Railing", "Railing"], ["Phillip Gibbons", "Gibbons"]]);
  const a = A.cmuAnswer({ id: "15-213", level: true, prof: false }, { name: "Introduction to Computer Systems", units: "12", prereqs: "15-122 and (21-127 or 15-151)" }, rows);
  expect(a).toMatchObject({ title: "15-213 Introduction to Computer Systems", href: "https://cmucourses.com/course/15-213", parts: ["12 units", "13.9 hrs/wk", { stars: 4 }, "prereq 15-122 +2"], sem: "Spring 2026" });
  expect(a.profs[0]).toEqual({ full: "Brian Railing", last: "Railing", r: "4.3" });
  expect(A.cmuAnswer({ id: "15-213", level: false }, { name: "x" }, rows)).toBe(null); // "15-213 malloc lab": no card
  expect(A.cmuAnswer({ id: "15-213", level: true }, { name: "Intro" }, []).parts).toEqual([]); // no evaluations: just the course
});

test("answers: sports card data (final, live, next)", () => {
  const g = { state: "post", detail: "Final", date: "2026-11-22T18:00Z", league: "NFL", away: { abbr: "CLE", score: "17", record: "3-7" }, home: { abbr: "PIT", score: "24", winner: true, record: "7-3" } };
  expect(A.sportsAnswer(g, now)).toMatchObject({ label: "NFL", status: "Final", live: false, showScore: true, copy: "CLE 17 – 24 PIT", detail: "Sun, Nov 22 · CLE 3–7 · PIT 7–3" });
  expect(A.sportsAnswer({ ...g, state: "in", detail: "Q3 4:12" }, now)).toMatchObject({ live: true, status: "Q3 4:12" });
  expect(A.sportsAnswer({ ...g, state: "pre" }, now)).toMatchObject({ status: "Next game", showScore: false, copy: "" });
  expect(A.sportsAnswer({ ...g, state: "postponed" }, now)).toBe(null);
});

test("knowledge panel: which searches ask, and the same-article check", () => {
  for (const q of ["taylor swift", "golden gate bridge", "jaguar", "mercury", "Pittsburgh", "AC/DC".replace("/", "")]) expect([q, !!A.kpQuery(q)]).toEqual([q, true]);
  for (const q of ["how to reset airpods", "best laptop 2026", "react useEffect cleanup", "iphone 16 vs iphone 17", "nvidia stock", "1Z999AA10123456784", "15-213", "chocolate chip cookie recipe", "time in tokyo", "weather pittsburgh", "apple support", "a", "one two three four five six"]) expect([q, A.kpQuery(q)]).toEqual([q, null]);
  const urls = ["https://www.taylorswift.com", "https://en.wikipedia.org/wiki/Taylor_Swift", "https://www.britannica.com/biography/Taylor-Swift"];
  expect(A.kpMatch("Taylor Swift", urls)).toEqual({ ok: true, wiki: [1] });
  expect(A.kpMatch("Taylor Swift", [urls[0], urls[2]])).toEqual({ ok: true, wiki: [] });
  expect(A.kpMatch("Golden Gate Bridge", ["https://www.wikiwand.com/en/Golden_Gate_Bridge"]).ok).toBe(true);
  expect(A.kpMatch("Mercury (planet)", ["https://en.wikipedia.org/wiki/Mercury_(planet)"]).wiki).toEqual([0]);
  expect(A.kpMatch("Jaguar", ["https://www.britannica.com/animal/jaguar-mammal", "https://en.wikipedia.org/wiki/Jaguar_Cars"]).ok).toBe(false);
  expect(A.kpMatch("Spider-Man", ["https://en.wikipedia.org/wiki/Spider-Man%3A_Homecoming", "not a url"]).ok).toBe(false);
  expect(A.kpMatch("", urls).ok).toBe(false);
  expect(A.kpLine([{ k: "Born", v: "Dec 13, 1989" }, { k: "Occupation", v: "singer, songwriter" }])).toEqual(["Born Dec 13, 1989", "Occupation singer, songwriter"]);
});

test("!deepl: DeepL translator link, optional target language", () => {
  expect(A.deeplUrl("!deepl guten Morgen")).toBe("https://www.deepl.com/translator#auto/en/guten%20Morgen");
  expect(A.deeplUrl("!deepl de good morning")).toBe("https://www.deepl.com/translator#auto/de/good%20morning");
  expect(A.deeplUrl("!DeepL so am I")).toBe("https://www.deepl.com/translator#auto/en/so%20am%20I"); // "so" isn't a code
  expect(A.deeplUrl("!deepl a/b")).toBe("https://www.deepl.com/translator#auto/en/a%5C%2Fb");
  expect(A.deeplUrl("!deepl")).toBe("https://www.deepl.com/translator");
  expect(A.deeplUrl("deepl hello")).toBe("");
  expect(A.deeplUrl("!deeplx hello")).toBe("");
});

test("images row: clearly visual searches from their words", () => {
  for (const q of ["golden gate bridge photos", "eiffel tower pictures", "nike logo", "short hairstyles", "what does a capybara look like", "minimalist wallpaper"]) expect([q, A.visualQ(q)]).toEqual([q, true]);
  for (const q of ["golden gate bridge", "how to reset airpods", "image processing python", "resize photo", "logo generator", "!images cats", ""]) expect([q, A.visualQ(q)]).toEqual([q, false]);
});

test("meaning line: only when the results cover one meaning; tap adds the word", () => {
  const R = JSON.parse(require("node:zlib").gunzipSync(require("node:fs").readFileSync(new URL("../rec/ct-recordings.json.gz", import.meta.url))));
  const texts = (q) => R.searches.find((x) => x.q === q && !x.type).results.map((r) => `${r.title} ${r.snippet}`);
  // Descriptions written the way Wikidata writes them (not fetched here)
  const python = [{ label: "Python", desc: "general-purpose programming language" }, { label: "Pythonidae", desc: "family of snakes" }, { label: "Monty Python", desc: "British comedy troupe" }];
  expect(A.meaningLine("python", python, texts("python"))).toEqual([{ text: "snakes", q: "python snakes" }, { text: "Monty Python", q: "Monty Python" }]);
  const mercury = [{ label: "Mercury", desc: "planet closest to the Sun" }, { label: "mercury", desc: "chemical element with symbol Hg and atomic number 80" }, { label: "Mercury", desc: "American financial technology company" }];
  expect(A.meaningLine("mercury", mercury, texts("mercury"))).toBeNull(); // results cover the planet, the element and the bank
  expect(A.meaningLine("python", python.slice(0, 1), texts("python"))).toBeNull();
  expect(A.meaningLine("python", python, ["a", "b"])).toBeNull();
});
