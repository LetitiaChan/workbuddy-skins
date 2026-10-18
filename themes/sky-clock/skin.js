/* Sky Clock · 四时天空 —— 主题伴随脚本（new Function 函数体，返回拆除回调）。
   职责：按真实时间插值「天空时刻表」，每 30s（墙钟半分钟对齐）重建一次场景 SVG，
   预解码后单帧换图写入 body::before，同步改写 skin.css 引用的 --sky-* 变量
   与界面明暗模式（明暗翻转走 0.20–0.40 亮度过渡带 + 迟滞，在带中央一次切换）。
   带内只有主题自有的半透明浮层色（--sky-panel/border/shadow/art-opacity）连续插值；
   原生实底表面令牌一律「档内着色」，不做跨档插值——跨档插值会放大令牌间的明度
   阶梯差并落在中间调，表现为满屏轴对齐的矩形色块（详见 applySurfaces 前注释）。
   刷新为「零动画、差量写入」：每 30s 天色变化 ≤1/255，不做任何 CSS 过渡；值未变的
   变量/令牌/属性一律不写，避免无谓的全树样式重算与整屏重绘（见 tick 前注释）。
   明暗模式由本脚本接管（theme.json 声明 dynamicMode，菜单跳过钉住）；
   写类名/属性的方式与菜单 writeMode 完全一致（六个类 + themeKind/themeName +
   colorScheme），观察者在应用回写时重新断言，检查先于写入故收敛无环。
   CSP 禁 eval 时本脚本不执行，skin.css 的静态默认值与 sky.svg 兜底生效。 */

// ---------- 天空时刻表（参考真实天空色，hour 升序，24:00 回卷到 0:00 帧） ----------
// ridge 为三层山脊（远→近）：白天为绿色山峦（远雾绿→近墨绿），夜晚沉为深蓝剪影，
// 晨昏帧（6:2/17:6）改用暖紫褐剪影与霞光天空协调，向两侧时段插值自然过渡；
// stars 为该时段强度（0..1）
const FRAMES = [
  { h: 0.0,  top: "#05070F", mid: "#0B1526", bot: "#12233A", ridge: ["#0C1D31", "#081426", "#040B15"], stars: 0.90 },
  { h: 4.5,  top: "#0B1226", mid: "#18293F", bot: "#274058", ridge: ["#10273B", "#0B1B2C", "#060F1C"], stars: 0.45 },
  { h: 6.2,  top: "#33417E", mid: "#96689A", bot: "#F08A5C", ridge: ["#7A5570", "#553B55", "#382840"], stars: 0.06 },
  { h: 7.5,  top: "#5B84BC", mid: "#A9C6E4", bot: "#F4CFA6", ridge: ["#5F827E", "#41604F", "#2A4538"], stars: 0.00 },
  { h: 10.0, top: "#3D7CC2", mid: "#83B4E2", bot: "#DAEDFA", ridge: ["#7FA0A0", "#5A7F66", "#33503E"], stars: 0.00 },
  { h: 12.5, top: "#2D6CB8", mid: "#79B3E4", bot: "#EAF5FD", ridge: ["#7FA0A3", "#5A7F66", "#33503E"], stars: 0.00 },
  { h: 15.5, top: "#3A74BA", mid: "#8ABDE5", bot: "#E3F2FB", ridge: ["#7E9C97", "#587B61", "#324C3B"], stars: 0.00 },
  { h: 17.6, top: "#4B4C92", mid: "#C96B80", bot: "#FF9C5C", ridge: ["#84566B", "#5C3D4F", "#3C2A3C"], stars: 0.04 },
  { h: 19.0, top: "#262C58", mid: "#41477A", bot: "#71608C", ridge: ["#182A49", "#12203A", "#0A1526"], stars: 0.55 },
  { h: 20.8, top: "#0A0F24", mid: "#152142", bot: "#1E3354", ridge: ["#0E2138", "#0A1829", "#050C17"], stars: 0.85 },
];

// 山脊轮廓参考 sakura.svg 的三层山形（节奏更平缓，峰位错开）
const RIDGE_PATHS = [
  "M0 600 Q280 520 540 610 T1060 590 T1600 540 V900 H0Z",
  "M0 700 Q330 590 650 710 T1260 655 T1600 640 V900 H0Z",
  "M0 790 Q280 690 610 785 T1160 750 T1600 730 V900 H0Z",
];
// 星星为四角星芒（✦）：20 单位宽的凹腰十字星路径，按 r 缩放、位置平移
const SPARKLE_PATH = "M0 -10 Q1.6 -1.6 10 0 Q1.6 1.6 0 10 Q-1.6 1.6 -10 0 Q-1.6 -1.6 0 -10 Z";
const STARS = [
  [180, 160, 3], [420, 245, 2], [730, 125, 3, "#A9C7FF"], [1260, 175, 2],
  [1430, 295, 3, "#D6E4FF"], [950, 90, 2], [560, 330, 2], [1100, 260, 2],
];

