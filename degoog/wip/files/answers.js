// ===== Answer card, local part (no network): math, units incl. cooking, tip / percent, date math, patterns =====
// answer(q, now) -> null, or { kind, label, value | title + href, detail, copy, swatch? }. Pure: the page draws it in
// the same pass that starts the search, so it never arrives late and needs no reserved space.
// Priority inside: exact pattern > calculation (spec: pattern > calculation > live > fact > snippet > AI).

// ----- Number formatting: headline rounded, exact value on the detail line -----
const NBSP = " ";
const MINUS = "−";
// Up to 6 significant digits on the headline ("about" values), thousands separators, "−" for negatives
export const fmtNum = (x, sig = 6) => {
  if (!Number.isFinite(x)) return "";
  if (x === 0) return "0";
  const a = Math.abs(x);
  let s;
  if (a >= 1e15 || a < 1e-6) s = x.toExponential(Math.max(0, sig - 1)).replace(/\.?0+e/, "e").replace("e+", " × 10^").replace("e-", ` × 10^${MINUS}`);
  else {
    const digits = Math.max(0, sig - 1 - Math.floor(Math.log10(a)));
    s = Number(x.toFixed(Math.min(digits, 10))).toLocaleString("en-US", { maximumFractionDigits: Math.min(digits, 10) });
  }
  return s.replace(/^-/, MINUS);
};
// Exact-ish (15 significant digits, floating noise removed) for the detail line and for copying
const exact = (x) => { const r = Number(x.toPrecision(15)); return Math.abs(r) >= 1e15 || (r !== 0 && Math.abs(r) < 1e-6) ? String(r) : r.toLocaleString("en-US", { maximumFractionDigits: 12 }); };
const plain = (x) => String(Number(x.toPrecision(15)));
const num = (s) => Number(String(s).replace(/,(?=\d{3}\b)/g, ""));
const NUM = "(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?|\\.\\d+";

