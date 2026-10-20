#!/usr/bin/env node
// svg-anim-probe.mjs —— SMIL 动效离线验证工具（无头 Edge 多帧渲染 + Pillow 采样）
//
// ★ 结论不可迁移到 WorkBuddy：Electron 37 / Chromium 138 的渲染进程把 SMIL 整类冻结
//   （inline 与 background-image 里的 SMIL 都停在 t=0），而无头 Edge 里 SMIL 正常。
//   本工具只适合验证「SVG 素材本身写得对不对」；动效是否在应用里真的跑，必须走
//   活体 CDP 截屏差分（见 output/cloud-probe/live-*.mjs 系列）。
//
// 用途：验证「含 SMIL/CSS 动画的 SVG 以 CSS background-image（data URL）方式挂载时，
//       动画是否真的在运行、幅度/面积是否可感知」。这是 workbuddy-skins 里 sky-clock
//       等「动态场景 SVG」的通用排障手段：直接把场景 SVG 喂进来，按给定采样点在不同
//       虚拟时刻截帧，逐点测峰值亮度（扣除本底后的增量 Δ）与亮像素面积，输出时序，
//       从而判定动画是否生效、相位是否错开、反差是否够。
//
// 链路：SVG → 包成 HTML（background-image data URL，模拟真实挂载）→ 无头 Edge 以
//       --virtual-time-budget=N 截多帧 PNG → Pillow 逐点采样 → 汇总报表。
//
// 用法：
//   node scripts/svg-anim-probe.mjs \
//     --svg output.svg \
//     --points "180,160;730,125;1430,295" \
//     --times "1200,2000,2800,3600,4400,5200" \
//     [--radius 14] [--threshold 8] [--ref 80,0] [--opacity 0.35] \
//     [--out ./frames] [--keep] [--edge <path>] [--python <path>]
//
// 参数：
//   --svg <path>     输入的 SVG 文件（含 SMIL animate/animateTransform 等）
//   --points <str>   采样点，分号分隔 "x,y;x,y"（用 SVG 坐标；挂载为 cover 且宽高比
//                    一致时与屏幕像素 1:1 对齐）
//   --times <str>    虚拟时刻（ms），逗号分隔。至少两个，否则无从比较
//   --radius <int>   采样方框半宽（px），默认 14
//   --threshold <int> 面积计数阈值：delta >= 阈值计入「亮像素」，默认 8
//   --ref <dx,dy>    本底参考点相对采样点的偏移，默认 80,0（同高度横向取暗背景）
//   --opacity <float> 挂载层的整体不透明度，默认 1（模拟 --sky-art-opacity 等）
//   --out <dir>      保留帧 PNG 到该目录
//   --keep           不清理临时帧（等价 --out 到临时目录并保留）
//   --edge <path>    覆盖 Edge/Chrome 可执行文件路径
//   --python <path>  覆盖带 Pillow 的 Python 解释器路径
//
// 退出码：0=正常（含"判定为不闪烁"），1=参数/环境错误（缺 Edge、缺 Pillow 等）。
//
// 依赖：Edge 或 Chrome（Chromium，SMIL 在 CSS background-image 中可运行）、
//       带 Pillow 的 Python 3。

import { parseArgs } from "node:util";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const W = 1600, H = 900;

// ---------- 纯函数（可单测） ----------

// "x,y;x,y" → [{x,y}, ...]
export function parsePoints(str) {
  if (typeof str !== "string" || str.trim() === "") throw new Error("--points 不能为空");
  return str.split(";").map((s, i) => {
    const [x, y] = s.split(",").map((v) => Number(v.trim()));
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`--points 第 ${i + 1} 项非法："${s}"`);
    return { x, y };
  });
}

// "t1,t2,..." → [num, ...]，至少两个
export function parseTimes(str) {
  if (typeof str !== "string" || str.trim() === "") throw new Error("--times 不能为空");
  const ts = str.split(",").map((v) => Number(v.trim()));
  if (ts.some((t) => !Number.isFinite(t))) throw new Error("--times 含非数字项");
  if (ts.length < 2) throw new Error("--times 至少需要两个时刻");
  return ts;
}