// ---------- 环境探测 ----------
// 系统偏好「减弱动效」时不输出云漂移与星闪的 SMIL 节点（云/星静态保留，天色/日月照常流转）。
// typeof window 短路 + try/catch 双保险：Node 端跑测试（新 Function/lib eval）时
// window 未定义，裸调 window.matchMedia 会抛 ReferenceError；旧环境或 matchMedia
// 被劫持时同样兜底为「不降级」。写法与菜单的 reducedMotion（skin-menu.mjs）一致。
const reducedMotion = () => {
  try {
    return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};
// 顶部只探一次（该偏好整场会话基本不变）：命中时 buildSvg 不输出云漂移与星闪 SMIL
const reduceMotion = reducedMotion();

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
// 微动：每簇云缓慢漂移（SMIL，背景图内仍生效），周期长、幅度小、速度错开，
// 近似积云随风缓移；[x 往返幅度, y 沉浮分量, 周期 s, 相位偏移 s]——y 给云加 3–5px
// 轻微「浮沉」，漂移不再是贴纸平移。
// begin 锁定墙钟相位（-(epoch+dur-offset) % dur）：每 30s 重建 SVG 时 SMIL 时间线虽重启，
// 但相位由当前时间推出，位置在重建前后严格连续，不会出现跳变/闪回。
const CLOUD_DRIFT = [[36, 4, 75, 0], [-30, -3, 95, -30], [26, 3, 115, -70]];
const cloudDriftAnim = (i) => {
  if (reduceMotion) return ""; // 减弱动效：云层静态保留，不输出漂移 SMIL
  const [amp, y, dur, phase] = CLOUD_DRIFT[i % CLOUD_DRIFT.length];
  const begin = -(((Date.now() / 1000 + phase) % dur + dur) % dur);
  // keySplines 非对称：去程更慢（0.3 0 0.7 1，峰值速度低）、回程略快（0.42 0 1 1，
  // ease-in 加速推回），模拟阵风而非机械往返
  return '<animateTransform attributeName="transform" type="translate" values="0 0; ' + amp +
    ' ' + y + '; 0 0" keyTimes="0; 0.5; 1" calcMode="spline" keySplines="0.3 0 0.7 1; 0.42 0 1 1" dur="' +
    dur + 's" begin="' + begin.toFixed(1) + 's" repeatCount="indefinite"/>';
};
// 簇内差异微动：真实积云边飘边鼓，单个 blob 在整簇漂移之上叠加 additive="sum" 的
// 微小 bob（幅度 1–2px，各 blob 周期/相位错开），让云在漂移中缓慢变形而非刚体平移。
// [x 幅度, y 幅度, 周期 s]；相位由簇序 ci 与 blob 序 bi 共同错开。
// begin 同漂移一样锁定墙钟相位，30s 重建 SVG 时位置严格连续
const CLOUD_BLOB_BOB = [[1.6, 1.2, 13], [1.2, 1.8, 17], [2, 1.4, 11], [1.4, 2, 19]];
const cloudBlobBob = (ci, bi) => {
  if (reduceMotion) return ""; // 减弱动效：不输出 blob 微动 SMIL
  const [ax, ay, dur] = CLOUD_BLOB_BOB[bi % CLOUD_BLOB_BOB.length];
  const phase = ci * 5.3 + bi * 2.7; // 簇间/簇内相位错开，避免三簇同步呼吸
  const begin = -(((Date.now() / 1000 + phase) % dur + dur) % dur);
  return '<animateTransform attributeName="transform" type="translate" additive="sum" values="0 0; ' +
    ax + ' ' + ay + '; 0 0" keyTimes="0; 0.5; 1" calcMode="spline" keySplines="0.4 0 0.6 1; 0.4 0 0.6 1" dur="' +
    dur + 's" begin="' + begin.toFixed(1) + 's" repeatCount="indefinite"/>';
};
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
  if (sky.stars > 0.1) {
    // 闪烁（SMIL）：保持原 8 颗星的疏密，把「明暗反差」拉大并叠加尺寸脉动，
    // 节奏做成不对称的「闪」——暗谷偏前（keyTimes 0/0.3/1）：前 30% 快速变暗、
    // 后 70% 缓慢回亮，更像大气闪烁的"骤暗渐亮"，而非对称呼吸。
    // 另挑 2 颗（#2、#7）配 2.4s/3.0s 短周期做快闪点缀，其余 5–10s。
    // 最暗亮度与暗时收缩都按星芒尺寸 r 分级（大星更亮、收缩更小），不做统一值。
    // 星芒基线 0.32 → 0.40：原尺寸下凹腰臂宽不足 1px，被抗锯齿抹平，实测扣除本底后
    // 亮度增量只有 +1（等于没画出来），放大到亚像素之上才谈得到闪烁。
    // 门控 0.02 → 0.1：stars 低于 0.1 的黄昏/凌晨，组不透明度×层 0.35 后星星本就不可见，
    // 却仍跑 16 个 SMIL 动画、持续触发整层重绘——提前不输出省掉无谓开销。
    // 整层压暗 0.35 会吃掉对比，星星组不透明度按 sky.stars 抬 1.25 倍补偿（上限 1）。
    const starOpacity = Math.min(1, sky.stars * 1.25);
    parts += '<g opacity="' + starOpacity.toFixed(2) + '">' +
      STARS.map(([cx, cy, r, tint], i) => {
        const accent = i === 2 || i === 7;            // 两粒快闪点缀
        const dur = accent ? 2.4 + (i % 2) * 0.6 : 5 + ((i * 2.1) % 5);
        // 最暗亮度随 r 抬升：r=2 小星暗到 0.08，r=3 大星最暗也只到 0.16——大星不会暗到底
        const lo = 0.08 + (r - 2) * 0.08;
        // 暗时收缩也随 r：大星收缩更小（更接近原大小），小星缩得更明显
        const sLo = 0.8 + (r - 2) * 0.08;             // r=2→0.80，r=3→0.88
        const fill = tint || "#EAFFF8";               // 亮星偏白、个别偏蓝，冷白为默认
        // begin 锁墙钟相位：每次重建 SVG 时亮度连续，无突变
        const begin = -(((Date.now() / 1000 + i * 2.3) % dur + dur) % dur);
        const timing = ' keyTimes="0; 0.3; 1" calcMode="spline"' +
          ' keySplines="0.42 0 0.58 1; 0.42 0 0.58 1" dur="' + dur.toFixed(1) +
          's" begin="' + begin.toFixed(1) + 's" repeatCount="indefinite"/>';
        // 减弱动效：星芒静态保留（只画 path 本体，不输出明暗/尺寸 SMIL）
        const anim = reduceMotion ? "" :
          '<animate attributeName="opacity" values="1; ' + lo.toFixed(2) + '; 1"' + timing +
          '<animateTransform attributeName="transform" type="scale" additive="sum"' +
          ' values="1; ' + sLo.toFixed(2) + '; 1"' + timing;
        return '<g transform="translate(' + cx + ' ' + cy + ')">' +
          '<path d="' + SPARKLE_PATH + '" transform="scale(' + (r * 0.4).toFixed(2) + ')" fill="' + fill + '">' +
          anim + '</path></g>';
      }).join("") +
      "</g>";
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
      CLOUDS.map((c, ci) =>
        '<g>' + cloudDriftAnim(ci) +
        CLOUD_BLOBS.map(([dx, dy, rx, ry, top], bi) =>
          '<ellipse cx="' + (c.x + dx * c.s).toFixed(0) + '" cy="' + (c.y + dy * c.s).toFixed(0) +
          '" rx="' + (rx * c.s).toFixed(0) + '" ry="' + (ry * c.s).toFixed(0) +
          '" fill="' + (top ? clouds.fill : clouds.shade) + '">' + cloudBlobBob(ci, bi) + '</ellipse>'
        ).join("") + "</g>"
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
    // 光晕 = 月光的大气散射。强度带基线：0.3 + 0.7·illum——弦月/残月也有可见晕圈
    // （原直接等于 illum，月牙时 ≈0.2×端点 0.3 几乎不可见），满月最盛且晕圈最大
    if (phase.illumination >= 0.03) {
      parts += '<circle cx="' + cxI + '" cy="' + cyI + '" r="' + (r * (1.7 + 1.1 * phase.illumination)).toFixed(0) +
        '" fill="url(#moonGlow)" opacity="' + (0.3 + 0.7 * phase.illumination).toFixed(2) + '"/>';
    }
    if (phase.illumination < 0.03) {
      // 新月：只剩一圈微光轮廓
      parts += '<circle cx="' + cxI + '" cy="' + cyI + '" r="' + r + '" fill="none" stroke="#EDF2FA" stroke-opacity="0.10" stroke-width="2"/>';
    } else {
      parts += '<circle cx="' + cxI + '" cy="' + cyI + '" r="' + r + '" fill="#1B2740" fill-opacity="0.45"/>';
      parts += phase.illumination > 0.97
        ? '<circle cx="' + cxI + '" cy="' + cyI + '" r="' + r + '" fill="#EDF2FA"/>'
        : '<path d="' + moonLitPath(cx, cy, r, phase.p) + '" fill="#EDF2FA"/>';
      // 亮部已可见时不画轮廓：2px 描边在细月牙时比亮面还抢眼，月牙自身就是边缘
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
    '<radialGradient id="moonGlow"><stop stop-color="#C9D6F2" stop-opacity="0.55"/>' +
    '<stop offset="0.55" stop-color="#C9D6F2" stop-opacity="0.22"/>' +
    '<stop offset="1" stop-color="#C9D6F2" stop-opacity="0"/></radialGradient>' +
    '<radialGradient id="rosyGlow"><stop stop-color="' + (rosy ? rosy.warm : "#FFC9D6") + '" stop-opacity="0.85"/>' +
    '<stop offset="1" stop-color="' + (rosy ? rosy.warm : "#FFC9D6") + '" stop-opacity="0"/></radialGradient></defs>' +
    '<rect width="1600" height="900" fill="url(#sky)"/>' + parts + "</svg>"
  );
};

// ---------- 场景量化：把「看不见的变化」挡在整屏重栅格化之外 ----------
// 场景层只有 0.18–0.24 不透明度、叠在 body 渐变之上。1/255 的色差经 0.2 倍衰减后
// 落到 0.2/255，远在显示量化之下；天体每 30s 位移 0.86px 同样不可分辨。把场景的
// 几何时间对齐到 1 分钟、颜色对齐到 4/255 栅格后，相邻 tick 常得到完全相同的场景串，
// 签名门控（见 swapArt）即可整帧跳过（实测一天 2880 次 tick 省掉约 1/3 重栅格化）。
// 精细的天色流动由 body 渐变（满不透明度、差量硬写）承担，不受此量化影响。
const GEOM_STEP = 60;   // 秒：几何时间栅格（太阳位移 ≤1.7px/步，屏上 ≤3px）
const COLOR_STEP = 4;   // /255：场景色栅格（0.2 不透明度下屏上 ≤0.3/255）
const quantHour = (h) => Math.round((h * 3600) / GEOM_STEP) * (GEOM_STEP / 3600);
const quantHex = (hex) => rgb2hex(hex2rgb(hex).map((v) => Math.round(v / COLOR_STEP) * COLOR_STEP));
const quantScene = (sky) => ({
  ...sky,
  top: quantHex(sky.top),
  mid: quantHex(sky.mid),
  bot: quantHex(sky.bot),
  ridge: sky.ridge.map(quantHex),
});
// 场景签名：抹掉 SMIL 的 begin 相位（只影响动画起点、不改渲染结果），
// 相同签名即「渲染等价」，swapArt 据此跳过换图
const artSignature = (svg) => svg.replace(/begin="[^"]*"/g, "");

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
  "--sky-art",
  "--sky-top", "--sky-mid", "--sky-bot",
  "--sky-panel", "--sky-border", "--sky-shadow", "--sky-art-opacity", "--sky-scheme",
];
// 差量写入：body 内联样式每改一次，所有继承 --sky-* 的元素都要重算样式、整屏重绘。
// 30s 一跳的色值多数时候取整后不变——值相同就不碰 DOM
const written = new Map();
const setVar = (k, v) => {
  if (written.get(k) === v) return;
  written.set(k, v);
  document.body.style.setProperty(k, v);
};
const setData = (k, v) => {
  if (document.body.dataset[k] !== v) document.body.dataset[k] = v;
};
// ---------- 中性灰表面统一着色 ----------
// 原生深色表面分两套令牌：画布系（--wb-home-bg-*/--cr-bg-canvas/--wb-sidebar-bg/--cb-tab-*，
// 会话页/新建任务页/侧栏底）与卡片系（--wb-bg-*/--cb-bg-*，右侧详情栏/无对话任务页/弹层），
// 各视图各取一套作底。只给其中几个令牌换色，视图切换必然在灰/蓝之间跳变——逐个容器
// 钉色永远补不完。改为令牌层统一处理：扫描全部样式表的自定义属性，凡深色模式下解析为
// 不透明、近中性、偏暗的灰（原生表面阶梯），一律加同一个天色色相偏移向量。
// 偏移零均值（只加色相不改明度），原生明度阶梯原样保留，所有视图同一色调。
// 色相取自天空中带（sky.mid）：黄昏/黎明 sky.mid 偏粉紫，按 track 退回静态午夜海军蓝，
// 并对偏移分量限幅，避免面板被染成高饱和品红。
const NEUTRAL_MAX_SPREAD = 10;   // max-min ≤ 10 视为中性灰（原生 #1e2127 这类微冷灰也算）
const NEUTRAL_MAX_LEVEL = 80;    // 最亮分量 ≤ 80 才算深色表面（排除文字/亮色描边）
// 着色强度：整屏场景层（--sky-art-opacity）已叠一层天色，底色再满额加色相会双重偏蓝，
// 只取天色色相的小部分并限幅，底色呈带一丝蓝调的黑灰而非饱和海军蓝
const TINT_STRENGTH = 0.3;
const TINT_CAP = 5;              // 色相偏移单分量上限
// 排除非「实底表面」语义的令牌。前半段是前景/浮层（文字、图标、阴影、蒙版）；
// 后半段是描边类（描边不是表面，被当表面着色会把分隔线/输入框边框一起染成天色，
// 实测 19 个描边令牌被误伤：--cb-*-border / --sc-divider-* / --cb-markdown-hr-border-color
// / --cb-toggle-track-off-bg 等，表现为描边糊掉、分隔线忽明忽暗）
const TOKEN_EXCLUDE =
  /^--sky-|text|fg|foreground|icon|shadow|mask|overlay|border|divider|separator|outline|stroke|ring|underline|caret|track|thumb|scrollbar/i;
const chromaOf = (rgb) => {
  const m = (rgb[0] + rgb[1] + rgb[2]) / 3;
  return rgb.map((v) => v - m);
};
const STATIC_TINT = chromaOf(hex2rgb("#0B1526")); // 午夜天空中带的色相
// 计算后的自定义属性值 → 不透明 rgb；非纯色（color-mix/渐变/半透明）返回 null
const parseOpaque = (v) => {
  v = v.trim();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(v);
  if (m) {
    let h = m[1];
    if (h.length === 3) h = h.replace(/./g, "$&$&");
    if (h.length === 8 && h.slice(6).toLowerCase() !== "ff") return null;
    return hex2rgb("#" + h.slice(0, 6));
  }
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*(?:[,/]\s*([\d.]+%?))?\s*\)$/i.exec(v);
  if (m && (m[4] === undefined || parseFloat(m[4]) >= (m[4].endsWith("%") ? 100 : 1))) return [+m[1], +m[2], +m[3]];
  return null;
};
const isDarkNeutral = (rgb) =>
  Math.max(...rgb) - Math.min(...rgb) <= NEUTRAL_MAX_SPREAD && Math.max(...rgb) <= NEUTRAL_MAX_LEVEL;
