# git-ai-commit

## 功能

- 借助 AI 生成 git commit 信息：执行 `git commit` 时，用本机已安装的 AI 编程 CLI 为暂存的改动生成一条中文、conventional commits
  格式的提交信息草稿，照常在编辑器中确认或修改。
- 支持四个后端：claude（Claude Code）、codex、pi、opencode。每台机器可以配置多个 profile，团队成员在同一仓库里可以用不同的后端，
  得到格式一致的消息。
- 输出经本地校验：类型、标题长度（按显示宽度计算，中文字符算 2 列）、语言、尾注格式、输入中不存在的 issue 编号；不合规时纠正
  一次，仍不合规就放弃。
- 后端在隔离环境中运行：临时工作目录、不获得读写文件或执行命令的工具、不加载用户的 MCP 服务器与插件、不保存会话。
- 生成失败不阻塞提交：消息文件保持原样，终端只显示一行原因，之后按 Git 原生规则继续（打开编辑器时手动填写）。
- 可选预热：暂存时就在后台提前生成，提交时直接使用结果。默认关闭。

### 已验证的平台与版本

| 项目 | macOS | Linux（Ubuntu 24.04，x86_64） |
|---|---|---|
| Node（要求 ≥ 22.18） | 22.19.0 | 22.22.2 |
| git（要求 ≥ 2.31） | 2.50.1 | 2.43.0 |
| claude | 2.1.281 | 2.1.281 |
| codex | 0.156.1 | 0.156.1（未跑合同测试） |
| pi | 0.87.1 | 0.87.1（未跑合同测试） |
| opencode | 1.18.32 | 1.18.32（未跑合同测试） |

Linux 上的 codex、pi、opencode 只验证了 `doctor` 的版本与兼容性判定和登录状态识别：验证环境访问不了这三个后端的服务，
它们的合同测试还没有在 Linux 上运行。

这些 CLI 更新很频繁。版本不在上表中、但必需的限制参数都还在时，照常调用，`git ai-commit doctor` 把它标为"未验证"；
缺少任一必需参数时判为"不兼容"，不会调用。

## 安装

### 前置条件

- **Node ≥ 22.18**（构建脚本直接运行 TypeScript 源码）。pi 本身依赖 Node；claude、codex、opencode 是原生程序，只用这三个后端时
  需要另外安装 Node。
- **git ≥ 2.31**。
- **至少一个已安装并登录的后端 CLI**：`claude`、`codex`、`pi` 或 `opencode`，并且能在终端里正常使用。

### 获取与构建

```sh
git clone <仓库地址> git-ai-commit
cd git-ai-commit
npm ci
npm run build
```

### 安装到 PATH

```sh
npm install -g .
git ai-commit --version
```

`npm install -g .` 把 `git-ai-commit` 命令装到 npm 的全局 bin 目录，之后可以用 `git ai-commit …` 调用；也可以用 `npm link`。
查看帮助用 `git ai-commit help`（`git ai-commit --help` 会被 git 改写成查找 man 手册）。

### 配置 profile

本机配置文件是 `~/.config/git-ai-commit/config.json`（设置了 `XDG_CONFIG_HOME` 时为 `$XDG_CONFIG_HOME/git-ai-commit/config.json`）。
至少需要一个 profile 和 `defaultProfile`：

```json
{
  "defaultProfile": "claude-haiku",
  "profiles": {
    "claude-haiku": { "harness": "claude", "model": "haiku" },
    "codex": { "harness": "codex", "model": "gpt-5.5", "effort": "low" },
    "pi": { "harness": "pi", "provider": "openai-codex", "model": "gpt-5.5", "effort": "low" },
    "opencode": { "harness": "opencode", "model": "deepseek/deepseek-flash" }
  }
}
```

模型请按你在该 CLI 中实际可用的填写。各后端的字段：

