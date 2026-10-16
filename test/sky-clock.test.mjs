import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// sky-clock 伴随 js 的引擎逻辑：以最小 DOM 桩在 Node 端跑真实代码，
// 验证变量写入、明暗判定、SVG 重建与 teardown 清理（1h 定时器必须可清除，否则测试进程悬挂）
const skinJs = await readFile(new URL("../themes/sky-clock/skin.js", import.meta.url), "utf8");

function makeEl() {
  const classes = new Set();
  return {
    dataset: {},
    style: {
      props: new Map(),
      setProperty(k, v) { this.props.set(k, v); },
      removeProperty(k) { this.props.delete(k); },
      colorScheme: "",
    },
    classList: {
      toggle(c, w) { if (w) classes.add(c); else classes.delete(c); },
      contains(c) { return classes.has(c); },
    },
  };
}

function installDomStubs() {
  const body = makeEl();
  const html = makeEl();
  const listeners = new Map();
  const saved = {
    document: globalThis.document,
    MutationObserver: globalThis.MutationObserver,
  };
  globalThis.document = {
    body,
    documentElement: html,
    hidden: false,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type) { listeners.delete(type); },
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() { this.disconnected = true; }
  };
  return {
    body,
    html,
    listeners,
    restore() {
      globalThis.document = saved.document;
      globalThis.MutationObserver = saved.MutationObserver;
    },
  };
}

test("sky-clock skin.js：激活即写入 --sky-* 变量与场景 SVG，明暗随天空亮度判定", () => {
  const dom = installDomStubs();
  try {
    const teardown = new Function(skinJs)();
    assert.equal(typeof teardown, "function", "必须返回拆除回调");
    // 九个变量全部写入
    for (const key of ["--sky-art", "--sky-top", "--sky-mid", "--sky-bot", "--sky-panel", "--sky-border", "--sky-shadow", "--sky-art-opacity", "--sky-scheme"]) {
      assert.ok(dom.body.style.props.has(key), `缺少变量 ${key}`);
    }
    // 场景 SVG 为内联 data URL，含天空渐变与山脊
    const art = dom.body.style.props.get("--sky-art");
    assert.ok(art.startsWith('url("data:image/svg+xml;charset=utf-8,'));
    const svg = decodeURIComponent(art.slice('url("data:image/svg+xml;charset=utf-8,'.length, -2));
    assert.ok(svg.includes('viewBox="0 0 1600 900"'));
    assert.ok(svg.includes("M0 600 Q280 520")); // 山脊轮廓参考 sakura.svg 三层山形
    // 明暗写入与 --sky-scheme 一致，类名/属性与菜单 writeMode 同构
    const dark = dom.body.dataset.vscodeThemeKind === "vscode-dark";
    assert.equal(dom.body.style.props.get("--sky-scheme"), dark ? "dark" : "light");
    assert.equal(dom.body.dataset.vscodeThemeName, dark ? "IDE Night" : "IDE Light");
    assert.equal(dom.body.classList.contains("dark"), dark);
    assert.equal(dom.html.classList.contains("vscode-light"), !dark);
    // 实况色调钩子：菜单弹窗打开时读它刷新背景/选中描边（取当前天空中间色）
    assert.match(dom.body.dataset.workbuddySkinTone ?? "", /^#[0-9a-f]{6}$/i);
    assert.equal(dom.body.dataset.workbuddySkinTone, dom.body.style.props.get("--sky-mid"));
    // 实况面板色钩子：弹窗背景取上方天空派生色（而非底部天际色）
    assert.match(dom.body.dataset.workbuddySkinSurface ?? "", /^#[0-9a-f]{6}$/i);
    teardown();
    assert.equal(dom.body.dataset.workbuddySkinTone, undefined, "teardown 应清除实况色调钩子");
    assert.equal(dom.body.dataset.workbuddySkinSurface, undefined, "teardown 应清除实况面板色钩子");
  } finally {
    dom.restore();
  }
});

test("sky-clock skin.js：深色时段所有原生中性灰令牌（画布系与卡片系）加同一色相偏移", () => {
  const dom = installDomStubs();
  const RealDate = globalThis.Date;
  const night = new RealDate(2026, 9, 15, 23, 0, 0).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [night])); }
    static now() { return night; }
  };
  // 原生令牌：画布系 #141414、卡片系 #1f1f1f、非中性/半透明/亮色/文字类不应被改写
  const native = {
    "--wb-home-bg-secondary": "#141414",
    "--wb-bg-primary": "#1f1f1f",
    "--cr-bg-canvas": "rgb(20, 20, 20)",
    "--wb-accent-bg": "#3a6fd8",
    "--wb-hover-bg": "#ffffff14",
    "--wb-card-light": "#e4e4e4",
    "--wb-text-strong": "#141414",
  };
  const names = Object.keys(native);
  globalThis.document.styleSheets = [{ ownerNode: {}, cssRules: [{ style: Object.assign([...names], {}) }] }];
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (n) => dom.body.style.props.get(n) ?? native[n] ?? "",
  });
  try {
    const teardown = new Function(skinJs)();
    const p = dom.body.style.props;
    assert.equal(dom.body.dataset.skyJs, "1");
    const canvas = p.get("--wb-home-bg-secondary"), card = p.get("--wb-bg-primary");
    assert.match(canvas ?? "", /^#[0-9a-f]{6}$/);
    assert.equal(p.get("--cr-bg-canvas"), canvas, "同原生值必须得到同色");
    // 同一偏移向量：卡片 − 画布 = 原生差（11,11,11）
    const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    assert.deepEqual(rgb(card).map((v, i) => v - rgb(canvas)[i]), [11, 11, 11]);
    const [r, , b] = rgb(canvas);
    assert.ok(b > r, "夜间应偏蓝");
    for (const n of ["--wb-accent-bg", "--wb-hover-bg", "--wb-card-light", "--wb-text-strong"]) {
      assert.ok(!p.has(n), `${n} 不应被改写`);
    }
    teardown();
    assert.ok(!p.has("--wb-home-bg-secondary"), "teardown 应清除表面令牌");
    assert.equal(dom.body.dataset.skyJs, undefined);
  } finally {
    globalThis.Date = RealDate;
    delete globalThis.getComputedStyle;
    dom.restore();
  }
});

