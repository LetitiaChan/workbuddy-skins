import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MENU_INJECT_TIMEOUT_MS } from "../src/constants.mjs";
import {
  activateSavedNative,
  activateSavedSkin,
  applySkin,
  readSavedActiveSkin,
  removeSkin,
  skinStatus,
  uploadRendererVideo,
} from "../src/injector.mjs";
// doctor 兼容性探测已拆到 compat-probe.mjs（与注入编排零耦合），测试随之改导入源
import { probeRendererCompat, summarizeCompatProbes } from "../src/compat-probe.mjs";
import { loadTheme } from "../src/theme-schema.mjs";

// 假 CDP Session：按表达式特征分流返回值，并记录完整调用序列
class FakeSession {
  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.calls = [];
    this.callOptions = [];
    this.closed = false;
  }

  async open() {
    if (this.options.failOpen) throw new Error("connect refused");
  }

  close() {
    this.closed = true;
  }

  async evaluate(expression, options = {}) {
    this.calls.push(expression);
    this.callOptions.push(options);
    if (this.options.failEvaluate) throw new Error("renderer navigated");
    if (this.options.failVideo && expression.includes('objectStore("videos")')) throw new Error("video timed out");
    // rendererVideoSize：读 IndexedDB 里已存视频的字节数
    if (expression.includes('objectStore("videos").get(')) return this.options.storedSize ?? 0;
    // uploadRendererVideo 收尾：返回写入 Blob 的大小
    if (expression.includes("return blob.size")) return this.options.blobSize ?? 0;
    return true;
  }

  chunkPushes() {
    return this.calls.filter((call) => typeof call === "string" && call.includes("push(arr)")).length;
  }

  lastCall() {
    return this.calls.at(-1);
  }
}

// Session 工厂：收集实例，支持按 url 注入失败
function sessionFactory(options = {}, { failUrls = new Set() } = {}) {
  const sessions = [];
  class Session extends FakeSession {
    constructor(url) {
      super(url, failUrls.has(url) ? { failEvaluate: true } : options);
      sessions.push(this);
    }
  }
  return { Session, sessions };
}

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "wss-injector-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const target = (id) => ({ id, webSocketDebuggerUrl: `ws://127.0.0.1:9223/${id}` });

test("uploadRendererVideo：按 4MB 分块，写入大小一致后清理暂存", async () => {
  const bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 1); // 4MB + 1B → 2 块
  const session = new FakeSession("ws://127.0.0.1:9223/x", { blobSize: bytes.length });
  await uploadRendererVideo(session, "demo", bytes);
  assert.equal(session.chunkPushes(), 2);
  assert.ok(session.lastCall().includes("delete window.__wbSkinVideoUpload"));
});

test("uploadRendererVideo：写入大小不符时抛错，且仍清理暂存", async () => {
  const bytes = Buffer.alloc(16, 1);
  const session = new FakeSession("ws://127.0.0.1:9223/x", { blobSize: 8 });
  await assert.rejects(uploadRendererVideo(session, "demo", bytes), /大小不符/);
  assert.ok(session.lastCall().includes("delete window.__wbSkinVideoUpload"));
});

test("uploadRendererVideo：优先原生 Uint8Array.fromBase64，带 atob 回退与主线程让出", async () => {
  const bytes = Buffer.alloc(16, 1);
  const session = new FakeSession("ws://127.0.0.1:9223/x", { blobSize: bytes.length });
  await uploadRendererVideo(session, "demo", bytes);
  const chunkCall = session.calls.find((call) => typeof call === "string" && call.includes("push(arr)"));
  assert.ok(chunkCall.includes("Uint8Array.fromBase64"));
  assert.ok(chunkCall.includes("atob("));
  assert.ok(chunkCall.includes("setTimeout(resolve, 0)"));
});

// applySkin 的最小依赖：一个视频主题 + 一个图片主题，临时目录内真实文件
async function withThemes(fn) {
  return withTempDir(async (dir) => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(join(dir, "hero.png"), png);
    await writeFile(join(dir, "poster.png"), png);
    await writeFile(join(dir, "hero.mp4"), Buffer.alloc(1024, 7));
    const image = { manifest: { id: "img", name: "Img", colors: {} }, heroPath: join(dir, "hero.png"), posterPath: null };
    const video = { manifest: { id: "vid", name: "Vid", colors: {} }, heroPath: join(dir, "hero.mp4"), posterPath: join(dir, "poster.png") };
    return fn({ image, video });
  });
}