// 浅色中性表面：同一「近中性」判定，亮度档反转（最暗分量 ≥176，排除彩色 accent 与深色）。
// 原生 IDE Light 全是中性无彩灰，与天空/山脊场景的色相脱节——浅色时段同样需要着色
const NEUTRAL_MIN_LEVEL_LIGHT = 176;
const isLightNeutral = (rgb) =>
  Math.max(...rgb) - Math.min(...rgb) <= NEUTRAL_MAX_SPREAD && Math.min(...rgb) >= NEUTRAL_MIN_LEVEL_LIGHT;
// 浅色着色强度高于深色（近白表面色相感知弱）、限幅更宽；纯白表面未被钳位的通道回落，
// 等效「压暗偏色通道」——亮度微降、色相就位，且不透明度/明度阶梯不动
const TINT_STRENGTH_LIGHT = 0.55;
const TINT_CAP_LIGHT = 9;
// 令牌名扫描（不含本主题样式表）：样式表数量变化（懒加载 chunk）时重扫
let tokenNames = [];
let sheetCount = -1;
const scanTokenNames = () => {
  const sheets = document.styleSheets;
  if (!sheets || sheets.length === sheetCount) return false;
  sheetCount = sheets.length;
  const set = new Set();
  const walk = (rules) => {
    for (const r of rules) {
      if (r.cssRules) walk(r.cssRules);
      const s = r.style;
      if (s) for (let i = 0; i < s.length; i++) if (s[i].startsWith("--") && !TOKEN_EXCLUDE.test(s[i])) set.add(s[i]);
    }
  };
  for (const ss of sheets) {
    if (ss.ownerNode && ss.ownerNode.id === "workbuddy-skin-style") continue;
    try { walk(ss.cssRules); } catch { /* 跨域样式表不可读，跳过 */ }
  }
  tokenNames = [...set];
  return true;
};
// 原生表面值缓存（按明暗分档）：读取前先撤掉本脚本写的内联值，读到的就是原生计算值
// （skin.css 的静态兜底挂在 :not([data-sky-js]) 下，js 运行时不参与）。撤与写在同一任务内
// 完成，不会出帧。两档都只收「该档的中性表面」，跨档插值已废弃（见 applySurfaces），
// 缓存无需保存彩色令牌；持久化到 localStorage，跨会话首次 tick 即可直接命中
const CACHE_KEY = "workbuddy-sky-clock:native-surfaces";
// 缓存结构变更（v1 的 light 档存了全部不透明令牌）必须换 key，否则旧缓存会被当新结构用
const CACHE_VER = "v2";
let nativeCache = { dark: null, light: null };
try {
  const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
  if (saved && typeof saved === "object" && saved.ver === CACHE_VER) {
    nativeCache = { dark: saved.dark || null, light: saved.light || null };
  }
} catch { /* 无 localStorage（测试桩/受限环境） */ }
let cacheFresh = { dark: false, light: false };
// 令牌差量写入：body 上每个 setProperty 都让继承该变量的整棵子树失效、触发全页重绘。
// 原实现每 30s 把上百个 !important 令牌整表重写一遍，哪怕值分毫未变——这是「到点抽丝
// 刷屏」的主因之一。改为维护「已写入值」表，只写变了的、只撤不再需要的
const applied = new Map();
const clearApplied = () => {
  const st = document.body.style;
  applied.forEach((_, p) => st.removeProperty(p));
  applied.clear();
};
const reconcile = (next) => {
  const st = document.body.style;
  applied.forEach((_, n) => {
    if (!next.has(n)) {
      st.removeProperty(n);
      applied.delete(n);
    }
  });
  next.forEach((v, n) => {
    if (applied.get(n) === v) return;
    applied.set(n, v);
    st.setProperty(n, v, "important");
  });
};
const readNative = (dark) => {
  if (typeof getComputedStyle !== "function") return;
  const rescanned = scanTokenNames();
  const mode = dark ? "dark" : "light";
  if (cacheFresh[mode] && !rescanned) return;
  clearApplied();
  const cs = getComputedStyle(document.body);
  const out = {};
  for (const n of tokenNames) {
    const rgb = parseOpaque(cs.getPropertyValue(n));
    // 两档各按本档的中性表面判定收集：深色档要「暗中性」，浅色档要「亮中性」。
    // 浅色档原先不过滤（彩色 accent 也进缓存），只为跨档插值取用——该路径已废弃
    if (rgb && (dark ? isDarkNeutral(rgb) : isLightNeutral(rgb))) out[n] = rgb;
  }
  nativeCache[mode] = out;
  cacheFresh = rescanned ? { dark: false, light: false, [mode]: true } : { ...cacheFresh, [mode]: true };
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ver: CACHE_VER, ...nativeCache })); } catch { /* 忽略 */ }
};
// 按当前明暗档写入全部中性表面令牌（内联 !important 压过原生规则）。
// tint / hue 分别是深色档与浅色档的天色色相向量（见 tick）。
// 先算出目标表再交给 reconcile 差量落盘，避免「清空→整表重写」的无谓重绘。
//
// ★ 这里曾经做「跨档插值」：过渡带内（flipT ∈ (0,1)）把每个令牌从浅色原生值 lerp
//   到深色值。该做法必然产出可见色块，已废弃——原因有三，均为实测：
//   1) 各令牌的浅↔深跨度互不相同（#fff→#1f1f1f 与 #f3f3f3→#252525 跨度差 10+），
//      lerp 到中段时「原本只差 1–2/255、人眼不可辨」的表面阶梯被放大到 6–18/255，
//      而且正好落在亮度最敏感的中间调区间；层层嵌套的容器（.teams-container /
//      .conversation-shell / .conversation-list / 侧栏条目）于是显形为一组
//      轴对齐的矩形色块——实测 flipT=0.72 时有 22 个元素画出 rgb(142,130,136)
//      到 rgb(160,146,154) 的不同中间调。
//   2) 中间调实底是近中性灰，与天空渐变的粉紫/蓝色族脱节，色块看起来「脏」。
//   3) 迟滞翻转（见 tick）让界面在带内仍处于上一档，深色档配中间调表面 =
//      白字压在中灰上，对比度同时受损。
//   现在改为「档内着色、翻转点硬切」：带内表面保持当前档的原生阶梯不动（只随天色
//   微调色相，幅度 ≤5/≤9 且取整），明暗切换由 writeMode 的迟滞在带中央一次完成。
//   为何不「保留渐暗但避免阶梯放大」（例如对浅色阶梯做统一亮度缩放）：表面能平滑
//   压暗，但文字令牌按设计不在改写范围内（TOKEN_EXCLUDE 排除 text/fg），
//   浅色模式的深色文字压在半暗表面上对比度会崩——可读性优先于渐变。
const applySurfaces = (dark, tint, hue) => {
  readNative(dark);
  const native = dark ? nativeCache.dark : nativeCache.light;
  const next = new Map();
  if (native) {
    // 色相偏移零均值（只加色相不改明度）：原生明度阶梯原样保留，所有视图同一色调
    const shift = dark ? tint : hue;
    for (const n in native) next.set(n, rgb2hex(native[n].map((v, i) => v + shift[i])));
  }
  reconcile(next);
};
// 明暗翻转窗口：天空中带亮度 L ∈ [0.20, 0.40] 为过渡带，flipT 0=纯亮 1=纯暗。
// 带内主题自有的半透明浮层色连续插值；原生实底表面在翻转点一次切换（见 applySurfaces）。
// 翻转点取带中央（flipT≥0.65 转暗、≤0.35 转亮）：带内不再做渐暗，若仍把翻转压到
// 带缘（旧值 0.98/0.02），黄昏会出现「全白界面 + 近夜空」持续约两小时。
// 0.30 的迟滞间隔远大于天色在带内的单步变化（30s 内 ΔflipT < 0.01），不会抖动。
// 注意：flipT 只驱动主题自有颜色，不再参与原生表面令牌的取值
const FLIP_TO_DARK = 0.65, FLIP_TO_LIGHT = 0.35;
const FLIP_HI = 0.40, FLIP_LO = 0.20;
const flipTof = (lum) => Math.min(1, Math.max(0, (FLIP_HI - lum) / (FLIP_HI - FLIP_LO)));

