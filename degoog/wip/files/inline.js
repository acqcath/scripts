const fs = require("fs");
const crypto = require("crypto");
const f = "/app/src/public/themes/degoog-theme/layout.html";
let h = fs.readFileSync(f, "utf8");
const code = fs.readFileSync("/tmp/ct.js", "utf8");
const dir = "/app/src/public/ct";
fs.mkdirSync(dir, { recursive: true });
// Static files degoog serves with a 1-year immutable cache (/public/*.js), named by their content so a new version
// gets a new name. degoog doesn't compress pages, so these used to cost ~280 KB on every page load (the page script
// was inlined, 208 KB): as files the browser downloads them once and keeps them (and their compiled code).
const put = (name, body) => {
  const hash = crypto.createHash("sha256").update(body).digest("hex").slice(0, 12);
  for (const old of fs.readdirSync(dir)) if (new RegExp(`^${name}\\.[0-9a-f]+\\.js$`).test(old) && old !== `${name}.${hash}.js`) fs.rmSync(`${dir}/${old}`);
  fs.writeFileSync(`${dir}/${name}.${hash}.js`, body);
  return `/public/ct/${name}.${hash}.js`;
};
// Public suffix list (which part of a host is the site: bbc.co.uk, user.github.io), then the page script; defer and
// module scripts run in page order, before results arrive. modulepreload starts the page script's download with the
// page's head instead of at its end.
const psl = fs.readFileSync("/tmp/psl.enc", "utf8").trim();
const pslUrl = put("psl", `window.CT_PSL=${JSON.stringify(psl)};\n`);
const ctUrl = put("ct", `const __PLUGIN_ID__="clean-titles";\n${code}\n`);
const block = `<script defer src="${pslUrl}" id="ct-psl"></script>\n<script type="module" src="${ctUrl}" id="ct-inline"></script>`;
const re = /(?:<script defer src="\/public\/ct\/psl\.[0-9a-f]+\.js" id="ct-psl"><\/script>\n)?(?:<script type="module" id="ct-inline">[\s\S]*?\n<\/script>|<script type="module" src="\/public\/ct\/ct\.[0-9a-f]+\.js" id="ct-inline"><\/script>)/;
h = re.test(h) ? h.replace(re, () => block) : h.replace("</body>", () => block + "\n</body>");
const pre = `<link rel="modulepreload" href="${ctUrl}" id="ct-pre">`;
const preRe = /<link rel="modulepreload" href="\/public\/ct\/ct\.[0-9a-f]+\.js" id="ct-pre">/;
h = preRe.test(h) ? h.replace(preRe, () => pre) : h.replace("</head>", () => `${pre}\n</head>`);
fs.writeFileSync(f, h);
console.log(`public suffix list: ${pslUrl} (${psl.length} chars)`);
console.log(`page script: ${ctUrl} (${code.length} chars, cached by the browser)`);
