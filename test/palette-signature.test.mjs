import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildSignatureCss } from "../src/skin-css.mjs";
import { loadTheme } from "../src/theme-schema.mjs";

// palette 签名装饰层的逐字节快照护栏。夹具（fixtures/palette-signatures/<id>.css）
// 是迁移前各主题手写 skin.css 的正文（去掉头部注释块），证明「装饰层数据化为
// theme.json signature」的渲染产物与手写时代逐字节一致；此后任何对
// buildSignatureCss 文本格式（空格 / 换行 / hex 大小写 / alpha 精度 / 层序）
// 的改动都会在这里红灯——与 skin-css 变量块、bundled-themes 孪生哈希同为防漂移护栏
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const themesRoot = join(root, "themes");
const fixturesRoot = join(root, "test", "fixtures", "palette-signatures");

test("palette 签名主题：buildSignatureCss 渲染正文与迁移前手写 skin.css 逐字节一致", async () => {
  const fixtures = (await readdir(fixturesRoot)).filter((name) => name.endsWith(".css")).sort();
  assert.ok(fixtures.length >= 10, `快照夹具数量异常：${fixtures.length}`);
  for (const file of fixtures) {
    const id = file.slice(0, -".css".length);
    const loaded = await loadTheme(join(themesRoot, id));
    // 第三形态：无 css 无 hero，分组恒为 palette
    assert.equal(loaded.cssPath, null, `${id} 不应再有 css 文件`);
    assert.equal(loaded.heroPath, null, `${id} 不应有 hero`);
    assert.equal(loaded.manifest.group, "palette", `${id} 分组应为 palette`);
    const rendered = buildSignatureCss({ theme: loaded.manifest });
    // 署名头（出处：workbuddy-skin-skill / MIT / zhangxiaoqiang1991）保留在生成物里
    assert.ok(rendered.startsWith(`/*\n * ${id} 装饰层`), `${id} 缺少署名注释头`);
    assert.ok(rendered.includes("zhangxiaoqiang1991"), `${id} 署名头丢失出处`);
    // 正文逐字节比对：夹具即迁移前的手写正文
    const body = rendered.slice(rendered.indexOf("*/") + "*/\n\n".length);
    assert.equal(body, await readFile(join(fixturesRoot, file), "utf8"), `${id} 签名渲染与快照漂移`);
  }
});
