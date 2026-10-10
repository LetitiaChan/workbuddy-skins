// 临时诊断脚本：探测当前渲染进程视图与首页推荐条带
import { fetchRendererTargets, CdpSession } from "../src/cdp-client.mjs";

const EXPRESSION = `(() => {
  const out = {
    url: location.href.slice(0, 120),
    hash: location.hash,
    skin: document.documentElement.dataset.workbuddySkin ?? null,
    styleInstalled: Boolean(document.getElementById("workbuddy-skin-style")),
    homeRoute: Boolean(document.querySelector(".wb-home-route")),
    homePage: Boolean(document.querySelector(".wb-home-page")),
    mainContent: Boolean(document.querySelector('[data-view-id="main-content"]')),
    bodyTextSample: (document.body.innerText || "").slice(0, 400),
  };
  // 搜索包含关键词的任意元素（不限文本节点精确匹配）
  const hits = [];
  const keywords = ["为你推荐", "推荐", "沙箱内拉取", "受限网络"];
  const all = document.querySelectorAll("body *");
  for (const el of all) {
    if (el.shadowRoot) hits.push({ shadowHost: el.tagName + "." + String(el.className).slice(0, 80) });
    const text = el.childNodes.length === 1 && el.firstChild.nodeType === 3 ? el.textContent.trim() : "";
    if (text && keywords.some((k) => text.includes(k))) {
      const cs = getComputedStyle(el);
      hits.push({
        tag: el.tagName.toLowerCase(),
        className: String(el.className).slice(0, 140),
        text: text.slice(0, 40),
        bg: cs.backgroundColor,
      });
      if (hits.length >= 20) break;
    }
  }
  out.hits = hits;
  return out;
})()`;

const targets = await fetchRendererTargets(9223);
for (const target of targets) {
  const session = new CdpSession(target.webSocketDebuggerUrl);
  try {
    await session.open();
    const result = await session.evaluate(EXPRESSION, { timeoutMs: 15000 });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    session.close();
  }
}
