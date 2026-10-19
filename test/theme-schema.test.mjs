import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadTheme, validateThemeManifest } from "../src/theme-schema.mjs";

const base = { schemaVersion: 1, id: "demo-theme", name: "Demo", hero: "hero.png" };

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "wss-theme-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("normalizePoster：图片 hero 不允许带 poster", () => {
  assert.throws(
    () => validateThemeManifest({ ...base, poster: "poster.png" }),
    /only valid for video heroes/,
  );
});

test("normalizePoster：图片 hero 不带 poster 时归一为 null", () => {
  assert.equal(validateThemeManifest(base).poster, null);
});

test("normalizePoster：视频 hero 必须配 poster", () => {
  assert.throws(
    () => validateThemeManifest({ ...base, hero: "hero.mp4" }),
    /video hero requires a poster/,
  );
});

test("normalizePoster：视频主题 poster 必须是图片", () => {
  const video = { ...base, hero: "hero.mp4", poster: "poster.webp" };
  assert.equal(validateThemeManifest(video).poster, "poster.webp");
  assert.throws(
    () => validateThemeManifest({ ...video, poster: "poster.mp4" }),
    /poster must be/,
  );
});

test("normalizePoster：poster 必须是主题目录内的相对路径", () => {
  const video = { ...base, hero: "hero.mp4", poster: "poster.png" };
  for (const poster of ["../poster.png", "a/../../poster.png", "C:/poster.png", "/abs/poster.png", ""]) {
    assert.throws(
      () => validateThemeManifest({ ...video, poster }),
      /relative path inside the theme directory/,
      `poster=${JSON.stringify(poster)}`,
    );
  }
});

test("loadTheme：加载视频主题并解析 hero/poster 路径", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "hero.mp4"), Buffer.alloc(16, 1));
    await writeFile(join(dir, "poster.png"), Buffer.alloc(8, 2));
    await writeFile(
      join(dir, "theme.json"),
      JSON.stringify({ schemaVersion: 1, id: "video-theme", name: "Video", hero: "hero.mp4", poster: "poster.png" }),
    );
    const loaded = await loadTheme(dir);
    assert.equal(loaded.manifest.id, "video-theme");
    assert.ok(loaded.heroPath.endsWith("hero.mp4"));
    assert.ok(loaded.posterPath.endsWith("poster.png"));
  });
});

test("loadTheme：拒绝空 hero 文件", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "hero.png"), Buffer.alloc(0));
    await writeFile(join(dir, "theme.json"), JSON.stringify(base));
    await assert.rejects(loadTheme(dir), /non-empty file/);
  });
});

test("loadTheme：拒绝经目录联结（junction/symlink）逃逸主题目录的 hero", async (t) => {
  await withTempDir(async (dir) => {
    const outside = await mkdtemp(join(tmpdir(), "wss-outside-"));
    try {
      await writeFile(join(outside, "evil.png"), Buffer.alloc(8, 3));
      try {
        // junction 在 Windows 上无需提权；POSIX 下退化为普通目录 symlink
        await symlink(outside, join(dir, "linked"), "junction");
      } catch (error) {
        t.skip(`无法创建目录联结：${error.message}`);
        return;
      }
      await writeFile(
        join(dir, "theme.json"),
        JSON.stringify({ schemaVersion: 1, id: "escape-theme", name: "Escape", hero: "linked/evil.png" }),
      );
      await assert.rejects(loadTheme(dir), /escapes the theme directory/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("loadTheme：theme.json 非法 JSON 时报错带清单路径", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "theme.json"), "{ broken");
    await assert.rejects(loadTheme(dir), (error) => error.message.includes("theme.json") && /invalid theme manifest/.test(error.message));
  });
});

test("loadTheme：目录内指向合法文件的符号链接 hero 可正常加载", async (t) => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "assets"));
    await writeFile(join(dir, "assets", "real.png"), Buffer.alloc(8, 4));
    try {
      await symlink(join(dir, "assets", "real.png"), join(dir, "hero.png"), "file");
    } catch (error) {
      t.skip(`无法创建文件符号链接（Windows 需开发者模式/提权）：${error.message}`);
      return;
    }
    await writeFile(join(dir, "theme.json"), JSON.stringify(base));
    const loaded = await loadTheme(dir);
    assert.ok(loaded.heroPath.endsWith("hero.png"));
  });
});

