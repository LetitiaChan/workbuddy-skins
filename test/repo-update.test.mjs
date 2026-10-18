import assert from "node:assert/strict";
import test from "node:test";

import { repoUpdateInfo } from "../src/repo-update.mjs";

// 拆分前这段逻辑埋在 cli.mjs 里，execFileAsync 是模块级常量、不走 deps——
// 要覆盖「ls-remote 两次回落」「分离头指针」等分支就得真有 git 和网络。
// 现在 gitOutput / exists / 版本读取全可注入，分支可确定性断言。

const gitStub = (table) => async (args) => {
  const key = args.join(" ");
  if (!(key in table)) throw new Error(`未预期的 git 调用：${key}`);
  const value = table[key];
  if (value instanceof Error) throw value;
  return value;
};

test("repoUpdateInfo：zip 安装（有 release-version.json）走 Release 检查，不碰 git", async () => {
  let gitCalled = false;
  const result = await repoUpdateInfo({
    sourceRoot: "/fake",
    deps: {
      readLocalReleaseVersion: async () => "v1.2.0",
      checkReleaseUpdate: async () => ({ checked: true, updateAvailable: false, latestVersion: "v1.2.0" }),
      gitOutput: async () => { gitCalled = true; return ""; },
      exists: async () => true,
    },
  });
  assert.equal(result.checked, true);
  assert.equal(result.latestVersion, "v1.2.0");
  assert.equal(gitCalled, false, "zip 路径不应调用 git");
});

test("repoUpdateInfo：非 git 仓库且非 zip 安装时 isRepo:false, checked:false", async () => {
  const result = await repoUpdateInfo({
    sourceRoot: "/fake",
    deps: {
      readLocalReleaseVersion: async () => null,
      exists: async () => false,
      gitOutput: async () => { throw new Error("不该被调用"); },
    },
  });
  assert.deepEqual(result, { isRepo: false, checked: false });
});

test("repoUpdateInfo：git 检出且远端领先时报告 updateAvailable 与 git pull 提示", async () => {
  const result = await repoUpdateInfo({
    sourceRoot: "/fake",
    deps: {
      readLocalReleaseVersion: async () => null,
      exists: async () => true,
      gitOutput: gitStub({
        "rev-parse HEAD": "aaaaaaaaaaaaaaaaaaaa",
        "rev-parse --abbrev-ref HEAD": "main",
        "ls-remote origin refs/heads/main": "bbbbbbbbbbbbbbbbbbbb\trefs/heads/main",
      }),
    },
  });
  assert.equal(result.isRepo, true);
  assert.equal(result.checked, true);
  assert.equal(result.branch, "main");
  assert.equal(result.head, "aaaaaaaa");
  assert.equal(result.remote, "bbbbbbbb");
  assert.equal(result.updateAvailable, true);
  assert.match(result.hint, /git pull/);
});

test("repoUpdateInfo：本地与远端一致时 updateAvailable:false 且不带 hint", async () => {
  const sha = "cccccccccccccccccccc";
  const result = await repoUpdateInfo({
    sourceRoot: "/fake",
    deps: {
      readLocalReleaseVersion: async () => null,
      exists: async () => true,
      gitOutput: gitStub({
        "rev-parse HEAD": sha,
        "rev-parse --abbrev-ref HEAD": "main",
        "ls-remote origin refs/heads/main": `${sha}\trefs/heads/main`,
      }),
    },
  });
  assert.equal(result.updateAvailable, false);
  assert.equal(result.hint, undefined);
});

test("repoUpdateInfo：同名分支不存在于远端时回落远端默认分支（HEAD）", async () => {
  const result = await repoUpdateInfo({
    sourceRoot: "/fake",
    deps: {
      readLocalReleaseVersion: async () => null,
      exists: async () => true,
      gitOutput: gitStub({
        "rev-parse HEAD": "aaaaaaaaaaaaaaaaaaaa",
        "rev-parse --abbrev-ref HEAD": "feature/local-only",
        "ls-remote origin refs/heads/feature/local-only": "", // 远端没有这个分支
        "ls-remote origin HEAD": "dddddddddddddddddddd\tHEAD",
      }),
    },
  });
  assert.equal(result.checked, true);
  assert.equal(result.remote, "dddddddd", "应回落到远端默认分支");
});

test("repoUpdateInfo：分离头指针（HEAD）直接问远端默认分支，不拼 refs/heads/HEAD", async () => {
  const result = await repoUpdateInfo({
    sourceRoot: "/fake",
    deps: {
      readLocalReleaseVersion: async () => null,
      exists: async () => true,
      gitOutput: gitStub({
        "rev-parse HEAD": "aaaaaaaaaaaaaaaaaaaa",
        "rev-parse --abbrev-ref HEAD": "HEAD",
        // 若实现拼成 refs/heads/HEAD，gitStub 会因未预期调用而抛错
        "ls-remote origin HEAD": "eeeeeeeeeeeeeeeeeeee\tHEAD",
      }),
    },
  });
  assert.equal(result.checked, true);
  assert.equal(result.remote, "eeeeeeee");
});

test("repoUpdateInfo：两次 ls-remote 都空时 checked:false 并给出原因", async () => {
  const result = await repoUpdateInfo({
    sourceRoot: "/fake",
    deps: {
      readLocalReleaseVersion: async () => null,
      exists: async () => true,
      gitOutput: gitStub({
        "rev-parse HEAD": "aaaaaaaaaaaaaaaaaaaa",
        "rev-parse --abbrev-ref HEAD": "main",
        "ls-remote origin refs/heads/main": "",
        "ls-remote origin HEAD": "",
      }),
    },
  });
  assert.equal(result.isRepo, true);
  assert.equal(result.checked, false);
  assert.match(result.reason, /远端无对应分支/);
});

test("repoUpdateInfo：git 失败（离线/无 git）向上抛，由 doctor 降级", async () => {
  await assert.rejects(
    repoUpdateInfo({
      sourceRoot: "/fake",
      deps: {
        readLocalReleaseVersion: async () => null,
        exists: async () => true,
        gitOutput: async () => { throw new Error("spawn git ENOENT"); },
      },
    }),
    /ENOENT/,
  );
});
