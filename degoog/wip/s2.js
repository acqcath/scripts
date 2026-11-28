import net from "node:net"; import fs from "node:fs";
try { fs.unlinkSync("/tmp/claude-0/w/t.sock"); } catch {}
net.createServer((c) => { setTimeout(() => c.write('{"rev":"9|0"}\n'), 800); }).listen("/tmp/claude-0/w/t.sock");
setTimeout(() => process.exit(0), 5000);