// ---------- 场景换图：单图层 + 签名门控 + 预解码 ----------
// 原实现用 ::before/::after 双图层做 1.2s 交叉淡化。代价是：两个全视口浮层（z-index
// 2147482900，压在整个界面之上）同时带 background-image，且 72 帧里每帧都要把两张
// 全屏 SVG 合成一次——光栅瓦片逐块提交就是用户看到的「颜色渐变抽丝刷屏」。
// 而交叉淡化本身并无必要：相邻两帧天色差 ≤1/255、天体位移 ≤1px（已实测），
// 直接换图在视觉上无法分辨。故退回单图层硬换，并加两道闸：
//   1) 签名门控（artSignature + 场景量化）——渲染等价就不换图。既省掉整屏重栅格化，
//      也让云漂移/星闪的 SMIL 时间线连续运行而不被重建打断。
//   2) 预解码——先 new Image().decode() 把新图解析完，再写入 background-image，
//      把 XML 解析/构图从绘制路径上挪走，换图成为一次原子提交。
let artKey = "";
let artInit = false;
const swapArt = (svg) => {
  const key = artSignature(svg);
  if (key === artKey) return; // 渲染结果等价：不碰 DOM，SMIL 时间线继续跑
  artKey = key;
  const url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  const commit = () => setVar("--sky-art", 'url("' + url + '")');
  // 首帧同步写入：此时 --sky-art 尚未定义，异步等待会先闪一下 skin.css 的静态兜底图
  if (artInit) {
    try {
      const img = new Image();
      img.src = url;
      if (typeof img.decode === "function") {
        img.decode().then(commit, commit);
        return;
      }
      if (!img.complete) { img.onload = commit; img.onerror = commit; return; }
    } catch { /* 无 Image（Node 测试桩/受限环境）：直接写入 */ }
  }
  artInit = true;
  commit();
};

