const fs = require("fs");
const crypto = require("crypto");
const f = "/app/src/public/themes/degoog-theme/layout.html";
let h = fs.readFileSync(f, "utf8");
const code = fs.readFileSync("/tmp/ct.js", "utf8").replace(/<\/script/gi, "<\\/script");
// Public suffix list (which part of a host is the site: bbc.co.uk, user.github.io): a static file degoog serves
// with a 1-year immutable cache, named by its content so a new list gets a new name. Loaded with defer before the
// module (both run in page order, before results arrive); not inlined, as degoog doesn't compress pages (76 KB)
const psl = fs.readFileSync("/tmp/psl.enc", "utf8").trim();
const hash = crypto.createHash("sha256").update(psl).digest("hex").slice(0, 12);
const dir = "/app/src/public/ct";
fs.mkdirSync(dir, { recursive: true });
for (const old of fs.readdirSync(dir)) if (/^psl\.[0-9a-f]+\.js$/.test(old) && old !== `psl.${hash}.js`) fs.rmSync(`${dir}/${old}`);
fs.writeFileSync(`${dir}/psl.${hash}.js`, `window.CT_PSL=${JSON.stringify(psl)};\n`);
const block = `<script defer src="/public/ct/psl.${hash}.js" id="ct-psl"></script>\n<script type="module" id="ct-inline">const __PLUGIN_ID__="clean-titles";\n` + code + "\n</script>";
const re = /(?:<script defer src="\/public\/ct\/psl\.[0-9a-f]+\.js" id="ct-psl"><\/script>\n)?<script type="module" id="ct-inline">[\s\S]*?\n<\/script>/;
h = re.test(h) ? h.replace(re, () => block) : h.replace("</body>", () => block + "\n</body>");
fs.writeFileSync(f, h);
console.log(`public suffix list: /public/ct/psl.${hash}.js (${psl.length} chars)`);
