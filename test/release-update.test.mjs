import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { performReleaseUpdate } from "../src/release-update.mjs";

const execFileAsync = promisify(execFile);

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "wb-relup-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 造一个与 release.yml 产物同构的 zip：src/release-version.json + 一个脚本文件
async function makeZip(dir, version) {
  const staging = join(dir, "staging");
  await mkdir(join(staging, "src"), { recursive: true });
  await mkdir(join(staging, "scripts"), { recursive: true });
  await writeFile(join(staging, "src", "release-version.json"), `{"version":"${version}"}`);
  await writeFile(join(staging, "scripts", "apply.ps1"), "# placeholder\n");
  const zipPath = join(dir, "release.zip");
  // 与 release.yml 同一打包工具（Git Bash 的 GNU tar 不支持 zip 格式，不能用 tar -acf）
  await execFileAsync("powershell", [
    "-NoProfile", "-NonInteractive", "-Command",
    `Compress-Archive -Path (Join-Path $env:WB_STG 'src'), (Join-Path $env:WB_STG 'scripts') -DestinationPath $env:WB_ZIP`,
  ], { env: { ...process.env, WB_STG: staging, WB_ZIP: zipPath }, windowsHide: true });
  return zipPath;
}

const zipFetch = (zipPath) => async () => ({
  ok: true,
  // Buffer.buffer 返回的是底层池（含池内其他数据），须按 offset/length 精确切片
  arrayBuffer: async () => {
    const buf = await readFile(zipPath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },
});

test("performReleaseUpdate：无版本文件（git clone）直接拒绝", async () => {
  await withTempDir(async (dir) => {
    const result = await performReleaseUpdate({ sourceRoot: dir, check: async () => ({ checked: true }) });
    assert.equal(result.updated, false);
    assert.match(result.reason, /git pull/);
  });
});

test("performReleaseUpdate：已是最新 / 无 zip 直链时不下载", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "release-version.json"), '{"version":"v1.1.0"}');
    const same = await performReleaseUpdate({
      sourceRoot: dir,
      check: async () => ({ checked: true, updateAvailable: false, latestVersion: "v1.1.0" }),
    });
    assert.equal(same.updated, false);
    assert.match(same.reason, /已是最新/);

    const noZip = await performReleaseUpdate({
      sourceRoot: dir,
      check: async () => ({ checked: true, updateAvailable: true, latestVersion: "v2.0.0", url: "https://x", zipUrl: null }),
    });
    assert.equal(noZip.updated, false);
    assert.match(noZip.reason, /手动下载/);
  });
});

test("performReleaseUpdate：下载解压到并列新目录，旧目录原样保留", async () => {
  await withTempDir(async (dir) => {
    // 模拟旧安装：parent/workbuddy-skins/src/release-version.json
    const oldInstall = join(dir, "workbuddy-skins");
    const oldSrc = join(oldInstall, "src");
    await mkdir(oldSrc, { recursive: true });
    await writeFile(join(oldSrc, "release-version.json"), '{"version":"v1.0.0"}');
    await writeFile(join(oldSrc, "old-marker.txt"), "do not touch");

    const zipPath = await makeZip(dir, "v2.0.0");
    const result = await performReleaseUpdate({
      sourceRoot: oldSrc,
      check: async () => ({
        checked: true, updateAvailable: true, latestVersion: "v2.0.0",
        url: "https://x", zipUrl: "https://x/release.zip",
      }),
      fetchImpl: zipFetch(zipPath),
    });

    assert.equal(result.updated, true);
    assert.equal(result.from, "v1.0.0");
    assert.equal(result.to, "v2.0.0");
    assert.equal(result.dir, join(dir, "workbuddy-skins-v2.0.0"));
    // 新目录内容完整
    const newVersion = JSON.parse(await readFile(join(result.dir, "src", "release-version.json"), "utf8"));
    assert.equal(newVersion.version, "v2.0.0");
    // 旧目录未动
    assert.equal(await readFile(join(oldSrc, "old-marker.txt"), "utf8"), "do not touch");
    assert.match(result.nextStep, /apply/);
  });
});

test("performReleaseUpdate：zip 内版本与 API 不一致时拒绝落位", async () => {
  await withTempDir(async (dir) => {
    const oldSrc = join(dir, "workbuddy-skins", "src");
    await mkdir(oldSrc, { recursive: true });
    await writeFile(join(oldSrc, "release-version.json"), '{"version":"v1.0.0"}');
    const zipPath = await makeZip(dir, "v1.9.9"); // 与 API 声称的 v2.0.0 不符

    await assert.rejects(
      performReleaseUpdate({
        sourceRoot: oldSrc,
        check: async () => ({
          checked: true, updateAvailable: true, latestVersion: "v2.0.0",
          url: "https://x", zipUrl: "https://x/release.zip",
        }),
        fetchImpl: zipFetch(zipPath),
      }),
      /不一致/,
    );
  });
});

test("performReleaseUpdate：下载内容非 zip（拦截页）时报错", async () => {
  await withTempDir(async (dir) => {
    const oldSrc = join(dir, "workbuddy-skins", "src");
    await mkdir(oldSrc, { recursive: true });
    await writeFile(join(oldSrc, "release-version.json"), '{"version":"v1.0.0"}');

    await assert.rejects(
      performReleaseUpdate({
        sourceRoot: oldSrc,
        check: async () => ({
          checked: true, updateAvailable: true, latestVersion: "v2.0.0",
          url: "https://x", zipUrl: "https://x/release.zip",
        }),
        fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode("<html>blocked</html>").buffer }),
      }),
      /不是 zip/,
    );
  });
});