test("css 主题：无 hero 合法，hero 归一为 null", () => {
  const manifest = validateThemeManifest({ schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css" });
  assert.equal(manifest.hero, null);
  assert.equal(manifest.css, "skin.css");
  assert.equal(manifest.poster, null);
});

test("css 主题：css 必须是主题目录内的 .css 相对路径", () => {
  const cssBase = { schemaVersion: 1, id: "css-theme", name: "CSS" };
  for (const css of ["../skin.css", "a/../../skin.css", "C:/skin.css", "/abs/skin.css", "", "skin.png"]) {
    assert.throws(
      () => validateThemeManifest({ ...cssBase, css }),
      /theme css must be/,
      `css=${JSON.stringify(css)}`,
    );
  }
});

test("css 主题：无 hero 时不允许带 poster", () => {
  assert.throws(
    () => validateThemeManifest({ schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css", poster: "p.png" }),
    /poster requires a video hero/,
  );
});

test("无 css 时 hero 必填", () => {
  assert.throws(
    () => validateThemeManifest({ schemaVersion: 1, id: "no-hero", name: "NoHero" }),
    /hero must be a relative path/,
  );
});

test("loadTheme：加载纯 CSS 主题并解析 cssPath", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), "body { color: red; }");
    await writeFile(
      join(dir, "theme.json"),
      JSON.stringify({ schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css" }),
    );
    const loaded = await loadTheme(dir);
    assert.ok(loaded.cssPath.endsWith("skin.css"));
    assert.equal(loaded.heroPath, null);
    assert.equal(loaded.posterPath, null);
  });
});

test("loadTheme：css 文件缺失或为空时拒绝", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "theme.json"),
      JSON.stringify({ schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css" }),
    );
    await assert.rejects(loadTheme(dir));
    await writeFile(join(dir, "skin.css"), "");
    await assert.rejects(loadTheme(dir), /non-empty file/);
  });
});

