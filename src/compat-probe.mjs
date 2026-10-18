// doctor 的 WorkBuddy 适配预警：探测宿主应用是否大改版。
//
// 从 injector.mjs 拆出的理由：这 100 行与注入编排零耦合——不读主题、不生成 CSS、
// 不碰视频，只做「量测原生界面 + 聚合判定 + 产出人类可读预警」。
// 它是 doctor 的业务逻辑，而 injector 不应该知道「doctor 需要什么」。
// 探测表达式按 renderer-snippets 的惯例以字符串形态内联，会话编排复用 renderer-session。

import { STYLE_ID } from "./constants.mjs";
import { evaluateTargets, resolveDeps } from "./renderer-session.mjs";

// ---- doctor 适配预警：探测 WorkBuddy 大改版 ----
// 皮肤机制的两个根基：body[data-application-name=workbuddy] 上的 --cb-* 设计变量系统
// （换色核心，实测 60+ 个）与 [data-view-id] DOM 锚点（容器透化/磨砂的作用对象）。
// 大改版若改掉任一者，皮肤会大面积失效，doctor 主动探测给出预警
export const EXPECTED_VIEW_IDS = ["sidebar", "main-content", "detail-panel"];

// 探测变量名单（14 个，2026-10 实测原生全部存在）：覆盖块核心变量 + 两个未被皮肤
// 覆盖的原生变量（team-member-card / markdown-hr）——皮肤 <style> 被禁用后仍能量测，
// 但保留未覆盖样本可防御未来探测逻辑变动。getComputedStyle 的索引枚举不含自定义属性
// （实测 length 395 个标准属性、--cb-* 为 0），必须按名单逐个 getPropertyValue
export const CB_PROBE_VARS = [
  "--cb-bg-primary",
  "--cb-bg-secondary",
  "--cb-panel-bg-primary",
  "--cb-text-primary",
  "--cb-text-secondary",
  "--cb-text-link",
  "--cb-vscode-editor-background",
  "--cb-vscode-foreground",
  "--cb-sidebar-bg",
  "--cb-hover-bg",
  "--cb-button-dark-background",
  "--cb-stroke-secondary",
  "--cb-team-member-card-background",
  "--cb-markdown-hr-border-color",
];

// 量测的是原生界面：临时禁用皮肤 <style>（getComputedStyle 同步重算），否则注入的
// --cb-* 覆盖会伪装成原生支持；finally 里恢复，探测对运行中的皮肤无副作用
const COMPAT_PROBE_EXPRESSION = `(() => {
  const style = document.getElementById(${JSON.stringify(STYLE_ID)});
  if (style) style.disabled = true;
  try {
    const body = document.body;
    const appMarker = body ? body.getAttribute("data-application-name") : null;
    const found = [];
    const missing = [];
    if (body) {
      const computed = getComputedStyle(body);
      for (const name of ${JSON.stringify(CB_PROBE_VARS)}) {
        (computed.getPropertyValue(name).trim() ? found : missing).push(name);
      }
    }
    const viewIds = new Set();
    const nodes = document.querySelectorAll("[data-view-id]");
    for (let i = 0; i < nodes.length; i += 1) viewIds.add(nodes[i].getAttribute("data-view-id"));
    return { appMarker, cbVarCount: found.length, missingCbVars: missing, viewIds: Array.from(viewIds) };
  } finally {
    if (style) style.disabled = false;
  }
})()`;

// 多 target 聚合：锚点取并集、变量命中取最大、缺失变量取交集（任一窗口健康即可证明原生结构还在）
export function summarizeCompatProbes(probes) {
  const viewIds = new Set();
  let cbVarCount = 0;
  let missingCbVars = null;
  let appMarker = null;
  for (const probe of probes) {
    if (!probe) continue;
    if ((probe.cbVarCount ?? 0) > cbVarCount) {
      cbVarCount = probe.cbVarCount;
      missingCbVars = probe.missingCbVars ?? [];
    }
    for (const id of probe.viewIds ?? []) viewIds.add(id);
    appMarker ??= probe.appMarker;
  }
  missingCbVars ??= [...CB_PROBE_VARS];
  const missingViewIds = EXPECTED_VIEW_IDS.filter((id) => !viewIds.has(id));
  const warnings = [];
  if (appMarker !== "workbuddy") {
    warnings.push(`body[data-application-name] 为 ${JSON.stringify(appMarker)}（期望 "workbuddy"），变量覆盖块将整体失效`);
  }
  if (missingCbVars.length > 0) {
    warnings.push(`--cb-* 设计变量缺失 ${missingCbVars.length}/${CB_PROBE_VARS.length}：${missingCbVars.join("、")}，全局换色将失效`);
  }
  if (missingViewIds.length > 0) {
    warnings.push(`[data-view-id] 锚点缺失：${missingViewIds.join("、")}，容器透化/磨砂将失效`);
  }
  return {
    ok: warnings.length === 0,
    appMarker,
    cbVarCount,
    cbVarProbed: CB_PROBE_VARS.length,
    missingCbVars,
    viewIds: [...viewIds].sort(),
    missingViewIds,
    warnings: warnings.map((text) => `WorkBuddy 界面可能已大改版：${text}，请关注仓库更新`),
  };
}

// 一次性探测（不等待重试）：WorkBuddy 未以 CDP 端口运行时快速失败，由 doctor 降级展示
export async function probeRendererCompat({ port, deps = {} }) {
  const { fetchTargets, Session } = resolveDeps(deps);
  const targets = await fetchTargets(port);
  if (targets.length === 0) return { reachable: false, reason: "未发现渲染进程 target（WorkBuddy 未以调试端口运行）" };
  const probes = await evaluateTargets(targets, COMPAT_PROBE_EXPRESSION, Session);
  return { reachable: true, targets: targets.length, ...summarizeCompatProbes(probes) };
}
