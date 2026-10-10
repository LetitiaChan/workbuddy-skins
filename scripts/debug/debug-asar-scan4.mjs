// 临时诊断脚本：扫 \u 转义的「为你推荐」与 .wb-home-composer__chips / recommend 相关 CSS 定义
import { open } from "node:fs/promises";

const ASAR = "C:/Users/letichen/AppData/Local/Programs/workbuddy/resources/app.asar";
const TARGETS = [
  { name: "escaped-为你推荐", buf: Buffer.from("4e3a\\u4f60\\u63a8\\u8350", "utf8") },
  { name: "chips-rule", buf: Buffer.from(".wb-home-composer__chips{", "utf8") },
  { name: "chips-bg", buf: Buffer.from("wb-home-composer__chips", "utf8") },
  { name: "label-recommend", buf: Buffer.from("quick-actions__label", "utf8") },
  { name: "recommend-i18n", buf: Buffer.from("RecommendForYou", "utf8") },
  { name: "recommend-i18n2", buf: Buffer.from("forYou", "utf8") },
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
      if (f.samples.length < 4) {
        f.samples.push({ offset: base + idx, text: data.subarray(Math.max(0, idx - 350), Math.min(data.length, idx + 650)).toString("utf8") });
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
    console.log(`  --- offset ${s.offset} ---`);
    console.log("  " + clean(s.text));
  }
}
