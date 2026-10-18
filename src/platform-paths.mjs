// 平台相关的安装路径发现。
//
// 从 cli.mjs 拆出的两个理由：
//   1) 这是平台知识（Windows 的 5 个候选安装位），不是命令分发；
//   2) 原实现直接判 process.platform，导致 Linux/macOS 上跑测试永远进不了 Windows
//      分支——那段路径事实上没有测试覆盖。现在 platform 与存在性探测都可注入。
//
// Windows 候选顺序即优先级：显式环境变量 > 用户级安装 > 用户级 Programs > 系统级。
// 注意大小写混用是实测结果而非笔误：安装器在 LOCALAPPDATA 下建的是小写 "workbuddy"，
// 在 Program Files 下建的是 "WorkBuddy"。Windows 文件系统不区分大小写，
// 但把两种都列出来是为了让读代码的人知道实际布局长什么样。

export const MACOS_APP_PATH = "/Applications/WorkBuddy.app";

// 纯函数：由环境变量推出候选列表，不碰文件系统，可直接断言
export function windowsAppCandidates(env = process.env) {
  return [
    env.WORKBUDDY_EXE,
    env.LOCALAPPDATA && joinPath(env.LOCALAPPDATA, "workbuddy", "WorkBuddy.exe"),
    env.LOCALAPPDATA && joinPath(env.LOCALAPPDATA, "Programs", "workbuddy", "WorkBuddy.exe"),
    env.ProgramFiles && joinPath(env.ProgramFiles, "WorkBuddy", "WorkBuddy.exe"),
    env["ProgramFiles(x86)"] && joinPath(env["ProgramFiles(x86)"], "WorkBuddy", "WorkBuddy.exe"),
  ].filter(Boolean);
}

// 不用 node:path 的 join：候选路径是给人看和给 exists 探测用的，
// 保持与环境变量同样的分隔符风格更直观，也避免跨平台测试时被规范化掉
function joinPath(...parts) {
  return parts.join("\\");
}

// 候选并发探测而非串行短路：5 次 access 的总耗时取决于最慢那次而非累加，
// 但要保留「按优先级取第一个命中」的语义
export async function findInstalledApp({ platform = process.platform, env = process.env, exists }) {
  if (platform === "win32") {
    const candidates = windowsAppCandidates(env);
    const hits = await Promise.all(candidates.map((path) => exists(path)));
    const index = hits.indexOf(true);
    return { platform: "win32", candidates, app: index >= 0 ? candidates[index] : null, appFound: index >= 0 };
  }
  // 非 Windows 按 macOS 布局探测；平台如实上报（Linux 等会显示 appFound:false）
  return {
    platform,
    candidates: [MACOS_APP_PATH],
    app: MACOS_APP_PATH,
    appFound: await exists(MACOS_APP_PATH),
  };
}
