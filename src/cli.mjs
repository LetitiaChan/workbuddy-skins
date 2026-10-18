#!/usr/bin/env node
import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validatePort } from "./cdp-client.mjs";
import { DEFAULT_CDP_PORT, DEFAULT_THEME_ID, EXPECTED_BUNDLE_ID, RENDERER_URL_HINT, resolveStudioPaths } from "./constants.mjs";
import { applySkin, removeSkin, skinStatus, readSavedActiveSkin, activateSavedSkin, activateSavedNative } from "./injector.mjs";
import { probeRendererCompat } from "./compat-probe.mjs";
import { findInstalledApp } from "./platform-paths.mjs";
import { repoUpdateInfo } from "./repo-update.mjs";
import { readState, writeState } from "./state-store.mjs";
import { loadTheme } from "./theme-schema.mjs";
import { createSingleImageTheme, listThemes } from "./theme-store.mjs";
import { checkReleaseUpdate } from "./update-check.mjs";
import { performReleaseUpdate } from "./release-update.mjs";

// 更新提示的后台等待上限：GitHub API 国内偶发慢，超时就放弃提示（不阻塞命令退出）。
// 检查结果已写入 state.json 缓存，提示丢失后下次命令立即可见
const UPDATE_HINT_TIMEOUT_MS = 5000;

const sourceRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function options(argv) {
  const result = {};
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`无法识别的参数：${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} 缺少值`);
    result[key.slice(2)] = value;
    index += 1;
  }
  return result;
}

function portFrom(value) {
  if (value === undefined) return DEFAULT_CDP_PORT;
  try {
    return validatePort(Number(value));
  } catch {
    throw new Error("--port 必须是 1024 到 65535 的整数");
  }
}

function defaults(overrides) {
  const paths = resolveStudioPaths();
  const deps = {
    bundledThemesRoot: join(sourceRoot, "themes"),
    userThemesRoot: paths.userThemesRoot,
    loadTheme,
    listThemes,
    createSingleImageTheme,
    applySkin,
    removeSkin,
    skinStatus,
    readSavedActiveSkin,
    activateSavedSkin,
    activateSavedNative,
    readStateFile: readState,
    writeStateFile: writeState,
    probeRenderer: probeRendererCompat,
    repoUpdate: () => repoUpdateInfo({ sourceRoot }),
    findInstalledApp,
    ...overrides,
  };
  // releaseUpdate 依赖 readStateFile/writeStateFile（结果缓存进 state.json），
  // 在 overrides 展开后定义，让测试替换 state 存取时检查模块同样走桩
  deps.releaseUpdate = overrides.releaseUpdate
    ?? (() => checkReleaseUpdate({ sourceRoot, readStateFile: deps.readStateFile, writeStateFile: deps.writeStateFile }));
  // 自更新复用同一检查（24h 缓存）： doctor/apply 刚查过时 update 不再发请求
  deps.releaseSelfUpdate = overrides.releaseSelfUpdate
    ?? (() => performReleaseUpdate({ sourceRoot, check: deps.releaseUpdate }));
  return deps;
}

const exists = (path) => access(path).then(() => true, () => false);

// 状态回执只作诊断：写入失败（权限/磁盘）绝不允许打断换肤主流程
function recordState(deps, patch) {
  return deps.writeStateFile(patch).catch(() => {});
}

