// 渲染进程侧的取色/配色纯函数（注入体片段，字符串形态）。
//
// 为什么是字符串而不是普通模块：这段代码在渲染进程里执行，由 skin-menu 拼进
// 注入体后经 CDP Runtime.evaluate 下发，无法 import。形态沿用 renderer-snippets.mjs
// 的既有惯例（BASE64_DECODE_SNIPPET / VIDEO_DB_LITERALS 同理）。
//
// 本片段零 DOM 依赖、零前向引用，是整个注入体里最干净的一刀：抽出来后既能单独阅读，
// 也让 skin-menu 的模板字面量少 55 行。
//
// 拼接位置有语义：必须排在首个使用者（paintDialogTone 读 hexToRgb、
// effectiveColors 读 buildSurfaces、importFromDataUrl 读 extractPalette）之前。
// 注入体是单一词法作用域，片段顺序即执行顺序——顺序由 skin-menu 的 RENDERER_FRAGMENTS
// 数组固化，并有测试断言，不要随意重排。

export const COLOR_UTILS_SNIPPET = String.raw`  const hex = (r, g, b) => "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const hexToRgb = (value) => {
    const m = /^#([0-9a-f]{6})$/i.exec(value || "");
    if (!m) return null;
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  };
  // Rec.709 加权亮度（0..255，不做 sRGB 线性化）。用于「挑主色 / 判面板明暗」这类
  // 感知近似，刻意不走 WCAG 的线性化：那是对比度计算用的，见 Node 侧 color.mjs。
  // 本函数是渲染进程内亮度判定的唯一实现，不要再内联复制这条公式。
  const lumOf = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  // 由主色派生浅/深两套面板底色+文字色，运行时按模式挑选（见 effectiveColors）
  const buildSurfaces = (accentRgb) => ({
    light: {
      surface: hex(...mix(accentRgb, [252, 252, 255], 0.92)),
      text: hex(...mix(accentRgb, [16, 24, 40], 0.82)),
    },
    dark: {
      surface: hex(...mix(accentRgb, [12, 12, 18], 0.86)),
      text: hex(...mix(accentRgb, [244, 246, 252], 0.85)),
    },
  });

  const extractPalette = (canvas) => {
    const ctx = canvas.getContext("2d");
    const { data: px } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const buckets = new Map();
    for (let i = 0; i < px.length; i += 4) {
      const r = px[i], g = px[i + 1], b = px[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const lum = lumOf([r, g, b]);
      const sat = max === 0 ? 0 : (max - min) / max;
      if (sat < 0.18 || lum < 24 || lum > 245) continue;   // 灰、过暗、过曝不参与取主色
      const d = max - min || 1;
      let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      const bucket = Math.round(h) % 6 * 2 + (sat > 0.55 ? 1 : 0);
      const entry = buckets.get(bucket) ?? { w: 0, r: 0, g: 0, b: 0, h: h * 60 };
      const weight = sat * sat;
      entry.w += weight; entry.r += r * weight; entry.g += g * weight; entry.b += b * weight;
      buckets.set(bucket, entry);
    }
    const ranked = [...buckets.values()].sort((a, b2) => b2.w - a.w)
      .map((e) => ({ rgb: [e.r / e.w, e.g / e.w, e.b / e.w], h: e.h, w: e.w }));
    const accent = ranked[0]?.rgb ?? [36, 201, 215];
    const second = ranked.find((e) => Math.abs(e.h - (ranked[0]?.h ?? 0)) > 50)?.rgb
      ?? mix(accent, [255, 255, 255], 0.35);
    // 明暗不再由全图平均亮度决定：同一主题生成浅/深两套 surface/text，
    // 运行时按「自动（主色亮度）/浅色/深色」三选挑选
    return {
      accent: hex(...accent),
      secondary: hex(...second),
      ...buildSurfaces(accent),
    };
  };
`;