const tick = () => {
  const d = new Date();
  const h = d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
  const sky = frameAt(h);
  const phase = moonPhase(Date.now());
  const lum = luminance(sky.mid);
  const flipT = flipTof(lum);
  // 迟滞翻转：过渡带内维持现状，避免阈值附近来回抖动
  const dark = currentDark === null
    ? flipT >= 0.5
    : (currentDark ? flipT > FLIP_TO_LIGHT : flipT >= FLIP_TO_DARK);
  // 场景几何时间对齐到 GEOM_STEP 栅格，配色走 COLOR_STEP 栅格（见上方量化说明）
  swapArt(buildSvg(quantHour(h), quantScene(sky), phase));
  setVar("--sky-top", sky.top);
  setVar("--sky-mid", sky.mid);
  setVar("--sky-bot", sky.bot);
  // 面板色由天际色派生：随 flipT 从亮侧（抬向白）连续过渡到暗侧（压向深海军蓝）
  const botRgb = hex2rgb(sky.bot);
  const target = [255, 255, 255].map((w, i) => lerp(w, [10, 17, 32][i], flipT));
  const mixT = lerp(0.6, 0.58, flipT);
  const panelRgb = botRgb.map((v, i) => lerp(v, target[i], mixT));
  setVar("--sky-panel", rgba(panelRgb, lerp(0.8, 0.82, flipT)));
  // 弹窗面板色由上方天空色派生（同 panel 混合比例）：弹窗是顶部下拉浮层，
  // 取色与视窗上半部的天色一致，而不是底部天际的暖色带
  const topRgb = hex2rgb(sky.top);
  const dialogRgb = topRgb.map((v, i) => lerp(v, target[i], mixT));
  // 边框/阴影同随 flipT 连续过渡（亮侧暖蓝灰 ↔ 暗侧冷蓝）
  const bc = [40, 90, 150].map((v, i) => lerp(v, [140, 180, 230][i], flipT));
  setVar("--sky-border", rgba(bc, lerp(0.16, 0.22, flipT)));
  const sc = [60, 110, 170].map((v, i) => lerp(v, [20, 50, 110][i], flipT));
  setVar("--sky-shadow", rgba(sc, lerp(0.18, 0.28, flipT)));
  // 夜间场景（星月/山脊剪影）需要存在感，但整屏浮层压在文字上方，过强会蒙雾发糊、
  // 白字对比度被吃掉（0.35 时白字亮度仅剩 ~65%，实测「灰蒙蒙」）——
  // 0.18（白天）→ 0.24（深夜）随 flipT 渐变，星月仍可辨而文字保持清晰
  setVar("--sky-art-opacity", lerp(0.18, 0.24, flipT).toFixed(3));
  setVar("--sky-scheme", dark ? "dark" : "light");
  // 实况色调钩子：主题选择弹窗打开时读它刷新背景/选中描边——天色每 30s 流转，
  // theme.json 里的静态 surface/accent 只是快照；mid 是当前时刻天空中间色，
  // 亮暗与明暗模式一致，弹窗文字色由菜单按亮度自适应
  setData("workbuddySkinTone", sky.mid);
  // 实况面板色钩子：弹窗背景取上方天空派生色（见上方 dialogRgb），
  // 避免直接用 sky.mid（天空中间色）或底部天际色导致色相偏差
  setData("workbuddySkinSurface", rgb2hex(dialogRgb));
  writeMode(dark);
  // 中性表面色相：入夜（track→1）跟随 sky.mid，黄昏/黎明（L(mid)≥0.15）退回静态午夜海军蓝
  const track = Math.min(1, Math.max(0, (0.15 - lum) / 0.10));
  const raw = STATIC_TINT.map((v, i) => lerp(v, chromaOf(hex2rgb(sky.mid))[i], track) * TINT_STRENGTH);
  const peak = Math.max(...raw.map(Math.abs));
  // 取整：偏移最终要落进 rgb2hex（整数通道），不取整则每 tick 的小数抖动都算「值变了」，
  // 触发 500+ 令牌的无谓重写——取整后绝大多数 tick 落在同一整数格，差量写入为零
  const tint = (peak > TINT_CAP ? raw.map((v) => (v * TINT_CAP) / peak) : raw).map(Math.round);
  // 浅色着色的天色色相向量：直接取当前天空中带色（黄昏粉紫、正午天蓝），
  // 与深色 tint 的「午夜海军蓝兜底」不同——浅色表面就活在当前天色下
  const hueRaw = chromaOf(hex2rgb(sky.mid)).map((v) => v * TINT_STRENGTH_LIGHT);
  const huePeak = Math.max(...hueRaw.map(Math.abs));
  const hue = (huePeak > TINT_CAP_LIGHT ? hueRaw.map((v) => (v * TINT_CAP_LIGHT) / huePeak) : hueRaw).map(Math.round);
  lastSurface = [dark, tint, hue];
  applySurfaces(dark, tint, hue);
};
let lastSurface = null;

