import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Release 更新检查：面向 zip 解压用户（无 .git，doctor 的 git 检查覆盖不到）。
// 版本号在打包时由 release.yml 写入 release-version.json；git clone 用户没有此文件，
// 检查直接短路为 checked:false。结果缓存进 state.json（releaseCheck），24 小时内不重复请求；
// 离线/超时一律降级（有旧缓存用旧缓存），绝不抛给调用方打断主流程。

export const RELEASE_API = "https://api.github.com/repos/LetitiaChan/workbuddy-skins/releases/latest";
export const RELEASES_PAGE = "https://github.com/LetitiaChan/workbuddy-skins/releases";
export const RELEASE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// 语义化版本比较：忽略 v 前缀与非数字段（如 v1.2.0-beta 按 1.2.0 计），返回 >0 表示 a 更新
export function compareVersions(a, b) {
  const parse = (v) => String(v).replace(/^v/i, "").split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function readLocalReleaseVersion({ versionFile } = {}) {
  try {
    // Out-File -Encoding utf8 可能带 BOM，先剥掉再 parse
    const parsed = JSON.parse((await readFile(versionFile, "utf8")).replace(/^﻿/, ""));
    return typeof parsed?.version === "string" && parsed.version ? parsed.version : null;
  } catch {
    return null;
  }
}

// 菜单展示用版本号：与「是否 Release 包」无关，任何安装方式都尽量给一个值。
// release-version.json（zip 打包写入，含 v 前缀）优先；否则回退 package.json（git 检出）。
export async function readLocalVersion({ sourceRoot } = {}) {
  if (!sourceRoot) return null;
  const release = await readLocalReleaseVersion({ versionFile: join(sourceRoot, "release-version.json") });
  if (release) return release;
  try {
    // zip 包内 sourceRoot 指向 src/，package.json 在其上一级；git 检出时 sourceRoot 即仓库根
    const raw = await readFile(join(sourceRoot, "package.json"), "utf8").catch(() =>
      readFile(join(sourceRoot, "..", "package.json"), "utf8"));
    const parsed = JSON.parse(raw.replace(/^﻿/, ""));
    return typeof parsed?.version === "string" && parsed.version ? parsed.version : null;
  } catch {
    return null;
  }
}

export async function fetchLatestRelease({ fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(RELEASE_API, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "workbuddy-skins" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub API 返回 ${response.status}`);
    const data = await response.json();
    if (typeof data?.tag_name !== "string" || !data.tag_name) throw new Error("响应缺少 tag_name");
    // zip 资产直链：update 命令自动下载用；缺失（API 异常/无资产）时 update 回退手动指引
    const zipAsset = Array.isArray(data.assets)
      ? data.assets.find((a) => typeof a?.name === "string" && a.name.endsWith(".zip") && typeof a?.browser_download_url === "string")
      : null;
    return {
      latest: data.tag_name,
      url: typeof data.html_url === "string" ? data.html_url : `${RELEASES_PAGE}/latest`,
      zipUrl: zipAsset?.browser_download_url ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkReleaseUpdate({ sourceRoot, readStateFile, writeStateFile, fetchImpl, nowMs = Date.now() } = {}) {
  const currentVersion = await readLocalReleaseVersion({ versionFile: join(sourceRoot, "release-version.json") });
  if (!currentVersion) return { checked: false, channel: "release", reason: "非 Release 包安装（无版本文件）" };

  const cached = await readStateFile?.().then((state) => state?.releaseCheck).catch(() => null);
  const cacheFresh = cached?.latest && Number.isFinite(Date.parse(cached.at)) && nowMs - Date.parse(cached.at) < RELEASE_CACHE_TTL_MS;

  let latest;
  let url;
  let zipUrl;
  if (cacheFresh) {
    latest = cached.latest;
    url = cached.url ?? `${RELEASES_PAGE}/latest`;
    zipUrl = typeof cached.zipUrl === "string" ? cached.zipUrl : null;
  } else {
    try {
      ({ latest, url, zipUrl } = await fetchLatestRelease({ fetchImpl }));
      // 缓存写入失败（权限/磁盘）不影响检查结果本身
      await writeStateFile?.({ releaseCheck: { at: new Date(nowMs).toISOString(), latest, url, zipUrl } }).catch(() => {});
    } catch (error) {
      if (!cached?.latest) return { checked: false, channel: "release", currentVersion, reason: error.message };
      latest = cached.latest;
      url = cached.url ?? `${RELEASES_PAGE}/latest`;
      zipUrl = typeof cached.zipUrl === "string" ? cached.zipUrl : null;
    }
  }

  const updateAvailable = compareVersions(latest, currentVersion) > 0;
  return {
    checked: true,
    channel: "release",
    currentVersion,
    latestVersion: latest,
    updateAvailable,
    ...(updateAvailable ? { url, zipUrl: zipUrl ?? null, hint: `发现新版本 ${latest}，运行 node src/cli.mjs update 自动更新，或前往 Releases 手动下载：${url}` } : {}),
  };
}
