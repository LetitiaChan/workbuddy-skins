import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli.mjs";

// runCli 全部依赖可注入：这里只验证 apply 的编排（主题选择、并发加载、坏主题跳过、恢复自定义皮肤）
function applyOverrides({ saved = null, themes, failLoad = new Set() }) {
  const calls = { applySkin: null, activateSavedSkin: null, activateSavedNative: null };
  const overrides = {
    bundledThemesRoot: "bundled",
    userThemesRoot: "user",
    listThemes: async () => themes,
    readSavedActiveSkin: async () => saved,
    // 默认隔绝真实状态文件：测试不应写用户目录；需要断言时由 stateSpy 显式覆盖
    writeStateFile: async () => {},
    readStateFile: async () => null,
    loadTheme: async (path) => {
      if (failLoad.has(path)) throw new Error(`broken ${path}`);
      return { manifest: { id: path.replace(/^dir-/, "") }, path };
    },
    applySkin: async (args) => {
      calls.applySkin = args;
      return { applied: 1, themeId: args.activeId === undefined ? args.loadedTheme.manifest.id : args.activeId };
    },
    activateSavedSkin: async (args) => {
      calls.activateSavedSkin = args;
      return { activated: 1 };
    },
    activateSavedNative: async (args) => {
      calls.activateSavedNative = args;
      return { activated: 1 };
    },
  };
  return { overrides, calls };
}

const THEMES = ["miku-light", "a", "b"].map((id) => ({ id, path: `dir-${id}` }));

test("apply --theme：坏主题不进菜单，菜单保持 listThemes 顺序", async () => {
  const { overrides, calls } = applyOverrides({ themes: THEMES, failLoad: new Set(["dir-a"]) });
  const result = await runCli(["apply", "--theme", "b"], overrides);
  assert.equal(result.themeId, "b");
  assert.deepEqual(calls.applySkin.themes.map(({ manifest }) => manifest.id), ["miku-light", "b"]);
  assert.equal(calls.applySkin.loadedTheme, calls.applySkin.themes[1]); // 选中主题只加载一次并复用
});

test("apply --theme：选中主题本身加载失败时直接报错", async () => {
  const { overrides } = applyOverrides({ themes: THEMES, failLoad: new Set(["dir-b"]) });
  await assert.rejects(runCli(["apply", "--theme", "b"], overrides), /broken dir-b/);
});

test("apply 无 --theme：恢复上次记住的自定义皮肤（先默认主题注入，再激活）", async () => {
  const { overrides, calls } = applyOverrides({ saved: "custom-xyz", themes: THEMES });
  const result = await runCli(["apply"], overrides);
  assert.equal(calls.applySkin.activeId, null);
  assert.deepEqual(calls.activateSavedSkin, { port: 9223, id: "custom-xyz", fallbackId: "miku-light" });
  assert.equal(result.themeId, "custom-xyz");
  assert.equal(result.restored, true);
});

test("apply 无 --theme：记住的内置主题已不存在时回退默认主题", async () => {
  const { overrides, calls } = applyOverrides({ saved: "gone", themes: THEMES });
  const result = await runCli(["apply"], overrides);
  assert.equal(result.themeId, "miku-light");
  assert.equal(calls.activateSavedSkin, null);
});

test("apply 无 --theme：恢复上次选中的原生浅色/深色（注入默认主题但不应用，只钉明暗）", async () => {
  for (const [saved, mode] of [["native-light", "light"], ["native-dark", "dark"]]) {
    const { overrides, calls } = applyOverrides({ saved, themes: THEMES });
    const result = await runCli(["apply"], overrides);
    assert.equal(calls.applySkin.activeId, null, `${saved} 注入时不应用任何皮肤`);
    assert.equal(calls.applySkin.loadedTheme.manifest.id, "miku-light", `${saved} 按默认主题注入菜单`);
    assert.deepEqual(calls.activateSavedNative, { port: 9223, mode });
    assert.equal(calls.activateSavedSkin, null);
    assert.equal(result.themeId, saved);
    assert.equal(result.restored, true);
  }
});

test("apply --theme：指定的主题不存在时报错", async () => {
  const { overrides } = applyOverrides({ themes: THEMES });
  await assert.rejects(runCli(["apply", "--theme", "nope"], overrides), /找不到主题：nope/);
});

// ---- 状态回执（state.json）：apply/pause 成功与失败都落记录，写失败不影响主流程 ----
function stateSpy() {
  const writes = [];
  return {
    writes,
    writeStateFile: async (patch) => { writes.push(patch); },
    readStateFile: async () => null,
  };
}

