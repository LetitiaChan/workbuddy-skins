// 仓库更新检查：判断本地安装是否落后于上游。
//
// 从 cli.mjs 拆出的理由：这是「怎么判断有没有新版本」的业务逻辑（含 git 探测与两次
// ls-remote 回落策略），不是参数解析与命令分发。cli 本就有一个对称的
// release-update.mjs 负责 zip 自更新，本模块补上 git 检出那一半。
//
// 两条路径：
//   zip 安装（存在打包写入的 release-version.json）→ 走 GitHub Release 检查
//   git clone → 对比本地 HEAD 与远端同名分支；该分支不存在于远端时回落远端默认分支
// 任何一步失败（无 git、非仓库、离线）都向上抛，由 doctor 降级为 checked:false，
// 不影响报告主体——更新提示是增强项，绝不允许让 doctor 整体失败。

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { readState, writeState } from "./state-store.mjs";
import { checkReleaseUpdate, readLocalReleaseVersion } from "./update-check.mjs";

const execFileAsync = promisify(execFile);

const exists = (path) => access(path).then(() => true, () => false);

// git 子进程超时：rev-parse 是纯本地操作，ls-remote 要走网络，预算分开给
const LOCAL_GIT_TIMEOUT_MS = 5000;
const REMOTE_GIT_TIMEOUT_MS = 8000;

// execFileAsync 走 deps 注入，便于测试在不装 git / 不联网的环境下覆盖两条分支
export async function repoUpdateInfo({ sourceRoot, deps = {} } = {}) {
  const runGit =
    deps.gitOutput ??
    (async (args, timeoutMs) => {
      const { stdout } = await execFileAsync("git", args, {
        cwd: sourceRoot,
        timeout: timeoutMs,
        windowsHide: true,
      });
      return stdout.trim();
    });
  const pathExists = deps.exists ?? exists;
  const releaseVersion = deps.readLocalReleaseVersion ?? readLocalReleaseVersion;
  const releaseCheck = deps.checkReleaseUpdate ?? checkReleaseUpdate;

  if (await releaseVersion({ versionFile: join(sourceRoot, "release-version.json") })) {
    return releaseCheck({ sourceRoot, readStateFile: readState, writeStateFile: writeState });
  }
  if (!(await pathExists(join(sourceRoot, ".git")))) return { isRepo: false, checked: false };

  const [head, branch] = await Promise.all([
    runGit(["rev-parse", "HEAD"], LOCAL_GIT_TIMEOUT_MS),
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], LOCAL_GIT_TIMEOUT_MS),
  ]);
  // 分离头指针（branch === "HEAD"）时没有同名远端分支可比，直接问远端默认分支
  const ref = branch && branch !== "HEAD" ? `refs/heads/${branch}` : "HEAD";
  let remote = await runGit(["ls-remote", "origin", ref], REMOTE_GIT_TIMEOUT_MS);
  if (!remote) remote = await runGit(["ls-remote", "origin", "HEAD"], REMOTE_GIT_TIMEOUT_MS);
  const remoteSha = remote.split(/\s+/)[0] ?? "";
  if (!remoteSha) return { isRepo: true, checked: false, reason: "远端无对应分支" };

  const updateAvailable = remoteSha !== head;
  return {
    isRepo: true,
    checked: true,
    branch,
    head: head.slice(0, 8),
    remote: remoteSha.slice(0, 8),
    updateAvailable,
    ...(updateAvailable ? { hint: "仓库有新版本，运行 git pull 获取最新适配" } : {}),
  };
}
