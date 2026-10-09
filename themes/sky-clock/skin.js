/* Sky Clock · 四时天空 —— 主题伴随脚本（new Function 函数体，返回拆除回调）。
   职责：按真实时间插值「天空时刻表」，每分钟（整分钟对齐）重建一次场景 SVG 写入
   --sky-art，同步改写 skin.css 引用的 --sky-* 变量与界面明暗模式。
   明暗模式由本脚本接管（theme.json 声明 dynamicMode，菜单跳过钉住）；
   写类名/属性的方式与菜单 writeMode 完全一致（六个类 + themeKind/themeName +
   colorScheme），观察者在应用回写时重新断言，检查先于写入故收敛无环。
   CSP 禁 eval 时本脚本不执行，skin.css 的静态默认值与 sky.svg 兜底生效。 */

// ---------- 天空时刻表（参考真实天空色，hour 升序，24:00 回卷到 0:00 帧） ----------
// ridge 为三层山脊（远→近）：白天为绿色山峦（远雾绿→近墨绿），夜晚沉为深蓝剪影，
// 晨昏帧取中间色使绿意在 7:5/17:6 前后随光自然淡入淡出；stars/aurora 为该时段强度（0..1）
const FRAMES = [
  { h: 0.0,  top: "#05070F", mid: "#0B1526", bot: "#12233A", ridge: ["#0C1D31", "#081426", "#040B15"], stars: 0.90, aurora: 0.55 },
  { h: 4.5,  top: "#0B1226", mid: "#18293F", bot: "#274058", ridge: ["#10273B", "#0B1B2C", "#060F1C"], stars: 0.45, aurora: 0.25 },
  { h: 6.2,  top: "#33417E", mid: "#96689A", bot: "#F08A5C", ridge: ["#24403E", "#1A2E30", "#101E22"], stars: 0.06, aurora: 0.00 },
  { h: 7.5,  top: "#5B84BC", mid: "#A9C6E4", bot: "#F4CFA6", ridge: ["#5F827E", "#41604F", "#2A4538"], stars: 0.00, aurora: 0.00 },
  { h: 10.0, top: "#3D7CC2", mid: "#83B4E2", bot: "#DAEDFA", ridge: ["#7FA0A0", "#5A7F66", "#33503E"], stars: 0.00, aurora: 0.00 },
  { h: 12.5, top: "#2D6CB8", mid: "#79B3E4", bot: "#EAF5FD", ridge: ["#7FA0A3", "#5A7F66", "#33503E"], stars: 0.00, aurora: 0.00 },
  { h: 15.5, top: "#3A74BA", mid: "#8ABDE5", bot: "#E3F2FB", ridge: ["#7E9C97", "#587B61", "#324C3B"], stars: 0.00, aurora: 0.00 },
  { h: 17.6, top: "#4B4C92", mid: "#C96B80", bot: "#FF9C5C", ridge: ["#4A4A3E", "#33382F", "#20251F"], stars: 0.04, aurora: 0.00 },
  { h: 19.0, top: "#262C58", mid: "#41477A", bot: "#71608C", ridge: ["#182A49", "#12203A", "#0A1526"], stars: 0.55, aurora: 0.10 },
  { h: 20.8, top: "#0A0F24", mid: "#152142", bot: "#1E3354", ridge: ["#0E2138", "#0A1829", "#050C17"], stars: 0.85, aurora: 0.50 },
];

// 山脊轮廓沿用 aurora.svg 的三层山形
const RIDGE_PATHS = [
  "M0 610 Q320 500 610 620 T1180 585 T1600 550 V900 H0Z",
  "M0 700 Q310 585 620 710 T1210 660 T1600 630 V900 H0Z",
  "M0 780 Q280 680 570 770 T1100 745 T1600 720 V900 H0Z",
];
// 星星为四角星芒（✦）：20 单位宽的凹腰十字星路径，按 r 缩放、位置平移
const SPARKLE_PATH = "M0 -10 Q1.6 -1.6 10 0 Q1.6 1.6 0 10 Q-1.6 1.6 -10 0 Q-1.6 -1.6 0 -10 Z";
const STARS = [
  [180, 160, 3], [420, 245, 2], [730, 125, 3], [1260, 175, 2],
  [1430, 295, 3], [950, 90, 2], [560, 330, 2], [1100, 260, 2],
];