test("js 伴随脚本：仅纯 CSS 主题可携带，路径必须是目录内 .js", () => {
  const cssTheme = { schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css" };
  assert.equal(validateThemeManifest({ ...cssTheme, js: "skin.js" }).js, "skin.js");
  assert.throws(
    () => validateThemeManifest({ ...base, js: "skin.js" }),
    /only valid together with a css theme/,
  );
  for (const js of ["../skin.js", "C:/skin.js", "", "skin.css"]) {
    assert.throws(() => validateThemeManifest({ ...cssTheme, js }), /theme js must be/, `js=${JSON.stringify(js)}`);
  }
});

test("dynamicMode：缺省 false，必须布尔，且要求伴随 js 接管明暗写入", () => {
  const cssTheme = { schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css", js: "skin.js" };
  // 缺省与显式 false 均归一为 false
  assert.equal(validateThemeManifest(cssTheme).dynamicMode, false);
  assert.equal(validateThemeManifest({ ...cssTheme, dynamicMode: false }).dynamicMode, false);
  // css + js + dynamicMode:true 合法（如 sky-clock 按时间自写明暗）
  assert.equal(validateThemeManifest({ ...cssTheme, dynamicMode: true }).dynamicMode, true);
  // 没有 js 就没有人接管明暗写入，拒绝
  assert.throws(
    () => validateThemeManifest({ schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css", dynamicMode: true }),
    /requires a companion js/,
  );
  // 非布尔取值拒绝
  for (const dynamicMode of ["true", 1, {}]) {
    assert.throws(
      () => validateThemeManifest({ ...cssTheme, dynamicMode }),
      /must be a boolean/,
      `dynamicMode=${JSON.stringify(dynamicMode)}`,
    );
  }
});

test("group 分组：仅纯 CSS 主题可配置，取值限 custom/palette/scenery，CSS 主题缺省归 custom", () => {
  const cssTheme = { schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css" };
  // 缺省：CSS 主题归 custom（定制主题），图片主题无分组（注入侧固定归 image）
  assert.equal(validateThemeManifest(cssTheme).group, "custom");
  assert.equal(validateThemeManifest(base).group, null);
  // 显式配置
  assert.equal(validateThemeManifest({ ...cssTheme, group: "palette" }).group, "palette");
  assert.equal(validateThemeManifest({ ...cssTheme, group: "custom" }).group, "custom");
  assert.equal(validateThemeManifest({ ...cssTheme, group: "scenery" }).group, "scenery");
  // 图片主题不允许携带 group（含 scenery——纯 CSS 分类）
  assert.throws(
    () => validateThemeManifest({ ...base, group: "palette" }),
    /only valid together with a css theme/,
  );
  assert.throws(
    () => validateThemeManifest({ ...base, group: "scenery" }),
    /only valid together with a css theme/,
  );
  // 非法取值
  for (const group of ["image", "", "Palette", 1]) {
    assert.throws(
      () => validateThemeManifest({ ...cssTheme, group }),
      /theme group must be/,
      `group=${JSON.stringify(group)}`,
    );
  }
});

test("signature 签名：palette 第三形态（无 css 无 hero）放行，与 css/hero 互斥", () => {
  const signature = { blobs: [{ color: "accent", x: 82, y: 18, alpha: 0.42, radius: 38 }] };
  const sigTheme = { schemaVersion: 1, id: "sig-theme", name: "Sig", group: "palette", signature };
  const manifest = validateThemeManifest(sigTheme);
  assert.equal(manifest.hero, null);
  assert.equal(manifest.css, null);
  assert.equal(manifest.group, "palette");
  // 归一化：shape 缺省 circle，hex 色大写（与 normalizeColors 同规）
  assert.deepEqual(manifest.signature.blobs[0], { color: "accent", shape: "circle", x: 82, y: 18, alpha: 0.42, radius: 38 });
  assert.equal(
    validateThemeManifest({ ...sigTheme, signature: { blobs: [{ color: "#5eead4", x: 40, y: 82, alpha: 0.2, radius: 42 }] } })
      .signature.blobs[0].color,
    "#5EEAD4",
  );
  // 无 css 无 hero 无 signature → 仍报 hero 必填（现有行为不破）
  assert.throws(
    () => validateThemeManifest({ schemaVersion: 1, id: "sig-theme", name: "Sig" }),
    /theme hero must be/,
  );
  // 签名主题必须显式 group:"palette"：缺省/custom/scenery 均拒绝
  assert.throws(
    () => validateThemeManifest({ schemaVersion: 1, id: "sig-theme", name: "Sig", signature }),
    /requires group "palette"/,
  );
  for (const group of ["custom", "scenery"]) {
    assert.throws(
      () => validateThemeManifest({ ...sigTheme, group }),
      /requires group "palette"/,
      `group=${group}`,
    );
  }
  // 与 css / hero 互斥：同存时层叠语义含糊、图片主题不需要装饰层
  assert.throws(
    () => validateThemeManifest({ ...sigTheme, css: "skin.css" }),
    /only valid without a css file/,
  );
  assert.throws(
    () => validateThemeManifest({ ...sigTheme, hero: "hero.png" }),
    /only valid without a hero/,
  );
  // 签名主题不开放伴随 js（normalizeJs 只认 css）
  assert.throws(
    () => validateThemeManifest({ ...sigTheme, js: "skin.js" }),
    /only valid together with a css theme/,
  );
});

test("signature 字段级校验：色槽/hex、alpha/百分位范围、shape 与 star 参数互斥、grid/base 边界", () => {
  const base0 = { schemaVersion: 1, id: "sig-theme", name: "Sig", group: "palette" };
  const blob = { color: "accent", x: 50, y: 50, alpha: 0.3, radius: 40 };
  const sig = (over) => ({ blobs: [{ ...blob, ...over }] });
  // color：色槽引用或 6 位 hex
  for (const color of ["red", "#FFF", "brand", 1]) {
    assert.throws(
      () => validateThemeManifest({ ...base0, signature: sig({ color }) }),
      /must be a palette slot/,
      `color=${JSON.stringify(color)}`,
    );
  }
  // alpha：(0,1] 裸 number
  for (const alpha of [0, 1.5, "0.5", Number.NaN]) {
    assert.throws(
      () => validateThemeManifest({ ...base0, signature: sig({ alpha }) }),
      /must be a number between 0 and 1/,
      `alpha=${JSON.stringify(alpha)}`,
    );
  }
  // x/y/radius：0–100
  for (const x of [-1, 101]) {
    assert.throws(
      () => validateThemeManifest({ ...base0, signature: sig({ x }) }),
      /must be a number between 0 and 100/,
      `x=${x}`,
    );
  }
  // shape 枚举与 star/circle 参数互斥
  assert.throws(
    () => validateThemeManifest({ ...base0, signature: sig({ shape: "blob" }) }),
    /shape must be "circle", "ellipse", or "star"/,
  );
  assert.throws(
    () => validateThemeManifest({ ...base0, signature: sig({ shape: "star", size: 2 }) }),
    /radius is only valid for circle\/ellipse/,
  );
  assert.throws(
    () => validateThemeManifest({ ...base0, signature: sig({ size: 2 }) }),
    /size is only valid for star/,
  );
  // star 合法形态
  assert.equal(
    validateThemeManifest({ ...base0, signature: { blobs: [{ color: "secondary", shape: "star", x: 15, y: 18, alpha: 0.22, size: 2 }] } })
      .signature.blobs[0].size,
    2,
  );
  // grid：line 1–4、size 8–64 整数
  const grid = { color: "accent", alpha: 0.14, line: 2, size: 24 };
  assert.deepEqual(validateThemeManifest({ ...base0, signature: { grid } }).signature.grid, grid);
  assert.throws(
    () => validateThemeManifest({ ...base0, signature: { grid: { ...grid, line: 5 } } }),
    /grid\.line must be an integer between 1 and 4/,
  );
  assert.throws(
    () => validateThemeManifest({ ...base0, signature: { grid: { ...grid, size: 7 } } }),
    /grid\.size must be an integer between 8 and 64/,
  );
  // base：stops 2–3 个，angle 0–360
  const stops = [{ color: "surface" }, { color: "#0A1A2C" }];
  assert.throws(
    () => validateThemeManifest({ ...base0, signature: { base: { stops: [stops[0]] } } }),
    /stops must be an array of 2 to 3 entries/,
  );
  assert.throws(
    () => validateThemeManifest({ ...base0, signature: { base: { angle: 361, stops } } }),
    /angle must be a number between 0 and 360/,
  );
  // 空 signature / 空 blobs 拒绝：至少一个装饰层
  assert.throws(
    () => validateThemeManifest({ ...base0, signature: {} }),
    /requires at least one of grid, blobs, or base/,
  );
  assert.throws(
    () => validateThemeManifest({ ...base0, signature: { blobs: [] } }),
    /blobs must be an array of 1 to 4 entries/,
  );
});

test("loadTheme：签名主题无 css/hero 路径，其余资源照常解析", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "theme.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "sig-theme",
        name: "Sig",
        group: "palette",
        signature: { blobs: [{ color: "accent", x: 82, y: 18, alpha: 0.42, radius: 38 }] },
      }),
    );
    const loaded = await loadTheme(dir);
    assert.equal(loaded.cssPath, null);
    assert.equal(loaded.heroPath, null);
    assert.equal(loaded.manifest.signature.blobs[0].shape, "circle");
  });
});

