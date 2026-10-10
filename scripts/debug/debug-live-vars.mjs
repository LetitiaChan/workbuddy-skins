// 临时诊断脚本：读取关键 CSS 变量计算值 + 推荐区 DOM 状态 + dismissal 状态
import { fetchRendererTargets, CdpSession } from "../src/cdp-client.mjs";

const EXPRESSION = `(() => {
  const cs = getComputedStyle(document.body);
  const vars = {};
  for (const name of [
    "--wb-bg-primary", "--wb-bg-secondary", "--wb-bg-hover", "--wb-bg-active",
    "--cb-bg-primary", "--cb-bg-secondary",
    "--wb-palette-gray-1", "--wb-palette-gray-3",
    "--wb-quick-actions-fade-bg",
    "--wb-home-composer-card-bg", "--wb-home-composer-sub-card-bg",
    "--wb-color-bg-primary", "--wb-color-bg-primary-hover",
    "--wb-surface", "--wb-text", "--wb-accent",
  ]) vars[name] = cs.getPropertyValue(name).trim() || null;

  const q = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { bg: s.backgroundColor, bgImage: s.backgroundImage.slice(0, 120), w: Math.round(r.width), h: Math.round(r.height) };
  };

  const dismissalKeys = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && (k.includes("skill-recommend") || k.includes("dismiss"))) {
      dismissalKeys.push({ key: k, value: (localStorage.getItem(k) || "").slice(0, 80) });
    }
  }

  return {
    skin: document.documentElement.dataset.workbuddySkin ?? null,
    themeName: document.body.dataset.vscodeThemeName ?? null,
    bodyClass: document.body.className.slice(0, 120),
    vars,
    dom: {
      skillRecommend: q(".wb-home-composer__skill-recommend"),
      chips: q(".wb-home-composer__chips"),
      quickActions: q(".quick-actions"),
      fadeRight: q(".quick-actions--fade-right"),
      composerChip: q(".wb-home-composer__chip"),
      qaItem: q(".wb-home-composer__chips .quick-actions__item"),
      homePage: q(".wb-home-page"),
      homeRoute: q(".wb-home-route"),
    },
    dismissalKeys,
  };
})()`;

const targets = await fetchRendererTargets(9223);
for (const target of targets) {
  const session = new CdpSession(target.webSocketDebuggerUrl);
  try {
    await session.open();
    const result = await session.evaluate(EXPRESSION, { timeoutMs: 10000 });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    session.close();
  }
}
