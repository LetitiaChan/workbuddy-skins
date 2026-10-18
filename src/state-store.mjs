import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { STATE_SCHEMA_VERSION, resolveStudioPaths } from "./constants.mjs";

// 状态回执（state.json）：记录最近一次 apply / pause 的结果，
// 供 doctor 展示「上次注入于何时、哪个主题、是否成功」，升级失效时诊断更直接。
// 只增不改语义：patch 按键浅合并，lastApply / lastPause 各自整体替换。

export async function readState({ statePath } = {}) {
  const path = statePath ?? resolveStudioPaths().statePath;
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    // 只接受扁平对象：数组/标量/ null 视为损坏，等同不存在
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // 文件不存在 / JSON 损坏 / 权限不足：状态是诊断增强项，一律回退 null 不报错
    return null;
  }
}

// 写入串行化：writeState 是 read-modify-write，并发调用会丢失更新——
// 后 rename 的那次用的是自己读到的旧快照，先写的字段被整体覆盖掉。
// 这不是假想：cli 的 updateHint 在后台写 releaseCheck（update-check），
// 主流程同时写 lastApply，两者天然并发。按 statePath 维度挂一条 Promise 链，
// 同一文件的写请求排队执行；失败不污染后续（catch 后继续接链）。
const writeQueues = new Map();
function enqueueWrite(path, task) {
  const prev = writeQueues.get(path) ?? Promise.resolve();
  const run = prev.then(task, task);
  // 队尾只用于排序，不保留结果与异常，避免 unhandled rejection
  const tail = run.then(
    () => {},
    () => {},
  );
  writeQueues.set(path, tail);
  // 链排空后清理，避免长生命周期进程里 Map 无界增长
  tail.then(() => {
    if (writeQueues.get(path) === tail) writeQueues.delete(path);
  });
  return run;
}

export async function writeState(patch, { statePath } = {}) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new TypeError("state patch must be a plain object");
  }
  const path = statePath ?? resolveStudioPaths().statePath;
  return enqueueWrite(path, async () => {
    const current = (await readState({ statePath: path })) ?? {};
    const next = { ...current, ...patch, schemaVersion: STATE_SCHEMA_VERSION };
    await mkdir(dirname(path), { recursive: true });
    // 原子写入：先写临时文件再 rename，进程中断也不会留下半个 JSON。
    // 随机后缀防跨进程并发写撞名（同进程内已由 enqueueWrite 串行化）
    const tmp = `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
    await rename(tmp, path);
    return next;
  });
}