// baseTheme 继承的测试夹具：base 主题（css+js）与只含 theme.json 的子主题
async function withTwinThemes(fn) {
  await withTempDir(async (dir) => {
    const baseDir = join(dir, "tdp-pro");
    const childDir = join(dir, "tdp-pro-dark");
    await mkdir(baseDir, { recursive: true });
    await mkdir(childDir);
    await writeFile(join(baseDir, "skin.css"), "body { color: red; }");
    await writeFile(join(baseDir, "skin.js"), "return null;");
    await writeFile(
      join(baseDir, "theme.json"),
      JSON.stringify({ schemaVersion: 1, id: "tdp-pro", name: "Base", css: "skin.css", js: "skin.js" }),
    );
    await writeFile(
      join(childDir, "theme.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "tdp-pro-dark",
        name: "Dark",
        baseTheme: "tdp-pro",
        colors: { accent: "#112233" },
      }),
    );
    return fn({ baseDir, childDir });
  });
}

test("baseTheme 继承：manifest 顶层合并（子覆盖 base），缺失文件回退 base 目录", async () => {
  await withTwinThemes(async ({ baseDir, childDir }) => {
    const loaded = await loadTheme(childDir);
    // 继承字段：css/js 来自 base manifest
    assert.equal(loaded.manifest.baseTheme, "tdp-pro");
    assert.equal(loaded.manifest.css, "skin.css");
    assert.equal(loaded.manifest.js, "skin.js");
    // 文件回退：子目录没有 skin.css/skin.js，解析进 base 目录
    assert.ok(loaded.cssPath.startsWith(baseDir), `cssPath 应在 base 目录：${loaded.cssPath}`);
    assert.ok(loaded.jsPath.startsWith(baseDir), `jsPath 应在 base 目录：${loaded.jsPath}`);
    // 顶层覆盖语义：colors 整体替换（accent 是子的，secondary 走 DEFAULT 而非 base 归并）
    assert.equal(loaded.manifest.colors.accent, "#112233");
    assert.equal(loaded.manifest.name, "Dark");
    // 子目录放进自有同名文件后优先于 base（逐文件覆盖）
    await writeFile(join(childDir, "skin.css"), "body { color: blue; }");
    const overridden = await loadTheme(childDir);
    assert.ok(overridden.cssPath.startsWith(childDir), `子目录自有文件应优先：${overridden.cssPath}`);
    assert.ok(overridden.jsPath.startsWith(baseDir), "未覆盖的文件仍回退 base");
  });
});

