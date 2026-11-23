const fs = require("fs");
const f = "/app/data/server-settings.json";
const s = JSON.parse(fs.readFileSync(f, "utf8"));
s.settings = s.settings || {};
s.settings.customCss = fs.readFileSync("/tmp/custom.css", "utf8");
// Result menu with Rank higher / Rank lower / Block, and endless scroll (both built into degoog)
s.settings.domainBlockUiEnabled = true;
s.settings.domainScoreUiEnabled = true;
s.settings.infiniteScrollEnabled = true;
fs.writeFileSync(f + ".tmp", JSON.stringify(s, null, 2));
fs.renameSync(f + ".tmp", f);
console.log("custom CSS saved into degoog: " + s.settings.customCss.length + " chars");