import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkReleaseUpdate, compareVersions, readLocalReleaseVersion, readLocalVersion } from "../src/update-check.mjs";

// 真实全局 fetch 绝不进测试：所有用例都注入 fetchImpl 桩
const okFetch = (tag = "v1.1.0", url = "https://github.com/x/releases/tag/v1.1.0", zipUrl = "https://github.com/x/releases/download/v1.1.0/workbuddy-skins-v1.1.0.zip") =>
  async () => ({
    ok: true,
    json: async () => ({
      tag_name: tag,
      html_url: url,
      assets: zipUrl ? [{ name: "workbuddy-skins.zip", browser_download_url: zipUrl }] : [],
    }),
  });

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "wb-update-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("compareVersions：忽略 v 前缀，逐段比较，缺段按 0", () => {
  assert.ok(compareVersions("v1.1.0", "1.0.9") > 0);
  assert.ok(compareVersions("1.0.0", "v1.0.0") === 0);
  assert.ok(compareVersions("v1.0", "1.0.1") < 0);
  assert.ok(compareVersions("v2.0.0-beta", "1.9.9") > 0); // 非数字段按 0
});

test("readLocalReleaseVersion：读取版本文件，容忍 BOM；缺失/损坏返回 null", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "release-version.json");
    await writeFile(file, "﻿{\"version\":\"v1.2.3\"}");
    assert.equal(await readLocalReleaseVersion({ versionFile: file }), "v1.2.3");
    await writeFile(file, "not json");
    assert.equal(await readLocalReleaseVersion({ versionFile: file }), null);
    assert.equal(await readLocalReleaseVersion({ versionFile: join(dir, "missing.json") }), null);
  });
});

test("readLocalVersion：release-version.json 优先，缺失回退同级 package.json，双缺失返回 null", async () => {
  await withTempDir(async (dir) => {
    // 只有 package.json（git 检出：sourceRoot 即仓库根）
    await writeFile(join(dir, "package.json"), '{"version":"1.1.0"}');
    assert.equal(await readLocalVersion({ sourceRoot: dir }), "1.1.0");
    // zip 结构：sourceRoot 指向 src/，package.json 在上一级
    const src = join(dir, "src");
    await mkdir(src, { recursive: true });
    assert.equal(await readLocalVersion({ sourceRoot: src }), "1.1.0");
    // release-version.json 存在时优先于 package.json
    await writeFile(join(src, "release-version.json"), '{"version":"v1.2.3"}');
    assert.equal(await readLocalVersion({ sourceRoot: src }), "v1.2.3");
  });
  // 两处都没有 → null（用与任何 package.json 无祖先关系的独立临时目录，避免回退路径误命中）
  await withTempDir(async (dir) => {
    const lone = join(dir, "lone");
    await mkdir(lone, { recursive: true });
    await writeFile(join(dir, "package.json"), '{"version":"1.1.0"}');
    // 上一条用例已证明父级可命中，这里把父级也换成无 package.json 的目录
    const outer = join(dir, "outer");
    await mkdir(join(outer, "inner"), { recursive: true });
    await rm(join(dir, "package.json"), { force: true });
    assert.equal(await readLocalVersion({ sourceRoot: join(outer, "inner") }), null);
    assert.equal(await readLocalVersion({}), null);
  });
});

test("checkReleaseUpdate：无版本文件（git clone）短路为 checked:false，不发请求", async () => {
  await withTempDir(async (dir) => {
    let fetched = false;
    const result = await checkReleaseUpdate({
      sourceRoot: dir,
      fetchImpl: async () => { fetched = true; return okFetch()(); },
    });
    assert.equal(result.checked, false);
    assert.equal(fetched, false);
  });
});