// apply/status 结果附带的新版本提示：后台检查 + 限时等待，离线/超时/无更新都返回 null，
// 提示是增强项，绝不允许拖慢或打断命令主流程。
// 超时 timer 必须在 finally 里清掉：Promise.race 胜出不会取消落败的那个 setTimeout，
// Node 事件循环要等它到点才退出——实测漏清时 runCli 70ms 返回、进程却 6.5s 才退，
// 每次 status/apply 白挂 5 秒。写法对齐 cdp-client.mjs 的 awaitBeforeDeadline。
async function updateHint(deps) {
  let timer = null;
  try {
    const result = await Promise.race([
      deps.releaseUpdate(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("更新检查超时")), UPDATE_HINT_TIMEOUT_MS);
      }),
    ]);
    return result?.updateAvailable ? { latest: result.latestVersion, url: result.url, hint: result.hint } : null;
  } catch {
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// doctor 环境报告附带的 Node 版本检查（注入脚本用到较新的内置 API，要求 18+）
function nodeInfo() {
  const major = Number(process.versions.node.split(".")[0]);
  return { version: process.version, required: ">=18", ok: Number.isInteger(major) && major >= 18 };
}

export async function runCli(argv, overrides = {}) {
  const command = argv[0] ?? "help";
  const args = options(argv);
  const deps = defaults(overrides);
  const roots = [deps.bundledThemesRoot, deps.userThemesRoot];

  if (command === "help") {
    return {
      commands: ["list", "create --image PATH --name NAME", "apply [--theme ID] [--port 9223]", "pause (alias: restore)", "status", "doctor", "update"],
    };
  }
  if (command === "update") {
    // Release 自更新：仅 zip 安装生效；git clone 由 repoUpdate 提示 git pull
    return deps.releaseSelfUpdate();
  }
  if (command === "list") {
    // listThemes 把坏 theme.json 的失败原因挂在非枚举的 errors 上（见 theme-store）。
    // 有问题时连同清单一起输出，避免「主题莫名消失」只能靠肉眼翻目录排查
    const themes = await deps.listThemes({ roots });
    const broken = themes.errors ?? [];
    return broken.length > 0 ? { themes, broken } : themes;
  }
  if (command === "create") {
    if (!args.image) throw new Error("create 需要 --image");
    if (!args.name) throw new Error("create 需要 --name");
    return deps.createSingleImageTheme({ imagePath: args.image, name: args.name, storeRoot: deps.userThemesRoot });
  }
  if (command === "apply") {
    const port = portFrom(args.port);
    // 与换肤主流程并发发起（内部写 state 缓存），成功后在结果上附带新版本提示
    const pendingUpdate = updateHint(deps);
    try {
      const result = await applyCommand(deps, roots, args, port);
      const update = await pendingUpdate;
      return update ? { ...result, update } : result;
    } catch (error) {
      await recordState(deps, {
        lastApply: { at: new Date().toISOString(), ok: false, port, themeId: args.theme ?? null, error: error.message },
      });
      throw error;
    }
  }
  if (command === "pause" || command === "restore") {
    const port = portFrom(args.port);
    const result = await deps.removeSkin({ port });
    await recordState(deps, { lastPause: { at: new Date().toISOString(), ok: true, port, removed: result.removed } });
    return result;
  }
  if (command === "status") {
    const [result, update] = await Promise.all([deps.skinStatus({ port: portFrom(args.port) }), updateHint(deps)]);
    return update ? { targets: result, update } : result;
  }
  if (command === "doctor") {
    const port = portFrom(args.port);
    // 四项诊断互不依赖，并发；各自降级（状态损坏/未运行/离线），绝不让 doctor 整体失败
    const [state, compat, repo, themes] = await Promise.all([
      deps.readStateFile().catch(() => null),
      deps.probeRenderer({ port }).catch((error) => ({ reachable: false, reason: error.message })),
      deps.repoUpdate().catch((error) => ({ checked: false, reason: error.message })),
      deps.listThemes({ roots }).catch(() => null),
    ]);
    // 坏 theme.json 清单（解析失败/缺 id）：这类主题会从列表里静默消失，doctor 必须报出来
    const brokenThemes = themes?.errors ?? [];
    // 安装位发现下沉到 platform-paths（platform / env / exists 全可注入，
    // 非 Windows 机器上也能覆盖 Windows 分支）
    const install = await deps.findInstalledApp({ exists });
    const common = {
      cdpPort: port,
      rendererHint: RENDERER_URL_HINT,
      installRoot: resolveStudioPaths().installRoot,
      statePath: resolveStudioPaths().statePath,
      node: nodeInfo(),
      compat,
      repo,
      state,
      brokenThemes,
    };
    if (install.platform === "win32") {
      const { platform, app, appFound, candidates } = install;
      return { platform, app, appFound, candidates, ...common };
    }
    const { platform, app, appFound } = install;
    return { platform, app, appFound, bundleId: EXPECTED_BUNDLE_ID, ...common };
  }
  throw new Error(`未知命令：${command}`);
}

async function applyCommand(deps, roots, args, port) {
  let themeId = args.theme;
  let savedCustomId = null;
  let savedNativeMode = null;
  let activeId;
  // 读取上次皮肤（CDP 往返）与扫描主题目录（磁盘）互不依赖，并发
  const [saved, themes] = await Promise.all([
    themeId ? null : deps.readSavedActiveSkin({ port }).catch(() => null),
    deps.listThemes({ roots }),
  ]);
  if (!themeId) {
    // 未指定主题：恢复上次使用的皮肤（菜单切换时已持久化到渲染进程 localStorage）；
    // 是自定义皮肤则先按默认主题注入菜单（activeId=null），再激活自定义皮肤；
    // 原生浅色/深色同理：注入后不应用皮肤，只钉明暗模式；
    // 没有记录或读取失败则回退默认主题
    if (saved && saved.startsWith("custom-")) {
      themeId = DEFAULT_THEME_ID;
      activeId = null;
      savedCustomId = saved;
    } else if (saved === "native-light" || saved === "native-dark") {
      themeId = DEFAULT_THEME_ID;
      activeId = null;
      savedNativeMode = saved === "native-dark" ? "dark" : "light";
    } else {
      themeId = saved ?? DEFAULT_THEME_ID;
    }
  }
  let selected = themes.find((theme) => theme.id === themeId);
  if (!selected) {
    if (args.theme) throw new Error(`找不到主题：${themeId}`);
    // 记住的主题已不存在：回退默认
    themeId = DEFAULT_THEME_ID;
    selected = themes.find((theme) => theme.id === themeId);
    if (!selected) throw new Error(`找不到主题：${themeId}`);
  }
  // 选中主题必须加载成功（失败直接抛出）；其余主题并发加载，坏主题不阻塞换肤、只是不进菜单。
  // allSettled 保序，菜单顺序与 listThemes 排序一致。
  // 透传 listThemes 已解析的 rawManifest（非枚举属性）：loadTheme 据此跳过第二次
  // readFile + JSON.parse——65 个主题原本要读 130 次 theme.json，一半是重复的
  const loadedTheme = await deps.loadTheme(selected.path, selected.rawManifest);
  const settled = await Promise.allSettled(
    themes.map((theme) =>
      theme.id === themeId ? loadedTheme : deps.loadTheme(theme.path, theme.rawManifest)),
  );
  const menuThemes = settled.filter(({ status }) => status === "fulfilled").map(({ value }) => value);
  const result = await deps.applySkin({ loadedTheme, themes: menuThemes, port, activeId });
  if (savedCustomId) {
    await deps.activateSavedSkin({ port, id: savedCustomId, fallbackId: themeId });
    result.themeId = savedCustomId;
    result.restored = true;
  }
  if (savedNativeMode) {
    await deps.activateSavedNative({ port, mode: savedNativeMode });
    result.themeId = savedNativeMode === "dark" ? "native-dark" : "native-light";
    result.restored = true;
  }
  await recordState(deps, {
    lastApply: {
      at: new Date().toISOString(),
      ok: true,
      port,
      themeId: result.themeId,
      restored: result.restored === true,
      applied: result.applied,
      videoWarnings: result.videoWarnings?.length ?? 0,
      themeWarnings: result.themeWarnings?.length ?? 0,
    },
  });
  return result;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  runCli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`WorkBuddy Skins：${error.message}\n`);
      process.exitCode = 1;
    });
}
