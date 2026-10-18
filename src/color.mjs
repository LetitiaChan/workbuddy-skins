// 主题色彩的单一来源。
//
// 拆出本模块的起因是一次实测到的漂移：`DEFAULT_COLORS` 曾在三处各写一份，且值不一致——
//   theme-schema.mjs  #4BC2E0 / #AD7ED5 / #FAFAFF / #122C60（蓝紫系）
//   skin-css.mjs      #24c9d7 / #ef8fd3 / #f7fbff / #17344f（青粉系）
//   theme-store.mjs   同 skin-css（内联字面量，连常量名都没有）
// 后果：只写 `{schemaVersion, id, name, hero}` 的手写主题走 schema 得到蓝紫系，
// 而 `create` 生成的主题写进 theme.json 的是青粉系——同一个「缺省」概念两套颜色。
// 统一取青粉系：它是 `create` 实际持久化进 theme.json 的值，也是 3 处里的多数。
//
// hex 校验同样曾有两套口径：schema 严格 6 位，skin-css / skin-menu 宽松 3–8 位。
// 实测宽松侧的 3/4/5/7/8 位分支不可达（所有调用点传的都是 normalizeColors 归一后的
// 6 位值或 6 位哨兵），属于伪装成灵活性的死代码，故统一收紧到严格 6 位。

// 六位十六进制颜色。不接受 3/4/8 位简写与 alpha：主题色要进 color-mix / oklch 运算，
// 位数不定会让下游每个消费者各自判长度
export const HEX6 = /^#[0-9A-F]{6}$/i;

export function isHex6(value) {
  return typeof value === "string" && HEX6.test(value);
}

// 四色驱动的缺省值。大写形态与 normalizeColors 的归一化输出一致，
// 避免「同一个颜色在不同路径上大小写不同」导致的字符串比较意外
export const DEFAULT_COLORS = Object.freeze({
  accent: "#24C9D7",
  secondary: "#EF8FD3",
  surface: "#F7FBFF",
  text: "#17344F",
});

export const COLOR_KEYS = Object.freeze(["accent", "secondary", "surface", "text"]);

export function hexToRgb(value) {
  if (!isHex6(value)) return null;
  const v = Number.parseInt(value.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function rgbToHex(rgb) {
  return `#${rgb
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
    .join("")}`;
}

// WCAG 2.1 相对亮度（含 sRGB 线性化），返回 0..1。
// 与渲染进程里的 `lumOf` 不是一回事：后者是 0..255 的 Rec.709 加权亮度，
// 用于「挑主色/判面板明暗」这类感知近似，不需要线性化开销。对比度计算必须用本函数。
export function relativeLuminance(value) {
  const rgb = hexToRgb(value);
  if (!rgb) return null;
  const linear = rgb.map((channel) => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

// WCAG 对比度，1..21。正文文字对背景应 ≥ 4.5，非文字元素（描边/图标）应 ≥ 3
export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  if (a === null || b === null) return null;
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}
