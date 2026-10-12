import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkReleaseUpdate, compareVersions, readLocalReleaseVersion } from "../src/update-check.mjs";

// 真实全局 fetch 绝不进测试：所有用例都注入 fetchImpl 桩
const okFetch = (tag = "v1.1.0", url = "https://github.com/x/releases/tag/v1.1.0") =>
  async () => ({ ok: true, json: async () => ({ tag_name: tag, html_url: url }) });

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
    assert.equal(writes.length, 1);
    assert.equal(writes[0].releaseCheck.latest, "v1.2.0");

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
