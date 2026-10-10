// 临时诊断脚本：在 app.asar 中扫描「为你推荐」字节序列，打印命中点上下文
import { open } from "node:fs/promises";

const ASAR = "C:/Users/letichen/AppData/Local/Programs/workbuddy/resources/app.asar";
const NEEDLE = Buffer.from("为你推荐", "utf8");
const CHUNK = 8 * 1024 * 1024;
const OVERLAP = NEEDLE.length - 1;

const fh = await open(ASAR, "r");
let offset = 0;
let hits = 0;
const contexts = [];
let tail = Buffer.alloc(0);

while (true) {
  const buf = Buffer.alloc(CHUNK);
  const { bytesRead } = await fh.read(buf, 0, CHUNK, offset);
  if (bytesRead === 0) break;
  const data = tail.length ? Buffer.concat([tail, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
  const base = offset - tail.length;
  let idx = -1;
  while ((idx = data.indexOf(NEEDLE, idx + 1)) !== -1) {
    hits++;
    if (contexts.length < 6) {
      const start = Math.max(0, idx - 700);
      const end = Math.min(data.length, idx + NEEDLE.length + 700);
      contexts.push({ offset: base + idx, text: data.subarray(start, end).toString("utf8") });
    }
  }
  tail = data.subarray(data.length - OVERLAP);
  offset += bytesRead;
}
await fh.close();
console.log(`hits: ${hits}`);
for (const c of contexts) {
  console.log(`\n===== offset ${c.offset} =====`);
  console.log(c.text.replace(/[^\x20-\x7e\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\n]/g, "·"));
}