| harness | model | provider | effort |
|---|---|---|---|
| claude | 必填，例如 `haiku` | 不填 | 可选，传给 `--effort`；不填时关闭扩展思考，速度最快 |
| codex | 必填 | 可选，只能是内置 provider（不读取 `~/.codex/config.toml`） | 可选，推理强度，例如 `low` |
| pi | 必填，必须与 `pi --list-models <provider>` 中的模型 ID 完全一致 | 必填 | 可选，thinking 级别 |
| opencode | 必填，`provider/model` 形式 | 不填（写在 model 里） | 可选，传给 `--variant` |

每个 profile 还可以用 `executable` 指定后端可执行文件的绝对路径（默认从 PATH 查找）。其他可选字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `fallback` | `[]` | 回退链（profile 名称数组）。首选后端因额度、限流、网络、服务不可用、超时或未登录失败时，切换一次 |
| `timeoutMs` | `45000` | 一次生成的总时间预算，等待、纠正与回退共用 |
| `strict` | `false` | 为 `true` 时拒绝调用"未验证"版本的后端 |
| `debounceMs` | `1500` | 预热的去抖窗口 |

使用哪个 profile，按以下顺序取第一个有值的：`preview --profile <名称>` → 环境变量 `AI_COMMIT_PROFILE` →
本仓库的 `git config aicommit.profile` → `defaultProfile`。

### 在仓库中接入

```sh
cd <你的仓库>
git ai-commit install
```

`install` 在本仓库的默认 hooks 目录写入 `prepare-commit-msg`。这个目录由本仓库的所有 worktree 共享。

- 遇到冲突时不修改任何文件，并打印需要手动加入的一行调用。冲突包括：`core.hooksPath` 指向别的目录（例如使用 Husky、Lefthook
  等 hook 管理器），或 `prepare-commit-msg` 已经存在且不是本工具写入的。把这一行加进管理器或既有 hook 即可。
- 在终端中安装、且没有设置过 `aicommit.prewarm` 时，会询问一次是否开启预热；非交互环境保持关闭。

### 自检

```sh
git ai-commit doctor
git add <文件>
git ai-commit preview
```

`doctor` 检查 Node、git、hook、配置，以及各后端的版本、兼容状态与登录状态，不发起模型请求。`preview` 为当前暂存内容生成一条消息
并输出，不提交、不修改暂存区。

### 可选：开启预热

```sh
git ai-commit prewarm on
```

开启后，每次暂存（`git add` 等）都会在后台把暂存的差异发给后端，提前生成消息；提交时命中结果就直接使用。
**请求在暂存阶段就已发出**：之后改用 `-m`、使用跳过开关或放弃提交，都撤不回已发出的请求。需要确定不外发时，用
`AI_COMMIT_SKIP=1 git commit -m "…"`。

授权以执行时的配置为准：直接执行 `git config aicommit.prewarm false` 也能立即停止预热，不需要重新安装。仓库里的 `.ai-commit.json`
不能开启预热。

### 关闭预热与卸载

```sh
git ai-commit prewarm off
git ai-commit uninstall
```

- `prewarm off` 把 `aicommit.prewarm` 设为 `false` 并移除 `post-index-change`；`prepare-commit-msg` 与缓存保留，提交时照常生成。
- `uninstall` 终止本仓库在途的后台任务，删除所有 worktree 中的状态目录与缓存，并移除本工具写入的 hook（安装后被改过的 hook
  会保留并提示）。它不改 `aicommit.prewarm`：该项仍为 `true` 时，重新安装会直接启用预热。
- 从 PATH 中移除命令：`npm uninstall -g git-ai-commit`。

### 升级或切换 Node 之后

hook 里记录的是安装时 Node 与脚本的绝对路径。升级、切换或移动 Node 之后，在每个已接入的仓库里重新执行一次
`git ai-commit install`。路径失效时，提交不会被阻塞：终端提示一行后按 Git 原生行为继续，`git ai-commit doctor` 也会报告。

## 日常使用