test("sky-clock skin.js：浅色时段浅色中性表面加天色色相偏移，彩色/深色令牌不动", () => {
  const dom = installDomStubs();
  const RealDate = globalThis.Date;
  // 正午 12:00：天空亮度高，flipT=0 纯浅色时段
  const noon = new RealDate(2026, 9, 15, 12, 0, 0).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [noon])); }
    static now() { return noon; }
  };
  // 浅色原生令牌：近白灰应被着色；彩色 accent、深色、文字类不应被改写
  const native = {
    "--wb-home-bg-secondary": "#fafafa",
    "--wb-bg-primary": "#ffffff",
    "--wb-accent-bg": "#3a6fd8",
    "--wb-card-dark": "#1f1f1f",
    "--wb-text-strong": "#fafafa",
  };
  const names = Object.keys(native);
  globalThis.document.styleSheets = [{ ownerNode: {}, cssRules: [{ style: Object.assign([...names], {}) }] }];
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (n) => dom.body.style.props.get(n) ?? native[n] ?? "",
  });
  try {
    const teardown = new Function(skinJs)();
    const p = dom.body.style.props;
    assert.equal(dom.body.dataset.vscodeThemeKind, "vscode-light", "正午应为浅色模式");
    const bg = p.get("--wb-home-bg-secondary"), card = p.get("--wb-bg-primary");
    assert.match(bg ?? "", /^#[0-9a-f]{6}$/);
    assert.match(card ?? "", /^#[0-9a-f]{6}$/);
    // 同一偏移向量：r/g 通道差 = 原生差 5（b 通道受 255 钳位，差值 ≤5），明度阶梯保留
    const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const diff = rgb(card).map((v, i) => v - rgb(bg)[i]);
    assert.equal(diff[0], 5);
    assert.equal(diff[1], 5);
    assert.ok(diff[2] >= 0 && diff[2] <= 5, `b 通道差应受钳位在 [0,5]，实际 ${diff[2]}`);
    // 正午天空中带偏蓝，着色后 b ≥ r
    const [r, , b] = rgb(card);
    assert.ok(b >= r, `浅色表面应带上天空色相，实际 ${card}`);
    for (const n of ["--wb-accent-bg", "--wb-card-dark", "--wb-text-strong"]) {
      assert.ok(!p.has(n), `${n} 不应被改写`);
    }
    teardown();
    assert.ok(!p.has("--wb-home-bg-secondary"), "teardown 应清除表面令牌");
  } finally {
    globalThis.Date = RealDate;
    delete globalThis.getComputedStyle;
    dom.restore();
  }
});

