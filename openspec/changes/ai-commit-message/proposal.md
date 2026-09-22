# Proposal

## Why

每次 `git commit` 手写提交信息是重复的机械劳动。本机已安装 codex、claude、opencode、pi 四个
harness CLI，它们各自持有可用的订阅认证，可以直接作为推理后端复用，无需另行管理 API key。

但把 agentic CLI 塞进 git hook 有两个实测出来的硬约束，决定了这个工具不能是一个简单的封装脚本：

- **延迟**：`claude -p` 端到端 14s（其中冷启动 6.7s），`opencode run` 7s。若同步阻塞每一次
  `git commit`，"省时间"的初衷会被抵消。
- **可用性**：codex 与 pi 共用 `openai-codex` 的 OAuth 额度。设计当日实测，两者**同时**因额度
  耗尽而不可用（四个后端躺倒两个）。因此"生成失败绝不能挡住提交"与"多后端回退"不是防御性
  冗余，而是常态路径。

## What Changes

- 新增独立程序 `git-ai-commit`（TypeScript / Node ≥22，esbuild 打包单文件，零运行时依赖）。
- 接入两个薄 git hook：
  - `prepare-commit-msg` —— 在 Git 打开编辑器前填入消息草稿，用户照常审阅后保存。
  - `post-index-change` —— 在 `git add` 时后台预生成并写入缓存，使常规提交的感知延迟从
    7~14s 降至约 120ms。
- 四个 harness adapter（codex / claude / pi / opencode）统一到同一接口，通过 profile 选择；
  harness、provider、model、reasoning effort 作为四个正交维度。
- 统一的结构化输出协议：模型返回 `{type, scope, subject, body[], breakingChange}`，
  由本程序渲染成最终文本，`!` 与 `BREAKING CHANGE:` 不由模型生成。
- 提交信息默认中文，标题长度按**显示宽度**（East Asian Width）约束而非码点数。
- 提供 `install` / `doctor` / `preview` / `uninstall` 子命令。

非目标（第一版不做）：

- 改写 `--amend` 的已有消息（需要"相对父提交的完整变化"这套另一套语义，留待第二版）。
- 常驻守护进程、跨会话复用、自动拆分 commit、历史批量重写。
- 多候选生成与打分。

## Capabilities

### New Capabilities

- `git-integration`: git hook 接入与提交语义边界 —— 何时生成、何时保留用户消息、如何取得
  本次提交真正的有效 index、消息文件的读写规则、hook 安装与冲突处理。
- `commit-generation`: 从不可变 tree 快照到候选消息的生成流程 —— 上下文采集与预算、秘密
  排除、prompt 构造与注入防护、输出 schema、校验与渲染、中文格式约束。
- `harness-adapter`: 四个 CLI 后端的统一抽象 —— 调用参数映射、副作用抑制、传输层解析、
  错误分类、profile 选择与 fallback 链、环境诊断。
- `prewarm-cache`: 预热与缓存 —— 触发条件与去重、缓存键构成、失效规则、后台执行约束。

### Modified Capabilities

（无。`openspec list --specs` 确认本项目当前没有任何已有 spec。）

## Impact

- **新建仓库**：目前仅有 README 与 OpenSpec 脚手架，无既有代码需要改动。
- **运行时前提**：Node ≥22。该前提实际已被满足 —— claude、opencode、pi 三个 harness 本身
  就是 Node 生态程序。
- **外部依赖**：不通过 npm 引入运行时依赖；对四个 harness CLI 的依赖是"可选且可降级"的，
  任一不可用时由 fallback 链或转人工处理。
- **对用户仓库的影响**：只写入 hook 与 `.git/gac/` 缓存目录；不修改全局 `core.hooksPath`；
  已有 husky / lefthook / pre-commit 时追加调用而非覆盖。
- **安全面**：diff 内容会发送至云端模型，因此秘密文件排除、临时文件权限、子进程 Git 环境
  隔离与 prompt 注入防护属于本变更的必要组成部分。