// ----- Math: a small safe parser (no eval). Radians, like a calculator. -----
const FUNCS = { sqrt: Math.sqrt, cbrt: Math.cbrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, ln: Math.log, log: Math.log10, log2: Math.log2, abs: Math.abs, exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round };
const CONSTS = { pi: Math.PI, "π": Math.PI, e: Math.E };
const tokenize = (src) => {
  const out = [];
  const re = new RegExp(`\\s*(?:(${NUM})|(\\*\\*|[-+*/^()!×÷−]|\\bx\\b)|([a-zπ][a-z0-9]*))`, "giy");
  let m, at = 0;
  const s = src.replace(/(\d)\s*x\s*(?=[\d(.])/gi, "$1*"); // "12 x 350"
  while (at < s.length) {
    re.lastIndex = at;
    m = re.exec(s);
    if (!m) { if (/^\s*$/.test(s.slice(at))) break; return null; }
    at = re.lastIndex;
    if (m[1]) out.push({ t: "n", v: num(m[1]) });
    else if (m[2]) out.push({ t: "o", v: { "×": "*", "÷": "/", "−": "-", "**": "^", x: "*", X: "*" }[m[2]] || m[2] });
    else { const w = m[3].toLowerCase(); if (w in FUNCS) out.push({ t: "f", v: w }); else if (w in CONSTS) out.push({ t: "n", v: CONSTS[w], c: w }); else return null; }
  }
  return out;
};
// expr := term (('+'|'-') term)* ; term := unary (('*'|'/') unary | implicit unary)* ; unary := '-' unary | power
// power := post ('^' unary)? ; post := atom '!'* ; atom := n | f atom | '(' expr ')'
const parse = (toks) => {
  let i = 0;
  const peek = () => toks[i], eat = (v) => (toks[i] && toks[i].t === "o" && toks[i].v === v ? (i++, true) : false);
  const atom = () => {
    const k = toks[i++];
    if (!k) throw 0;
    if (k.t === "n") return k.v;
    if (k.t === "f") { const a = eat("(") ? (() => { const v = expr(); if (!eat(")")) throw 0; return v; })() : unary(); return FUNCS[k.v](a); }
    if (k.t === "o" && k.v === "(") { const v = expr(); if (!eat(")")) throw 0; return v; }
    throw 0;
  };
  const fact = (n) => { if (!Number.isInteger(n) || n < 0 || n > 170) throw 0; let r = 1; for (let j = 2; j <= n; j++) r *= j; return r; };
  const post = () => { let v = atom(); while (eat("!")) v = fact(v); return v; };
  const power = () => { const b = post(); return eat("^") ? b ** unary() : b; };
  const unary = () => (eat("-") ? -unary() : eat("+") ? unary() : power());
  const term = () => {
    let v = unary();
    for (;;) {
      if (eat("*")) v *= unary();
      else if (eat("/")) { const d = unary(); if (d === 0) throw 0; v /= d; }
      else if (peek() && (peek().t === "n" || peek().t === "f" || (peek().t === "o" && peek().v === "("))) v *= unary(); // 2pi, 3(4+5)
      else return v;
    }
  };
  const expr = () => { let v = term(); for (;;) { if (eat("+")) v += term(); else if (eat("-")) v -= term(); else return v; } };
  const v = expr();
  if (i !== toks.length) throw 0;
  return v;
};
// Things that look like sums but aren't: phone numbers, dates, ZIP+4, course numbers, version numbers, ranges
const NOT_MATH = /^24\/7$|^\d{2}-\d{3}$|^\d{3}-\d{3}-\d{4}$|^\d{5}-\d{4}$|^\d{4}-\d{1,2}-\d{1,2}$|^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$|^\d+(?:\.\d+){2,}$|^\d+-\d+$/;
export const calc = (q) => {
  let s = String(q).trim().toLowerCase().replace(/^(?:what(?:'s| is)|calculate|calc|compute|solve)\s+/, "").replace(/\s*=\s*\??$|\?$/, "").trim();
  if (!s || s.length > 120 || NOT_MATH.test(s)) return null;
  const toks = tokenize(s);
  // Needs an operation: a bare number or word isn't a sum
  if (!toks || toks.length < 2 || !toks.some((k) => k.t === "f" || (k.t === "o" && k.v !== "(" && k.v !== ")") || k.c)) return null;
  if (toks.filter((k) => k.t === "n").length < 1) return null;
  let v;
  try { v = parse(toks); } catch { return null; }
  if (!Number.isFinite(v)) return null;
  // The sum as read: "12 × 350", "√" kept as the function name, π for pi, spaced operators
  const shown = toks.map((k, n) => {
    if (k.t === "n") return k.c ? (k.c === "e" ? "e" : "π") : exact(k.v);
    if (k.t === "f") return k.v;
    const o = { "*": " × ", "/": " ÷ ", "-": n === 0 || (toks[n - 1].t === "o" && toks[n - 1].v !== ")" && toks[n - 1].v !== "!") ? MINUS : ` ${MINUS} `, "+": " + " }[k.v];
    return o || k.v;
  }).join("").replace(/([a-z]\d*)(?=[\dπe])/g, "$1 ").replace(/(\d)(?=[π(a-z])/g, "$1").trim();
  return { kind: "calc", label: "Calculator", value: fmtNum(v, 10), detail: `${shown} = ${exact(v)}`, copy: plain(v) };
};

// ----- Units (incl. cooking). Factor = size of one unit in the base unit of its kind. -----
const U = {};
const unit = (kind, factor, names, show) => { for (const n of names) U[n] = { kind, factor, show: show || names[0] }; };
// length (m)
unit("len", 1e-3, ["mm", "millimeter", "millimeters", "millimetre", "millimetres"]);
unit("len", 1e-2, ["cm", "centimeter", "centimeters", "centimetre", "centimetres"]);
unit("len", 1, ["m", "meter", "meters", "metre", "metres"]);
unit("len", 1e3, ["km", "kilometer", "kilometers", "kilometre", "kilometres"]);
unit("len", 0.0254, ["in", "inch", "inches", "\""], "in");
unit("len", 0.3048, ["ft", "foot", "feet", "'"], "ft");
unit("len", 0.9144, ["yd", "yard", "yards"]);
unit("len", 1609.344, ["mi", "mile", "miles"]);
unit("len", 1852, ["nmi", "nautical mile", "nautical miles"]);
// mass (kg)
unit("mass", 1e-6, ["mg", "milligram", "milligrams"]);
unit("mass", 1e-3, ["g", "gram", "grams"]);
unit("mass", 1, ["kg", "kilogram", "kilograms", "kilo", "kilos"]);
unit("mass", 0.028349523125, ["oz", "ounce", "ounces"]);
unit("mass", 0.45359237, ["lb", "lbs", "pound", "pounds"]);
unit("mass", 6.35029318, ["st", "stone", "stones"]);
unit("mass", 1000, ["t", "tonne", "tonnes", "metric ton", "metric tons"]);
// volume (L) — US customary for cups/spoons/fl oz/pints/quarts/gallons (searches here are US)
unit("vol", 1e-3, ["ml", "milliliter", "milliliters", "millilitre", "millilitres"]);
unit("vol", 1, ["l", "liter", "liters", "litre", "litres"]);
unit("vol", 0.00492892159375, ["tsp", "teaspoon", "teaspoons"]);
unit("vol", 0.01478676478125, ["tbsp", "tablespoon", "tablespoons"]);
unit("vol", 0.0295735295625, ["fl oz", "fluid ounce", "fluid ounces", "floz"]);
unit("vol", 0.2365882365, ["cup", "cups", "c"]);
unit("vol", 0.473176473, ["pt", "pint", "pints"]);
unit("vol", 0.946352946, ["qt", "quart", "quarts"]);
unit("vol", 3.785411784, ["gal", "gallon", "gallons"]);
// speed (m/s)
unit("speed", 1 / 3.6, ["km/h", "kph", "kmh", "kilometers per hour"]);
unit("speed", 0.44704, ["mph", "miles per hour"]);
unit("speed", 1, ["m/s", "meters per second"]);
unit("speed", 1852 / 3600, ["knot", "knots", "kn"]);
// area (m²)
unit("area", 1, ["m2", "m²", "sq m", "square meter", "square meters"]);
unit("area", 0.09290304, ["ft2", "ft²", "sq ft", "square foot", "square feet"]);
unit("area", 4046.8564224, ["acre", "acres"]);
unit("area", 1e4, ["ha", "hectare", "hectares"]);
unit("area", 1e6, ["km2", "km²", "sq km", "square kilometer", "square kilometers"]);
unit("area", 2589988.110336, ["mi2", "mi²", "sq mi", "square mile", "square miles"]);
// data (bytes; decimal and binary as named)
unit("data", 1, ["b", "byte", "bytes"], "B");
unit("data", 1e3, ["kb", "kilobyte", "kilobytes"], "KB");
unit("data", 1e6, ["mb", "megabyte", "megabytes"], "MB");
unit("data", 1e9, ["gb", "gigabyte", "gigabytes"], "GB");
unit("data", 1e12, ["tb", "terabyte", "terabytes"], "TB");
unit("data", 1024, ["kib", "kibibyte", "kibibytes"], "KiB");
unit("data", 1024 ** 2, ["mib", "mebibyte", "mebibytes"], "MiB");
unit("data", 1024 ** 3, ["gib", "gibibyte", "gibibytes"], "GiB");
unit("data", 1024 ** 4, ["tib", "tebibyte", "tebibytes"], "TiB");
// time (s)
unit("time", 1, ["s", "sec", "secs", "second", "seconds"]);
unit("time", 60, ["min", "mins", "minute", "minutes"]);
unit("time", 3600, ["h", "hr", "hrs", "hour", "hours"]);
unit("time", 86400, ["day", "days"]);
unit("time", 604800, ["week", "weeks", "wk", "wks"]);
unit("time", 31557600, ["year", "years", "yr", "yrs"]); // Julian year (365.25 days)
// temperature: handled apart (offsets)
const TEMP = { c: "C", "°c": "C", celsius: "C", f: "F", "°f": "F", fahrenheit: "F", k: "K", kelvin: "K", kelvins: "K" };
const toK = (v, u) => (u === "C" ? v + 273.15 : u === "F" ? (v - 32) * 5 / 9 + 273.15 : v);
const fromK = (k, u) => (u === "C" ? k - 273.15 : u === "F" ? (k - 273.15) * 9 / 5 + 32 : k);
// Cooking: grams in one US cup (King Arthur's ingredient weight chart values for the common ones)
const CUP_G = { flour: 120, "all-purpose flour": 120, "all purpose flour": 120, "bread flour": 120, sugar: 198, "granulated sugar": 198, "white sugar": 198, "brown sugar": 213, "powdered sugar": 113, "icing sugar": 113, butter: 227, water: 236.6, milk: 227, rice: 191, oats: 89, "rolled oats": 89, honey: 336, "maple syrup": 312, oil: 198, "vegetable oil": 198, "olive oil": 200, cocoa: 84, "cocoa powder": 84, salt: 288, "chocolate chips": 170, yogurt: 227, cornstarch: 112 };
const unitShow = (u, v) => {
  const one = Math.abs(v) === 1;
  const n = { in: "in", ft: "ft", cup: one ? "cup" : "cups", tsp: "tsp", tbsp: "tbsp", "fl oz": "fl oz", pt: one ? "pint" : "pints", qt: one ? "quart" : "quarts", gal: one ? "gallon" : "gallons", day: one ? "day" : "days", week: one ? "week" : "weeks", year: one ? "year" : "years", acre: one ? "acre" : "acres", knot: one ? "knot" : "knots", stone: "st" }[u.show];
  return n || u.show;
};
const UNIT_NAMES = Object.keys(U).sort((a, b) => b.length - a.length).map((n) => n.replace(/[.*+?^${}()|[\]\\/"']/g, "\\$&")).join("|");
const TEMP_NAMES = "°c|°f|celsius|fahrenheit|kelvins?|c|f|k";
const ING = Object.keys(CUP_G).sort((a, b) => b.length - a.length).join("|");
const UNIT_RE = new RegExp(`^(?:convert\\s+|how many\\s+(${UNIT_NAMES})\\s+(?:are\\s+)?in\\s+)?(-?${NUM})\\s*(${UNIT_NAMES}|${TEMP_NAMES})(?:\\s+(?:of\\s+)?(${ING}))?(?:\\s+(?:to|in|into|as|=)\\s+(${UNIT_NAMES}|${TEMP_NAMES}))?\\s*\\??$`, "i");
export const convert = (q) => {
  const s = String(q).trim().toLowerCase().replace(/\s+/g, " ").replace(/degrees?\s+/g, "°");
  const m = UNIT_RE.exec(s);
  if (!m) return null;
  const v = num(m[2]);
  let from = m[3], to = m[5] || m[1], ing = m[4];
  if (!to) return null; // "5 km" alone: not asked
  if (TEMP[from] && TEMP[to]) {
    const a = TEMP[from], b = TEMP[to];
    if (a === b) return null;
    const r = fromK(toK(v, a), b);
    if (b === "K" && r < 0) return null;
    return { kind: "unit", label: "Unit converter", value: `${fmtNum(r, 4)}${a === "K" || b === "K" ? NBSP : ""}${b === "K" ? "K" : `°${b}`}`, detail: `${exact(v)}${a === "K" ? " K" : ` °${a}`} = ${exact(r)}${b === "K" ? " K" : ` °${b}`}`, copy: plain(r) };
  }
  const a = U[from], b = U[to];
  if (!a || !b) return null;
  // Cooking: cups/spoons <-> grams/ounces of a named ingredient
  if (a.kind !== b.kind) {
    const g = ing && CUP_G[ing];
    if (!g || !((a.kind === "vol" && b.kind === "mass") || (a.kind === "mass" && b.kind === "vol"))) return null;
    const perL = g / 1000 / U.cup.factor; // kg per litre
    const r = a.kind === "vol" ? (v * a.factor * perL) / b.factor : (v * a.factor / perL) / b.factor;
    return { kind: "unit", label: `Cooking · ${ing}`, value: `${fmtNum(r, 3)} ${unitShow(b, r)}`, detail: `${exact(v)} ${unitShow(a, v)} ${ing} ≈ ${exact(Number(r.toPrecision(4)))} ${unitShow(b, r)} · 1 cup = ${g} g`, copy: plain(Number(r.toPrecision(4))) };
  }
  if (a === b) return null;
  const r = (v * a.factor) / b.factor;
  return { kind: "unit", label: "Unit converter", value: `${fmtNum(r, 6)} ${unitShow(b, r)}`, detail: `${exact(v)} ${unitShow(a, v)} = ${exact(r)} ${unitShow(b, r)}`, copy: plain(r) };
};

// ----- Tip / percent -----
export const percent = (q) => {
  const s = String(q).trim().toLowerCase().replace(/\s+/g, " ").replace(/\?$/, "").replace(/^what(?:'s| is) /, "").replace(/\$/g, "");
  let m;
  const P = `(${NUM})\\s*(?:%|percent)`;
  // "20% tip on 45.50", "tip 18% of 62", "15% tip for 80"
  if ((m = new RegExp(`^(?:tip (?:of )?)?${P}(?: tip)? (?:on|of|for) (${NUM})$`).exec(s)) && /tip/.test(s)) {
    const p = num(m[1]), b = num(m[2]), t = b * p / 100;
    return { kind: "percent", label: "Tip", value: `$${t.toFixed(2)}`, detail: `${exact(p)}% of $${b.toFixed(2)} · total $${(b + t).toFixed(2)}`, copy: t.toFixed(2) };
  }
  // "15% of 200"
  if ((m = new RegExp(`^${P} of (${NUM})$`).exec(s))) {
    const p = num(m[1]), b = num(m[2]), r = b * p / 100;
    return { kind: "percent", label: "Percent", value: fmtNum(r, 8), detail: `${exact(p)}% of ${exact(b)} = ${exact(r)}`, copy: plain(r) };
  }
  // "30 is what percent of 120", "30 out of 120 as a percent"
  if ((m = new RegExp(`^(${NUM}) (?:is what (?:%|percent) of|out of|of) (${NUM})(?: (?:as a |in )?(?:%|percent(?:age)?))?$`).exec(s)) && /percent|%/.test(s)) {
    const a = num(m[1]), b = num(m[2]);
    if (!b) return null;
    const r = a / b * 100;
    return { kind: "percent", label: "Percent", value: `${fmtNum(r, 4)}%`, detail: `${exact(a)} ÷ ${exact(b)} = ${exact(r)}%`, copy: plain(r) };
  }
  // "percent change from 80 to 100", "% increase from 50 to 65"
  if ((m = new RegExp(`^(?:%|percent(?:age)?) (?:change|increase|decrease|difference) from (${NUM}) to (${NUM})$`).exec(s))) {
    const a = num(m[1]), b = num(m[2]);
    if (!a) return null;
    const r = (b - a) / a * 100;
    return { kind: "percent", label: "Percent change", value: `${r > 0 ? "+" : ""}${fmtNum(r, 4)}%`, detail: `${exact(a)} → ${exact(b)} = ${exact(r)}%`, copy: plain(r) };
  }
  return null;
};

// ----- Date math (local calendar days) -----
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MON_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const monIdx = (s) => MONTHS.findIndex((x) => x.startsWith(s.slice(0, 3)));
const day0 = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const nthWeekday = (y, m, wd, n) => { const d = new Date(y, m, 1); d.setDate(1 + ((wd - d.getDay() + 7) % 7) + (n - 1) * 7); return d; };
const easter = (y) => { // Anonymous Gregorian algorithm (Meeus/Jones/Butcher)
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, mo - 1, da);
};
// US-centred holidays (the user's searches are US); each -> date in year y
const HOLIDAYS = {
  christmas: [(y) => new Date(y, 11, 25), "Christmas"], "christmas eve": [(y) => new Date(y, 11, 24), "Christmas Eve"],
  "new year": [(y) => new Date(y, 0, 1), "New Year's Day"], "new years": [(y) => new Date(y, 0, 1), "New Year's Day"], "new year's": [(y) => new Date(y, 0, 1), "New Year's Day"],
  "new years eve": [(y) => new Date(y, 11, 31), "New Year's Eve"], "new year's eve": [(y) => new Date(y, 11, 31), "New Year's Eve"],
  halloween: [(y) => new Date(y, 9, 31), "Halloween"], "valentines day": [(y) => new Date(y, 1, 14), "Valentine's Day"], "valentine's day": [(y) => new Date(y, 1, 14), "Valentine's Day"],
  "july 4th": [(y) => new Date(y, 6, 4), "Independence Day"], "4th of july": [(y) => new Date(y, 6, 4), "Independence Day"], "independence day": [(y) => new Date(y, 6, 4), "Independence Day"],
  thanksgiving: [(y) => nthWeekday(y, 10, 4, 4), "Thanksgiving"], easter: [easter, "Easter"],
  "mothers day": [(y) => nthWeekday(y, 4, 0, 2), "Mother's Day"], "mother's day": [(y) => nthWeekday(y, 4, 0, 2), "Mother's Day"],
  "fathers day": [(y) => nthWeekday(y, 5, 0, 3), "Father's Day"], "father's day": [(y) => nthWeekday(y, 5, 0, 3), "Father's Day"],
  "labor day": [(y) => nthWeekday(y, 8, 1, 1), "Labor Day"], "memorial day": [(y) => { const d = new Date(y, 5, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; }, "Memorial Day"],
};
const longDate = (d) => d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
const dayDiff = (a, b) => Math.round((day0(b) - day0(a)) / 864e5);
const parseDay = (s, now) => {
  let m;
  if ((m = new RegExp(`^${MON_RE}\\.? (\\d{1,2})(?:st|nd|rd|th)?(?:,? (\\d{4}))?$`).exec(s))) return { d: new Date(m[3] ? +m[3] : now.getFullYear(), monIdx(m[1]), +m[2]), y: !!m[3] };
  if ((m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MON_RE}(?:,? (\\d{4}))?$`).exec(s))) return { d: new Date(m[3] ? +m[3] : now.getFullYear(), monIdx(m[2]), +m[1]), y: !!m[3] };
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) return { d: new Date(+m[1], +m[2] - 1, +m[3]), y: true };
  if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) return { d: new Date(+m[3], +m[1] - 1, +m[2]), y: true };
  const h = HOLIDAYS[s.replace(/^the /, "")];
  if (h) return { d: h[0](now.getFullYear()), y: false, name: h[1], f: h[0] };
  return null;
};
export const dateMath = (q, nowMs = Date.now()) => {
  const now = new Date(nowMs);
  const s = String(q).trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.]$/, "").replace(/^how many /, "");
  let m;
  // "days until christmas", "days till dec 25", "weeks until 2027-01-01"
  if ((m = /^(days|weeks) (?:until|till|til|to|before) (.+)$/.exec(s))) {
    const p = parseDay(m[2], now);
    if (!p || isNaN(p.d)) return null;
    // A date without a year that already passed this year means next year's
    if (!p.y && dayDiff(now, p.d) < 0) p.d = p.f ? p.f(now.getFullYear() + 1) : new Date(p.d.getFullYear() + 1, p.d.getMonth(), p.d.getDate());
    const n = dayDiff(now, p.d);
    if (n < 0) return null;
    const what = p.name || p.d.toLocaleDateString("en-US", { month: "long", day: "numeric" });
    const v = m[1] === "weeks" ? `${fmtNum(n / 7, 3)} weeks` : n === 0 ? "Today" : `${n.toLocaleString("en-US")} ${n === 1 ? "day" : "days"}`;
    return { kind: "date", label: `Until ${what}`, value: v, detail: `${longDate(p.d)}${m[1] === "weeks" ? ` · ${n} days` : n >= 14 ? ` · ${Math.floor(n / 7)} weeks ${n % 7 ? `${n % 7} ${n % 7 === 1 ? "day" : "days"}` : ""}`.trimEnd() : ""}`, copy: String(m[1] === "weeks" ? Number((n / 7).toFixed(2)) : n) };
  }
  // "days since jan 1", "days since 2020-03-11"
  if ((m = /^days since (.+)$/.exec(s))) {
    const p = parseDay(m[1], now);
    if (!p || isNaN(p.d)) return null;
    if (!p.y && dayDiff(p.d, now) < 0) p.d = p.f ? p.f(now.getFullYear() - 1) : new Date(p.d.getFullYear() - 1, p.d.getMonth(), p.d.getDate());
    const n = dayDiff(p.d, now);
    if (n < 0) return null;
    return { kind: "date", label: `Since ${p.name || p.d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`, value: `${n.toLocaleString("en-US")} ${n === 1 ? "day" : "days"}`, detail: longDate(p.d), copy: String(n) };
  }
  // "30 days from today", "2 weeks from now", "90 days ago", "6 months from today"
  if ((m = /^(?:what (?:is|day is) |what date is )?(\d{1,5}) (days?|weeks?|months?|years?) (from (?:today|now)|ago|from now)$/.exec(s))) {
    const n = +m[1], u = m[2].replace(/s$/, ""), sign = m[3] === "ago" ? -1 : 1;
    const d = day0(now);
    if (u === "day") d.setDate(d.getDate() + sign * n);
    else if (u === "week") d.setDate(d.getDate() + sign * n * 7);
    else if (u === "month") d.setMonth(d.getMonth() + sign * n);
    else d.setFullYear(d.getFullYear() + sign * n);
    if (isNaN(d)) return null;
    return { kind: "date", label: `${n} ${n === 1 ? u : `${u}s`} ${sign < 0 ? "ago" : "from today"}`, value: d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" }), detail: longDate(d), copy: d.toLocaleDateString("en-CA") };
  }
  return null;
};

// ----- Patterns ("paste anything"): exact shapes only, checksums where the format has one -----
const ups1Z = (s) => {
  const m = /^1Z([0-9A-Z]{15})(\d)$/.exec(s);
  if (!m) return false;
  let sum = 0;
  [...m[1]].forEach((c, i) => { const v = /\d/.test(c) ? +c : (c.charCodeAt(0) - 63) % 10; sum += i % 2 ? v * 2 : v; });
  return (10 - (sum % 10)) % 10 === +m[2];
};
const isbn = (x) => {
  if (/^\d{9}[\dX]$/.test(x)) { let t = 0; for (let i = 0; i < 10; i++) t += (x[i] === "X" ? 10 : +x[i]) * (10 - i); return t % 11 === 0; }
  if (/^97[89]\d{10}$/.test(x)) { let t = 0; for (let i = 0; i < 13; i++) t += +x[i] * (i % 2 ? 3 : 1); return t % 10 === 0; }
  return false;
};
const res = (label, title, href, detail, copy) => ({ kind: "pattern", label, title, href, detail, copy });
const hexColor = (h) => {
  const x = h.length <= 4 ? h.slice(1).split("").map((c) => c + c).join("") : h.slice(1, 7);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16));
  const mx = Math.max(r, g, b) / 255, mn = Math.min(r, g, b) / 255, l = (mx + mn) / 2, d = mx - mn;
  let hh = 0;
  if (d) { const R = r / 255, G = g / 255, B = b / 255; hh = mx === R ? ((G - B) / d) % 6 : mx === G ? (B - R) / d + 2 : (R - G) / d + 4; }
  const sat = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
  return { hex: `#${x.toUpperCase()}`, rgb: `rgb(${r}, ${g}, ${b})`, hsl: `hsl(${Math.round(((hh * 60) + 360) % 360)}, ${Math.round(sat * 100)}%, ${Math.round(l * 100)}%)` };
};
const ipv4 = (s) => { const p = s.split("."); return p.length === 4 && p.every((x) => /^(?:0|[1-9]\d{0,2})$/.test(x) && +x <= 255) ? p.map(Number) : null; };
const ipKind = ([a, b]) => (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ? "Private network address" : a === 127 ? "Loopback (this device)" : a === 169 && b === 254 ? "Link-local address" : a === 100 && b >= 64 && b <= 127 ? "Carrier-grade NAT address" : a >= 224 && a <= 239 ? "Multicast address" : a === 0 || a >= 240 ? "Reserved address" : "Public address");
const NOT_REPO = /^(?:and\/or|he\/him|she\/her|they\/them|km\/h|m\/s|w\/o|n\/a|24\/7|ft\/s|mi\/h|lb\/ft|ac\/dc)$|\.(?:com|org|net|io|edu|gov)\//i;
// IATA codes of large airlines (a bare "UA 123" is a flight; other two-letter codes need the word "flight")
const AIRLINES = new Set("AA UA DL WN B6 AS NK F9 HA G4 SY AC WS BA VS AF KL LH LX OS SN SK AY EI IB VY FR U2 AZ TP TK EK QR EY SV MS ET QF NZ VA JQ NH JL KE OZ CI BR CX SQ MH TG GA VN AI 6E AM AV LA CM".split(" "));
export const pattern = (q) => {
  const raw = String(q).trim();
  const s = raw.replace(/\s+/g, " ");
  const tight = s.replace(/[\s-]/g, "").toUpperCase();
  let m;
  // Parcels
  if (ups1Z(tight)) return res("UPS tracking number", `Track UPS ${tight}`, `https://www.ups.com/track?tracknum=${tight}`, "Check digit OK", tight);
  if (/^TBA\d{12}$/.test(tight)) return res("Amazon tracking number", `Track Amazon package ${tight}`, `https://track.amazon.com/tracking/${tight}`, "Amazon Logistics", tight);
  if (/^(?:94|93|92|95)\d{18,20}$/.test(tight)) return res("USPS tracking number", `Track USPS ${tight}`, `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tight}`, "Format matches USPS (no check digit tested)", tight);
  // FedEx numbers have no published check digit that can be confirmed here, so only with the word "fedex"
  if ((m = /^fedex\s+(?:tracking\s+)?(\d{12}|\d{15}|\d{20})$|^(\d{12}|\d{15}|\d{20})\s+fedex$/i.exec(s))) { const n = m[1] || m[2]; return res("FedEx tracking number", `Track FedEx ${n}`, `https://www.fedex.com/fedextrack/?trknbr=${n}`, "FedEx", n); }
  // Books, papers, security advisories
  // 13 digits starting 978/979 on their own; 10 digits only after "isbn" (1 in 11 random numbers pass its check)
  if ((m = /^(isbn(?:-1[03])?:?\s*)?((?:97[89][\s-]?)?(?:\d[\s-]?){9}[\dXx])$/i.exec(s)) && (m[1] || /^97[89]/.test(m[2])) && isbn(m[2].replace(/[\s-]/g, "").toUpperCase())) { const n = m[2].replace(/[\s-]/g, "").toUpperCase(); return res(`ISBN-${n.length}`, `Open Library: ISBN ${n}`, `https://openlibrary.org/isbn/${n}`, "Checksum OK", n); }
  if ((m = /^(?:doi:\s*|https?:\/\/(?:dx\.)?doi\.org\/)?(10\.\d{4,9}\/\S+)$/i.exec(s))) return res("DOI", `doi.org/${m[1]}`, `https://doi.org/${m[1]}`, "Digital Object Identifier", m[1]);
  if ((m = /^(?:arxiv:?\s*)?(\d{4}\.\d{4,5})(v\d+)?$/i.exec(s)) && +m[1].slice(2, 4) >= 1 && +m[1].slice(2, 4) <= 12) return res("arXiv paper", `arXiv:${m[1]}${m[2] || ""}`, `https://arxiv.org/abs/${m[1]}${m[2] || ""}`, `PDF: arxiv.org/pdf/${m[1]}${m[2] || ""}`, `arXiv:${m[1]}${m[2] || ""}`);
  if ((m = /^cve-(\d{4})-(\d{4,7})$/i.exec(s))) { const id = `CVE-${m[1]}-${m[2]}`; return res("Vulnerability", `${id} on NVD`, `https://nvd.nist.gov/vuln/detail/${id}`, "National Vulnerability Database", id); }
  // Windows error codes (0x8xxxxxxx and friends)
  if ((m = /^(?:error\s+(?:code\s+)?)?(0x[0-9a-f]{8})$/i.exec(s))) { const c = `0x${m[1].slice(2).toUpperCase()}`; return res("Windows error code", `${c} on Microsoft Learn`, `https://learn.microsoft.com/en-us/search/?terms=${c}`, `Decimal ${(parseInt(c, 16) | 0).toLocaleString("en-US").replace(/^-/, MINUS)}`, c); }
  // Network and color
  const ip = ipv4(s);
  if (ip) return { kind: "pattern", label: "IPv4 address", value: s, detail: ipKind(ip), copy: s };
  if ((m = /^(?:#|(?:hex|colou?r)\s+#?)([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s))) {
    const c = hexColor(`#${m[1]}`);
    return { kind: "pattern", label: "Color", value: c.hex, detail: `${c.rgb} · ${c.hsl}`, copy: c.hex, swatch: c.hex };
  }
  // Packages and repositories
  if ((m = /^(?:pip(?:3)? install|pip|pypi)\s+([a-z0-9][a-z0-9._-]{0,80})$/i.exec(s))) return res("Python package", `${m[1]} on PyPI`, `https://pypi.org/project/${m[1]}/`, `pip install ${m[1]}`, `pip install ${m[1]}`);
  if ((m = /^(?:npm (?:install|i)|npm)\s+((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213})$/i.exec(s))) return res("npm package", `${m[1]} on npm`, `https://www.npmjs.com/package/${m[1]}`, `npm install ${m[1]}`, `npm install ${m[1]}`);
  if ((m = /^(?:https?:\/\/github\.com\/)?([a-z\d][a-z\d-]{1,38})\/([\w.-]{2,100})$/i.exec(s)) && !/^\d+\/\d+$/.test(s) && !NOT_REPO.test(s)) return res("GitHub repository", `${m[1]}/${m[2]} on GitHub`, `https://github.com/${m[1]}/${m[2]}`, "github.com", `${m[1]}/${m[2]}`);
  // Flights ("UA 123", "dl1234"): with the word "flight"/"status", or a big airline's code alone ("rx 7800" is a GPU)
  if ((m = /^(?:flight\s+)?([a-z]{2}|[a-z]\d|\d[a-z])\s?(\d{1,4})(?:\s+(?:flight|status|flight status))?$/i.exec(s)) && (/flight|status/i.test(s) || AIRLINES.has(m[1].toUpperCase()))) {
    const code = `${m[1].toUpperCase()}${m[2]}`;
    return res("Flight", `Flight ${m[1].toUpperCase()} ${m[2]} status`, `https://www.flightaware.com/live/flight/${code}`, "FlightAware", code);
  }
  // Stock tickers: "$AAPL" (live price is a network answer, M4)
  if ((m = /^\$([a-z]{1,5}(?:\.[a-z])?)$/i.exec(s))) { const t = m[1].toUpperCase(); return res("Stock", `${t} quote`, `https://finance.yahoo.com/quote/${t}`, "Yahoo Finance", t); }
  return null;
};

// ----- Currency, from the ECB's daily reference rates (the server fetches them once after each publication and the
// page keeps a copy, so the answer is local and instant). fx = { date: "2026-11-20", rates: { USD: 1.08, ... } } per EUR.
const CUR = { usd: "USD", "us dollar": "USD", "us dollars": "USD", dollar: "USD", dollars: "USD", "$": "USD", eur: "EUR", euro: "EUR", euros: "EUR", "€": "EUR",
  gbp: "GBP", pound: "GBP", pounds: "GBP", "british pound": "GBP", "british pounds": "GBP", "£": "GBP", jpy: "JPY", yen: "JPY", "¥": "JPY", cny: "CNY", yuan: "CNY", rmb: "CNY",
  cad: "CAD", "canadian dollar": "CAD", "canadian dollars": "CAD", aud: "AUD", "australian dollar": "AUD", "australian dollars": "AUD", chf: "CHF", "swiss franc": "CHF", "swiss francs": "CHF",
  inr: "INR", rupee: "INR", rupees: "INR", "₹": "INR", krw: "KRW", won: "KRW", mxn: "MXN", peso: "MXN", pesos: "MXN", "mexican peso": "MXN", "mexican pesos": "MXN", sek: "SEK", nok: "NOK", dkk: "DKK",
  pln: "PLN", zloty: "PLN", czk: "CZK", huf: "HUF", ron: "RON", bgn: "BGN", isk: "ISK", try: "TRY", lira: "TRY", brl: "BRL", real: "BRL", reais: "BRL", zar: "ZAR", rand: "ZAR", nzd: "NZD",
  sgd: "SGD", hkd: "HKD", thb: "THB", baht: "THB", idr: "IDR", rupiah: "IDR", myr: "MYR", ringgit: "MYR", php: "PHP", ils: "ILS", shekel: "ILS", shekels: "ILS" };
const SYM = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", INR: "₹" };
const CUR_NAMES = Object.keys(CUR).sort((a, b) => b.length - a.length).map((n) => n.replace(/[$€£¥₹]/g, "\\$&")).join("|");
const CUR_RE = new RegExp(`^(?:convert\\s+)?(${CUR_NAMES})?\\s*(${NUM})\\s*(${CUR_NAMES})?\\s+(?:to|in|into|=)\\s+(${CUR_NAMES})\\s*\\??$`, "i");
const money = (v, c) => { const d = c === "JPY" || c === "KRW" || c === "ISK" || c === "HUF" || c === "IDR" ? 0 : 2; const t = v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); return SYM[c] ? `${SYM[c]}${t}` : `${t} ${c}`; };
export const currency = (q, fx) => {
  if (!fx || !fx.rates) return null;
  const m = CUR_RE.exec(String(q).trim().toLowerCase().replace(/\s+/g, " "));
  if (!m || !(m[1] || m[3])) return null;
  const a = CUR[m[3] || m[1]], b = CUR[m[4]], v = num(m[2]);
  const per = (c) => (c === "EUR" ? 1 : fx.rates[c]);
  if (!a || !b || a === b || !per(a) || !per(b)) return null;
  const r = (v / per(a)) * per(b), one = per(b) / per(a);
  const day = fx.date ? new Date(`${fx.date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";
  return { kind: "currency", label: `Currency · ECB rate${day ? ` of ${day}` : ""}`, value: money(r, b), detail: `${money(v, a)} · 1 ${a} = ${one.toLocaleString("en-US", { maximumSignificantDigits: 5 })} ${b}`, copy: plain(Number(r.toFixed(b === "JPY" || b === "KRW" ? 0 : 2))) };
};

// ----- Versions and support (endoflife.date): the page asks the server for one product's release cycles at page
// load (only the product name leaves the page), and draws the answer with the results if it's in hand by then.
const EOL = [
  ["ios", "iOS", "ios|iphone os"], ["ipados", "iPadOS", "ipados"], ["macos", "macOS", "macos|mac os|osx|os x"], ["windows", "Windows", "windows"],
  ["windows-server", "Windows Server", "windows server"], ["android", "Android", "android"], ["python", "Python", "python"], ["nodejs", "Node.js", "node|nodejs|node\\.js"],
  ["php", "PHP", "php"], ["go", "Go", "go|golang"], ["ruby", "Ruby", "ruby"], ["django", "Django", "django"], ["react", "React", "react"], ["angular", "Angular", "angular"],
  ["vue", "Vue", "vue|vue\\.js|vuejs"], ["ubuntu", "Ubuntu", "ubuntu"], ["debian", "Debian", "debian"], ["fedora", "Fedora", "fedora"], ["postgresql", "PostgreSQL", "postgres|postgresql"],
  ["mysql", "MySQL", "mysql"], ["mongodb", "MongoDB", "mongodb|mongo"], ["redis", "Redis", "redis"], ["nginx", "nginx", "nginx"], ["kubernetes", "Kubernetes", "kubernetes|k8s"],
  ["docker-engine", "Docker Engine", "docker"], ["dotnet", ".NET", "\\.net|dotnet"], ["firefox", "Firefox", "firefox"], ["electron", "Electron", "electron"], ["laravel", "Laravel", "laravel"],
  ["rails", "Ruby on Rails", "rails|ruby on rails"], ["spring-boot", "Spring Boot", "spring boot"],
];
const EOL_ALT = EOL.map((x) => x[2]).join("|");
const eolOf = (w) => EOL.find((x) => new RegExp(`^(?:${x[2]})$`, "i").test(w));
// "latest ios", "what is the latest version of python", "node latest version", "is windows 10 supported",
// "python 3.8 end of life", "when does ubuntu 20.04 end support" -> {slug, name, cycle, ask}
export const eolQuery = (q) => {
  const s = String(q || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/\?$/, "");
  let m, ask = "", w = "", cycle = "";
  if ((m = new RegExp(`^(?:what(?:'s| is) the )?(?:latest|newest|current) (?:version of |release of )?(${EOL_ALT})(?: version| release)?$`).exec(s))) { ask = "latest"; w = m[1]; }
  else if ((m = new RegExp(`^(${EOL_ALT}) (?:latest|newest|current)(?: version| release)?$`).exec(s))) { ask = "latest"; w = m[1]; }
  else if ((m = new RegExp(`^is (${EOL_ALT}) ([\\w.]+) (?:still )?supported$`).exec(s))) { ask = "support"; w = m[1]; cycle = m[2]; }
  else if ((m = new RegExp(`^(${EOL_ALT}) ([\\w.]+) (?:end of life|eol|end of support|support end(?:s)?|support)$`).exec(s))) { ask = "support"; w = m[1]; cycle = m[2]; }
  else if ((m = new RegExp(`^when (?:does|will) (${EOL_ALT}) ([\\w.]+) (?:reach end of life|end support|lose support|stop being supported)$`).exec(s))) { ask = "support"; w = m[1]; cycle = m[2]; }
  if (!ask) return null;
  const p = eolOf(w);
  return p ? { slug: p[0], name: p[1], cycle, ask } : null;
};
const dayText = (d, now) => {
  const t = Date.parse(`${d}T12:00:00Z`);
  if (!Number.isFinite(t)) return "";
  const days = Math.round((Date.UTC(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate()) - Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth(), new Date(t).getUTCDate())) / 864e5);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days > 1 && days <= 6) return `${days} days ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
};
const isDate = (x) => typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x);
// cycles: [{cycle, releaseDate, eol, latest, latestReleaseDate}] newest first (endoflife.date's order)
export const eolAnswer = (e, cycles, now = Date.now()) => {
  if (!e || !Array.isArray(cycles) || !cycles.length) return null;
  const today = new Date(now).toISOString().slice(0, 10);
  const ended = (c) => (c.eol === true || (isDate(c.eol) && c.eol <= today));
  if (e.ask === "latest") {
    const c = cycles.find((x) => x && x.latest && (!x.releaseDate || x.releaseDate <= today)) || cycles[0];
    if (!c || !c.latest) return null;
    const v = String(c.latest).startsWith(String(c.cycle).split("-")[0]) || /^\d/.test(String(c.latest)) ? c.latest : `${c.cycle} (${c.latest})`;
    const rel = isDate(c.latestReleaseDate) ? dayText(c.latestReleaseDate, now) : "";
    return { kind: "version", label: `Latest ${e.name}`, value: `${e.name} ${v}`, detail: [rel && `Released ${rel}`, ended(c) ? "no longer supported" : isDate(c.eol) ? `supported until ${dayText(c.eol, now)}` : "supported"].filter(Boolean).join(" · "), copy: String(v), src: "endoflife.date" };
  }
  // Support: that cycle ("10", "3.8", "20.04"); Windows' enterprise / IoT / LTSC editions aren't what people mean
  const want = String(e.cycle).toLowerCase();
  const pick = cycles.filter((c) => { const n = String(c.cycle).toLowerCase(); return (n === want || n.startsWith(`${want}-`) || n.startsWith(`${want}.`)) && !(e.slug === "windows" && /(?:^|-)(?:e|iot|lts|ltsc|ltsb)(?:-|$)/.test(n)); });
  if (!pick.length) return null;
  const c = pick[0];
  const end = isDate(c.eol) ? dayText(c.eol, now) : "";
  const ed = String(c.cycle).toLowerCase() === want ? "" : String(c.cycle).slice(want.length + 1).replace(/-w$/i, "").toUpperCase(); // "10-22h2-w" -> "22H2"
  const yes = !ended(c);
  return { kind: "version", label: `${e.name} ${e.cycle} support`, value: yes ? "Yes" : "No", detail: [yes ? (end ? `Supported until ${end}` : "Still supported") : (end ? `Ended ${end}` : "Ended"), ed, c.latest ? `latest ${c.latest}` : ""].filter(Boolean).join(" · "), copy: yes ? "Yes" : "No", src: "endoflife.date" };
};

// ----- Facts from Wikidata ("how tall is the eiffel tower", "pittsburgh population", "when was X born", "ceo of X",
// "distance between A and B"). The page sends only the fact asked and the subject's name; the server looks the
// subject up and sends back that one property. Drawn with the results if in hand, like every network answer.
export const WD_PROP = { height: "P2048", population: "P1082", born: "P569", age: "P569", died: "P570", founded: "P571", ceo: "P169", released: "P577", distance: "P625" };
const WD_RULES = [
  [/^(?:how tall is|how high is|what is the height of|height of) (?:the )?(.+)$/, "height"], [/^(?:the )?(.+?) (?:height|how tall)$/, "height"],
  [/^(?:what is the )?population of (.+)$/, "population"], [/^(.+?) population$/, "population"], [/^how many people live in (.+)$/, "population"],
  [/^when (?:was|is) (.+?) born$/, "born"], [/^(.+?) (?:birthday|date of birth|born)$/, "born"], [/^how old is (.+)$/, "age"],
  [/^when did (.+?) die$/, "died"], [/^(.+?) (?:death date|died)$/, "died"],
  [/^when was (.+?) (?:founded|established|built)$/, "founded"], [/^(.+?) (?:founded|founding date)$/, "founded"],
  [/^(?:who is (?:the )?)?ceo of (.+)$/, "ceo"], [/^(.+?) ceo$/, "ceo"],
  [/^when (?:was|did) (.+?) (?:released|come out)$/, "released"], [/^(.+?) release date$/, "released"],
];
export const wdQuery = (q) => {
  const s = String(q || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.]+$/, "");
  let m = /^(?:distance|how far is it|how far) (?:between|from) (.+?) (?:and|to) (.+)$/.exec(s) || /^how far is (.+?) from (.+)$/.exec(s);
  if (m) return { fact: "distance", s: m[1].replace(/^the /, ""), s2: m[2].replace(/^the /, "") };
  for (const [re, fact] of WD_RULES) if ((m = re.exec(s))) { const subj = m[1].replace(/^the /, "").trim(); if (subj.length >= 2 && subj.split(" ").length <= 6) return { fact, s: subj }; }
  return null;
};
const UNIT_M = { Q11573: 1, Q174728: 0.01, Q3710: 0.3048, Q828224: 1000, Q11570: null };
const wdDay = (t, prec) => {
  const m = /^([+-]\d+)-(\d{2})-(\d{2})/.exec(String(t || ""));
  if (!m) return "";
  const y = Number(m[1]);
  if (prec <= 9 || m[2] === "00") return y < 0 ? `${-y} BC` : String(y);
  const d = new Date(Date.UTC(2000, Number(m[2]) - 1, Number(m[3] === "00" ? 1 : m[3])));
  return prec === 10 || m[3] === "00" ? `${d.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" })} ${y}` : `${d.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}, ${y}`;
};
const ageAt = (t, now, end) => {
  const a = /^\+(\d{4})-(\d{2})-(\d{2})/.exec(String(t || "")); if (!a) return null;
  const e = end ? /^\+(\d{4})-(\d{2})-(\d{2})/.exec(String(end)) : null;
  const n = new Date(now), Y = e ? +e[1] : n.getFullYear(), M = e ? +e[2] : n.getMonth() + 1, D = e ? +e[3] : n.getDate();
  if (+a[2] === 0) return null;
  return Y - +a[1] - (M < +a[2] || (M === +a[2] && D < +a[3]) ? 1 : 0);
};
const hav = (a, b) => { const R = 6371.0088, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lon - a.lon) * r; const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
// d: server answer {label, desc, v: [{amount, unit} | {time, prec, asOf} | {label} | {lat, lon}], b?: same for subject 2}
export const wdAnswer = (w, d, now = Date.now()) => {
  if (!w || !d || !d.label || !Array.isArray(d.v) || !d.v.length) return null;
  const v = d.v[0], who = d.label, src = "Wikidata";
  const desc = d.desc ? ` · ${d.desc}` : "";
  if (w.fact === "height") {
    const f = UNIT_M[v.unit];
    const amt = Number(v.amount);
    if (!f || !Number.isFinite(amt)) return null;
    const mtr = amt * f, ft = mtr / 0.3048;
    return { kind: "fact", label: `${who} · height`, value: `${fmtNum(mtr, 4)} m`, detail: `${Math.round(ft).toLocaleString("en-US")} ft${desc}`, copy: `${plain(mtr)} m`, src };
  }
  if (w.fact === "population") {
    const n = Number(v.amount);
    if (!Number.isFinite(n) || n <= 0) return null;
    const asOf = v.asOf ? wdDay(v.asOf, 9) : "";
    return { kind: "fact", label: `${who} · population`, value: Math.round(n).toLocaleString("en-US"), detail: `${asOf ? `as of ${asOf}` : ""}${asOf ? desc : desc.slice(3)}`, copy: String(Math.round(n)), src };
  }
  if (w.fact === "age") {
    const age = v.prec >= 11 ? ageAt(v.time, now, d.died) : null;
    if (age == null || d.died) return null; // "how old was" isn't asked; a person who died gets no "age"
    return { kind: "fact", label: `${who} · age`, value: `${age} years`, detail: `born ${wdDay(v.time, v.prec)}${desc}`, copy: String(age), src };
  }
  if (w.fact === "born" || w.fact === "died" || w.fact === "founded" || w.fact === "released") {
    const day = wdDay(v.time, v.prec);
    if (!day) return null;
    let extra = "";
    if (w.fact === "born" && v.prec >= 11) { const died = d.died; const age = ageAt(v.time, now, died); if (age != null) extra = died ? ` · died at ${age}` : ` · age ${age}`; }
    const what = { born: "born", died: "died", founded: "founded", released: "released" }[w.fact];
    return { kind: "fact", label: `${who} · ${what}`, value: day, detail: `${extra.slice(3)}${extra ? desc : desc.slice(3)}`, copy: day, src };
  }
  if (w.fact === "ceo") {
    if (!v.label) return null;
    return { kind: "fact", label: `${who} · CEO`, value: v.label, detail: desc.slice(3), copy: v.label, src };
  }
  if (w.fact === "distance") {
    const b = d.b;
    if (!b || !b.label || !Array.isArray(b.v) || !b.v.length || !Number.isFinite(v.lat) || !Number.isFinite(b.v[0].lat)) return null;
    const km = hav(v, b.v[0]), mi = km / 1.609344;
    return { kind: "fact", label: `${who} to ${b.label} · straight line`, value: `${fmtNum(km, 3)} km`, detail: `${Math.round(mi).toLocaleString("en-US")} mi as the crow flies`, copy: `${Math.round(km)} km`, src };
  }
  return null;
};

// ----- CMU course card (CMU Courses' numbers: ScottyLabs course-tool fce.ts aggregateFCEs + user.ts defaults) -----
// Drop 0% response rate, fall + spring only, Pittsburgh only, exact-duplicate rows merged, the 2 most recent counted
// semesters, means weighted by respondents. rating[7] = teaching, rating[8] = course (0-based).
const SEM = { spring: 1, summer: 2, fall: 3 };
const pct = (x) => { const n = parseFloat(String(x ?? "").replace("%", "")); return Number.isFinite(n) ? n : 0; };
const prettyName = (n) => { const m = /^\s*([^,]+),\s*(.+)$/.exec(String(n || "")); const t = (x) => x.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (a, b, c) => b + c.toUpperCase()); return m ? { full: `${t(m[2])} ${t(m[1])}`, last: t(m[1]) } : { full: t(String(n || "").trim()), last: t(String(n || "").trim().split(" ").pop() || "") }; };
export const cmuAgg = (rows) => {
  const seen = new Set();
  const ok = (Array.isArray(rows) ? rows : []).filter((r) => {
    if (!r || !Array.isArray(r.rating) || r.rating.length < 9) return false;
    const sem = String(r.semester || "").toLowerCase();
    if (sem !== "fall" && sem !== "spring") return false;
    if (pct(r.responseRate) <= 0 || !(Number(r.numRespondents) > 0)) return false;
    if (r.location && !/pittsburgh/i.test(String(r.location))) return false;
    const k = JSON.stringify(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const key = (r) => Number(r.year) * 10 + SEM[String(r.semester).toLowerCase()];
  const sems = [...new Set(ok.map(key))].sort((a, b) => b - a).slice(0, 2);
  const use = ok.filter((r) => sems.includes(key(r)));
  if (!use.length) return null;
  const wmean = (rs, f) => { let a = 0, n = 0; for (const r of rs) { const v = Number(f(r)), w = Number(r.numRespondents); if (Number.isFinite(v) && w > 0) { a += v * w; n += w; } } return n ? a / n : null; };
  const latest = use.filter((r) => key(r) === sems[0]);
  const profs = [];
  for (const r of latest) for (const raw of String(r.instructor || "").split(/;|\band\b/)) {
    const nm = raw.trim();
    if (!nm || profs.some((p) => p.raw === nm)) continue;
    const mine = use.filter((x) => String(x.instructor || "").includes(nm));
    profs.push({ raw: nm, ...prettyName(nm), rating: wmean(mine, (x) => x.rating[7]) });
  }
  profs.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  const s0 = latest[0];
  return { hrs: wmean(use, (r) => r.hrsPerWeek), teach: wmean(use, (r) => r.rating[7]), course: wmean(use, (r) => r.rating[8]), n: use.reduce((a, r) => a + Number(r.numRespondents), 0), sem: `${String(s0.semester).replace(/^./, (c) => c.toUpperCase())} ${s0.year}`, profs };
};
const one = (x) => (x == null ? "" : (Math.round(x * 10) / 10).toFixed(1));
// c: cmuCourse(q) result; course: {courseID, name, units, prereqs}; fces: rows
export const cmuAnswer = (c, course, fces) => {
  if (!c || !c.level || !course || !course.name) return null;
  const agg = cmuAgg(fces);
  const ids = String(course.prereqs || "").match(/\b\d{2}-?\d{3}\b/g) || [];
  const pre = [...new Set(ids.map((x) => (x.includes("-") ? x : `${x.slice(0, 2)}-${x.slice(2)}`)))];
  const parts = [];
  if (course.units != null && String(course.units).trim()) parts.push(`${String(course.units).trim()} units`);
  if (agg && agg.hrs != null) parts.push(`${one(agg.hrs)} hrs/wk`);
  if (agg && agg.course != null) parts.push({ stars: Math.round(agg.course * 10) / 10 });
  if (pre.length) parts.push(`prereq ${pre[0]}${pre.length > 1 ? ` +${pre.length - 1}` : ""}`);
  const profs = agg ? agg.profs.map((p) => ({ full: p.full, last: p.last, r: one(p.rating) })) : [];
  return { kind: "cmu", label: "CMU Courses", title: `${c.id} ${course.name}`, href: `https://cmucourses.com/course/${c.id}`, parts, sem: agg ? agg.sem : "", profs, prof: !!c.prof, copy: "" };
};

// ----- Sports card from the server's ESPN game ({state pre|in|post, detail, date, away, home, league}) -----
export const sportsAnswer = (g, now = Date.now()) => {
  if (!g || !g.away || !g.home || !g.away.abbr || !g.home.abbr || !["pre", "in", "post"].includes(g.state)) return null;
  const t = Date.parse(g.date);
  const when = Number.isFinite(t) ? new Date(t).toLocaleString("en-US", g.state === "pre" ? { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { weekday: "short", month: "short", day: "numeric" }) : "";
  const status = g.state === "in" ? (g.detail || "Live") : g.state === "post" ? (g.detail || "Final") : "Next game";
  const rec = [g.away, g.home].filter((x) => x.record).map((x) => `${x.abbr} ${x.record.replace(/-/g, "–")}`).join(" · ");
  return { kind: "sports", label: g.league || "", live: g.state === "in", status, teams: [g.away, g.home], showScore: g.state !== "pre", detail: [when, rec].filter(Boolean).join(" · "), copy: g.state === "pre" ? "" : `${g.away.abbr} ${g.away.score} – ${g.home.score} ${g.home.abbr}` };
};

// ----- Knowledge panel (spec 3): which searches ask for one, and whether the results back it up -----
// Short name-like searches only: no question, task, shopping or command words (those want results or an answer)
const KP_NOT = /^(?:how|what|whats|why|when|where|who|whos|which|is|are|was|do|does|did|can|could|should|will|define|weather|time|best|top|cheap|buy|download|install|watch|play|login|log|sign|free|near|latest|new)\b|\b(?:vs|versus|or|near me|review|reviews|price|prices|deal|deals|stock|tutorial|login|error|errors|support|setup|fix|not working|lyrics|meaning|tickets|hours|menu|coupon|codes?|app|apk|wallpaper|jobs|careers|salary|today|tonight|score|schedule|news|recipe|pdf|reddit)\b/i;
export const kpQuery = (q) => {
  const s = String(q || "").trim().replace(/\s+/g, " ");
  if (s.length < 2 || s.length > 60 || s.split(" ").length > 5) return null;
  if (!/^[\p{L}\d][\p{L}\d .'&-]*$/u.test(s) || /^[\d .-]+$/.test(s) || KP_NOT.test(s)) return null;
  // Code-like words (useEffect, 1Z999…) aren't names of things
  if (/\p{Ll}\p{Lu}/u.test(s) || /\d\p{L}|\p{L}\d/u.test(s)) return null;
  return s;
};
// Titles compared without case, underscores/hyphens or a "(qualifier)"
const kpNorm = (t) => String(t || "").toLowerCase().replace(/[_-]+/g, " ").replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
// The panel shows only when a result is that same article: Wikipedia itself (that result is then hidden: the panel
// replaces it), or the same article on Wikiwand (a Wikipedia mirror) or Britannica (on the user's engines no
// Wikipedia result came back in 50 recorded searches; Britannica's article is the same evidence that this meaning
// is the one the results are about). Returns {ok, wiki: [indices of Wikipedia results]}.
export const kpMatch = (title, urls) => {
  const t = kpNorm(title), wiki = [];
  let ok = false;
  if (!t) return { ok, wiki };
  (urls || []).forEach((h, i) => {
    let u;
    try { u = new URL(h); } catch { return; }
    let path;
    try { path = decodeURIComponent(u.pathname); } catch { path = u.pathname; }
    const host = u.hostname.replace(/^www\./, "");
    let m;
    if (/^en\.(?:m\.)?wikipedia\.org$/.test(host) && (m = /^\/wiki\/([^/]+)$/.exec(path)) && kpNorm(m[1]) === t) { ok = true; wiki.push(i); }
    else if (host === "wikiwand.com" && (m = /^\/en\/(?:articles\/)?([^/]+)$/.exec(path)) && kpNorm(m[1]) === t) ok = true;
    else if (host === "britannica.com" && (m = /^\/(?:topic|biography|place|science|art|technology|event|animal|plant|money|sports|summary)\/([^/]+)/.exec(path)) && kpNorm(m[1]) === t) ok = true;
  });
  return { ok, wiki };
};
// Phone line: up to 3 facts, short ("Born Dec 13, 1989 · Height 330 m (1,083 ft)"); the page drops what doesn't fit
export const kpLine = (facts) => (facts || []).slice(0, 4).map((f) => `${f.k} ${f.v}`);

// ----- Meaning line (spec 9): the search's words have several meanings (Wikidata's matches for them), and the
// results cover just one: "Also: snakes · Monty Python", each a search that adds the word. Results covering two or
// more meanings (mercury: planet, element, bank) get no line. Never reorders or interleaves results.
const MEAN_STOP = new Set("about after also american british from into known like main more most other over part such than that their them then there these they this used uses using very were what when where which while with within without world".split(" "));
const meanWords = (t) => new Set(String(t || "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4 && !MEAN_STOP.has(w)).map((w) => w.replace(/(?<=\w{3})s$/, "")));
export const meaningLine = (q, alts, texts) => {
  const s = String(q || "").trim().toLowerCase();
  if (!s || !Array.isArray(alts) || alts.length < 2) return null;
  const qw = meanWords(s);
  const sets = alts.map((a) => { const w = meanWords(a.desc); for (const x of meanWords(a.label)) if (!qw.has(x)) w.add(x); for (const x of qw) w.delete(x); return w; });
  const count = new Map();
  for (const w of sets) for (const x of w) count.set(x, (count.get(x) || 0) + 1);
  const own = sets.map((w) => [...w].filter((x) => count.get(x) === 1));
  const docs = (texts || []).slice(0, 10).map((t) => meanWords(t));
  const cov = own.map((ws) => docs.filter((d) => ws.some((x) => d.has(x))).length);
  const top = cov.indexOf(Math.max(...cov));
  if (cov[top] < 3 || cov.some((c, i) => i !== top && c > 0)) return null;
  const chips = [];
  alts.forEach((a, i) => {
    if (i === top || !own[i].length || chips.length >= 3) return;
    const label = String(a.label).trim(), ll = label.toLowerCase();
    if (ll !== s && ` ${ll.replace(/[^\p{L}\p{N}]+/gu, " ")} `.includes(` ${s.replace(/[^\p{L}\p{N}]+/gu, " ")} `)) { if (!chips.some((c) => c.q === label)) chips.push({ text: label, q: label }); return; }
    // the description's last own word ("family of snakes" -> "snake", as the search would say it)
    const dw = String(a.desc).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => own[i].includes(w.replace(/(?<=\w{3})s$/, "")));
    const w = dw.length ? dw[dw.length - 1] : own[i][0];
    const nq = `${String(q).trim()} ${w}`;
    if (!chips.some((c) => c.q === nq)) chips.push({ text: w, q: nq });
  });
  return chips.length ? chips : null;
};

// ----- Images row (spec 12): searches that clearly want pictures, from their words -----
const VISUAL = /\b(?:pictures?|photos?|photographs?|images?|pics?|wallpapers?|logos?|aesthetic|tattoos?|outfits?|hairstyles?|haircuts?|drawings?|paintings?|memes?|gifs?|clipart|inspo|nail designs?|room ideas|decor ideas|cake ideas|what does .+ look like)\b/i;
// …but not tasks about image files ("image processing python", "resize photo", "logo generator")
const NOT_VISUAL = /\b(?:processing|python|javascript|java|css|html|api|upload|resize|crop|compress|convert|converter|format|size|editor|edit|search|generator|ai|dataset|recognition|classification|docker|file|files|link|url|tag|src|alt text|background remover|remove background|to pdf|to text|ocr)\b/i;
export const visualQ = (q) => { const s = String(q || "").trim(); return !!s && !s.startsWith("!") && s.length <= 100 && VISUAL.test(s) && !NOT_VISUAL.test(s); };

// ----- !deepl (spec 14): "!deepl text" or "!deepl de text" -> DeepL's translator with that text (target English
// unless a DeepL target code comes first). URL form from knowledge (#source/target/text), not live-checked.
const DEEPL_TO = new Set(["ar", "bg", "cs", "da", "de", "el", "en", "es", "et", "fi", "fr", "he", "hu", "id", "it", "ja", "ko", "lt", "lv", "nb", "nl", "pl", "pt", "ro", "ru", "sk", "sl", "sv", "th", "tr", "uk", "vi", "zh"]);
export const deeplUrl = (q) => {
  const m = /^\s*!deepl(?:\s+([\s\S]*))?$/i.exec(String(q || ""));
  if (!m) return "";
  let text = (m[1] || "").trim(), to = "en";
  const w = /^([a-z]{2})\s+([\s\S]+)$/i.exec(text);
  if (w && DEEPL_TO.has(w[1].toLowerCase())) { to = w[1].toLowerCase(); text = w[2].trim(); }
  return text ? `https://www.deepl.com/translator#auto/${to}/${encodeURIComponent(text).replace(/%2F/g, "%5C%2F")}` : "https://www.deepl.com/translator";
};

// ----- The one local answer for a search, or null. CMU course numbers are left to the CMU card (network). -----
export const answer = (q, now = Date.now(), data = {}) => {
  const s = String(q || "").trim();
  if (!s || s.length > 200 || s.startsWith("!")) return null;
  if (/^\d{2}-\d{3}\b/.test(s)) return null;
  return pattern(s) || convert(s) || currency(s, data.fx) || percent(s) || dateMath(s, now) || calc(s);
};
