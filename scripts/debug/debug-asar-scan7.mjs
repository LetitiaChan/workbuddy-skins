// 临时诊断脚本：定位「为你推荐」i18n key 及其组件用法
import { open } from "node:fs/promises";

const ASAR = "C:/Users/letichen/AppData/Local/Programs/workbuddy/resources/app.asar";
const TARGETS = [
  { name: "esc-为你推荐", buf: Buffer.from("\\u4E3A\\u4F60\\u63A8\\u8350", "utf8") },
];
const CHUNK = 8 * 1024 * 1024;
const OVERLAP = 64;

const fh = await open(ASAR, "r");
let offset = 0;
let tail = Buffer.alloc(0);
let hits = 0;
const samples = [];

while (true) {
  const buf = Buffer.alloc(CHUNK);
  const { bytesRead } = await fh.read(buf, 0, CHUNK, offset);
  if (bytesRead === 0) break;
  const data = tail.length ? Buffer.concat([tail, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
  const base = offset - tail.length;
  let idx = -1;
  while ((idx = data.indexOf(TARGETS[0].buf, idx + 1)) !== -1) {
    hits++;
    if (samples.length < 10) {
      samples.push({ offset: base + idx, text: data.subarray(Math.max(0, idx - 260), Math.min(data.length, idx + 200)).toString("utf8") });
    }
  }
  tail = data.subarray(data.length - OVERLAP);
  offset += bytesRead;
}
await fh.close();

const clean = (t) => t.replace(/[^\x20-\x7e]/g, "·").replace(/·{4,}/g, "····");
console.log(`hits=${hits}`);
for (const s of samples) {
  console.log(`\n  --- offset ${s.offset} ---`);
  console.log("  " + clean(s.text));
}
