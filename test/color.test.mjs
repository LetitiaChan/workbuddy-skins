import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  COLOR_KEYS,
  DEFAULT_COLORS,
  HEX6,
  contrastRatio,
  hexToRgb,
  isHex6,
  relativeLuminance,
  rgbToHex,
} from "../src/color.mjs";

test("HEX6 / isHex6：只接受六位十六进制，拒绝简写与 alpha", () => {
  for (const ok of ["#000000", "#FFFFFF", "#24c9d7", "#24C9D7"]) {
    assert.ok(isHex6(ok), `应接受 ${ok}`);
  }
  for (const bad of ["#fff", "#ffff", "#fffff", "#fffffff", "#ffffffff", "fff000", "", null, undefined, 0x24c9d7]) {
    assert.ok(!isHex6(bad), `应拒绝 ${String(bad)}`);
  }
  // 正则本身必须锚定两端，否则 "x#000000y" 会被放过
  assert.ok(!HEX6.test("x#000000"));
  assert.ok(!HEX6.test("#000000y"));
});

test("DEFAULT_COLORS：四键齐备、均为合法六位 hex、且不可变", () => {
  assert.deepEqual(Object.keys(DEFAULT_COLORS).sort(), [...COLOR_KEYS].sort());
  for (const key of COLOR_KEYS) {
    assert.ok(isHex6(DEFAULT_COLORS[key]), `${key} 非法：${DEFAULT_COLORS[key]}`);
  }
  assert.ok(Object.isFrozen(DEFAULT_COLORS), "应冻结，防止调用方就地改默认色");
  // 大写形态须与 normalizeColors 的归一化输出一致，避免同色不同写法的字符串比较意外
  for (const key of COLOR_KEYS) {
    assert.equal(DEFAULT_COLORS[key], DEFAULT_COLORS[key].toUpperCase());
  }
});

test("DEFAULT_COLORS：正文文字对背景满足 WCAG AA（4.5:1）", () => {
  const ratio = contrastRatio(DEFAULT_COLORS.text, DEFAULT_COLORS.surface);
  assert.ok(ratio >= 4.5, `缺省 text/surface 对比度 ${ratio?.toFixed(2)} 低于 4.5`);
});

test("hexToRgb / rgbToHex：往返一致，非法输入返回 null，越界值夹取", () => {
  assert.deepEqual(hexToRgb("#000000"), [0, 0, 0]);
  assert.deepEqual(hexToRgb("#FFFFFF"), [255, 255, 255]);
  assert.deepEqual(hexToRgb("#24C9D7"), [36, 201, 215]);
  assert.equal(hexToRgb("#fff"), null);
  assert.equal(hexToRgb("nope"), null);
  for (const hex of ["#000000", "#24C9D7", "#EF8FD3", "#17344F"]) {
    assert.equal(rgbToHex(hexToRgb(hex)).toUpperCase(), hex.toUpperCase(), `${hex} 往返不一致`);
  }
  // 越界与小数：夹取到 [0,255] 并四舍五入
  assert.equal(rgbToHex([-10, 300, 127.6]), "#00ff80");
});

test("relativeLuminance：黑 0、白 1，非法输入 null；含 sRGB 线性化", () => {
  assert.equal(relativeLuminance("#000000"), 0);
  assert.equal(relativeLuminance("#FFFFFF"), 1);
  assert.equal(relativeLuminance("#xyz"), null);
  // 线性化的意义：#808080 的线性亮度约 0.216，而非朴素的 0.5。
  // 若有人把实现换成不线性化的加权平均，这条会立刻失败
  const mid = relativeLuminance("#808080");
  assert.ok(mid > 0.2 && mid < 0.24, `#808080 线性亮度应约 0.216，实际 ${mid}`);
});

test("contrastRatio：对称、黑白为 21、同色为 1", () => {
  assert.ok(Math.abs(contrastRatio("#000000", "#FFFFFF") - 21) < 0.01);
  assert.equal(contrastRatio("#FFFFFF", "#000000"), contrastRatio("#000000", "#FFFFFF"));
  assert.ok(Math.abs(contrastRatio("#24C9D7", "#24C9D7") - 1) < 1e-9);
  assert.equal(contrastRatio("#000000", "bad"), null);
});

// 漂移护栏：DEFAULT_COLORS 与 hex 校验曾在 theme-schema / skin-css / theme-store
// 三处各写一份且值不一致（蓝紫系 vs 青粉系），导致「同一个缺省两套颜色」。
// 统一后用护栏钉住：src/ 下除 color.mjs 自身外，不得再出现第二份四色字面量或 hex 正则。
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

test("src/：色彩常量不得在 color.mjs 之外重复定义", async () => {
  const files = (await readdir(srcRoot)).filter((f) => f.endsWith(".mjs") && f !== "color.mjs");
  const offenders = [];
  for (const file of files) {
    const text = await readFile(join(srcRoot, file), "utf8");
    // 去注释：注释里引用旧值做说明是允许的（color.mjs 的由来就写在注释里）
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (/const\s+DEFAULT_COLORS\s*=/.test(code)) offenders.push(`${file}: 重复定义 DEFAULT_COLORS`);
    // hex 校验正则：只允许 color.mjs 定义。渲染进程注入体（skin-menu）里的
    // /^#([0-9a-f]{6})$/ 是 renderer 侧实现，不能 import，豁免；但宽松的 {3,8} 不许再出现
    if (/\[0-9a-f\]\{3,8\}/i.test(code)) offenders.push(`${file}: 残留宽松 hex 校验（3-8 位）`);
  }
  assert.deepEqual(offenders, [], `色彩常量出现漂移：\n  ${offenders.join("\n  ")}`);
});

test("内置主题：全部四色通过 color.mjs 的严格校验，text 对 surface 达 AA", async () => {
  const themesRoot = join(srcRoot, "..", "themes");
  const dirs = (await readdir(themesRoot, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  const lowContrast = [];
  for (const name of dirs) {
    const manifest = JSON.parse(await readFile(join(themesRoot, name, "theme.json"), "utf8"));
    for (const key of COLOR_KEYS) {
      assert.ok(isHex6(manifest.colors?.[key]), `${name}.colors.${key} 非六位 hex：${manifest.colors?.[key]}`);
    }
    const ratio = contrastRatio(manifest.colors.text, manifest.colors.surface);
    if (ratio < 4.5) lowContrast.push(`${name}: ${ratio.toFixed(2)}`);
  }
  assert.deepEqual(lowContrast, [], `以下主题正文对比度低于 WCAG AA 4.5:1：\n  ${lowContrast.join("\n  ")}`);
});
