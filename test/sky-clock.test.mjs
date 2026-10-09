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