// "dx,dy" → [dx,dy]
export function parseRef(str) {
  const [dx, dy] = str.split(",").map((v) => Number(v.trim()));
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error(`--ref 非法："${str}"`);
  return [dx, dy];
}

// 把 SVG 包成 HTML：CSS background-image data URL（与皮肤运行时挂载方式一致）
export function buildProbeHtml(svg, { opacity = 1 } = {}) {
  return (
    "<!doctype html><meta charset=utf-8>" +
    "<style>html,body{margin:0;height:100%}body{background:#0b1226}" +
    ".art{position:fixed;inset:0;background-image:url(\"data:image/svg+xml;charset=utf-8," +
    encodeURIComponent(svg) +
    "\");background-size:cover;background-position:center bottom;opacity:" + opacity +
    "}</style><div class=art></div>"
  );
}

// ---------- 环境探测 ----------

function findEdge(override) {
  if (override) {
    if (!existsSync(override)) throw new Error(`--edge 指定的可执行文件不存在：${override}`);
    return override;
  }
  const win = process.platform === "win32";
  const mac = process.platform === "darwin";
  const candidates = win
    ? [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ]
    : mac
      ? [
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        ]
      : ["/usr/bin/microsoft-edge", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const c of [process.env.CHROME_PATH, process.env.EDGE_PATH, ...candidates]) {
    if (c && existsSync(c)) return c;
  }
  throw new Error("未找到 Edge/Chrome。请用 --edge 指定 Chromium 可执行文件路径");
}

