import assert from "node:assert/strict";
import test from "node:test";

import { parsePoints, parseTimes, parseRef, buildProbeHtml } from "../scripts/svg-anim-probe.mjs";

test("parsePoints：分号/逗号解析为坐标数组，非法项报错", () => {
  assert.deepEqual(parsePoints("180,160;730,125"), [
    { x: 180, y: 160 },
    { x: 730, y: 125 },
  ]);
  assert.throws(() => parsePoints(""), /--points 不能为空/);
  assert.throws(() => parsePoints("180,abc"), /第 1 项非法/);
});

test("parseTimes：至少两个数字时刻", () => {
  assert.deepEqual(parseTimes("1200,2000,2800"), [1200, 2000, 2800]);
  assert.throws(() => parseTimes("1200"), /至少需要两个/);
  assert.throws(() => parseTimes("1200,x"), /非数字/);
});

test("parseRef：dx,dy", () => {
  assert.deepEqual(parseRef("80,0"), [80, 0]);
  assert.throws(() => parseRef("80"), /--ref 非法/);
});

test("buildProbeHtml：SVG 以 background-image data URL 挂载，含 cover/opacity", () => {
  const html = buildProbeHtml("<svg viewBox='0 0 10 10'></svg>", { opacity: 0.35 });
  assert.ok(html.includes("data:image/svg+xml;charset=utf-8,"), "应以 data URL 内联");
  assert.ok(html.includes("background-size:cover"), "应 cover 铺满");
  assert.ok(html.includes("opacity:0.35"), "应写入挂载层不透明度");
  assert.ok(!html.includes("\n"), "单行 HTML，避免 file:// 换行歧义");
});