test("apply 成功：记录 lastApply（ok、themeId、applied）", async () => {
  const { overrides } = applyOverrides({ themes: THEMES });
  const spy = stateSpy();
  const result = await runCli(["apply", "--theme", "b"], { ...overrides, ...spy });
  assert.equal(result.themeId, "b");
  const lastApply = spy.writes.at(-1)?.lastApply;
  assert.equal(lastApply.ok, true);
  assert.equal(lastApply.themeId, "b");
  assert.equal(lastApply.applied, 1);
  assert.equal(typeof lastApply.at, "string");
});

test("apply 失败：记录 ok:false 与错误信息，错误照常抛出", async () => {
  const { overrides } = applyOverrides({ themes: THEMES });
  const spy = stateSpy();
  await assert.rejects(
    runCli(["apply", "--theme", "nope"], { ...overrides, ...spy }),
    /找不到主题：nope/,
  );
  const lastApply = spy.writes.at(-1)?.lastApply;
  assert.equal(lastApply.ok, false);
  assert.equal(lastApply.themeId, "nope");
  assert.ok(lastApply.error.includes("nope"));
});

test("apply：状态写入失败不阻断换肤结果", async () => {
  const { overrides } = applyOverrides({ themes: THEMES });
  const result = await runCli(["apply", "--theme", "b"], {
    ...overrides,
    writeStateFile: async () => { throw new Error("disk full"); },
  });
  assert.equal(result.themeId, "b");
});

// ---- 更新提示：apply/status 成功时附带 update；失败/无更新不影响结果形状 ----
const updateStub = { checked: true, channel: "release", currentVersion: "v1.0.0", latestVersion: "v1.2.0", updateAvailable: true, url: "https://example", hint: "发现新版本 v1.2.0" };

test("apply：有新版本时结果附带 update 提示；无更新时结果形状不变", async () => {
  const withUpdate = applyOverrides({ themes: THEMES });
  const updated = await runCli(["apply", "--theme", "b"], { ...withUpdate.overrides, releaseUpdate: async () => updateStub });
  assert.equal(updated.themeId, "b");
  assert.equal(updated.update.latest, "v1.2.0");
  assert.equal(updated.update.url, "https://example");

  const noUpdate = applyOverrides({ themes: THEMES });
  const plain = await runCli(["apply", "--theme", "b"], { ...noUpdate.overrides, releaseUpdate: async () => ({ ...updateStub, updateAvailable: false }) });
  assert.equal(plain.update, undefined);
});

test("apply：更新检查失败/超时静默，不换出错误也不阻塞结果", async () => {
  const { overrides } = applyOverrides({ themes: THEMES });
  const result = await runCli(["apply", "--theme", "b"], {
    ...overrides,
    releaseUpdate: async () => { throw new Error("offline"); },
  });
  assert.equal(result.themeId, "b");
  assert.equal(result.update, undefined);
});

test("status：有新版本时包装为 { targets, update }；无更新保持原样返回数组", async () => {
  const statusResult = [{ installed: true, menu: true, themeId: "miku-light" }];
  const skinStatus = async () => statusResult;
  const wrapped = await runCli(["status"], { skinStatus, releaseUpdate: async () => updateStub });
  assert.deepEqual(wrapped.targets, statusResult);
  assert.equal(wrapped.update.latest, "v1.2.0");

  const plain = await runCli(["status"], { skinStatus, releaseUpdate: async () => ({ ...updateStub, updateAvailable: false }) });
  assert.deepEqual(plain, statusResult);
});

test("updateHint：releaseUpdate 先返回时清掉超时 timer，不残留未引用句柄", async () => {
  // 回归「Promise.race 胜出后落败的 setTimeout 未 clearTimeout」——
  // 该 timer 会把 Node 事件循环顶住到点，实测曾让 runCli 70ms 返回、进程 6.5s 才退。
  // 这里直接拦 setTimeout/clearTimeout 计数：发起的每个 timer 都必须被清掉。
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const live = new Set();
  globalThis.setTimeout = (fn, ms, ...rest) => {
    const handle = realSet(fn, ms, ...rest);
    live.add(handle);
    return handle;
  };
  globalThis.clearTimeout = (handle) => {
    live.delete(handle);
    return realClear(handle);
  };
  try {
    const skinStatus = async () => [];
    await runCli(["status"], { skinStatus, releaseUpdate: async () => updateStub });
    assert.equal(live.size, 0, `应清掉全部超时 timer，残留 ${live.size} 个`);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
    live.forEach((h) => realClear(h));
  }
});

