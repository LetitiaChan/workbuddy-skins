// 临时诊断脚本：在 app.asar 中扫描推荐条带相关 ASCII 锚点
import { open } from "node:fs/promises";

const ASAR = "C:/Users/letichen/AppData/Local/Programs/workbuddy/resources/app.asar";
const NEEDLES = [
  "wb-home-recommend",
  "home-recommend",
  "recommend-bar",
  "recommendBar",
  "forYou",
  "for-you",
  "quick-actions",
  "wb-home-suggest",
  "homeSuggestions",
  "recommendations",
].map((s) => ({ s, buf: Buffer.from(s, "utf8"), hits: 0, samples: [] }));

const CHUNK = 8 * 1024 * 1024;
const MAX_LEN = Math.max(...NEEDLES.map((n) => n.buf.length));
const OVERLAP = MAX_LEN - 1;

const fh = await open(ASAR, "r");
let offset = 0;
let tail = Buffer.alloc(0);

while (true) {
  const buf = Buffer.alloc(CHUNK);
  const { bytesRead } = await fh.read(buf, 0, CHUNK, offset);
  if (bytesRead === 0) break;
  const data = tail.length ? Buffer.concat([tail, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
  const base = offset - tail.length;
  for (const n of NEEDLES) {
    let idx = -1;
    while ((idx = data.indexOf(n.buf, idx + 1)) !== -1) {
      n.hits++;
      if (n.samples.length < 3) {
        const start = Math.max(0, idx - 300);
        const end = Math.min(data.length, idx + n.buf.length + 300);
        n.samples.push({ offset: base + idx, text: data.subarray(start, end).toString("utf8") });
      }
    }
  }
  tail = data.subarray(data.length - OVERLAP);
  offset += bytesRead;
}
await fh.close();

for (const n of NEEDLES) {
  console.log(`\n### "${n.s}" hits=${n.hits}`);
  for (const s of n.samples) {
    console.log(`  --- offset ${s.offset} ---`);
    console.log("  " + s.text.replace(/[^\x20-\x7e]/g, "·").replace(/·{4,}/g, "····"));
  }
}
