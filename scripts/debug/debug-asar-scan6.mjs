// 临时诊断脚本：定位 zh-CN 文案在包内的编码形式
import { open } from "node:fs/promises";

const ASAR = "C:/Users/letichen/AppData/Local/Programs/workbuddy/resources/app.asar";
const TARGETS = [
  { name: "utf8-日常办公", buf: Buffer.from("日常办公", "utf8") },
  { name: "esc-lower-日常办公", buf: Buffer.from("\\u65e5\\u5e38\\u529e\\u516c", "utf8") },
  { name: "esc-upper-日常办公", buf: Buffer.from("\\u65E5\\u5E38\\u529E\\u516C", "utf8") },
  { name: "utf16-日常办公", buf: Buffer.from("日常办公", "utf16le") },
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
      if (f.samples.length < 2) {
        f.samples.push({ offset: base + idx, text: data.subarray(Math.max(0, idx - 200), Math.min(data.length, idx + 300)).toString("utf8") });
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
