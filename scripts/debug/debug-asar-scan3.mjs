// 临时诊断脚本：提取 quick-actions 相关 CSS 规则原文
import { open } from "node:fs/promises";

const ASAR = "C:/Users/letichen/AppData/Local/Programs/workbuddy/resources/app.asar";
const NEEDLE = Buffer.from("quick-actions-fade", "utf8");
const NEEDLE2 = Buffer.from("quick-actions-container", "utf8");
const CHUNK = 8 * 1024 * 1024;
const OVERLAP = 64;

const fh = await open(ASAR, "r");
let offset = 0;
let tail = Buffer.alloc(0);
const samples = { fade: [], container: [] };

while (true) {
  const buf = Buffer.alloc(CHUNK);
  const { bytesRead } = await fh.read(buf, 0, CHUNK, offset);
  if (bytesRead === 0) break;
  const data = tail.length ? Buffer.concat([tail, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
  const base = offset - tail.length;

  let idx = -1;
  while ((idx = data.indexOf(NEEDLE, idx + 1)) !== -1) {
    if (samples.fade.length < 8) {
      samples.fade.push({ offset: base + idx, text: data.subarray(Math.max(0, idx - 500), Math.min(data.length, idx + 900)).toString("utf8") });
    }
  }
  idx = -1;
  while ((idx = data.indexOf(NEEDLE2, idx + 1)) !== -1) {
    const ctx = data.subarray(Math.max(0, idx - 200), Math.min(data.length, idx + 400)).toString("utf8");
    // 只收集 CSS 语境（含 { 或 background）
    if ((ctx.includes("{") || ctx.includes("background")) && samples.container.length < 8) {
      samples.container.push({ offset: base + idx, text: data.subarray(Math.max(0, idx - 400), Math.min(data.length, idx + 800)).toString("utf8") });
    }
  }
  tail = data.subarray(data.length - OVERLAP);
  offset += bytesRead;
}
await fh.close();

const clean = (t) => t.replace(/[^\x20-\x7e]/g, "·").replace(/·{4,}/g, "····");
for (const [k, arr] of Object.entries(samples)) {
  console.log(`\n######## ${k} (${arr.length} samples)`);
  for (const s of arr) {
    console.log(`\n  --- offset ${s.offset} ---`);
    console.log("  " + clean(s.text));
  }
}
