// Runs inside the degoog container (docker exec ... bun /tmp/ct-wait.js), started by the PC's watcher, and sleeps
// until there's something to do; then prints one JSON line and exits. Nothing is checked on a timer:
//   {"kind":"reports","rev":"..."} a ⚑ was saved (pc.json rev changed from the one the watcher last handled)
//   {"kind":"update","id":"..."}   a release was pushed (ntfy ping from the repo's GitHub Action), and no search ran
//                                  for 15 s (pc.json last), so the install never restarts degoog mid-search
//   {"kind":"idle"}                mode idle: degoog unused for 15 s
//   {"kind":"timer"}               the job asked to run again at a time (a failed install, the AI still building)
// args: plugin dir, ntfy topic, ntfy since (last ping id or ""), handled rev, ms until the job's timer (0 = none), mode
import fs from "node:fs";
import net from "node:net";
// ("-" = empty: Windows drops empty arguments)
const [dir, topic, since0, handled, timerMs, mode] = process.argv.slice(2).map((x) => (x === "-" ? "" : x));
// 15 s: a search, its endless-scroll pages and the page's follow-up calls are done well within it
const IDLE = 15000;
let pending = null, since = since0 || "", done = false;
const out = (o) => { if (done) return; done = true; process.stdout.write(JSON.stringify(o) + "\n"); process.exit(0); };
const pc = () => { try { return JSON.parse(fs.readFileSync(`${dir}/pc.json`, "utf8")) || {}; } catch { return {}; } };
let idleT = null;
const check = () => {
  const p = pc();
  if (mode !== "idle" && p.rev && p.rev !== handled) return out({ kind: "reports", rev: p.rev });
  if (mode === "idle" || pending) {
    const left = (p.last || 0) + IDLE - Date.now();
    if (left <= 0) return out(mode === "idle" ? { kind: "idle" } : { kind: "update", id: pending });
    clearTimeout(idleT); idleT = setTimeout(check, left + 50); // a newer search moves pc.json's last: check() re-arms
  }
};
try { fs.watch(dir, (e, f) => { if (f === "pc.json") check(); }); } catch {}
// The server also pushes each change down a socket in /tmp (a file change alone may not wake fs.watch on every kind
// of Docker volume); a dropped socket (degoog restarting) is opened again
const sock = () => {
  if (done) return;
  const c = net.createConnection(process.env.CT_SOCK || "/tmp/ct-pc.sock");
  c.on("data", () => check());
  c.on("error", () => {});
  c.on("close", () => { if (!done) setTimeout(sock, 5000); });
};
sock();
if (+timerMs > 0) setTimeout(() => out({ kind: "timer" }), Math.min(+timerMs, 2147483000));
check();
// The push ping: one long-lived connection to ntfy.sh (it sends a keepalive every ~45 s); a dropped connection is
// opened again with since = the last message seen, so a ping sent meanwhile isn't lost
const listen = async () => {
  for (let wait = 1000; !done; wait = Math.min(wait * 2, 60000)) {
    try {
      // a connection that went silent (the PC slept, the network changed) is dropped after 2 min without even
      // ntfy's keepalive (every ~45 s) and opened again
      const ab = new AbortController();
      let dog = setTimeout(() => ab.abort(), 120000);
      const r = await fetch(`${process.env.CT_NTFY || "https://ntfy.sh"}/${topic}/json${since ? `?since=${encodeURIComponent(since)}` : ""}`, { signal: ab.signal });
      if (!r.ok || !r.body) throw new Error(String(r.status));
      wait = 1000;
      const dec = new TextDecoder(); let buf = "";
      for await (const ch of r.body) {
        clearTimeout(dog); dog = setTimeout(() => ab.abort(), 120000);
        buf += dec.decode(ch, { stream: true });
        let n;
        while ((n = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, n); buf = buf.slice(n + 1);
          let m; try { m = JSON.parse(line); } catch { continue; }
          if (m && m.event === "message" && m.id) { since = m.id; if (mode !== "idle") { pending = m.id; check(); } }
        }
      }
    } catch {}
    if (!done) await new Promise((res) => setTimeout(res, wait));
  }
};
if (mode !== "idle" && topic) listen();
