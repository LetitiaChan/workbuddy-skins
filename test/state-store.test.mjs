import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { STATE_SCHEMA_VERSION } from "../src/constants.mjs";
import { readState, writeState } from "../src/state-store.mjs";

const freshPath = async () => join(await mkdtemp(join(tmpdir(), "wb-state-")), "state.json");

test("readState：文件不存在返回 null，不抛异常", async () => {
  assert.equal(await readState({ statePath: await freshPath() }), null);
});

test("writeState：新建写入并带 schemaVersion，读回内容一致", async () => {
  const statePath = await freshPath();
  const patch = { lastApply: { at: "2026-10-04T00:00:00Z", ok: true, themeId: "miku-light" } };
  const written = await writeState(patch, { statePath });
  assert.equal(written.schemaVersion, STATE_SCHEMA_VERSION);
  assert.deepEqual(await readState({ statePath }), written);
  // 落盘的是格式化 JSON + 尾换行
  const raw = await readFile(statePath, "utf8");
  assert.ok(raw.endsWith("}\n"));
});

test("writeState：patch 浅合并保留旧键，同名键整体替换", async () => {
  const statePath = await freshPath();
  await writeState({ lastApply: { ok: true, themeId: "a" } }, { statePath });
  const next = await writeState({ lastPause: { ok: true, removed: 2 } }, { statePath });
  assert.deepEqual(next.lastApply, { ok: true, themeId: "a" });
  assert.deepEqual(next.lastPause, { ok: true, removed: 2 });
  // 同名键整体替换而非深合并
  const replaced = await writeState({ lastApply: { ok: false, error: "boom" } }, { statePath });
  assert.deepEqual(replaced.lastApply, { ok: false, error: "boom" });
});

test("readState：损坏 JSON / 非对象内容一律回退 null", async () => {
  const dir = await freshPath();
  await writeFile(dir, "{ not json");
  assert.equal(await readState({ statePath: dir }), null);
  await writeFile(dir, "[1,2,3]");
  assert.equal(await readState({ statePath: dir }), null);
});

test("writeState：patch 非对象时拒绝写入", async () => {
  await assert.rejects(writeState(null, { statePath: await freshPath() }), TypeError);
  await assert.rejects(writeState([1], { statePath: await freshPath() }), TypeError);
});

test("writeState：并发写串行化，不丢失更新（read-modify-write 竞态回归）", async () => {
  const statePath = await freshPath();
  // 不 await 第一次就发起第二次：旧实现两者各自读到同一份（空）快照，
  // 后 rename 的那次整体覆盖，先写的键静默消失
  const [a, b] = await Promise.all([
    writeState({ lastApply: { ok: true, themeId: "miku-light" } }, { statePath }),
    writeState({ releaseCheck: { at: "2026-10-18T00:00:00Z" } }, { statePath }),
  ]);
  const final = await readState({ statePath });
  assert.ok(final.lastApply, "lastApply 不应被并发写覆盖丢失");
  assert.ok(final.releaseCheck, "releaseCheck 不应被并发写覆盖丢失");
  assert.equal(final.lastApply.themeId, "miku-light");
  assert.equal(final.releaseCheck.at, "2026-10-18T00:00:00Z");
  // 后执行的那次返回值应已包含先执行的键（串行可见性）
  const later = a.releaseCheck ? a : b;
  assert.ok(later.lastApply && later.releaseCheck, "后一次写入应看到前一次的结果");
});

test("writeState：队列中一次失败不影响后续写入", async () => {
  const statePath = await freshPath();
  const bad = writeState({ loop: { get self() { throw new Error("boom"); } } }, { statePath });
  await assert.rejects(bad);
  // 链上后续请求照常执行
  const ok = await writeState({ lastApply: { ok: true } }, { statePath });
  assert.ok(ok.lastApply.ok);
  assert.deepEqual((await readState({ statePath })).lastApply, { ok: true });
});

test("writeState：大量并发写全部生效，键不互相覆盖", async () => {
  const statePath = await freshPath();
  await Promise.all(
    Array.from({ length: 12 }, (_, i) => writeState({ [`k${i}`]: i }, { statePath })),
  );
  const final = await readState({ statePath });
  for (let i = 0; i < 12; i++) {
    assert.equal(final[`k${i}`], i, `k${i} 应存在且为 ${i}`);
  }
});
