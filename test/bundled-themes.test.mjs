import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { MAX_THEME_MASCOT_BYTES, MAX_THEME_THUMBNAIL_BYTES, MAX_THEME_VIDEO_BYTES } from "../src/constants.mjs";
import { loadTheme } from "../src/theme-schema.mjs";

// 内置主题目录的集成护栏：每个 themes/<id>/ 都必须通过 loadTheme 完整校验；
// 携带伴随 js 的主题，js 文本必须可被 JS 引擎编译（防手滑改坏随包主题）
const themesRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "themes");

const themeDirs = async () => {
  const entries = await readdir(themesRoot, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
};

test("内置主题：全部通过 loadTheme 校验，伴随 js 可编译", async () => {
  const dirs = await themeDirs();
  assert.ok(dirs.length >= 18, `内置主题数量异常：${dirs.length}`);
  const seen = new Set();
  for (const name of dirs) {
    const loaded = await loadTheme(join(themesRoot, name));
    assert.ok(!seen.has(loaded.manifest.id), `主题 id 重复：${loaded.manifest.id}`);
    seen.add(loaded.manifest.id);
    assert.equal(loaded.manifest.id, name, `目录名与主题 id 不一致：${name}`);
    if (loaded.jsPath) {
      const js = await readFile(loaded.jsPath, "utf8");
      assert.doesNotThrow(() => new Function(js), `${name} 的伴随 js 语法错误`);
    }
  }
});

// tdp-pro 与 tdp-pro-dark 曾是孪生主题：除 theme.json 四色与 thumbnail 外，
// 其余 7 个文件逐字节相同（skin.css 1200+ 行），两份独立存放必然漂移。
// 现由 schema 的 baseTheme 继承消化：tdp-pro-dark 声明 "baseTheme": "tdp-pro"，
// 共享文件物理上只剩一份（在 base 目录），漂移在结构上不可能发生。
// 本测试钉住这个关系：子目录只含差异文件，css/js 解析进 base 目录
test("tdp-pro-dark：baseTheme 继承 tdp-pro，子目录只留差异文件", async () => {
  const loaded = await loadTheme(join(themesRoot, "tdp-pro-dark"));
  assert.equal(loaded.manifest.baseTheme, "tdp-pro");
  assert.equal(loaded.manifest.css, "skin.css", "css 字段应从 base manifest 继承");
  // 继承文件解析进 base 目录（injector 的 url() 内联以文件所在目录为基准）
  assert.ok(loaded.cssPath.startsWith(join(themesRoot, "tdp-pro")), `cssPath 应在 base 目录：${loaded.cssPath}`);
  assert.ok(loaded.jsPath.startsWith(join(themesRoot, "tdp-pro")), `jsPath 应在 base 目录：${loaded.jsPath}`);
  // 深色配色与标语仍是子主题自己的
  assert.equal(loaded.manifest.colors.surface, "#0A1426");
  assert.equal(loaded.manifest.copy.tagline, "深色沉稳，专业高效");
  // thumbnail 是子目录自有文件（明暗封面不同），不回退
  assert.ok(loaded.thumbnailPath.startsWith(join(themesRoot, "tdp-pro-dark")), `thumbnailPath 应在子目录：${loaded.thumbnailPath}`);
  // 子目录只留 theme.json + thumbnail.webp
  const files = await readdir(join(themesRoot, "tdp-pro-dark"));
  assert.deepEqual(files.sort(), ["theme.json", "thumbnail.webp"]);
});

// 资产体积护栏：schema 只在 loadTheme 时校验引用到的素材，这里补一道全量扫描——
// 体积是注入体大小的直接来源（缩略图/mascot 以 data URL 随菜单脚本下发）
test("内置主题：thumbnail / mascot / 视频体积不越限", async () => {
  const limits = [
    ["thumbnail.webp", MAX_THEME_THUMBNAIL_BYTES],
    ["mascot.webp", MAX_THEME_MASCOT_BYTES],
    ["hero.mp4", MAX_THEME_VIDEO_BYTES],
  ];
  for (const name of await themeDirs()) {
    for (const [file, limit] of limits) {
      const info = await stat(join(themesRoot, name, file)).catch(() => null);
      if (!info) continue;
      assert.ok(
        info.size <= limit,
        `${name}/${file} 为 ${info.size} B，超出上限 ${limit} B`,
      );
    }
  }
});

// 全视口元素零过渡/动画：这是本项目确认过的「整屏抽丝刷屏」根因（sky-clock 曾踩）。
// body / body::before / body::after 上挂 transition 或 animation，会让一次变更演变成
// 几十帧的整屏重绘。此护栏只盯这三个选择器，局部元素上的动画不受限制。
//
// 匹配策略：`[^{}]+\{[^{}]*\}` 因为两个字符组都排除了花括号，天然只命中**最内层**规则块，
// 于是 @media 包裹也能正确穿透（选择器组从上一个花括号后开始，不会把 @media 前言带进来）。
// 再按逗号拆选择器逐个判定，这样 `body::before, body::after { ... }` 这类组合写法也能覆盖。
// 不要换成以 (^|\}) 作前导锚点的写法：那会消耗掉前一个块的 }，使紧邻的下一个 body 块漏判。
const INNERMOST_RULE = /([^{}]+)\{([^{}]*)\}/g;
const VIEWPORT_WIDE = /^body(?:::(?:before|after))?$/;

test("内置主题 skin.css：body 与 body 伪元素上不得出现 transition / animation", async () => {
  const offenders = [];
  for (const name of await themeDirs()) {
    const css = await readFile(join(themesRoot, name, "skin.css"), "utf8").catch(() => null);
    if (css === null) continue;
    // 先去注释：注释里提到 transition（如性能基线说明）不应被误判
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, selectorList, decls] of stripped.matchAll(INNERMOST_RULE)) {
      if (!/\b(?:transition|animation)(?:-\w+)?\s*:/.test(decls)) continue;
      for (const selector of selectorList.split(",").map((s) => s.trim())) {
        if (VIEWPORT_WIDE.test(selector)) offenders.push(`${name}: ${selector}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下主题在全视口元素上挂了 transition/animation（会导致整屏逐帧重绘）：\n  ${offenders.join("\n  ")}`,
  );
});

// 带 infinite 动画的主题必须提供减弱动效降级：无 prefers-reduced-motion 保护时，
// 系统开了减弱动效动画仍会永久跑（tdp-pro 曾有 7 条 infinite 动画无任何保护）
test("内置主题 skin.css：含 infinite 动画的主题必须有 prefers-reduced-motion 降级", async () => {
  const offenders = [];
  for (const name of await themeDirs()) {
    const css = await readFile(join(themesRoot, name, "skin.css"), "utf8").catch(() => null);
    if (css === null) continue;
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    if (!/animation:[^;}]*\binfinite\b/.test(stripped)) continue;
    if (!/@media[^{]*prefers-reduced-motion/.test(stripped)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], `以下主题有 infinite 动画但缺少减弱动效降级：${offenders.join(", ")}`);
});
