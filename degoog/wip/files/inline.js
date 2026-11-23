const fs = require("fs");
const f = "/app/src/public/themes/degoog-theme/layout.html";
let h = fs.readFileSync(f, "utf8");
const code = fs.readFileSync("/tmp/ct.js", "utf8").replace(/<\/script/gi, "<\\/script");
const block = '<script type="module" id="ct-inline">const __PLUGIN_ID__="clean-titles";\n' + code + '\n</script>';
const re = /<script type="module" id="ct-inline">[\s\S]*?\n<\/script>/;
h = re.test(h) ? h.replace(re, () => block) : h.replace("</body>", () => block + "\n</body>");
fs.writeFileSync(f, h);