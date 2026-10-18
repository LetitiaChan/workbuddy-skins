import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { readLocalReleaseVersion } from "./update-check.mjs";

// Release 自更新：下载最新 zip → 解压到与当前安装并列的新目录（workbuddy-skins-<版本>）。
// 全程不碰旧目录，失败可直接删掉新目录回滚；state.json 在全局安装目录（constants.mjs
// resolveStudioPaths），与 zip 内容无关，无需迁移。仅 zip 安装可用；git clone 走 git pull。

const execFileAsync = promisify(execFile);

// zip 为 release.yml 的 Compress-Archive 产物：src/ scripts/ themes/ 等平铺根目录，
// 版本号文件固定在解压后的 src/release-version.json
async function readUnpackedVersion(unpackDir) {
  try {
    const parsed = JSON.parse((await readFile(join(unpackDir, "src", "release-version.json"), "utf8")).replace(/^﻿/, "").trim());
    return typeof parsed?.version === "string" && parsed.version ? parsed.version : null;
  } catch {
    return null;
  }
}

// 下载带限时与魔数校验：防止把网关/代理的 HTML 拦截页当 zip 解压
async function downloadZip({ url, dest, fetchImpl = fetch, timeoutMs = 120000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: "application/octet-stream", "User-Agent": "workbuddy-skins" },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw new Error("下载内容不是 zip（可能遇到网关/代理拦截页）");
    }
    await writeFile(dest, buffer);
    return buffer.length;
  } finally {
    clearTimeout(timer);
  }
}

// 解压：Windows 优先 Expand-Archive（PowerShell 自带，GNU tar 不支持 zip 时仍可用），
// macOS/其他走 bsdtar（系统自带，zip 支持良好），免去引入解压依赖
async function extractZip(zipPath, destDir) {
  if (process.platform === "win32") {
    await execFileAsync("powershell", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -LiteralPath $env:WB_ZIP -DestinationPath $env:WB_DEST -Force`,
    ], { env: { ...process.env, WB_ZIP: zipPath, WB_DEST: destDir }, windowsHide: true });
    return;
  }
  await execFileAsync("tar", ["-xf", zipPath, "-C", destDir], { windowsHide: true });
}

export async function performReleaseUpdate({ sourceRoot, check, fetchImpl } = {}) {
  const currentVersion = await readLocalReleaseVersion({ versionFile: join(sourceRoot, "release-version.json") });
  if (!currentVersion) {
    return { updated: false, reason: "非 Release 包安装（无版本文件），git 用户请用 git pull" };
  }

  const result = await check();
  if (!result?.checked) {
    return { updated: false, reason: result?.reason ?? "更新检查未执行" };
  }
  if (!result.updateAvailable) {
    return { updated: false, currentVersion, latestVersion: result.latestVersion, reason: "已是最新版本" };
  }
  if (!result.zipUrl) {
    return {
      updated: false,
      currentVersion,
      latestVersion: result.latestVersion,
      reason: "Release 未提供 zip 直链，请手动下载",
      url: result.url,
    };
  }

  // zip 结构：sourceRoot 即 <安装目录>/src；git 检出时已在前面的版本文件检查处短路，
  // 到这里一定是 zip 布局，故安装目录 = sourceRoot/..，并列新目录落在其同级
  const installDir = join(sourceRoot, "..");
  const targetDir = join(installDir, "..", `workbuddy-skins-${result.latestVersion}`);
  const scratch = await mkdtemp(join(tmpdir(), "wb-release-"));
  const zipPath = join(scratch, "release.zip");
  const unpackDir = join(scratch, "unpacked");
  try {
    await mkdir(unpackDir);
    await downloadZip({ url: result.zipUrl, dest: zipPath, fetchImpl });
    await extractZip(zipPath, unpackDir);
    // 防错版：zip 内版本号必须与 API 报告一致，避免代理缓存拿到旧包却声称新版。
    // 读不到版本号（文件缺失/损坏/非法 JSON）必须视为校验失败——若在此降级放行，
    // 代理返回的旧包或被改造的包会被静默安装，恰好绕开这道校验要防的攻击面。
    const zipVersion = await readUnpackedVersion(unpackDir);
    if (!zipVersion) {
      throw new Error("zip 内缺少可读的 src/release-version.json，无法校验版本，已中止安装");
    }
    if (zipVersion !== result.latestVersion) {
      throw new Error(`zip 内版本 ${zipVersion} 与 Release 标记 ${result.latestVersion} 不一致`);
    }
    // 落位：解压出的条目（src/scripts/themes/...）整体移入目标目录
    await mkdir(targetDir, { recursive: false }).catch((error) => {
      if (error.code === "EEXIST") throw new Error(`目标目录已存在：${targetDir}，请先删除或改名`);
      throw error;
    });
    for (const entry of await readdir(unpackDir)) {
      await rename(join(unpackDir, entry), join(targetDir, entry));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }

  return {
    updated: true,
    from: currentVersion,
    to: result.latestVersion,
    dir: targetDir,
    nextStep: `在新目录重新执行安装：node ${join(targetDir, "src", "cli.mjs")} apply（或双击 Start.bat / scripts/apply.command）。确认无误后可删除旧目录 ${installDir}`,
  };
}
