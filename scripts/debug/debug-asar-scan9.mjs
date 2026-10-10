// 临时诊断脚本：提取 .wb-skill-rec-bar 全部 CSS 规则
import { open } from "node:fs/promises";

const ASAR = "C:/Users/letichen/AppData/Local/Programs/workbuddy/resources/app.asar";
const NEEDLE = Buffer.from(".wb-skill-rec-bar", "utf8");
const CHUNK = 8 * 1024 * 1024;
const OVERLAP = 64;

const fh = await open(ASAR, "r");
let offset = 0;
let tail = Buffer.alloc(0);
const samples = [];
let hits = 0;

while (true) {
  const buf = Buffer.alloc(CHUNK);
  const { bytesRead } = await fh.read(buf, 0, CHUNK, offset);
  if (bytesRead === 0) break;
  const data = tail.length ? Buffer.concat([tail, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
  const base = offset - tail.length;
  let idx = -1;
  while ((idx = data.indexOf(NEEDLE, idx + 1)) !== -1) {
    hits++;
    const off = base + idx;
    // CSS 语境过滤：附近有 { 或 background
    const ctx = data.subarray(Math.max(0, idx - 100), Math.min(data.length, idx + 200)).toString("utf8");
    if (ctx.includes("{") || ctx.includes("background")) {
      samples.push({ offset: off, text: data.subarray(Math.max(0, idx - 150), Math.min(data.length, idx + 1600)).toString("utf8") });
    }
  }
  tail = data.subarray(data.length - OVERLAP);
  offset += bytesRead;
}
await fh.close();

const clean = (t) => t.replace(/[^\x20-\x7e]/g, "·").replace(/·{4,}/g, "····");
console.log(`hits=${hits}, css-context samples=${samples.length}`);
for (const s of samples) {
  console.log(`\n  --- offset ${s.offset} ---`);
  console.log("  " + clean(s.text));
}
