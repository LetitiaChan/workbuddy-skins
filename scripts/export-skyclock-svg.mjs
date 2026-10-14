#!/usr/bin/env node
// export-skyclock-svg.mjs —— 导出 sky-clock 主题「当前时刻」的场景 SVG，供 svg-anim-probe.mjs 验证。
//
// sky-clock 的场景是 skin.js 运行时按天空时刻表动态重建的内联 SVG（含 SMIL 星闪/云飘等）。
// 本脚本用最小 DOM 桩（与 test/sky-clock.test.mjs 同款）在 Node 端执行真实 skin.js，
// 抓取它写入 body 的 --sky-art 变量，解码出场景 SVG 写到磁盘，完成「素材 → SVG」这一环。
//
// 用法：
//   node scripts/export-skyclock-svg.mjs [输出路径]   # 缺省输出到 stdout
//
// 与验证工具串成完整链路：
//   node scripts/export-skyclock-svg.mjs sky.svg
//   node scripts/svg-anim-probe.mjs --svg sky.svg --points "180,160;730,125" \
//     --times "1200,2000,2800,3600,4400,5200" --opacity 0.35

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIN_JS = fileURLToPath(new URL("../themes/sky-clock/skin.js", import.meta.url));

function makeEl() {
  const classes = new Set();
  return {
    dataset: {},
    style: {
      props: new Map(),
      setProperty(k, v) { this.props.set(k, v); },
      removeProperty(k) { this.props.delete(k); },
      colorScheme: "",
    },
    classList: {
      toggle(c, w) { if (w) classes.add(c); else classes.delete(c); },
      contains(c) { return classes.has(c); },
    },
  };
}

function exportSvg() {
  const body = makeEl();
  const html = makeEl();
  globalThis.document = {
    body, documentElement: html, hidden: false,
    addEventListener() {}, removeEventListener() {},
  };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  // skin.js 尾部返回拆除回调；此处不清理，进程随脚本自然退出
  new Function(readFileSync(SKIN_JS, "utf8"))();
  const art = body.style.props.get("--sky-art");
  if (!art) throw new Error("未抓到 --sky-art 变量，skin.js 结构可能已变");
  return decodeURIComponent(art.slice('url("data:image/svg+xml;charset=utf-8,'.length, -2));
}

const outPath = process.argv[2];
const svg = exportSvg();
if (outPath) {
  writeFileSync(resolve(outPath), svg, "utf8");
  console.error(`已导出：${resolve(outPath)}（${svg.length} 字节）`);
} else {
  process.stdout.write(svg);
}
// skin.js 挂了 1 分钟 tick 定时器，显式退出避免进程悬挂
process.exit(0);
