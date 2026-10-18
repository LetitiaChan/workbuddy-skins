import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import { IMAGE_EXTENSIONS, MAX_ANIMATED_DIMENSION, THEME_SCHEMA_VERSION } from "./constants.mjs";
import { DEFAULT_COLORS } from "./color.mjs";
import { probeAnimatedSize } from "./media-probe.mjs";

// createSingleImageTheme 原子写入用的临时目录后缀；listThemes 据此跳过残留的半成品
const TEMP_DIR_MARKER = ".tmp-";

function slugify(value) {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "custom-skin";
}

export async function createSingleImageTheme({ imagePath, name: rawName, storeRoot, colors = {} }) {
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) throw new Error("主题名称不能为空");
  const extension = extname(imagePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    throw new Error("素材必须是 PNG、JPG、JPEG、WebP、GIF 或 AVIF 图片");
  }
  const source = await stat(imagePath);
  if (!source.isFile() || source.size === 0) throw new Error("素材图片不存在或为空");

  const animatedSize = await probeAnimatedSize(imagePath, extension);
  if (animatedSize && Math.max(animatedSize.width, animatedSize.height) > MAX_ANIMATED_DIMENSION) {
    throw new Error(
      `动图分辨率过高（${animatedSize.width}×${animatedSize.height}，最长边限 ${MAX_ANIMATED_DIMENSION}px），请缩小尺寸后再试`,
    );
  }

  const digest = createHash("sha256")
    .update(`${name}\0${basename(imagePath)}\0${source.size}\0${source.mtimeMs}`)
    .digest("hex")
    .slice(0, 8);
  const id = `${slugify(name)}-${digest}`;
  const destination = join(storeRoot, id);
  const temporary = `${destination}${TEMP_DIR_MARKER}${process.pid}`;
  const hero = `hero${extension}`;
  const manifest = {
    schemaVersion: THEME_SCHEMA_VERSION,
    id,
    name,
    hero,
    colors: {
      // 缺省四色统一自 color.mjs，不再内联字面量（曾与 theme-schema 的默认值分叉）
      accent: colors.accent ?? DEFAULT_COLORS.accent,
      secondary: colors.secondary ?? DEFAULT_COLORS.secondary,
      surface: colors.surface ?? DEFAULT_COLORS.surface,
      text: colors.text ?? DEFAULT_COLORS.text,
    },
    copy: null,
  };

  await mkdir(storeRoot, { recursive: true });
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    await copyFile(imagePath, join(temporary, hero));
    await writeFile(join(temporary, "theme.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await rm(destination, { recursive: true, force: true });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return { id, path: destination, manifest };
}

// theme.json 解析缓存，键为绝对路径，用 mtimeMs + size 做失效判定。
// 一次 CLI 调用里 listThemes 会被 apply / doctor 各走一遍（见 cli 的 Promise.all），
// 65 个主题每轮就是 65 次 readFile + 65 次 JSON.parse；文件没动时纯属重复。
// 刻意不设容量上限：键数等于主题目录数（几十个量级），且 CLI 是短生命周期进程。
// mtimeMs 与 size 同时比对，规避某些文件系统 mtime 精度只到秒、同秒内改动不被察觉。
const manifestCache = new Map();

async function readManifest(dir) {
  const file = join(dir, "theme.json");
  const info = await stat(file);
  const cached = manifestCache.get(file);
  if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached.manifest;
  }
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifestCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, manifest });
  return manifest;
}

// 返回 { manifests, errors }：坏 theme.json 不再静默消失。
// 旧实现对解析异常一律 return null，用户看到的只是「主题从列表里不见了」——
// 没有日志、没有 warning、doctor 也不报告，少一个逗号就得靠肉眼翻目录。
// 现在把失败原因收集起来交给上层（list/doctor）展示，列表本身仍然容错不中断。
async function readRootManifests(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { manifests: [], errors: [] };
    throw error;
  }
  const results = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.includes(TEMP_DIR_MARKER))
      .map(async (entry) => {
        const path = join(root, entry.name);
        try {
          const manifest = await readManifest(path);
          // 只做列表所需的最小校验（id 必须是字符串）；完整校验留给 loadTheme
          if (manifest === null || typeof manifest !== "object" || typeof manifest.id !== "string") {
            return { error: { path, reason: "theme.json 缺少字符串类型的 id" } };
          }
          const entryObj = { ...manifest, path };
          // 原始 manifest 挂非枚举属性：apply 路径紧接着要对每个主题调 loadTheme 做完整
          // 校验，透传这份已解析的对象可省掉第二次 readFile + JSON.parse（见 loadTheme 注释）。
          // 非枚举是为了不污染调用方的 map/JSON 序列化，也不与未来新增的 schema 字段撞名。
          Object.defineProperty(entryObj, "rawManifest", { value: manifest, enumerable: false });
          return { manifest: entryObj };
        } catch (error) {
          // 目录里没有 theme.json 属于正常情况（半拷贝中的文件夹、非主题目录），不报告；
          // 有文件但读不了/解析失败才是真问题（语法错误、权限、编码），必须浮出来
          if (error.code === "ENOENT") return {};
          return { error: { path, reason: error instanceof Error ? error.message : String(error) } };
        }
      }),
  );
  return {
    manifests: results.map((r) => r.manifest).filter(Boolean),
    errors: results.map((r) => r.error).filter(Boolean),
  };
}

// roots 按优先级排列（cli 传入 [内置, 用户]）：同 id 只保留第一个出现的，
// 否则重复 id 会进入菜单，行 Map 互相覆盖、切换命中错误主题。
// 返回数组（向后兼容既有调用方），坏主题清单挂在非枚举的 errors 属性上——
// 既不影响 map/filter/JSON 序列化，又让 list/doctor 能取到诊断信息。
export async function listThemes({ roots }) {
  const perRoot = await Promise.all(roots.map(readRootManifests));
  const seen = new Set();
  const themes = [];
  for (const manifest of perRoot.flatMap((r) => r.manifests)) {
    if (seen.has(manifest.id)) continue;
    seen.add(manifest.id);
    themes.push(manifest);
  }
  // order 字段可选：数值小的排前，缺省按 0 处理，同值再按名称 locale 排序
  // （name 缺失/非字符串时回退 id，避免 localeCompare 抛 TypeError 让整个 list 失败）
  const rank = (theme) => (Number.isFinite(theme.order) ? theme.order : 0);
  const label = (theme) => (typeof theme.name === "string" ? theme.name : theme.id);
  const sorted = themes.sort((a, b) => rank(a) - rank(b) || label(a).localeCompare(label(b)));
  Object.defineProperty(sorted, "errors", {
    value: perRoot.flatMap((r) => r.errors),
    enumerable: false,
  });
  return sorted;
}