test("baseTheme 字段校验与继承边界：id 形态 / 自引用 / 链式 / base 缺失 / id 不符", async () => {
  const child = { schemaVersion: 1, id: "child-theme", name: "C", css: "skin.css" };
  assert.equal(validateThemeManifest(child).baseTheme, null);
  assert.equal(validateThemeManifest({ ...child, baseTheme: "parent-theme" }).baseTheme, "parent-theme");
  for (const baseTheme of ["../escape", "UPPER", "a/b", 1, true]) {
    assert.throws(
      () => validateThemeManifest({ ...child, baseTheme }),
      /baseTheme must be a theme id/,
      `baseTheme=${JSON.stringify(baseTheme)}`,
    );
  }
  assert.throws(
    () => validateThemeManifest({ ...child, baseTheme: "child-theme" }),
    /cannot reference itself/,
  );
  // 链式继承拒绝：base 自身再声明 baseTheme（循环由此在构造上不可能）
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "grand"), { recursive: true });
    await mkdir(join(dir, "parent"));
    await mkdir(join(dir, "child-a"));
    await writeFile(join(dir, "grand", "hero.png"), Buffer.from("png"));
    await writeFile(join(dir, "grand", "theme.json"), JSON.stringify({ schemaVersion: 1, id: "grand", name: "G", hero: "hero.png" }));
    await writeFile(join(dir, "parent", "theme.json"), JSON.stringify({ schemaVersion: 1, id: "parent", name: "P", baseTheme: "grand" }));
    await writeFile(join(dir, "child-a", "theme.json"), JSON.stringify({ schemaVersion: 1, id: "child-a", name: "C", baseTheme: "parent" }));
    await assert.rejects(loadTheme(join(dir, "child-a")), /chains are not supported/);
    // base 目录缺失 / base id 不符
    await writeFile(join(dir, "child-a", "theme.json"), JSON.stringify({ schemaVersion: 1, id: "child-a", name: "C", baseTheme: "ghost" }));
    await assert.rejects(loadTheme(join(dir, "child-a")), /invalid base theme manifest/);
    await writeFile(join(dir, "child-a", "theme.json"), JSON.stringify({ schemaVersion: 1, id: "child-a", name: "C", baseTheme: "grand" }));
    // 合法继承：hero 从 grand 目录回退解析（若抛错则测试自然失败）
    await loadTheme(join(dir, "child-a"));
    await writeFile(join(dir, "grand", "theme.json"), JSON.stringify({ schemaVersion: 1, id: "renamed", name: "G", hero: "hero.png" }));
    await assert.rejects(loadTheme(join(dir, "child-a")), /base theme id mismatch/);
  });
});

test("loadTheme：解析 jsPath，缺失时拒绝", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), "body { color: red; }");
    await writeFile(
      join(dir, "theme.json"),
      JSON.stringify({ schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css", js: "skin.js" }),
    );
    await assert.rejects(loadTheme(dir));
    await writeFile(join(dir, "skin.js"), "return null;");
    const loaded = await loadTheme(dir);
    assert.ok(loaded.jsPath.endsWith("skin.js"));
  });
});