// ---------- 颜色工具 ----------
const lerp = (a, b, t) => a + (b - a) * t;
const hex2rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgb2hex = (rgb) =>
  "#" + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
const lerpHex = (a, b, t) => {
  const A = hex2rgb(a), B = hex2rgb(b);
  return rgb2hex(A.map((v, i) => lerp(v, B[i], t)));
};
const rgba = (rgb, a) =>
  "rgba(" + rgb.map((v) => Math.round(v)).join(",") + "," + a.toFixed(2) + ")";
// sRGB 相对亮度：判定当前天空该配浅色还是深色界面
const luminance = (hex) => {
  const f = (c) => {
    c = c / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = hex2rgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};

// ---------- 时刻表插值 ----------
const frameAt = (h) => {
  let i = FRAMES.length - 1;
  for (let k = 0; k < FRAMES.length; k++) {
    if (h < FRAMES[k].h) { i = k - 1; break; }
  }
  const a = FRAMES[(i + FRAMES.length) % FRAMES.length];
  const b = FRAMES[(i + 1) % FRAMES.length];
  const span = (b.h - a.h + 24) % 24 || 24;
  const t = ((h - a.h + 24) % 24) / span;
  return {
    top: lerpHex(a.top, b.top, t),
    mid: lerpHex(a.mid, b.mid, t),
    bot: lerpHex(a.bot, b.bot, t),
    ridge: a.ridge.map((c, k) => lerpHex(c, b.ridge[k], t)),
    stars: lerp(a.stars, b.stars, t),
    aurora: lerp(a.aurora, b.aurora, t),
  };
};

// ---------- 天体轨迹（viewBox 1600×900；地平线 y≈700，山脊线后方落山） ----------
const SUNRISE = 6.0, SUNSET = 18.0;
const sunState = (h) => {
  if (h < SUNRISE || h > SUNSET) return null;
  const t = (h - SUNRISE) / (SUNSET - SUNRISE);
  const arc = Math.sin(Math.PI * t);
  return {
    cx: 180 + 1240 * t,
    cy: 700 - 540 * arc,
    r: 64 + 62 * (1 - arc),                    // 日出日落大、正午小
    color: lerpHex("#FF5E33", "#FFFDEF", Math.pow(arc, 0.6)), // 地平橙红 → 正午近白（空气透视方案 B）
    glow: 0.85 - 0.13 * arc,                   // 正午光晕 0.72，保持日盘存在感
  };
};
const MOONRISE = 18.0, MOON_SPAN = 12.0; // 18:00 → 次日 6:00，与太阳窗口 [6,18] 无缝对冲交接
const moonState = (h) => {
  const nh = (h - MOONRISE + 24) % 24;
  if (nh > MOON_SPAN) return null;
  const t = nh / MOON_SPAN;
  const arc = Math.sin(Math.PI * t);
  return { cx: 180 + 1240 * t, cy: 700 - 470 * arc, r: 46 };
};

// ---------- 朝霞 / 晚霞（粉色雾，贴地平线、锚定太阳方位） ----------
// 强度为日出/日落时刻的高斯峰（σ=0.9h）：约 4:30–8:30 与 15:30–19:30 可见，峰值在日出后/日落前
const gauss = (x, mu, sig) => Math.exp(-((x - mu) * (x - mu)) / (2 * sig * sig));
const rosyState = (h, sun) => {
  const dawn = gauss(h, SUNRISE + 0.15, 0.9), dusk = gauss(h, SUNSET - 0.15, 0.9);
  const strength = Math.max(dawn, dusk);
  if (strength < 0.04) return null;
  const isDawn = dawn >= dusk;
  // 太阳未出/已落时锚定其地平方位（东 180 / 西 1420），否则跟随太阳横向位置
  const cx = sun ? sun.cx : (isDawn ? 180 : 1420);
  return { cx, cy: 655, strength: strength * 0.85, warm: isDawn ? "#FFC9A8" : "#FFA8BC" };
};

// ---------- 白云（正午前后最盛，晨昏染霞色） ----------
// 云量 = 以 12:30 为峰的高斯（σ=2.6h），约 7:00–18:00 淡入淡出；位置避开正午太阳顶点（800,160）
const CLOUDS = [
  { x: 300, y: 215, s: 1.0 },
  { x: 1180, y: 150, s: 0.8 },
  { x: 760, y: 340, s: 1.15 },
];
// 单簇 = 底部压暗片（先画垫底）+ 主体/左右片，按 s 缩放平移
const CLOUD_BLOBS = [
  [0, 15, 68, 18, 0], [0, 0, 58, 26, 1], [-52, 10, 40, 20, 1], [55, 12, 44, 21, 1],
];
const cloudState = (h) => {
  const strength = gauss(h, 12.5, 2.6);
  if (strength < 0.05) return null;
  // 晨昏暖白 #FFDEC8 ↔ 正午纯白 #FFFFFF
  const warmth = Math.min(1, Math.abs(h - 12.5) / 5);
  return { strength, fill: lerpHex("#FFFFFF", "#FFDEC8", warmth), shade: lerpHex("#DDE8F2", "#E8B9A8", warmth) };
};

// ---------- 月相（按真实朔望月推算，参考新月 2000-01-06 18:14 UTC） ----------
const SYNODIC = 29.530588853; // 朔望月天数
const NEW_MOON_EPOCH = Date.UTC(2000, 0, 6, 18, 14);
const PHASE_NAMES = ["新月", "娥眉月", "上弦月", "盈凸月", "满月", "亏凸月", "下弦月", "残月"];
const moonPhase = (nowMs) => {
  const age = (((nowMs - NEW_MOON_EPOCH) / 86400000) % SYNODIC + SYNODIC) % SYNODIC; // 月龄（天）
  const p = age / SYNODIC; // 相位 0..1：0=新月 0.25=上弦 0.5=满月 0.75=下弦
  return { age, p, illumination: (1 - Math.cos(2 * Math.PI * p)) / 2, name: PHASE_NAMES[Math.round(p * 8) % 8] };
};
// 亮部轮廓 = 外缘半圆 + 明暗界线椭圆弧。界线横轴 rx = r·|cos(2πp)|：
// 弦月（p=.25/.75）rx→0 退化为直线（半月），新月/满月附近 rx→r（蛾眉/凸月）。
// 方向约定（屏幕坐标 y 向下，sweep=1 为视觉顺时针）：盈月右亮外缘顺时针、亏月左亮逆时针；
// 界线从底部回到顶部：蛾眉/盈凸分别凸向右/左（sweep 0/1），亏凸/残月镜像为 0/1——
// 即盈月两段 sweep 同号规律为 0,1，亏月为 0,1 对调；cos(2πp) 变号处（弦月）翻转
const moonLitPath = (cx, cy, r, p) => {
  const rx = Math.max(r * Math.abs(Math.cos(2 * Math.PI * p)), 0.5).toFixed(1);
  const limbSweep = p < 0.5 ? 1 : 0; // 外缘：盈=右半圆，亏=左半圆
  // 界线：蛾眉(0) 盈凸(1) 亏凸(0) 残月(1)——盈月随 cos 符号，亏月取反
  const termSweep = p < 0.25 || (p > 0.5 && p < 0.75) ? 0 : 1;
  const x = cx.toFixed(0), top = (cy - r).toFixed(0), bottom = (cy + r).toFixed(0);
  return "M" + x + " " + top +
    " A" + r + " " + r + " 0 0 " + limbSweep + " " + x + " " + bottom +
    " A" + rx + " " + r + " 0 0 " + termSweep + " " + x + " " + top + " Z";
};

// ---------- 场景 SVG 重建（phase 为 moonPhase 结果） ----------
const buildSvg = (h, sky, phase) => {
  const sun = sunState(h);
  const moon = sun ? null : moonState(h);
  const rosy = rosyState(h, sun);
  const clouds = cloudState(h);
  let parts = "";
  if (sky.stars > 0.02) {
    parts += '<g fill="#EAFFF8" opacity="' + sky.stars.toFixed(2) + '">' +
      STARS.map(([cx, cy, r]) =>
        '<path d="' + SPARKLE_PATH + '" transform="translate(' + cx + ' ' + cy + ') scale(' + (r * 0.32).toFixed(2) + ')"/>'
      ).join("") +
      "</g>";
  }
  if (sky.aurora > 0.02) {
    parts += '<ellipse cx="980" cy="210" rx="460" ry="210" fill="url(#auroraGlow)" opacity="' +
      sky.aurora.toFixed(2) + '"/>';
  }
  if (rosy) {
    // 粉色雾双层：宽雾带压地平线 + 太阳方位的浓芯，画在山脊之后、日盘之前
    parts +=
      '<ellipse cx="' + rosy.cx.toFixed(0) + '" cy="' + rosy.cy + '" rx="820" ry="185" fill="url(#rosyGlow)" opacity="' +
      (rosy.strength * 0.6).toFixed(2) + '"/>' +
      '<ellipse cx="' + rosy.cx.toFixed(0) + '" cy="' + (rosy.cy - 30) + '" rx="400" ry="140" fill="url(#rosyGlow)" opacity="' +
      rosy.strength.toFixed(2) + '"/>';
  }
  if (clouds) {
    // 白云三簇：底部压暗片先画（体积阴影），主体片后画；位置避开正午太阳
    parts += '<g class="sky-clouds" opacity="' + clouds.strength.toFixed(2) + '">' +
      CLOUDS.map((c) =>
        CLOUD_BLOBS.map(([dx, dy, rx, ry, top]) =>
          '<ellipse cx="' + (c.x + dx * c.s).toFixed(0) + '" cy="' + (c.y + dy * c.s).toFixed(0) +
          '" rx="' + (rx * c.s).toFixed(0) + '" ry="' + (ry * c.s).toFixed(0) +
          '" fill="' + (top ? clouds.fill : clouds.shade) + '"/>'
        ).join("")
      ).join("") +
      "</g>";
  }
  if (sun) {
    parts +=
      '<circle cx="' + sun.cx.toFixed(0) + '" cy="' + sun.cy.toFixed(0) + '" r="' + (sun.r * 2.1).toFixed(0) +
      '" fill="url(#sunGlow)" opacity="' + sun.glow.toFixed(2) + '"/>' +
      '<circle cx="' + sun.cx.toFixed(0) + '" cy="' + sun.cy.toFixed(0) + '" r="' + sun.r.toFixed(0) +
      '" fill="' + sun.color + '"/>';
  } else if (moon) {
    // 月亮按真实月相绘制：暗面地照蓝灰盘 + 亮部月相弧 + 细轮廓；
    // 亮面足够大时环形山落在亮侧（盈右亏左），与太阳的满圆盘明确区分
    const { cx, cy, r } = moon;
    const cxI = cx.toFixed(0), cyI = cy.toFixed(0);
    parts += '<circle cx="' + cxI + '" cy="' + cyI + '" r="' + (r * 2.4).toFixed(0) + '" fill="url(#moonGlow)"/>';
    if (phase.illumination < 0.03) {
      // 新月：只剩一圈微光轮廓
      parts += '<circle cx="' + cxI + '" cy="' + cyI + '" r="' + r + '" fill="none" stroke="#EDF2FA" stroke-opacity="0.10" stroke-width="2"/>';
    } else {
      parts += '<circle cx="' + cxI + '" cy="' + cyI + '" r="' + r + '" fill="#1B2740" fill-opacity="0.45"/>';
      parts += phase.illumination > 0.97
        ? '<circle cx="' + cxI + '" cy="' + cyI + '" r="' + r + '" fill="#EDF2FA"/>'
        : '<path d="' + moonLitPath(cx, cy, r, phase.p) + '" fill="#EDF2FA"/>';
      parts += '<circle cx="' + cxI + '" cy="' + cyI + '" r="' + r + '" fill="none" stroke="#EDF2FA" stroke-opacity="0.18" stroke-width="2"/>';
      if (phase.illumination > 0.55) {
        const side = phase.p < 0.5 ? 1 : -1;
        parts += '<circle cx="' + (cx + side * r * 0.38).toFixed(0) + '" cy="' + (cy - r * 0.2).toFixed(0) + '" r="' + (r * 0.18).toFixed(0) + '" fill="#D4DCEA"/>' +
          '<circle cx="' + (cx + side * r * 0.3).toFixed(0) + '" cy="' + (cy + r * 0.32).toFixed(0) + '" r="' + (r * 0.12).toFixed(0) + '" fill="#D4DCEA"/>';
      }
    }
  }
  // 天体在山脊之前绘制——日落时太阳沉入山后
  RIDGE_PATHS.forEach((d, i) => {
    parts += '<path d="' + d + '" fill="' + sky.ridge[i] + '"/>';
  });
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900"><defs>' +
    '<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="' + sky.top + '"/>' +
    '<stop offset="0.52" stop-color="' + sky.mid + '"/>' +
    '<stop offset="1" stop-color="' + sky.bot + '"/></linearGradient>' +
    '<radialGradient id="sunGlow"><stop stop-color="#FF8A4D" stop-opacity="0.9"/>' +
    '<stop offset="1" stop-color="#FF8A4D" stop-opacity="0"/></radialGradient>' +
    '<radialGradient id="moonGlow"><stop stop-color="#C9D6F2" stop-opacity="0.5"/>' +
    '<stop offset="1" stop-color="#C9D6F2" stop-opacity="0"/></radialGradient>' +
    '<radialGradient id="auroraGlow"><stop stop-color="#BDFFE8" stop-opacity="0.9"/>' +
    '<stop offset="1" stop-color="#74F2C9" stop-opacity="0"/></radialGradient>' +
    '<radialGradient id="rosyGlow"><stop stop-color="' + (rosy ? rosy.warm : "#FFC9D6") + '" stop-opacity="0.85"/>' +
    '<stop offset="1" stop-color="' + (rosy ? rosy.warm : "#FFC9D6") + '" stop-opacity="0"/></radialGradient></defs>' +
    '<rect width="1600" height="900" fill="url(#sky)"/>' + parts + "</svg>"
  );
};

