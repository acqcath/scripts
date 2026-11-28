// ----- server/02-net.js: net(): the one fetch helper every outside request goes through -----
// ===== Shared fetch helper: every outside request goes through here (timeout, size cap, never throws) =====
// -> {status, text, etag} or {status: 0} on any failure. 304 when the If-None-Match tag still matches.
// redirect: "manual" returns a 3xx as is, with its Location (archive.today answers a found copy that way)
// imp: on 403/429/503 ask once more through degoog's curl-impersonate transport (a browser's TLS fingerprint; the
// degoog image ships it), for sites that turn away plain server requests (ESPN, recipe sites). Only with degoog's
// own fetch (ctx.fetch = outgoingFetch, whose 3rd argument picks the transport).
export const net = async (url, { etag = "", timeout = 10000, max = 2_000_000, accept = "*/*", headers = {}, redirect = "follow", imp = false } = {}) => {
  try {
    const f = _fetch || fetch;
    const init = () => ({ headers: { Accept: accept, ...headers, ...(etag ? { "If-None-Match": etag } : {}) }, signal: AbortSignal.timeout(timeout), redirect });
    let r = await f(url, init());
    if (imp && _fetch && [403, 429, 503].includes(r.status)) { try { const r2 = await _fetch(url, init(), "curl-impersonate"); if (r2 && typeof r2.status === "number") r = r2; } catch {} }
    if (r.status === 304) return { status: 304, text: "", etag };
    if (redirect === "manual" && r.status >= 300 && r.status < 400) return { status: r.status, text: "", etag: "", location: r.headers.get("location") || "" };
    if (!r.ok) return { status: r.status, text: "", etag: "" };
    const text = await r.text();
    if (text.length > max) return { status: 0, text: "", etag: "" };
    return { status: r.status, text, etag: r.headers.get("etag") || "" };
  } catch { return { status: 0, text: "", etag: "" }; }
};