// 视频预置的覆盖面：原先这 5 个场景测的是 ensureRendererVideos，但那个函数虽 export
// 却零生产调用——applySkin 内联复刻了它的逻辑且失败策略不同（它放弃，applySkin 关会话重建
// 后重试）。即测试在验证一条没人走的路。现已删除死代码，改为对 applySkin 的真实路径断言。
test("applySkin：渲染进程已有同尺寸视频时跳过上传（stat 判重）", async () => {
  await withThemes(async ({ image, video }) => {
    const { Session, sessions } = sessionFactory({ storedSize: 1024 });
    const result = await applySkin({
      loadedTheme: image,
      themes: [image, video],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    assert.deepEqual(result.videoWarnings, []);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].chunkPushes(), 0, "尺寸一致应完全跳过分块上传");
  });
});

test("applySkin：渲染进程视频尺寸不一致时执行分块上传", async () => {
  await withThemes(async ({ image, video }) => {
    const { Session, sessions } = sessionFactory({ storedSize: 0, blobSize: 1024 });
    const result = await applySkin({
      loadedTheme: image,
      themes: [image, video],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    assert.deepEqual(result.videoWarnings, []);
    assert.equal(sessions[0].chunkPushes(), 1);
  });
});

test("applySkin：本地视频文件缺失时降级为警告，菜单照常注入", async () => {
  await withThemes(async ({ image }) => {
    const brokenVideo = {
      manifest: { id: "vid", name: "Vid", colors: {} },
      heroPath: join(tmpdir(), "wss-no-such-file.mp4"),
      posterPath: image.heroPath,
    };
    const { Session, sessions } = sessionFactory();
    const result = await applySkin({
      loadedTheme: image,
      themes: [image, brokenVideo],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    assert.equal(result.videoWarnings.length, 1);
    assert.match(result.videoWarnings[0], /读取内置视频文件失败/);
    // 视频失败不阻塞主流程：菜单仍要注入成功
    assert.equal(result.applied, 1);
    assert.ok(sessions[0].lastCall().includes("__workbuddySkinTeardown"));
  });
});

test("applySkin：无视频主题时不发起任何 IndexedDB 调用，只注入菜单", async () => {
  await withThemes(async ({ image }) => {
    const { Session, sessions } = sessionFactory();
    const result = await applySkin({
      loadedTheme: image,
      themes: [image],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    assert.deepEqual(result.videoWarnings, []);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].calls.length, 1, "应只有菜单注入这一次 evaluate");
    assert.ok(sessions[0].calls[0].includes("__workbuddySkinTeardown"));
  });
});

test("applySkin：每个 target 一条会话，视频预置与菜单注入复用同一连接", async () => {
  await withThemes(async ({ image, video }) => {
    const { Session, sessions } = sessionFactory({ storedSize: 1024 });
    const result = await applySkin({
      loadedTheme: image,
      themes: [image, video],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1"), target("t2")] },
    });
    assert.equal(result.applied, 2);
    assert.deepEqual(result.menuThemes, ["img", "vid"]);
    assert.deepEqual(result.videoWarnings, []);
    assert.equal(sessions.length, 2);
    for (const session of sessions) {
      assert.ok(session.calls[0].includes('objectStore("videos").get('));
      assert.ok(session.lastCall().includes("__workbuddySkinTeardown"));
      assert.ok(session.closed);
    }
  });
});

test("applySkin：菜单注入显式给足超时预算（MB 级表达式不能走 CDP 默认 5s）", async () => {
  await withThemes(async ({ image, video }) => {
    const { Session, sessions } = sessionFactory({ storedSize: 1024 });
    await applySkin({
      loadedTheme: image,
      themes: [image, video],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    const session = sessions[0];
    // 菜单注入是最后一次 evaluate（teardown 全局名是其特征）
    const menuIdx = session.calls.findLastIndex((c) => c.includes("__workbuddySkinTeardown"));
    assert.ok(menuIdx >= 0, "应有菜单注入调用");
    assert.equal(
      session.callOptions[menuIdx]?.timeoutMs,
      MENU_INJECT_TIMEOUT_MS,
      `菜单注入须显式传 timeoutMs=${MENU_INJECT_TIMEOUT_MS}，实际 ${JSON.stringify(session.callOptions[menuIdx])}`,
    );
    assert.ok(MENU_INJECT_TIMEOUT_MS >= 30_000, "预算应不低于 30s");
  });
});

test("applySkin：视频预置失败只记警告，换新连接后照常注入菜单", async () => {
  await withThemes(async ({ image, video }) => {
    let created = 0;
    const sessions = [];
    class Session extends FakeSession {
      constructor(url) {
        // 第一条连接视频阶段失败，其后的连接正常
        super(url, created++ === 0 ? { failVideo: true } : { storedSize: 1024 });
        sessions.push(this);
      }
    }
    const result = await applySkin({
      loadedTheme: image,
      themes: [image, video],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    assert.equal(result.applied, 1);
    assert.equal(result.videoWarnings.length, 1);
    assert.match(result.videoWarnings[0], /video timed out/);
    assert.equal(sessions.length, 2);
    assert.ok(sessions[0].closed);
    assert.ok(sessions[1].lastCall().includes("__workbuddySkinTeardown"));
  });
});

test("applySkin：非选中主题构建条目失败只记警告不进菜单，不阻塞换肤", async () => {
  await withThemes(async ({ image }) => {
    const broken = { manifest: { id: "broken", name: "Broken", colors: {} }, heroPath: join(tmpdir(), "wss-no-such-hero.png"), posterPath: null };
    const { Session } = sessionFactory();
    const result = await applySkin({
      loadedTheme: image,
      themes: [image, broken],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    assert.equal(result.applied, 1);
    assert.deepEqual(result.menuThemes, ["img"], "坏主题不进菜单");
    assert.equal(result.videoWarnings.length, 0);
    assert.equal(result.themeWarnings.length, 1);
    assert.match(result.themeWarnings[0], /broken/);
  });
});

test("applySkin：选中主题构建条目失败时抛原始错误（而非模糊的「不在菜单列表中」）", async () => {
  await withThemes(async ({ image }) => {
    const broken = { manifest: { id: "img", name: "Img", colors: {} }, heroPath: join(tmpdir(), "wss-no-such-hero.png"), posterPath: null };
    const { Session } = sessionFactory();
    await assert.rejects(
      applySkin({
        loadedTheme: broken,
        themes: [image, broken],
        port: 9223,
        deps: { Session, waitForRendererTargets: async () => [target("t1")] },
      }),
      /ENOENT/,
    );
  });
});

test("removeSkin：先调菜单 teardown 再移除节点，并发处理所有 target", async () => {
  const { Session, sessions } = sessionFactory();
  const result = await removeSkin({
    port: 9223,
    deps: { Session, fetchRendererTargets: async () => [target("t1"), target("t2")] },
  });
  assert.deepEqual(result, { removed: 2 });
  for (const session of sessions) {
    const expression = session.lastCall();
    assert.ok(expression.indexOf("__workbuddySkinTeardown") < expression.indexOf(".remove()"));
  }
});

test("removeSkin：单个 target 失败不拖垮整批，removed 只计成功数", async () => {
  const { Session } = sessionFactory({}, { failUrls: new Set(["ws://127.0.0.1:9223/t1"]) });
  const result = await removeSkin({
    port: 9223,
    deps: { Session, fetchRendererTargets: async () => [target("t1"), target("t2")] },
  });
  assert.deepEqual(result, { removed: 1 });
});

test("applySkin：CSS 主题资源内联为 data URL，菜单分组为 custom", async () => {
  await withTempDir(async (dir) => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(join(dir, "logo.png"), png);
    await writeFile(
      join(dir, "skin.css"),
      'a { background: url("./logo.png"); } b { background: url( ./logo.png ); } c { background: url("https://x.test/y.png"); }',
    );
    const cssTheme = {
      manifest: { id: "css-theme", name: "CSS", colors: { accent: "#5141F2", surface: "#F5F6F8" } },
      cssPath: join(dir, "skin.css"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session, sessions } = sessionFactory();
    const result = await applySkin({
      loadedTheme: cssTheme,
      themes: [cssTheme],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    assert.equal(result.applied, 1);
    const expression = sessions[0].lastCall();
    assert.ok(expression.includes("data:image/png;base64"), "应内联 PNG 为 data URL");
    assert.ok(!expression.includes('url("./logo.png")'), "相对引用应全部被重写");
    assert.ok(expression.includes("https://x.test/y.png"), "绝对 URL 应原样保留");
    assert.ok(expression.includes('"group":"custom"'), "CSS 主题应标记为定制主题分组");
    assert.equal(sessions[0].calls.filter((call) => call.includes('objectStore("videos")')).length, 0, "无视频主题不应触碰 IndexedDB");
  });
});

test("applySkin：图片主题配置 mascot 时内联挂件图并拼接成长伙伴替换规则", async () => {
  await withTempDir(async (dir) => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(join(dir, "hero.png"), png);
    await writeFile(join(dir, "mascot.webp"), Buffer.from("mascot-bytes"));
    const imageTheme = {
      manifest: { id: "img", name: "Img", colors: {} },
      heroPath: join(dir, "hero.png"),
      posterPath: null,
      mascotPath: join(dir, "mascot.webp"),
      root: dir,
    };
    const { Session, sessions } = sessionFactory();
    const result = await applySkin({
      loadedTheme: imageTheme,
      themes: [imageTheme],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    assert.equal(result.applied, 1);
    const expression = sessions[0].lastCall();
    assert.ok(expression.includes("growth-buddy"), "注入 CSS 应含成长伙伴槽位规则");
    assert.ok(expression.includes(`data:image/webp;base64,${Buffer.from("mascot-bytes").toString("base64")}`), "挂件图应内联为 data URL");
    assert.ok(expression.includes("object-fit: contain !important"));
  });
});

test("applySkin：CSS 主题 manifest.group 为 palette 时前置拼接换色基座，菜单分组透传", async () => {
  await withTempDir(async (dir) => {
    // palette 主题的 skin.css 只是装饰层（签名渐变），基座由 buildPaletteCss 生成
    await writeFile(join(dir, "skin.css"), ".wb-home-route { background-image: linear-gradient(#000, #111) !important; }");
    const paletteTheme = {
      manifest: { id: "focus-night", name: "Focus Night", group: "palette", colors: { accent: "#67E8F9", secondary: "#2563EB", surface: "#090D13", text: "#EDF4FF" } },
      cssPath: join(dir, "skin.css"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session, sessions } = sessionFactory();
    const result = await applySkin({
      loadedTheme: paletteTheme,
      themes: [paletteTheme],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    assert.equal(result.applied, 1);
    const expression = sessions[0].lastCall();
    assert.ok(expression.includes('"group":"palette"'), "palette 分组应透传进菜单脚本");
    // 基座在前、装饰层在后（后者依赖前者定义的 --wb-surface 与覆盖顺序）
    const baseAt = expression.indexOf("WORKBUDDY_PALETTE:focus-night");
    const decorationAt = expression.indexOf(".wb-home-route { background-image:");
    assert.ok(baseAt >= 0, "注入 CSS 应含生成的配色基座");
    assert.ok(decorationAt > baseAt, "装饰层应拼在基座之后");
    // 基座核心：--cb-* 变量覆盖按 theme.json colors 取色
    assert.ok(expression.includes("--wb-accent: #67E8F9"));
    assert.ok(expression.includes("--cb-bg-primary: var(--wb-surface) !important"));
  });
});

test("applySkin：签名配色主题（signature，无 css 无 hero）基座+装饰层全由数据渲染", async () => {
  await withTempDir(async (dir) => {
    // 第三形态：cssPath/heroPath 均为 null，装饰层由 buildSignatureCss 按 signature 渲染
    const sigTheme = {
      manifest: {
        id: "focus-night",
        name: "Focus Night",
        group: "palette",
        colors: { accent: "#67E8F9", secondary: "#2563EB", surface: "#090D13", text: "#EDF4FF" },
        copy: { tagline: "夜色专注，心无旁骛" },
        signature: { blobs: [{ color: "accent", shape: "circle", x: 82, y: 12, alpha: 0.22, radius: 40 }] },
      },
      cssPath: null,
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session, sessions } = sessionFactory();
    const result = await applySkin({
      loadedTheme: sigTheme,
      themes: [sigTheme],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    assert.equal(result.applied, 1);
    const expression = sessions[0].lastCall();
    assert.ok(expression.includes('"group":"palette"'), "palette 分组应透传进菜单脚本");
    // 基座在前、签名装饰层在后（后者依赖前者的 --wb-surface 与覆盖顺序）
    const baseAt = expression.indexOf("WORKBUDDY_PALETTE:focus-night");
    const signatureAt = expression.indexOf("[data-view-id=main-content]");
    assert.ok(baseAt >= 0, "注入 CSS 应含生成的配色基座");
    assert.ok(signatureAt > baseAt, "签名装饰层应拼在基座之后");
    // 装饰层内容：槽引用解为字面值（accent #67E8F9 → 103,232,249）
    assert.ok(expression.includes("radial-gradient(circle at 82% 12%, rgba(103, 232, 249, 0.22), transparent 40%)"));
    // 侧边栏晕染随装饰层一起渲染
    assert.ok(expression.includes("[data-view-id=sidebar]"));
    // tagline 直接追加（生成物不可能自带 ::after，无需跳过检测）
    assert.ok(expression.includes(".wb-home-header::after"), "tagline 标语应追加");
    // 无 heroPath 也不掉进 hero 分支报错
  });
});

test("applySkin：baseTheme 继承主题的 css/js 资源以文件所在目录（base 目录）为基准内联", async () => {
  await withTempDir(async (dir) => {
    // base 主题持有 skin.css/skin.js 与它们引用的 ./asset；子主题只有 theme.json
    const baseDir = join(dir, "base-theme");
    const childDir = join(dir, "child-theme");
    await mkdir(baseDir, { recursive: true });
    await mkdir(childDir);
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(join(baseDir, "logo.png"), png);
    await writeFile(join(baseDir, "skin.css"), 'a { background: url("./logo.png"); }');
    await writeFile(join(baseDir, "skin.js"), 'const p = "./logo.png"; return null;');
    await writeFile(
      join(baseDir, "theme.json"),
      JSON.stringify({ schemaVersion: 1, id: "base-theme", name: "Base", css: "skin.css", js: "skin.js" }),
    );
    await writeFile(
      join(childDir, "theme.json"),
      JSON.stringify({ schemaVersion: 1, id: "child-theme", name: "Child", baseTheme: "base-theme", colors: { surface: "#0A1426" } }),
    );
    const child = await loadTheme(childDir);
    assert.ok(child.cssPath.startsWith(baseDir), "css 应解析进 base 目录");
    const { Session, sessions } = sessionFactory();
    const result = await applySkin({
      loadedTheme: child,
      themes: [child],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    assert.equal(result.applied, 1);
    const expression = sessions[0].lastCall();
    // css 与 js 里的 ./logo.png 都以 base 目录为基准内联成 data URL
    const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
    assert.ok(expression.includes(dataUrl), "base 目录的引用资源应内联为 data URL");
    assert.ok(!expression.includes('url("./logo.png")'), "css 相对引用应全部被重写");
    assert.ok(expression.includes('"surface":"#0A1426"'), "子主题配色应透传进菜单脚本");
  });
});

test("applySkin：CSS 主题配置 copy.tagline 时追加自包含标语块（var 回退字面色值）", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), ".wb-home-route { background: red; }");
    const cssTheme = {
      manifest: {
        id: "scenery",
        name: "Scenery",
        group: "scenery",
        colors: { accent: "#15D4B4", secondary: "#253B5B" },
        copy: { tagline: "极光漫卷" },
      },
      cssPath: join(dir, "skin.css"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session, sessions } = sessionFactory();
    await applySkin({
      loadedTheme: cssTheme,
      themes: [cssTheme],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    const expression = sessions[0].lastCall();
    assert.ok(expression.includes(".wb-home-header::after"), "应追加标语块");
    // 菜单脚本 JSON 序列化后 css 内双引号转义为 \"
    assert.ok(expression.includes('content: \\"极光漫卷\\"'), "标语文本应内联");
    assert.ok(expression.includes("var(--wb-accent, #15D4B4)"), "无 --wb-* 变量时应回退 colors 字面色值");
  });
});

test("applySkin：CSS 主题 skin.css 已自带 .wb-home-header::after 标语时跳过追加", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), '.wb-home-header::after { content: "与开发者共鸣 · 与云端共生"; }');
    const cssTheme = {
      manifest: {
        id: "tdp-pro",
        name: "TDP",
        group: "custom",
        colors: { accent: "#5141F2", secondary: "#7C3AED" },
        copy: { tagline: "云端专业" },
      },
      cssPath: join(dir, "skin.css"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session, sessions } = sessionFactory();
    await applySkin({
      loadedTheme: cssTheme,
      themes: [cssTheme],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    const expression = sessions[0].lastCall();
    assert.ok(expression.includes("与开发者共鸣 · 与云端共生"), "应保留 skin.css 自带的硬编码标语");
    assert.ok(!expression.includes("云端专业"), "已自带 ::after 标语的主题不应被 copy.tagline 覆盖");
  });
});

test("applySkin：CSS 主题引用逃逸主题目录的资源时拒绝", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), 'a { background: url("./../outside.png"); }');
    const cssTheme = {
      manifest: { id: "evil", name: "Evil", colors: {} },
      cssPath: join(dir, "skin.css"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session } = sessionFactory();
    await assert.rejects(
      applySkin({
        loadedTheme: cssTheme,
        themes: [cssTheme],
        port: 9223,
        deps: { Session, waitForRendererTargets: async () => [target("t1")] },
      }),
      /逃逸主题目录/,
    );
  });
});

test("applySkin：CSS 主题引用不支持的资源类型时拒绝", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), 'a { src: url("./font.exe"); }');
    await writeFile(join(dir, "font.exe"), Buffer.alloc(4, 1));
    const cssTheme = {
      manifest: { id: "bad-asset", name: "Bad", colors: {} },
      cssPath: join(dir, "skin.css"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session } = sessionFactory();
    await assert.rejects(
      applySkin({
        loadedTheme: cssTheme,
        themes: [cssTheme],
        port: 9223,
        deps: { Session, waitForRendererTargets: async () => [target("t1")] },
      }),
      /不支持的资源类型/,
    );
  });
});

test("applySkin：CSS 主题的伴随 JS 透传进菜单脚本，相对资源内联为 data URL", async () => {
  await withTempDir(async (dir) => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    await writeFile(join(dir, "hero.webp"), png);
    await writeFile(join(dir, "skin.css"), "body { color: red; }");
    await writeFile(join(dir, "skin.js"), 'const img = "./hero.webp"; return () => {};');
    const cssTheme = {
      manifest: { id: "css-js", name: "CssJs", colors: { accent: "#5141F2", surface: "#F5F6F8" } },
      cssPath: join(dir, "skin.css"),
      jsPath: join(dir, "skin.js"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session, sessions } = sessionFactory();
    await applySkin({
      loadedTheme: cssTheme,
      themes: [cssTheme],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    const expression = sessions[0].lastCall();
    assert.ok(expression.includes("data:image/webp;base64"), "js 内相对资源应内联为 data URL");
    assert.ok(!expression.includes('"./hero.webp"'), "js 内相对引用应全部被重写");
    assert.ok(expression.includes("runThemeJs"), "菜单脚本应包含伴随 JS 执行逻辑");
  });
});

test("applySkin：伴随 JS 引用逃逸主题目录的资源时拒绝", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), "body { color: red; }");
    await writeFile(join(dir, "skin.js"), 'const img = "../outside.webp"; return () => {};');
    const cssTheme = {
      manifest: { id: "evil-js", name: "EvilJs", colors: {} },
      cssPath: join(dir, "skin.css"),
      jsPath: join(dir, "skin.js"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session } = sessionFactory();
    await assert.rejects(
      applySkin({
        loadedTheme: cssTheme,
        themes: [cssTheme],
        port: 9223,
        deps: { Session, waitForRendererTargets: async () => [target("t1")] },
      }),
      /逃逸主题目录/,
    );
  });
});

test("applySkin：伴随 JS 内联音频资源（wav → audio/wav，mp3 → audio/mpeg）", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "a.wav"), Buffer.alloc(8, 2));
    await writeFile(join(dir, "b.mp3"), Buffer.alloc(8, 3));
    await writeFile(join(dir, "skin.css"), "body { color: red; }");
    await writeFile(join(dir, "skin.js"), 'const a = new Audio("./a.wav"); const b = new Audio("./b.mp3"); return () => {};');
    const cssTheme = {
      manifest: { id: "qq-like", name: "QQ", colors: {} },
      cssPath: join(dir, "skin.css"),
      jsPath: join(dir, "skin.js"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session, sessions } = sessionFactory();
    await applySkin({
      loadedTheme: cssTheme,
      themes: [cssTheme],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    const expression = sessions[0].lastCall();
    assert.ok(expression.includes("data:audio/wav;base64"));
    assert.ok(expression.includes("data:audio/mpeg;base64"));
    assert.ok(!expression.includes('"./a.wav"') && !expression.includes('"./b.mp3"'));
  });
});

test("applySkin：theme.json thumbnail 内联为 data URL 随条目下发（thumb 字段）", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), "a { color: red; }");
    await writeFile(join(dir, "thumb.webp"), Buffer.from("RIFFxxxxWEBP"));
    const cssTheme = {
      manifest: { id: "css-theme", name: "CSS", colors: { accent: "#5141F2", surface: "#F5F6F8" } },
      cssPath: join(dir, "skin.css"),
      thumbnailPath: join(dir, "thumb.webp"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session, sessions } = sessionFactory();
    await applySkin({
      loadedTheme: cssTheme,
      themes: [cssTheme],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    const expression = sessions[0].lastCall();
    const expected = `"thumb":"data:image/webp;base64,${Buffer.from("RIFFxxxxWEBP").toString("base64")}"`;
    assert.ok(expression.includes(expected), "条目应携带 thumbnail data URL");
  });
});

test("applySkin：theme.json mascot 内联为 data URL 拼入条目 css（growth-buddy 替换规则）", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), "a { color: red; }");
    await writeFile(join(dir, "mascot.webp"), Buffer.from("RIFFxxxxWEBP"));
    const mascotDataUrl = `data:image/webp;base64,${Buffer.from("RIFFxxxxWEBP").toString("base64")}`;
    const cssTheme = {
      manifest: { id: "css-theme", name: "CSS", colors: { accent: "#5141F2", surface: "#F5F6F8" } },
      cssPath: join(dir, "skin.css"),
      mascotPath: join(dir, "mascot.webp"),
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session, sessions } = sessionFactory();
    await applySkin({
      loadedTheme: cssTheme,
      themes: [cssTheme],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    const expression = sessions[0].lastCall();
    // 菜单脚本 JSON 序列化后 css 内的双引号转义为 \"
    assert.ok(expression.includes(".wb-home-route__growth-buddy"), "条目 css 应含 growth-buddy 槽位选择器");
    assert.ok(
      expression.includes(`content: url(\\"${mascotDataUrl}\\")`),
      "条目 css 应内联 mascot data URL",
    );
  });
});