test("sky-clock skin.js：双图层交叉淡化——激活即双图层同图、A 层在位", () => {
  const dom = installDomStubs();
  try {
    const teardown = new Function(skinJs)();
    const p = dom.body.style.props;
    // 双图层变量齐备且首帧同图（避免从静态兜底图淡出）
    for (const key of ["--sky-art", "--sky-art-b", "--sky-a-on", "--sky-b-on"]) {
      assert.ok(p.has(key), `缺少变量 ${key}`);
    }
    assert.equal(p.get("--sky-art"), p.get("--sky-art-b"), "首帧双图层应同图");
    assert.equal(p.get("--sky-a-on"), "1");
    assert.equal(p.get("--sky-b-on"), "0");
    // art-opacity 为连续数值（flipT 插值），不再是二元 0.22/0.35
    assert.match(p.get("--sky-art-opacity"), /^0\.\d{3}$/);
    teardown();
  } finally {
    dom.restore();
  }
});

test("sky-clock skin.js：teardown 清除定时器、监听与全部 --sky-* 变量", () => {
  const dom = installDomStubs();
  try {
    const teardown = new Function(skinJs)();
    assert.ok(dom.listeners.has("visibilitychange"));
    teardown();
    assert.equal(dom.listeners.size, 0, "visibilitychange 监听应移除");
    assert.equal(dom.body.style.props.size, 0, "内联变量应全部清除");
    // 二次调用安全（幂等）
    assert.doesNotThrow(() => teardown());
  } finally {
    dom.restore();
  }
});

// 月相引擎为纯函数段（FRAMES 起至明暗模式前），可在 Node 端脱离 DOM 直接求值
const lib = eval(
  skinJs.slice(skinJs.indexOf("const FRAMES"), skinJs.indexOf("// ---------- 明暗模式")) +
    "; ({ moonPhase, moonLitPath, buildSvg, frameAt, cloudState })",
);

test("sky-clock 月相：朔望月推算——新月/上弦/满月/下弦的照亮比与命名", () => {
  const epoch = Date.UTC(2000, 0, 6, 18, 14); // 参考新月
  const at = (days) => lib.moonPhase(epoch + days * 86400000);
  const newMoon = at(0);
  assert.equal(newMoon.name, "新月");
  assert.ok(newMoon.illumination < 0.01, `新月照亮比应≈0，实际 ${newMoon.illumination}`);
  const quarter = at(7.38);
  assert.equal(quarter.name, "上弦月");
  assert.ok(Math.abs(quarter.illumination - 0.5) < 0.01, `上弦照亮比应≈0.5，实际 ${quarter.illumination}`);
  const full = at(14.77);
  assert.equal(full.name, "满月");
  assert.ok(full.illumination > 0.99, `满月照亮比应≈1，实际 ${full.illumination}`);
  const lastQuarter = at(22.15);
  assert.equal(lastQuarter.name, "下弦月");
  assert.ok(Math.abs(lastQuarter.illumination - 0.5) < 0.01);
  // 跨年回卷：2024-01-11 11:57 UTC 是实际新月，模型应给出极低照亮比
  const y2024 = lib.moonPhase(Date.UTC(2024, 0, 11, 11, 57));
  assert.ok(y2024.illumination < 0.03, `2024-01-11 实际新月，照亮比应≈0，实际 ${y2024.illumination}`);
});

test("sky-clock 月相弧：盈月右亮、亏月左亮，弦月界线退化为直线", () => {
  // 盈月（p=0.2）外缘顺时针（sweep=1）；亏月（p=0.6）外缘逆时针（sweep=0）
  assert.ok(lib.moonLitPath(800, 300, 46, 0.2).includes("A46 46 0 0 1"));
  assert.ok(lib.moonLitPath(800, 300, 46, 0.6).includes("A46 46 0 0 0"));
  // 上弦（p=0.25）界线 rx≈0.5（夹取下限），蛾眉月（p=0.1）界线为宽椭圆
  assert.ok(lib.moonLitPath(800, 300, 46, 0.25).includes("A0.5 46"));
  const crescent = lib.moonLitPath(800, 300, 46, 0.1);
  assert.ok(/A(3[5-9]|4[0-6])\.\d 46/.test(crescent), `蛾眉月界线 rx 应接近 46·|cos(0.2π)|≈37，实际：${crescent}`);
  // 界线 sweep 四象限规则（亏月与盈月相反，错配会把残月画成亏凸月）：
  // 蛾眉(0.1)=0、盈凸(0.4)=1、亏凸(0.6)=0、残月(0.9)=1
  const termSweep = (p) => lib.moonLitPath(800, 300, 46, p).match(/A[\d.]+ 46 0 0 (\d) \d+ \d+ Z/)[1];
  assert.equal(termSweep(0.1), "0", "蛾眉月界线应凸向亮侧");
  assert.equal(termSweep(0.4), "1", "盈凸月界线应凸向暗侧");
  assert.equal(termSweep(0.6), "0", "亏凸月界线应凸向暗侧");
  assert.equal(termSweep(0.9), "1", "残月界线应凸向亮侧");
  // 端到端：深夜场景绘制月亮，白天场景绘制太阳（defs 恒含渐变定义，须查 url() 引用）
  const night = lib.buildSvg(23, lib.frameAt(23), lib.moonPhase(Date.UTC(2026, 0, 3))); // 2026-01-03 满月附近
  assert.ok(night.includes('url(#moonGlow)') && !night.includes('url(#sunGlow)'));
  const day = lib.buildSvg(12, lib.frameAt(12), lib.moonPhase(Date.now()));
  assert.ok(day.includes('url(#sunGlow)') && !day.includes('url(#moonGlow)'));
});