function pythonHasPillow(py) {
  if (!py) return false;
  try {
    execFileSync(py, ["-c", "import PIL"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function findPython(override) {
  if (override) {
    if (!pythonHasPillow(override)) throw new Error(`--python 指定的解释器没有 Pillow：${override}`);
    return override;
  }
  const home = homedir();
  const candidates = [
    process.env.PYTHON,
    "python",
    "python3",
    process.platform === "win32"
      ? join(home, ".workbuddy", "binaries", "python", "envs", "default", "Scripts", "python.exe")
      : join(home, ".workbuddy", "binaries", "python", "envs", "default", "bin", "python"),
  ];
  for (const c of candidates) {
    if (pythonHasPillow(c)) return c;
  }
  throw new Error("未找到带 Pillow 的 Python。请 pip install pillow 后用 --python 指定解释器路径");
}

// ---------- 渲染 + 采样 ----------

function renderFrames(edge, html, times, outDir, profileDir) {
  const htmlPath = join(outDir, "probe.html");
  writeFileSync(htmlPath, html, "utf8");
  const url = "file:///" + htmlPath.replace(/\\/g, "/");
  for (const t of times) {
    execFileSync(
      edge,
      [
        "--headless=new", "--disable-gpu", "--no-sandbox",
        "--user-data-dir=" + profileDir,
        "--window-size=" + W + "," + H,
        "--virtual-time-budget=" + t,
        "--screenshot=" + join(outDir, `frame-${t}.png`),
        url,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
  }
}

function sampleFrames(python, outDir, times, points, { radius, threshold, refDx, refDy }) {
  const cfg = {
    frames: times.map((t) => ({ t, path: join(outDir, `frame-${t}.png`) })),
    points,
    radius,
    threshold,
    refDx,
    refDy,
  };
  const cfgPath = join(outDir, "sample-cfg.json");
  const samplerPath = join(__dirname, "svg-anim-sample.py");
  writeFileSync(cfgPath, JSON.stringify(cfg), "utf8");
  const res = spawnSync(python, [samplerPath, cfgPath], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error("采样失败：" + (res.stderr || res.stdout || `exit ${res.status}`));
  }
  return JSON.parse(res.stdout);
}

// 汇总：每点时序 + 幅度 + 动画判定
function summarize(samples, times, points) {
  const rows = points.map((p, i) => {
    const series = times.map((t) => samples[String(t)][i]);
    const deltas = series.map((s) => s.delta);
    const areas = series.map((s) => s.area);
    const minD = Math.min(...deltas), maxD = Math.max(...deltas);
    const minA = Math.min(...areas), maxA = Math.max(...areas);
    // 动画判定：亮度增量有起伏，或亮像素面积有起伏
    const animating = maxD - minD >= 8 || maxA - minA >= 4;
    return { point: p, series, minD, maxD, minA, maxA, animating };
  });
  return { rows, anyAnimating: rows.some((r) => r.animating) };
}

function report(result, { svgPath, times }) {
  const L = (r) => `(${r.point.x},${r.point.y})`;
  const fmt = (n) => (n >= 0 ? "+" : "") + n;
  console.log(`SVG:      ${svgPath}`);
  console.log(`采样点:   ${result.rows.length} 个   时刻: ${times.join(" / ")} ms`);
  console.log("");
  for (const r of result.rows) {
    const deltas = r.series.map((s) => fmt(s.delta)).join("  ");
    console.log(`  ${L(r).padEnd(12)} Δ=[${deltas}]  幅度 ${fmt(r.minD)}~${fmt(r.maxD)}  面积 ${r.minA}~${r.maxA}  ${r.animating ? "闪烁" : "无明显变化"}`);
  }
  console.log("");
  console.log(result.anyAnimating ? "结论：至少一个采样点检测到亮度/面积起伏，动画在 background-image 下运行。" : "结论：所有采样点无明显起伏——检查动画参数或 SMIL 是否被禁用。");
  console.log("（Δ=扣除本底后的峰值亮度增量；面积=Δ 超过阈值的亮像素数，反映视觉尺寸。）");
  return result.anyAnimating;
}

// ---------- 入口 ----------

export function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      svg: { type: "string" },
      points: { type: "string" },
      times: { type: "string" },
      radius: { type: "string", default: "14" },
      threshold: { type: "string", default: "8" },
      ref: { type: "string", default: "80,0" },
      opacity: { type: "string", default: "1" },
      out: { type: "string" },
      keep: { type: "boolean", default: false },
      edge: { type: "string" },
      python: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: false,
  });

  if (values.help || !values.svg) {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 60).join("\n"));
    return values.help ? 0 : 2;
  }
  for (const key of ["svg", "points", "times"]) {
    if (!values[key]) { console.error(`缺少必需参数 --${key}`); return 2; }
  }

  const svgPath = resolve(values.svg);
  if (!existsSync(svgPath)) { console.error(`SVG 文件不存在：${svgPath}`); return 1; }
  const svg = readFileSync(svgPath, "utf8");
  const points = parsePoints(values.points);
  const times = parseTimes(values.times);
  const [refDx, refDy] = parseRef(values.ref);
  const radius = Number(values.radius);
  const threshold = Number(values.threshold);
  const opacity = Number(values.opacity);

  let edge, python;
  try { edge = findEdge(values.edge); } catch (e) { console.error(e.message); return 1; }
  try { python = findPython(values.python); } catch (e) { console.error(e.message); return 1; }

  const keepOut = values.out ? resolve(values.out) : (values.keep ? mkdtempSync(join(tmpdir(), "svg-anim-probe-")) : null);
  const workDir = keepOut || mkdtempSync(join(tmpdir(), "svg-anim-probe-"));
  const profileDir = join(workDir, "profile");
  mkdirSync(profileDir, { recursive: true });

  try {
    const html = buildProbeHtml(svg, { opacity });
    renderFrames(edge, html, times, workDir, profileDir);
    const samples = sampleFrames(python, workDir, times, points, { radius, threshold, refDx, refDy });
    const result = summarize(samples, times, points);
    const ok = report(result, { svgPath, times });
    if (keepOut) console.log(`\n帧已保留：${keepOut}`);
    return ok ? 0 : 0; // "无明显变化"是有效结论，非错误
  } catch (e) {
    console.error("验证失败：" + e.message);
    return 1;
  } finally {
    if (!keepOut) rmSync(workDir, { recursive: true, force: true });
  }
}

// 直接执行入口
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"))) {
  process.exitCode = main(process.argv.slice(2));
}