test("applySkin：未配置 mascot 的条目 css 不含 growth-buddy 替换规则（原生机器人保留）", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "skin.css"), "a { color: red; }");
    const cssTheme = {
      manifest: { id: "css-theme", name: "CSS", colors: { accent: "#5141F2", surface: "#F5F6F8" } },
      cssPath: join(dir, "skin.css"),
      mascotPath: null,
      root: dir,
      heroPath: null,
      posterPath: null,
    };
    const { Session, sessions } = sessionFactory();
    await applySkin({
      loadedTheme: cssTheme,
      themes: [cssTheme],
      port: 9223,
      deps: { Session, waitForRendererTargets: async () => [target("t1")] },
    });
    const expression = sessions[0].lastCall();
    assert.ok(!expression.includes("growth-buddy"), "未配置 mascot 时不应输出替换规则");
  });
});

// ---- 轻量表达式（status / 读取 / 激活）：按 url 分派返回值的 Session ----

function valueSession(valuesByUrl) {
  const sessions = [];
  class Session {
    constructor(url) {
      this.url = url;
      this.calls = [];
      sessions.push(this);
    }
    async open() {}
    close() {
      this.closed = true;
    }
    async evaluate(expression) {
      this.calls.push(expression);
      return valuesByUrl.get(this.url);
    }
  }
  return { Session, sessions };
}

