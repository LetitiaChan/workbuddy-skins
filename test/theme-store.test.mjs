import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSingleImageTheme, listThemes } from "../src/theme-store.mjs";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "wss-store-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeTheme(root, folder, manifest) {
  await mkdir(join(root, folder), { recursive: true });
  await writeFile(join(root, folder, "theme.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
}

test("listThemes：多个 root 出现同 id 时只保留先出现的（内置优先），避免菜单重复 id", async () => {
  await withTempDir(async (dir) => {
    const bundled = join(dir, "bundled");
    const user = join(dir, "user");
    await writeTheme(bundled, "a", { id: "dup", name: "Bundled" });
    await writeTheme(user, "b", { id: "dup", name: "User" });
    await writeTheme(user, "c", { id: "only-user", name: "Only" });
    const themes = await listThemes({ roots: [bundled, user] });
    assert.deepEqual(themes.map(({ id, name }) => [id, name]), [["dup", "Bundled"], ["only-user", "Only"]]);
  });
});

test("listThemes：name 缺失不再让排序抛 TypeError，回退按 id 排序", async () => {
  await withTempDir(async (dir) => {
    await writeTheme(dir, "x", { id: "zeta" });
    await writeTheme(dir, "y", { id: "alpha", name: "Beta" });
    const themes = await listThemes({ roots: [dir] });
    assert.deepEqual(themes.map(({ id }) => id), ["alpha", "zeta"]);
  });
});

test("listThemes：order 优先，其次名称；跳过坏 JSON、无 id 清单与 .tmp- 残留目录", async () => {
  await withTempDir(async (dir) => {
    await writeTheme(dir, "first", { id: "b-theme", name: "B", order: -1 });
    await writeTheme(dir, "second", { id: "a-theme", name: "A" });
    await writeTheme(dir, "broken", "{ not json");
    await writeTheme(dir, "noid", { name: "No id" });
    await writeTheme(dir, "half.tmp-1234", { id: "half", name: "Half" });
    const themes = await listThemes({ roots: [dir, join(dir, "missing-root")] });
    assert.deepEqual(themes.map(({ id }) => id), ["b-theme", "a-theme"]);
    assert.ok(themes[0].path.endsWith("first"));
  });
});

test("listThemes：坏 theme.json 收集到 errors，不再静默消失", async () => {
  await withTempDir(async (dir) => {
    await writeTheme(dir, "good", { id: "good", name: "Good" });
    await writeTheme(dir, "broken", "{ not json");
    await writeTheme(dir, "noid", { name: "No id" });
    // 没有 theme.json 的目录属正常情况（非主题目录），不应产生报错
    await mkdir(join(dir, "empty-dir"), { recursive: true });
    const themes = await listThemes({ roots: [dir] });
    // 列表本身仍然容错：只返回可用主题
    assert.deepEqual(themes.map(({ id }) => id), ["good"]);
    // 但失败原因必须可取（非枚举，不污染 map/JSON）
    const errors = themes.errors;
    assert.equal(errors.length, 2, `应报告 2 个坏主题，实际 ${errors.length}: ${JSON.stringify(errors)}`);
    const paths = errors.map((e) => e.path.split(/[\\/]/).pop()).sort();
    assert.deepEqual(paths, ["broken", "noid"]);
    assert.ok(errors.every((e) => typeof e.reason === "string" && e.reason.length > 0), "每条都应带原因");
    assert.ok(errors.find((e) => e.path.endsWith("noid")).reason.includes("id"), "缺 id 的原因应提到 id");
    // errors 非枚举：不进 JSON、不被展开
    assert.equal(JSON.parse(JSON.stringify(themes)).length, 1);
    assert.ok(!Object.keys(themes).includes("errors"));
  });
});

test("listThemes：全部主题正常时 errors 为空数组", async () => {
  await withTempDir(async (dir) => {
    await writeTheme(dir, "a", { id: "a", name: "A" });
    const themes = await listThemes({ roots: [dir] });
    assert.deepEqual(themes.errors, []);
  });
});

test("listThemes：透传已解析的 rawManifest（非枚举），供 loadTheme 跳过重复读盘", async () => {
  await withTempDir(async (dir) => {
    await writeTheme(dir, "a", { schemaVersion: 1, id: "a", name: "A", hero: "x.png" });
    const [theme] = await listThemes({ roots: [dir] });
    assert.ok(theme.rawManifest, "应带 rawManifest");
    assert.equal(theme.rawManifest.id, "a");
    assert.equal(theme.rawManifest.hero, "x.png");
    // 非枚举：不进 JSON、不被展开，也不会污染 Object.keys
    assert.ok(!Object.keys(theme).includes("rawManifest"));
    assert.equal(JSON.parse(JSON.stringify(theme)).rawManifest, undefined);
    // rawManifest 不含 path（那是 listThemes 附加的），保持 theme.json 原样
    assert.equal(theme.rawManifest.path, undefined);
  });
});

test("listThemes：manifest 缓存按 mtime+size 失效，改文件后能读到新内容", async () => {
  await withTempDir(async (dir) => {
    await writeTheme(dir, "a", { id: "a", name: "旧名" });
    assert.equal((await listThemes({ roots: [dir] }))[0].name, "旧名");
    // 同一进程内改写：mtime 或 size 任一变化都必须让缓存失效。
    // 刻意改成不同长度的名字，确保 size 也变（部分文件系统 mtime 精度只到秒，
    // 同秒内改动若只比 mtime 会漏判——这正是同时比对 size 的理由）
    await writeTheme(dir, "a", { id: "a", name: "新名字更长一些" });
    assert.equal(
      (await listThemes({ roots: [dir] }))[0].name,
      "新名字更长一些",
      "改动 theme.json 后必须读到新内容，不能命中陈旧缓存",
    );
  });
});

test("listThemes：缓存命中时不重复读盘（同内容连续两轮结果一致）", async () => {
  await withTempDir(async (dir) => {
    await writeTheme(dir, "a", { id: "a", name: "A", order: -3 });
    await writeTheme(dir, "b", { id: "b", name: "B" });
    const first = await listThemes({ roots: [dir] });
    const second = await listThemes({ roots: [dir] });
    assert.deepEqual(first.map((t) => t.id), second.map((t) => t.id));
    assert.deepEqual(first.map((t) => t.name), second.map((t) => t.name));
    // 缓存返回的是同一个 manifest 对象引用（证明没重新 parse）
    assert.equal(first[0].rawManifest, second[0].rawManifest);
  });
});

test("createSingleImageTheme：名称去首尾空白，空名称拒绝", async () => {
  await withTempDir(async (dir) => {
    const image = join(dir, "pic.png");
    await writeFile(image, Buffer.alloc(32, 1));
    const store = join(dir, "store");
    const created = await createSingleImageTheme({ imagePath: image, name: "  My Skin  ", storeRoot: store });
    assert.equal(created.manifest.name, "My Skin");
    assert.equal(created.manifest.schemaVersion, 1);
    assert.match(created.id, /^my-skin-[0-9a-f]{8}$/);
    await assert.rejects(createSingleImageTheme({ imagePath: image, name: "   ", storeRoot: store }), /名称不能为空/);
  });
});