// 应用异步回写模式时重新断言（与菜单 modeObserver 同策略：不一致才重写）
const observer = new MutationObserver(() => {
  if (currentDark === null) return;
  writeMode(currentDark);
});
observer.observe(document.body, { attributes: true, attributeFilter: ["class", "data-vscode-theme-kind", "data-vscode-theme-name"] });
observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
// 懒加载的样式 chunk（如助理/同事页）带来新令牌：head 增删样式节点后补扫并重写（微任务合并）
let sheetPending = false;
const sheetObserver = new MutationObserver(() => {
  if (sheetPending || !lastSurface) return;
  sheetPending = true;
  Promise.resolve().then(() => {
    sheetPending = false;
    applySurfaces(...lastSurface);
  });
});
if (document.head) sheetObserver.observe(document.head, { childList: true });

// skin.css 的实底表面静态兜底仅在 js 未运行时生效（:not([data-sky-js])），js 运行时由
// applySurfaces 从原生值统一着色
document.body.dataset.skyJs = "1";

// ---------- 定时：半分钟级刷新（对齐墙钟半分钟）；页面重新可见时补算（节流兜底） ----------
// 每 30s 重算一次天色：相邻帧天体位移 ≤1px、天色差 ≤1/255，故全程零 CSS 动画——
// 不做颜色过渡、不做图层淡化，只在值真的变了时写一次。单次开销 ≈ 字符串拼接 <1ms
// ＋（仅签名变化时）一次整屏 SVG 重栅格化；页面隐藏时浏览器自动节流，可见时补算。
tick();
let interval = null;
const toNextHalf = 30000 - (Date.now() % 30000) + 30;
const timeout = setTimeout(() => {
  tick();
  interval = setInterval(tick, 30000);
}, toNextHalf);
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
  sheetObserver.disconnect();
  const st = document.body.style;
  SKY_VARS.forEach((p) => st.removeProperty(p));
  written.clear();
  clearApplied();
  delete document.body.dataset.skyJs;
  delete document.body.dataset.workbuddySkinTone;
  delete document.body.dataset.workbuddySkinSurface;
};