// ---------- 明暗模式自写（与菜单 writeMode 同一套属性/类名） ----------
const MODE_CLASSES = ["light", "vscode-light", "cb-light", "dark", "vscode-dark", "cb-dark"];
const DARK_CLASSES = ["dark", "vscode-dark", "cb-dark"];
let currentDark = null;
const modeMatches = (dark) => {
  const body = document.body, html = document.documentElement;
  if (body.dataset.vscodeThemeKind !== (dark ? "vscode-dark" : "vscode-light")) return false;
  if (body.dataset.vscodeThemeName !== (dark ? "IDE Night" : "IDE Light")) return false;
  return MODE_CLASSES.every((cls) => {
    const want = dark ? DARK_CLASSES.includes(cls) : !DARK_CLASSES.includes(cls);
    return body.classList.contains(cls) === want && html.classList.contains(cls) === want;
  });
};
const writeMode = (dark) => {
  if (currentDark === dark && modeMatches(dark)) return; // 检查先于写入，observer 收敛无环
  currentDark = dark;
  const body = document.body, html = document.documentElement;
  body.dataset.vscodeThemeKind = dark ? "vscode-dark" : "vscode-light";
  body.dataset.vscodeThemeName = dark ? "IDE Night" : "IDE Light";
  html.style.colorScheme = dark ? "dark" : "light";
  MODE_CLASSES.forEach((cls) => {
    const want = dark ? DARK_CLASSES.includes(cls) : !DARK_CLASSES.includes(cls);
    body.classList.toggle(cls, want);
    html.classList.toggle(cls, want);
  });
};

