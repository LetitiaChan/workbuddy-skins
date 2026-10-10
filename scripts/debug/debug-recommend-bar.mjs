// 临时诊断脚本：定位首页「为你推荐」条带的不透明白底来源
import { fetchRendererTargets, CdpSession } from "../src/cdp-client.mjs";

const EXPRESSION = `(() => {
  // 1) 找到「为你推荐」文本节点
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let labelNode = null;
  while (walker.nextNode()) {
    if (walker.currentNode.nodeValue && walker.currentNode.nodeValue.includes("为你推荐")) {
      labelNode = walker.currentNode;
      break;
    }
  }
  if (!labelNode) return { found: false };

  // 2) 从文本节点向上走，收集每一层的 tag/class 与关键计算样式
  const chain = [];
  let el = labelNode.parentElement;
  for (let depth = 0; el && depth < 14; depth++, el = el.parentElement) {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    chain.push({
      depth,
      tag: el.tagName.toLowerCase(),
      className: typeof el.className === "string" ? el.className.slice(0, 160) : "",
      background: cs.background,
      backgroundColor: cs.backgroundColor,
      backgroundImage: cs.backgroundImage.slice(0, 200),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    });
  }

  // 3) 同时看整条推荐栏里的 chip 元素类名（取前 3 个兄弟/后代样本）
  const samples = [];
  const container = chain.length ? labelNode.parentElement.closest("div") : null;
  if (container) {
    const chips = container.parentElement
      ? Array.from(container.parentElement.querySelectorAll("*")).slice(0, 40)
      : [];
    for (const chip of chips) {
      const cs = getComputedStyle(chip);
      if (cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") {
        samples.push({
          tag: chip.tagName.toLowerCase(),
          className: typeof chip.className === "string" ? chip.className.slice(0, 160) : "",
          backgroundColor: cs.backgroundColor,
          text: (chip.textContent || "").trim().slice(0, 30),
        });
        if (samples.length >= 10) break;
      }
    }
  }
  return { found: true, chain, samples };
})()`;

const targets = await fetchRendererTargets(9223);
console.log(`targets: ${targets.length}`);
for (const target of targets) {
  const session = new CdpSession(target.webSocketDebuggerUrl);
  try {
    await session.open();
    const result = await session.evaluate(EXPRESSION, { timeoutMs: 10000 });
    console.log(JSON.stringify({ target: target.id, result }, null, 2));
  } finally {
    session.close();
  }
}