test("thumbnail：可选，任意主题可配，路径必须是目录内图片", () => {
  const cssTheme = { schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css" };
  assert.equal(validateThemeManifest(cssTheme).thumbnail, null);
  assert.equal(validateThemeManifest({ ...cssTheme, thumbnail: "thumb.webp" }).thumbnail, "thumb.webp");
  assert.equal(validateThemeManifest({ ...base, thumbnail: "cover.png" }).thumbnail, "cover.png");
  for (const thumbnail of ["../t.webp", "C:/t.webp", "", "t.mp4", "t.svg"]) {
    assert.throws(
      () => validateThemeManifest({ ...cssTheme, thumbnail }),
      /theme thumbnail must be/,
      `thumbnail=${JSON.stringify(thumbnail)}`,
    );
  }
});

test("mascot：可选，图片/视频/CSS 主题均可配，路径必须是目录内图片", () => {
  assert.equal(validateThemeManifest(base).mascot, null);
  assert.equal(validateThemeManifest({ ...base, mascot: "mascot.webp" }).mascot, "mascot.webp");
  // 视频主题（hero.mp4 + poster）与纯 CSS 主题同样允许
  assert.equal(
    validateThemeManifest({ ...base, hero: "hero.mp4", poster: "poster.png", mascot: "m.webp" }).mascot,
    "m.webp",
  );
  assert.equal(
    validateThemeManifest({ schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css", mascot: "m.webp" }).mascot,
    "m.webp",
  );
  for (const mascot of ["../m.webp", "C:/m.webp", "", "m.mp4", "m.svg"]) {
    assert.throws(
      () => validateThemeManifest({ ...base, mascot }),
      /theme mascot must be/,
      `mascot=${JSON.stringify(mascot)}`,
    );
  }
});

test("mascotScale/mascotOffset：默认 1 与 {0,0}，需与 mascot 同配，范围校验", () => {
  const withMascot = { ...base, mascot: "mascot.webp" };
  const def = validateThemeManifest(withMascot);
  assert.equal(def.mascotScale, 1);
  assert.deepEqual(def.mascotOffset, { x: 0, y: 0 });
  const tuned = validateThemeManifest({ ...withMascot, mascotScale: 1.05, mascotOffset: { x: 0, y: 5 } });
  assert.equal(tuned.mascotScale, 1.05);
  assert.deepEqual(tuned.mascotOffset, { x: 0, y: 5 });
  // offset 缺省键补 0
  assert.deepEqual(validateThemeManifest({ ...withMascot, mascotOffset: { y: -8 } }).mascotOffset, { x: 0, y: -8 });
  // 无 mascot 时配置微调参数直接拒绝（防笔误静默失效）
  assert.throws(() => validateThemeManifest({ ...base, mascotScale: 1.2 }), /mascotScale requires a mascot/);
  assert.throws(() => validateThemeManifest({ ...base, mascotOffset: { x: 1 } }), /mascotOffset requires a mascot/);
  for (const scale of [0.2, 3.1, Number.NaN, "1.2"]) {
    assert.throws(
      () => validateThemeManifest({ ...withMascot, mascotScale: scale }),
      /mascotScale must be/,
      `mascotScale=${JSON.stringify(scale)}`,
    );
  }
  for (const offset of [{ x: 81 }, { y: -100 }, { x: "0" }, 5]) {
    assert.throws(
      () => validateThemeManifest({ ...withMascot, mascotOffset: offset }),
      /mascotOffset/,
      `mascotOffset=${JSON.stringify(offset)}`,
    );
  }
});

test("loadTheme：mascot 图片缺失时按未配置处理，超过体积上限时拒绝", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "hero.png"), Buffer.alloc(16, 1));
    await writeFile(
      join(dir, "theme.json"),
      JSON.stringify({ schemaVersion: 1, id: "demo-theme", name: "Demo", hero: "hero.png", mascot: "mascot.webp" }),
    );
    // 配置了 mascot 但文件缺失：加载成功，mascotPath 为 null，等价于未配置
    const loaded = await loadTheme(dir);
    assert.equal(loaded.mascotPath, null);
    await writeFile(join(dir, "mascot.webp"), Buffer.alloc(1024, 1));
    const loaded2 = await loadTheme(dir);
    assert.ok(loaded2.mascotPath.endsWith("mascot.webp"));
    await writeFile(join(dir, "mascot.webp"), Buffer.alloc(256 * 1024 + 1, 1));
    await assert.rejects(loadTheme(dir), /mascot exceeds/);
  });
});

test("loadTheme：解析 thumbnailPath，缺失或超过体积上限时拒绝", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), "body { color: red; }");
    await writeFile(
      join(dir, "theme.json"),
      JSON.stringify({ schemaVersion: 1, id: "css-theme", name: "CSS", css: "skin.css", thumbnail: "thumb.webp" }),
    );
    await assert.rejects(loadTheme(dir));
    await writeFile(join(dir, "thumb.webp"), Buffer.alloc(1024, 1));
    const loaded = await loadTheme(dir);
    assert.ok(loaded.thumbnailPath.endsWith("thumb.webp"));
    await writeFile(join(dir, "thumb.webp"), Buffer.alloc(512 * 1024 + 1, 1));
    await assert.rejects(loadTheme(dir), /thumbnail exceeds/);
  });
});