// ---------- 主刷新 ----------
const SKY_VARS = [
  "--sky-art", "--sky-top", "--sky-mid", "--sky-bot",
  "--sky-panel", "--sky-border", "--sky-shadow", "--sky-art-opacity", "--sky-scheme",
];
const tick = () => {
  const d = new Date();
  const h = d.getHours() + d.getMinutes() / 60;
  const sky = frameAt(h);
  const phase = moonPhase(Date.now());
  const dark = luminance(sky.mid) < 0.3;
  const svg = buildSvg(h, sky, phase);
  const st = document.body.style;
  st.setProperty("--sky-art", 'url("data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) + '")');
  st.setProperty("--sky-top", sky.top);
  st.setProperty("--sky-mid", sky.mid);
  st.setProperty("--sky-bot", sky.bot);
  // 面板色由天际色派生：深色时段压向深海军蓝，浅色时段抬向白
  const botRgb = hex2rgb(sky.bot);
  const target = dark ? [10, 17, 32] : [255, 255, 255];
  const mixT = dark ? 0.58 : 0.6;
  st.setProperty("--sky-panel", rgba(botRgb.map((v, i) => lerp(v, target[i], mixT)), dark ? 0.82 : 0.8));
  st.setProperty("--sky-border", dark ? "rgba(140,180,230,0.22)" : "rgba(40,90,150,0.16)");
  st.setProperty("--sky-shadow", dark ? "rgba(20,50,110,0.28)" : "rgba(60,110,170,0.18)");
  st.setProperty("--sky-art-opacity", dark ? "0.32" : "0.18");
  st.setProperty("--sky-scheme", dark ? "dark" : "light");
  writeMode(dark);
};

// 应用异步回写模式时重新断言（与菜单 modeObserver 同策略：不一致才重写）
const observer = new MutationObserver(() => {
  if (currentDark === null) return;
  writeMode(currentDark);
});
observer.observe(document.body, { attributes: true, attributeFilter: ["class", "data-vscode-theme-kind", "data-vscode-theme-name"] });
observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

// ---------- 定时：分钟级刷新（整分钟对齐）；页面重新可见时补算（节流兜底） ----------
// 每分钟重建一次场景 SVG：单次开销 ≈ 字符串拼接 <1ms + 整屏 SVG 重栅格化 ~5ms，
// 平均 CPU 占用 <0.1%；天体分钟级位移 ≤2px、天色经 skin.css 的 @property 颜色过渡
// 平滑滑动，视觉即为连续流动。颜色过渡时长 << 刷新间隔，避免常驻逐帧重绘。
tick();
let interval = null;
const toNextMinute = 60000 - (Date.now() % 60000) + 30;
const timeout = setTimeout(() => {
  tick();
  interval = setInterval(tick, 60000);
}, toNextMinute);
const onVisible = () => {
  if (!document.hidden) tick();
};
document.addEventListener("visibilitychange", onVisible);

// ---------- 拆除：切主题/暂停时由菜单调用 ----------
return function teardown() {
  clearTimeout(timeout);
  if (interval !== null) clearInterval(interval);
  document.removeEventListener("visibilitychange", onVisible);
  observer.disconnect();
  const st = document.body.style;
  SKY_VARS.forEach((p) => st.removeProperty(p));
};
