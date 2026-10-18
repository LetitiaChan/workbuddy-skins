// 幂等地给 tdp-pro / tdp-pro-dark 的 skin.css 打上「动画图层提升 + 减弱动效降级」补丁。
// 做成脚本而非手工编辑的理由：两个孪生主题必须逐字节一致（test/bundled-themes 有护栏），
// 且补丁点有 10 处，手工同步两份极易漏。重复执行不会叠加。
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PRIMARY = join(root, "themes", "tdp-pro", "skin.css");
const TWIN = join(root, "themes", "tdp-pro-dark", "skin.css");

// [锚点, 紧随锚点插入的声明]。锚点必须唯一且已存在，否则报错而不是静默跳过。
const LAYER_PATCHES = [
  [
    "  pointer-events: none;\n  transition: opacity .4s ease;\n}",
    `  pointer-events: none;
  transition: opacity .4s ease;
  /* 常驻提升为独立合成层：本层 64vh×70vh 且 z-index:-1 会被拉进根滚动层的绘制序列，
     内部又挂着 7 条 infinite 动画——不提升则每帧动画都让下方整页参与重绘。
     注意不要加 contain: paint：.tdp-vis 是 overflow:visible !important、
     .tdp-orbit--3 宽 126%，子元素按设计溢出本盒，paint containment 会裁掉轨道环。 */
  will-change: opacity;
}`,
  ],
  [
    "  animation: tdp-hero-float 3.8s ease-in-out infinite;\n\n  background:\n    radial-gradient(circle at 28% 24%",
    `  animation: tdp-hero-float 3.8s ease-in-out infinite;
  /* 37.5vh 的圆顶叠了 3 层 box-shadow + 2 层 radial-gradient，不提升图层则每帧都要
     重绘这整套渐变与投影；提升后动画退化为合成器上的纯 transform */
  will-change: transform;

  background:
    radial-gradient(circle at 28% 24%`,
  ],
  [
    "  animation: tdp-orbit-spin 18s linear infinite;\n}",
    "  animation: tdp-orbit-spin 18s linear infinite;\n  will-change: transform;\n}",
  ],
  [
    "  animation: tdp-orbit-spin 28s linear infinite reverse;\n}",
    "  animation: tdp-orbit-spin 28s linear infinite reverse;\n  will-change: transform;\n}",
  ],
  [
    "  animation: tdp-float 5s ease-in-out infinite;\n  pointer-events: none;\n}",
    `  animation: tdp-float 5s ease-in-out infinite;
  /* 带 box-shadow 发光的小光点：提升图层让发光只烘一次，动画走合成器 */
  will-change: transform;
  pointer-events: none;
}`,
  ],
  [
    "  animation: tdp-float 6s ease-in-out infinite -1s;\n}",
    "  animation: tdp-float 6s ease-in-out infinite -1s;\n  will-change: transform;\n}",
  ],
  [
    "  animation: tdp-float 7s ease-in-out infinite -3s;\n}",
    "  animation: tdp-float 7s ease-in-out infinite -3s;\n  will-change: transform;\n}",
  ],
  [
    "  animation: tdp-float 5.5s ease-in-out infinite -2.5s;\n}",
    "  animation: tdp-float 5.5s ease-in-out infinite -2.5s;\n  will-change: transform;\n}",
  ],
  [
    `    drop-shadow(0 16px 40px color-mix(in srgb, var(--tdp-primary) 28%, transparent));
  animation: tdp-hero-float 3.8s ease-in-out infinite;
}`,
    `    drop-shadow(0 16px 40px color-mix(in srgb, var(--tdp-primary) 28%, transparent));
  animation: tdp-hero-float 3.8s ease-in-out infinite;
  /* 全主题最重的一处：animated transform 叠两层 drop-shadow（36px/40px 高斯模糊）。
     不提升图层时每帧都要重跑整条 filter 管线，而不是只做合成层位移；
     提升后 filter 只在建层时烘一次进纹理，动画变成对该纹理的 transform。 */
  will-change: transform;
}`,
  ],
  [
    "  animation: tdp-float 4.2s ease-in-out infinite;\n}",
    "  animation: tdp-float 4.2s ease-in-out infinite;\n  will-change: transform;\n}",
  ],
];

const REDUCED_MOTION_BLOCK = `
/* 减弱动效降级：本主题有 7 条 infinite 动画（圆顶 / 双轨道 / 5 个发光点 / 头像浮动），
   原先无任何 prefers-reduced-motion 保护——系统开了减弱动效仍会永久跑。
   命中时一并撤掉 will-change：动画停了就不需要常驻合成层，留着白占显存。
   hero 层的 opacity transition 同样关掉（切页时的 .4s 淡变纯属装饰）。 */
@media (prefers-reduced-motion: reduce) {
  #tdp-hero-visual {
    transition: none;
    will-change: auto;
  }

  #tdp-hero-visual .tdp-dome,
  #tdp-hero-visual .tdp-orbit--1,
  #tdp-hero-visual .tdp-orbit--2,
  #tdp-hero-visual .tdp-vis::before,
  #tdp-hero-visual .tdp-vis::after,
  #tdp-hero-visual .tdp-deco--a,
  #tdp-hero-visual .tdp-deco--b,
  #tdp-hero-visual .tdp-deco--c,
  #tdp-hero-visual .tdp-spaceman__img,
  .claw-agent-chat-pane .colleague-chat-empty-profile__avatar[data-cloud-assistant="true"],
  .claw-agent-chat-pane .colleague-chat-empty-profile__avatar.colleague-card-avatar--image[data-cloud-assistant="true"] {
    animation: none !important;
    will-change: auto;
  }
}
`;

let css = await readFile(PRIMARY, "utf8");
let applied = 0;

for (const [anchor, replacement] of LAYER_PATCHES) {
  if (css.includes(replacement)) continue; // 已打过
  const hits = css.split(anchor).length - 1;
  if (hits !== 1) {
    throw new Error(`锚点命中 ${hits} 次（应为 1），补丁不安全：\n${anchor.slice(0, 80)}…`);
  }
  css = css.replace(anchor, replacement);
  applied += 1;
}

if (!css.includes("prefers-reduced-motion")) {
  css = `${css.replace(/\s*$/, "")}\n${REDUCED_MOTION_BLOCK}`;
  applied += 1;
}

await writeFile(PRIMARY, css, "utf8");
await writeFile(TWIN, css, "utf8");

console.log(`已应用 ${applied} 处改动`);
console.log(`will-change 共 ${css.split("will-change").length - 1} 处`);
console.log(`prefers-reduced-motion 块 ${css.includes("prefers-reduced-motion") ? "已就位" : "缺失"}`);
