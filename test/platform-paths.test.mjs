import assert from "node:assert/strict";
import test from "node:test";

import { MACOS_APP_PATH, findInstalledApp, windowsAppCandidates } from "../src/platform-paths.mjs";

// 这些用例的价值在于：拆分前 doctor 的安装位发现直接判 process.platform，
// 非 Windows 机器上跑测试永远进不了 Windows 分支——那段路径事实上零覆盖。
// 现在 platform / env / exists 全可注入，两个平台分支都能在任意机器上断言。

test("windowsAppCandidates：按优先级产出候选，缺失的环境变量被跳过", () => {
  const full = windowsAppCandidates({
    WORKBUDDY_EXE: "D:\\custom\\WorkBuddy.exe",
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  });
  assert.deepEqual(full, [
    "D:\\custom\\WorkBuddy.exe",
    "C:\\Users\\u\\AppData\\Local\\workbuddy\\WorkBuddy.exe",
    "C:\\Users\\u\\AppData\\Local\\Programs\\workbuddy\\WorkBuddy.exe",
    "C:\\Program Files\\WorkBuddy\\WorkBuddy.exe",
    "C:\\Program Files (x86)\\WorkBuddy\\WorkBuddy.exe",
  ]);
  // 环境变量全缺时返回空数组而非含 undefined 的数组
  assert.deepEqual(windowsAppCandidates({}), []);
  // 只有 LOCALAPPDATA 时只出它派生的两条
  assert.deepEqual(windowsAppCandidates({ LOCALAPPDATA: "L" }), [
    "L\\workbuddy\\WorkBuddy.exe",
    "L\\Programs\\workbuddy\\WorkBuddy.exe",
  ]);
});

test("findInstalledApp：Windows 取第一个命中的候选（即使后面的也存在）", async () => {
  const env = { LOCALAPPDATA: "L", ProgramFiles: "P" };
  // 第 2、3 个候选都存在，必须取优先级更高的第 2 个
  const present = new Set(["L\\Programs\\workbuddy\\WorkBuddy.exe", "P\\WorkBuddy\\WorkBuddy.exe"]);
  const result = await findInstalledApp({
    platform: "win32",
    env,
    exists: async (p) => present.has(p),
  });
  assert.equal(result.platform, "win32");
  assert.equal(result.appFound, true);
  assert.equal(result.app, "L\\Programs\\workbuddy\\WorkBuddy.exe");
  assert.equal(result.candidates.length, 3);
});

test("findInstalledApp：Windows 全不命中时 appFound:false 且 app 为 null", async () => {
  const result = await findInstalledApp({
    platform: "win32",
    env: { LOCALAPPDATA: "L" },
    exists: async () => false,
  });
  assert.equal(result.appFound, false);
  assert.equal(result.app, null);
  assert.deepEqual(result.candidates, ["L\\workbuddy\\WorkBuddy.exe", "L\\Programs\\workbuddy\\WorkBuddy.exe"]);
});

test("findInstalledApp：非 Windows 走 macOS 布局，平台如实上报", async () => {
  const found = await findInstalledApp({ platform: "darwin", env: {}, exists: async () => true });
  assert.equal(found.platform, "darwin");
  assert.equal(found.app, MACOS_APP_PATH);
  assert.equal(found.appFound, true);

  // Linux 等平台如实上报 appFound:false，而不是伪装成 macOS 或抛错
  const linux = await findInstalledApp({ platform: "linux", env: {}, exists: async () => false });
  assert.equal(linux.platform, "linux");
  assert.equal(linux.appFound, false);
});

test("findInstalledApp：候选并发探测，不串行累加等待", async () => {
  let inFlight = 0;
  let peak = 0;
  const exists = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return false;
  };
  await findInstalledApp({
    platform: "win32",
    env: { LOCALAPPDATA: "L", ProgramFiles: "P", "ProgramFiles(x86)": "P86" },
    exists,
  });
  assert.ok(peak > 1, `应并发探测，实测峰值并发 ${peak}`);
});