test("checkReleaseUpdate：有新版本时写缓存并返回 hint；无新版本不带 hint", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "release-version.json"), '{"version":"v1.0.0"}');
    const writes = [];
    const result = await checkReleaseUpdate({
      sourceRoot: dir,
      fetchImpl: okFetch("v1.2.0"),
      readStateFile: async () => null,
      writeStateFile: async (patch) => { writes.push(patch); },
    });
    assert.equal(result.checked, true);
    assert.equal(result.currentVersion, "v1.0.0");
    assert.equal(result.latestVersion, "v1.2.0");
    assert.equal(result.updateAvailable, true);
    assert.match(result.hint, /v1\.2\.0/);
    assert.equal(result.zipUrl, "https://github.com/x/releases/download/v1.1.0/workbuddy-skins-v1.1.0.zip");
    assert.equal(writes.length, 1);
    assert.equal(writes[0].releaseCheck.latest, "v1.2.0");
    assert.equal(writes[0].releaseCheck.zipUrl, "https://github.com/x/releases/download/v1.1.0/workbuddy-skins-v1.1.0.zip");

    const same = await checkReleaseUpdate({
      sourceRoot: dir,
      fetchImpl: okFetch("v1.0.0"),
      readStateFile: async () => null,
      writeStateFile: async () => {},
    });
    assert.equal(same.updateAvailable, false);
    assert.equal(same.hint, undefined);
  });
});

test("checkReleaseUpdate：Release 无 zip 资产时 zipUrl 为 null（update 命令据此回退手动指引）", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "release-version.json"), '{"version":"v1.0.0"}');
    const result = await checkReleaseUpdate({
      sourceRoot: dir,
      fetchImpl: okFetch("v2.0.0", undefined, null),
      readStateFile: async () => null,
      writeStateFile: async () => {},
    });
    assert.equal(result.updateAvailable, true);
    assert.equal(result.zipUrl, null);
    assert.match(result.hint, /cli\.mjs update/);
  });
});

test("checkReleaseUpdate：24h 内缓存新鲜时不发请求，直接按缓存判断", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "release-version.json"), '{"version":"v1.0.0"}');
    let fetched = false;
    const result = await checkReleaseUpdate({
      sourceRoot: dir,
      nowMs: Date.parse("2026-03-01T12:00:00Z"),
      fetchImpl: async () => { fetched = true; return okFetch()(); },
      readStateFile: async () => ({ releaseCheck: { at: "2026-03-01T08:00:00Z", latest: "v9.9.9", url: "https://cached" } }),
      writeStateFile: async () => {},
    });
    assert.equal(fetched, false);
    assert.equal(result.latestVersion, "v9.9.9");
    assert.equal(result.url, "https://cached");
    assert.equal(result.zipUrl, null, "旧缓存无 zipUrl 字段时回退 null");
    assert.equal(result.updateAvailable, true);
  });
});

test("checkReleaseUpdate：请求失败且有旧缓存时降级用缓存；无缓存则 checked:false", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "release-version.json"), '{"version":"v1.0.0"}');
    const failFetch = async () => { throw new Error("offline"); };
    const stale = { at: "2020-01-01T00:00:00Z", latest: "v1.5.0", url: "https://cached" };
    const fallback = await checkReleaseUpdate({
      sourceRoot: dir,
      fetchImpl: failFetch,
      readStateFile: async () => ({ releaseCheck: stale }),
      writeStateFile: async () => {},
    });
    assert.equal(fallback.checked, true);
    assert.equal(fallback.latestVersion, "v1.5.0");
    assert.equal(fallback.updateAvailable, true);

    const none = await checkReleaseUpdate({
      sourceRoot: dir,
      fetchImpl: failFetch,
      readStateFile: async () => null,
      writeStateFile: async () => {},
    });
    assert.equal(none.checked, false);
    assert.match(none.reason, /offline/);
  });
});

test("checkReleaseUpdate：缓存写入失败不影响检查结果", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "release-version.json"), '{"version":"v1.0.0"}');
    const result = await checkReleaseUpdate({
      sourceRoot: dir,
      fetchImpl: okFetch("v2.0.0"),
      readStateFile: async () => null,
      writeStateFile: async () => { throw new Error("disk full"); },
    });
    assert.equal(result.checked, true);
    assert.equal(result.updateAvailable, true);
  });
});
