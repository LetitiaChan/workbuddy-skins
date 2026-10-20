#!/usr/bin/env node
// export-skyclock-svg.mjs —— 导出 sky-clock 主题「当前时刻」的场景 SVG，供离线检查/录屏对照。
//
// sky-clock 的场景是 skin.js 运行时按天空时刻表重建的内联 SVG（云漂移/星闪由 CSS
// keyframes 驱动，样式定义在 skin.css）。本脚本复用 skin.js 的纯函数段（FRAMES 起至
// 明暗模式前）直接产出独立 SVG 文件：带 xmlns/viewBox/preserveAspectRatio，动画以
// class + --dur/--delay 标记——用浏览器打开时需要同时注入 skin.css 的「场景动效」段
// 才能看到动画。
//
// ★ 动效验证不要用 scripts/svg-anim-probe.mjs：无头 Edge/Chrome 里 SMIL 正常，但
//   WorkBuddy 渲染进程会把 SMIL 整类冻结。要验证真实效果，用活体 CDP 截屏差分
//   （output/cloud-probe/live-*.mjs 系列）。
//
// 用法：
//   node scripts/export-skyclock-svg.mjs [输出路径]   # 缺省输出到 stdout

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKIN_JS = fileURLToPath(new URL("../themes/sky-clock/skin.js", import.meta.url));
const src = readFileSync(SKIN_JS, "utf8");
const lib = eval(
  src.slice(src.indexOf("const FRAMES"), src.indexOf("// ---------- 明暗模式")) +
    "; ({ buildSvg, frameAt, moonPhase, quantHour, quantScene })",
);

const now = new Date();
const h = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
const svg = lib.buildSvg(lib.quantHour(h), lib.quantScene(lib.frameAt(h)), lib.moonPhase(Date.now()));

const outPath = process.argv[2];
if (outPath) {
  writeFileSync(resolve(outPath), svg, "utf8");
  console.error(`已导出：${resolve(outPath)}（${svg.length} 字节）`);
} else {
  process.stdout.write(svg);
}