test("list：坏 theme.json 存在时连同 broken 清单一起返回，否则只返回数组", async () => {
  const good = Object.assign([{ id: "a", name: "A" }], {});
  Object.defineProperty(good, "errors", { value: [], enumerable: false });
  const plain = await runCli(["list"], {
    bundledThemesRoot: "b", userThemesRoot: "u", listThemes: async () => good,
  });
  assert.ok(Array.isArray(plain), "无坏主题时应直接返回数组");

  const withBroken = Object.assign([{ id: "a", name: "A" }], {});
  Object.defineProperty(withBroken, "errors", {
    value: [{ path: "/themes/oops", reason: "Unexpected token" }],
    enumerable: false,
  });
  const reported = await runCli(["list"], {
    bundledThemesRoot: "b", userThemesRoot: "u", listThemes: async () => withBroken,
  });
  assert.equal(reported.broken.length, 1, "坏主题应被报出而非静默消失");
  assert.equal(reported.broken[0].path, "/themes/oops");
  assert.deepEqual(reported.themes.map((t) => t.id), ["a"]);
});

test("pause：记录 lastPause（removed 数）", async () => {
  const spy = stateSpy();
  const result = await runCli(["pause"], {
    removeSkin: async () => ({ removed: 2 }),
    ...spy,
  });
  assert.equal(result.removed, 2);
  assert.deepEqual(spy.writes.at(-1).lastPause.removed, 2);
  assert.equal(spy.writes.at(-1).lastPause.ok, true);
});

// ---- doctor：Node 版本检查与状态回执一并输出 ----
// 探测/仓库检查默认走真实实现（CDP/git），测试一律注入桩保持可重复
const doctorOverrides = {
  probeRenderer: async () => ({ reachable: false, reason: "stub" }),
  repoUpdate: async () => ({ isRepo: false, checked: false }),
};

test("doctor：包含 node 版本检查结果与 statePath，state 来自状态文件", async () => {
  const state = { lastApply: { ok: true, themeId: "miku-light" } };
  const report = await runCli(["doctor"], { ...doctorOverrides, readStateFile: async () => state });
  assert.equal(report.node.ok, true);
  assert.equal(report.node.version, process.version);
  assert.equal(report.node.required, ">=18");
  assert.equal(typeof report.statePath, "string");
  assert.deepEqual(report.state, state);
});

test("doctor：状态文件读取失败时 state 为 null 且不影响报告", async () => {
  const report = await runCli(["doctor"], { ...doctorOverrides, readStateFile: async () => { throw new Error("io"); } });
  assert.equal(report.state, null);
  assert.equal(typeof report.appFound, "boolean");
});

test("doctor：兼容探测结果原样进报告（大改版预警透传），--port 透传给探测", async () => {
  const compat = {
    reachable: true,
    targets: 1,
    ok: false,
    cbVarCount: 3,
    missingViewIds: ["sidebar"],
    warnings: ["WorkBuddy 界面可能已大改版：…"],
  };
  const calls = [];
  const report = await runCli(["doctor", "--port", "9333"], {
    ...doctorOverrides,
    probeRenderer: async (args) => { calls.push(args); return compat; },
  });
  assert.deepEqual(calls, [{ port: 9333 }]);
  assert.equal(report.cdpPort, 9333);
  assert.deepEqual(report.compat, compat);
});

test("doctor：探测失败降级为 reachable:false，仓库检查失败降级为 checked:false", async () => {
  const report = await runCli(["doctor"], {
    probeRenderer: async () => { throw new Error("connect refused"); },
    repoUpdate: async () => { throw new Error("offline"); },
    readStateFile: async () => null,
  });
  assert.equal(report.compat.reachable, false);
  assert.match(report.compat.reason, /connect refused/);
  assert.equal(report.repo.checked, false);
  assert.match(report.repo.reason, /offline/);
  assert.equal(report.node.ok, true); // 降级不影响报告其余部分
});

test("doctor：仓库有更新时 hint 透传进报告", async () => {
  const report = await runCli(["doctor"], {
    ...doctorOverrides,
    repoUpdate: async () => ({ isRepo: true, checked: true, updateAvailable: true, hint: "仓库有新版本，运行 git pull 获取最新适配" }),
    readStateFile: async () => null,
  });
  assert.equal(report.repo.updateAvailable, true);
  assert.match(report.repo.hint, /git pull/);
});

test("status：透传 --port 并原样返回 skinStatus 结果", async () => {
  const calls = [];
  const result = await runCli(["status", "--port", "9333"], {
    skinStatus: async (args) => {
      calls.push(args);
      return [{ installed: true, menu: true, themeId: "miku-light" }];
    },
  });
  assert.deepEqual(calls, [{ port: 9333 }]);
  assert.deepEqual(result, [{ installed: true, menu: true, themeId: "miku-light" }]);
});

test("status：默认端口 9223；非法端口直接报错，不发起 CDP", async () => {
  const calls = [];
  await runCli(["status"], {
    skinStatus: async (args) => {
      calls.push(args);
      return [];
    },
  });
  assert.deepEqual(calls, [{ port: 9223 }]);
  await assert.rejects(runCli(["status", "--port", "80"], { skinStatus: async () => [] }), /--port/);
});