const lightTargets = [target("a"), target("b")];
const fetchLight = async () => lightTargets;

test("skinStatus：逐 target 汇总状态，表达式同时探测 style/menu 节点与主题 id", async () => {
  const { Session, sessions } = valueSession(
    new Map([
      ["ws://127.0.0.1:9223/a", { installed: true, menu: true, themeId: "miku-light" }],
      ["ws://127.0.0.1:9223/b", { installed: false, menu: false, themeId: null }],
    ]),
  );
  const result = await skinStatus({ port: 9223, deps: { fetchRendererTargets: fetchLight, Session } });
  assert.deepEqual(result, [
    { installed: true, menu: true, themeId: "miku-light" },
    { installed: false, menu: false, themeId: null },
  ]);
  assert.equal(sessions.length, 2);
  const expression = sessions[0].calls[0];
  assert.ok(expression.includes('getElementById("workbuddy-skin-style")'));
  assert.ok(expression.includes('getElementById("workbuddy-skin-menu")'));
  assert.ok(expression.includes("dataset.workbuddySkin"));
});

test("readSavedActiveSkin：返回第一个非空字符串；全为空/非字符串时返回 null", async () => {
  const { Session } = valueSession(
    new Map([
      ["ws://127.0.0.1:9223/a", ""],
      ["ws://127.0.0.1:9223/b", "custom-xyz"],
    ]),
  );
  const deps = { fetchRendererTargets: fetchLight, Session };
  assert.equal(await readSavedActiveSkin({ port: 9223, deps }), "custom-xyz");

  const empty = valueSession(new Map([["ws://127.0.0.1:9223/a", null], ["ws://127.0.0.1:9223/b", ""]]));
  assert.equal(await readSavedActiveSkin({ port: 9223, deps: { fetchRendererTargets: fetchLight, Session: empty.Session } }), null);
});

