// 渲染进程会话编排：建连 / 保证关闭 / 多 target 并发求值。
//
// 从 injector.mjs 拆出的理由：这套管道原本是 injector 的私有函数，但 doctor 的兼容性
// 探测（compat-probe.mjs）同样需要它。继续留在 injector 里，compat-probe 就得反向
// 依赖「注入编排层」才能发一条 CDP 求值——方向是倒的。
// 本模块只管会话生命周期，不认识主题、CSS、视频，也不做任何业务判断。
//
// 超时与重连策略由 cdp-client 的 CdpSession 承担（connectTimeoutMs / commandTimeoutMs /
// deadline 递减），本层刻意不再叠一层超时，避免两套预算互相掩盖。

import { CdpSession, fetchRendererTargets } from "./cdp-client.mjs";

export function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

// 依赖注入点：测试传入假 Session / 假 target 发现函数，生产走真实实现
export function resolveDeps(deps = {}) {
  return {
    fetchTargets: deps.fetchRendererTargets ?? fetchRendererTargets,
    Session: deps.Session ?? CdpSession,
  };
}

export async function openSession(Session, target) {
  const session = new Session(target.webSocketDebuggerUrl);
  try {
    await session.open();
  } catch (error) {
    session.close();
    throw error;
  }
  return session;
}

export async function withSession(Session, target, run) {
  const session = await openSession(Session, target);
  try {
    return await run(session);
  } finally {
    session.close();
  }
}

// 轻量表达式（状态/暂停/读取/激活）各 target 互不依赖，并发执行；结果顺序与 targets 一致。
// 单个 target 失败（会话建立时正好导航/连接断开）不拖垮整批：拒绝位记 null，
// 调用方按语义忽略（status 该位为 null、remove/activate 只计成功数、doctor 聚合跳过空值）
export async function evaluateTargets(targets, expression, Session) {
  const settled = await Promise.allSettled(
    targets.map((target) => withSession(Session, target, (session) => session.evaluate(expression))),
  );
  return settled.map((outcome) => (outcome.status === "fulfilled" ? outcome.value : null));
}

export async function evaluateOnPort(port, expression, deps) {
  const { fetchTargets, Session } = resolveDeps(deps);
  const targets = await fetchTargets(port);
  return evaluateTargets(targets, expression, Session);
}