| 做法 | 效果 |
|---|---|
| `git commit` | 生成草稿，写在编辑器里的注释之上，确认或修改后保存 |
| `git commit --no-edit` | 生成后直接提交，不打开编辑器 |
| `git commit -m "…"`、`git commit -F <文件>` | 使用你给的消息，不生成 |
| `AI_COMMIT_SKIP=1 git commit` | 这一次不生成；同时关闭该进程内的预热 |
| `git ai-commit preview [--profile <名称>] [--refresh]` | 只生成并输出，不提交；`--refresh` 忽略缓存重新生成 |
| `AI_COMMIT_PROFILE=codex git commit` | 这一次改用另一个 profile |
| `git config aicommit.profile pi` | 本仓库改用另一个 profile（`git config --unset aicommit.profile` 恢复默认） |

- 模板或消息文件里已经有正文（例如 `commit.template` 写好了标题）、`--amend`、合并、rebase、cherry-pick、revert 时不生成。
- 生成期间按 Ctrl-C 会中止这次提交。
- 仓库可以用 `.ai-commit.json` 统一格式要求，例如：

  ```json
  { "language": "zh-CN", "headerMaxWidth": 72, "scopeRules": { "src/api/**": "api" }, "exclude": ["*.secret"] }
  ```

  可用字段：`language`、`headerMaxWidth`、`headerMaxLength`、`lengthUnit`、`types`、`scopeRules`、`maxInputBytes`、
  `maxPerFileBytes`、`bodyMaxItems`、`bodyMaxItemLength`、`exclude`、`statOnly`（后两项只能在内置清单上追加）。
  这个文件不能包含凭证、命令、后端选择、回退链或预热开关，出现时会被拒绝并在 `doctor` 中提示。

### GUI 客户端

- 客户端需要执行原生 git hook。直接用 libgit2 等库提交、不运行 hook 的客户端不会生成。
- 大多数客户端会把输入框里的内容用 `-m` 传给 git，此时不生成；输入框留空提交时，是否生成取决于客户端的实现。
- hook 使用安装时记录的 Node 绝对路径，GUI 环境的 PATH 里没有 Node 也能运行。

## 已知限制

- **秘密排除基于路径模式**：`.env`、`*.pem`、`*.key`、`id_rsa` 等文件不会发送，但写在普通源码文件里的密钥会随差异一起发给后端。
  提交前请自行检查。
- 消息文件里已有 `--trailer` 添加的尾注时视为已有正文，不生成。
- 使用 `--allow-empty-message` 或 `commit.cleanup=verbatim` 时，如果生成失败，会按 Git 原生行为提交（可能是空消息）。
- 不支持在同一个 worktree 里同时进行多个提交操作。
- opencode 没有关闭会话记录的参数：本工具在每次调用后删除本次会话，调用被中断时可能残留，`doctor` 会列出。
- codex 以 `--ignore-user-config` 运行：`~/.codex/config.toml` 中自定义的 model provider 不可用。
- 仓库还没有任何提交时不预热，第一次提交走同步生成。

## 开发

```sh
npm ci
npm test                                   # 构建并运行单元测试与集成测试
AI_COMMIT_CONTRACT=1 npm test              # 另外运行合同测试（真实调用本机的后端，会消耗额度）
npm run build && AI_COMMIT_CONTRACT=1 node --test --test-concurrency=1 --test-name-pattern="[Cc]laude" "test/contract/*.test.ts"   # 只运行 claude 的合同测试
npm run build && AI_COMMIT_PERF=1 node --test --test-concurrency=1 "test/perf/*.test.ts"   # 性能测量（单独运行）
```

合同测试观察后端子进程时依赖 `ps`（Linux 上需要安装 procps）；单元测试与集成测试在有 `/proc` 的系统上不依赖它。

规格在 `openspec/specs/`；设计文档、提案与任务清单已归档在 `openspec/changes/archive/2026-09-24-ai-commit-message/`。
