// 临时诊断脚本：找 skills.recommend.bar.label 的组件用法与 DOM 结构
import { open } from "node:fs/promises";

const ASAR = "C:/Users/letichen/AppData/Local/Programs/workbuddy/resources/app.asar";
const TARGETS = [
  { name: "usage-bar-label", buf: Buffer.from("skills.recommend.bar.label", "utf8") },
  { name: "skill-recommend-class", buf: Buffer.from("wb-home-composer__skill-recommend", "utf8") },
];
const CHUNK = 8 * 1024 * 1024;
const OVERLAP = 64;

const fh = await open(ASAR, "r");
let offset = 0;
let tail = Buffer.alloc(0);
const found = new Map(TARGETS.map((t) => [t.name, { hits: 0, samples: [] }]));

while (true) {
  const buf = Buffer.alloc(CHUNK);
  const { bytesRead } = await fh.read(buf, 0, CHUNK, offset);
  if (bytesRead === 0) break;
  const data = tail.length ? Buffer.concat([tail, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
  const base = offset - tail.length;
  for (const t of TARGETS) {
    let idx = -1;
    while ((idx = data.indexOf(t.buf, idx + 1)) !== -1) {
      const f = found.get(t.name);
      f.hits++;
      // 组件用法：排除 i18n 定义处（205950304 附近即 205.9MB 区域）
      const off = base + idx;
      if (f.samples.length < 6 && !(t.name === "usage-bar-label" && off > 205000000 && off < 206000000)) {
        f.samples.push({ offset: off, text: data.subarray(Math.max(0, idx - 600), Math.min(data.length, idx + 1200)).toString("utf8") });
      }
    }
  }
  tail = data.subarray(data.length - OVERLAP);
  offset += bytesRead;
}
await fh.close();

const clean = (t) => t.replace(/[^\x20-\x7e]/g, "·").replace(/·{4,}/g, "····");
for (const [name, f] of found) {
  console.log(`\n######## ${name} hits=${f.hits}`);
  for (const s of f.samples) {
    console.log(`\n  --- offset ${s.offset} ---`);
    console.log("  " + clean(s.text));
  }
}