test("sky-clock 白云：正午三簇纯白、晨昏染霞色、夜间不渲染", () => {
  const noon = lib.cloudState(12.5), dawn = lib.cloudState(7), night = lib.cloudState(0);
  assert.ok(noon && noon.strength > 0.95, `正午云量应接近峰值，实际 ${noon && noon.strength}`);
  assert.equal(noon.fill.toLowerCase(), "#ffffff", "正午云应为纯白");
  assert.ok(dawn && dawn.fill.toLowerCase() !== "#ffffff", "清晨云应染霞色");
  assert.equal(night, null, "子夜不应有云");
  const svgNoon = lib.buildSvg(12, lib.frameAt(12), lib.moonPhase(Date.now()));
  assert.ok(svgNoon.includes('class="sky-clouds"'), "正午场景应含云层");
  const svgNight = lib.buildSvg(0, lib.frameAt(0), lib.moonPhase(Date.now()));
  assert.ok(!svgNight.includes("sky-clouds"), "子夜场景不应含云层");
});

test("sky-clock 白云：漂移带 y 沉浮分量与非对称 keySplines（模拟阵风）", () => {
  const svg = lib.buildSvg(12, lib.frameAt(12), lib.moonPhase(Date.now()));
  assert.ok(svg.includes('values="0 0; 36 4; 0 0"'), "云漂移应含 y 沉浮分量");
  assert.ok(svg.includes('keySplines="0.3 0 0.7 1; 0.42 0 1 1"'), "去程/回程 keySplines 应非对称");
  assert.ok(!svg.includes('keySplines="0.42 0 0.58 1; 0.42 0 0.58 1"'), "旧对称 keySplines 应已移除");
});

test("sky-clock 白云：簇内 blob 叠加 additive bob（差异变形），数量与相位正确", () => {
  const svg = lib.buildSvg(12, lib.frameAt(12), lib.moonPhase(Date.now()));
  const bobs = svg.match(/<animateTransform[^>]*additive="sum"[^>]*\/>/g) || [];
  assert.equal(bobs.length, 12, `三簇 × 四 blob 应有 12 条 additive bob，实际 ${bobs.length}`);
  assert.ok(bobs.every((b) => b.includes('dur="')), "每条 bob 应有 dur");
  const durs = new Set(bobs.map((b) => /dur="(\d+)s"/.exec(b)[1]));
  assert.ok(durs.size >= 4, `bob 周期应错开（≥4 种），实际 ${[...durs].join(",")}`);
  const begins = new Set(bobs.map((b) => /begin="([-\d.]+)s"/.exec(b)[1]));
  assert.ok(begins.size > 1, "bob 相位应错开，不应全部同相位");
  assert.ok(bobs.every((b) => b.includes('keySplines="0.4 0 0.6 1; 0.4 0 0.6 1"')), "bob 应使用对称缓动（轻柔呼吸）");
});

test("sky-clock 减弱动效：命中 prefers-reduced-motion 时不输出云漂移与星闪 SMIL", () => {
  const saved = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  try {
    const libRM = eval(skinJs.slice(skinJs.indexOf("const FRAMES"), skinJs.indexOf("// ---------- 明暗模式")) +
      "; ({ buildSvg, frameAt, moonPhase })");
    const noon = libRM.buildSvg(12, libRM.frameAt(12), libRM.moonPhase(Date.now()));
    assert.ok(noon.includes('class="sky-clouds"'), "减弱动效下云层应静态保留");
    assert.ok(!noon.includes("<animate"), "减弱动效下正午场景不应含 SMIL 动画");
    const night = libRM.buildSvg(23, libRM.frameAt(23), libRM.moonPhase(Date.now()));
    assert.ok(night.includes("M0 -10 Q1.6"), "减弱动效下星芒应静态保留");
    assert.ok(!night.includes("<animate"), "减弱动效下夜间场景不应含星闪 SMIL");
  } finally {
    if (saved === undefined) delete globalThis.window; else globalThis.window = saved;
  }
});