test("readSavedActiveSkin：表达式带 try/catch，localStorage 不可用时不打断渲染进程", async () => {
  const { Session, sessions } = valueSession(new Map([["ws://127.0.0.1:9223/a", null]]));
  await readSavedActiveSkin({ port: 9223, deps: { fetchRendererTargets: async () => [target("a")], Session } });
  const expression = sessions[0].calls[0];
  assert.ok(expression.includes('localStorage.getItem("workbuddySkinActive")'));
  assert.ok(/try \{[\s\S]*?\} catch \{/.test(expression));
});

test("activateSavedSkin：表达式带 setTheme 兜底，activated 只计成功 target", async () => {
  const { Session, sessions } = valueSession(
    new Map([
      ["ws://127.0.0.1:9223/a", true],
      ["ws://127.0.0.1:9223/b", false], // 菜单脚本缺失（__workbuddySkin 不存在）返回 false
    ]),
  );
  const result = await activateSavedSkin({
    port: 9223,
    id: "custom-xyz",
    fallbackId: "miku-light",
    deps: { fetchRendererTargets: fetchLight, Session },
  });
  assert.deepEqual(result, { activated: 1 });
  const expression = sessions[0].calls[0];
  assert.ok(expression.includes('api.applyCustom("custom-xyz")'));
  // 皮肤已被删除时 applyCustom 静默失败，需回落内置主题避免停在无皮肤状态
  assert.ok(expression.includes('api.setTheme("miku-light")'));
});

test("activateSavedNative：表达式按 mode 钉明暗，activated 只计成功 target", async () => {
  const { Session, sessions } = valueSession(
    new Map([
      ["ws://127.0.0.1:9223/a", true],
      ["ws://127.0.0.1:9223/b", true],
    ]),
  );
  const result = await activateSavedNative({ port: 9223, mode: "dark", deps: { fetchRendererTargets: fetchLight, Session } });
  assert.deepEqual(result, { activated: 2 });
  assert.ok(sessions[0].calls[0].includes('api.setNative("dark")'));
});

// ---- doctor 适配预警：--cb-* 变量与 [data-view-id] 锚点探测 ----

test("probeRendererCompat：多 target 聚合（锚点并集、变量数取最大），齐全时 ok 且无警告", async () => {
  const { Session } = valueSession(
    new Map([
      ["ws://127.0.0.1:9223/a", { appMarker: "workbuddy", cbVarCount: 62, viewIds: ["sidebar", "main-content"] }],
      ["ws://127.0.0.1:9223/b", { appMarker: "workbuddy", cbVarCount: 60, viewIds: ["detail-panel"] }],
    ]),
  );
  const result = await probeRendererCompat({ port: 9223, deps: { fetchRendererTargets: fetchLight, Session } });
  assert.equal(result.reachable, true);
  assert.equal(result.targets, 2);
  assert.equal(result.ok, true);
  assert.equal(result.cbVarCount, 62);
  assert.deepEqual(result.viewIds, ["detail-panel", "main-content", "sidebar"]);
  assert.deepEqual(result.missingViewIds, []);
  assert.deepEqual(result.warnings, []);
});

test("probeRendererCompat：锚点缺失与变量缺失时给出大改版预警", async () => {
  const { Session } = valueSession(
    new Map([
      ["ws://127.0.0.1:9223/a", { appMarker: "workbuddy", cbVarCount: 12, missingCbVars: ["--cb-bg-primary", "--cb-hover-bg"], viewIds: ["sidebar"] }],
      ["ws://127.0.0.1:9223/b", { appMarker: "workbuddy", cbVarCount: 10, missingCbVars: ["--cb-text-link"], viewIds: [] }],
    ]),
  );
  const result = await probeRendererCompat({ port: 9223, deps: { fetchRendererTargets: fetchLight, Session } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.missingViewIds, ["main-content", "detail-panel"]);
  // 缺失变量取命中数最高 target 的名单（12 > 10）
  assert.deepEqual(result.missingCbVars, ["--cb-bg-primary", "--cb-hover-bg"]);
  assert.equal(result.cbVarProbed, 14);
  assert.equal(result.warnings.length, 2);
  assert.ok(result.warnings.every((text) => text.includes("WorkBuddy 界面可能已大改版")));
  assert.ok(result.warnings.some((text) => text.includes("--cb-bg-primary")));
  assert.ok(result.warnings.some((text) => text.includes("main-content")));
});

test("probeRendererCompat：app 标记缺失时同样预警（变量覆盖块作用域失效）", async () => {
  const { Session } = valueSession(
    new Map([["ws://127.0.0.1:9223/a", { appMarker: null, cbVarCount: 60, viewIds: ["sidebar", "main-content", "detail-panel"] }]]),
  );
  const result = await probeRendererCompat({ port: 9223, deps: { fetchRendererTargets: async () => [target("a")], Session } });
  assert.equal(result.ok, false);
  assert.ok(result.warnings.some((text) => text.includes("data-application-name")));
});

test("probeRendererCompat：探测表达式先禁用皮肤样式再量测（测的是原生界面），按名单 getPropertyValue", async () => {
  const { Session, sessions } = valueSession(
    new Map([["ws://127.0.0.1:9223/a", { appMarker: "workbuddy", cbVarCount: 60, viewIds: ["sidebar", "main-content", "detail-panel"] }]]),
  );
  await probeRendererCompat({ port: 9223, deps: { fetchRendererTargets: async () => [target("a")], Session } });
  const expression = sessions[0].calls[0];
  assert.ok(expression.includes('getElementById("workbuddy-skin-style")'));
  assert.ok(expression.includes("style.disabled = true"));
  assert.ok(expression.includes("style.disabled = false"));
  assert.ok(expression.includes('getPropertyValue(name)'));
  assert.ok(expression.includes("--cb-team-member-card-background"));
});

test("probeRendererCompat：无渲染进程 target 时降级 reachable:false，不抛错", async () => {
  const result = await probeRendererCompat({ port: 9223, deps: { fetchRendererTargets: async () => [] } });
  assert.equal(result.reachable, false);
  assert.match(result.reason, /未发现渲染进程/);
});

test("summarizeCompatProbes：空结果与缺字段容忍", () => {
  const summary = summarizeCompatProbes([null, {}]);
  assert.equal(summary.ok, false);
  assert.equal(summary.cbVarCount, 0);
  assert.deepEqual(summary.missingViewIds, ["sidebar", "main-content", "detail-panel"]);
});
