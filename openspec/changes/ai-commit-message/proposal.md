# Proposal

## Why

每次 `git commit` 手写提交信息是重复的机械劳动。本机已安装 codex、claude、opencode、pi 四个
harness CLI，它们各自持有可用的订阅认证，可以直接作为推理后端复用，无需另行管理 API key。

但把 agentic CLI 放进 git 提交流程有两个实测约束，决定了这个工具不能只是一个简单的封装脚本
（均为单次采样，测量条件见 design.md Context）：

- **延迟**：`claude -p` 端到端约 14s（空 prompt 即需 6.7s），`opencode run` 约 7s。若同步阻塞每一次
  `git commit`，"省时间"的初衷会被抵消。
- **可用性**：codex 与 pi 在本机共用同一份 `openai-codex` 账户额度，设计当日两者同时因额度耗尽而不可用。
  生成失败时，提交流程必须有确定、可预期的退路。

## What Changes

- 新增独立程序 `git-ai-commit`（TypeScript / Node ≥22，esbuild 打包单文件，零运行时依赖）。
- 接入 Git 原生 hook，两类 hook 使用各自的启动模板：
  - `prepare-commit-msg`（始终安装）：在 Git 打开编辑器前填入消息草稿，用户照常审阅后保存；
    `git commit --no-edit` 时直接提交生成的消息。显式消息、跳过开关等 shell 可直接识别的无需生成情形在 shell 中放行，不启动主程序。
  - `post-index-change`（仅在用户于本机开启预热后安装）：index 写入后作为"暂存内容可能变了"的提示，
    在 shell 中完成授权与过滤后，才在后台提前生成并写入缓存，使常规提交无需等待模型。**预热默认关闭**，
    因为它把数据外发的时机从提交阶段提前到了暂存阶段；每次触发都按执行时的本机配置重新确认授权。
- 四个 harness adapter（codex / claude / pi / opencode）遵循同一行为契约，通过 profile 选择；harness、provider、
  model、reasoning effort 是四个正交维度。后端版本分为兼容、未验证、不兼容三种状态。**回退链默认关闭**，
  只使用用户在本机显式配置的链。
- 统一的结构化输出协议：模型返回 `{type, scope, subject, body[], breakingChange}` 或明确的拒绝结果，
  由本程序校验并渲染；`!` 与 `BREAKING CHANGE:` 不由模型生成。
- 提交信息默认中文；完整 header 同时按显示宽度与字符串长度校验。
- 生成失败或无法完成判定时（例如运行时路径失效），消息文件保持不变并输出一行诊断，后续交给 Git 的原生规则——
  不打开编辑器且消息为空或只剩签名行时，Git 会自行中止；用户取消则取消本次提交。
- 提供 `install` / `uninstall` / `prewarm on|off` / `doctor` / `preview` 子命令。

非目标（第一版不做）：

- 改写 `--amend` 的已有消息。
- 自动集成 Husky / Lefthook / pre-commit 等 hook 管理器，以及写入任何共享或自定义的 hooks 目录。检测到时报告冲突
  并给出接入指引，不修改其配置或脚本。
- 非 conventional 格式的输出、Windows 原生支持、直连 API 后端。
- 常驻守护进程、自动拆分 commit、历史批量重写、多候选打分。

明确不做（不是推迟）：

- 编辑器停留期间的一致性复核（原计划依赖第三个 hook `commit-msg`）。实测表明本次提交的内容在
  `prepare-commit-msg` 调用前已由 Git 固定，编辑期间的暂存进入的是下一次提交，因此不存在需要复核的
  不一致（design.md D4）。

## Capabilities

### New Capabilities

- `git-integration`: git hook 接入与提交语义边界 —— 何时生成、何时原样保留消息（含消息文件中是否已有正文的判断）、
  本次提交的快照如何取得、消息文件的读写规则、失败时回到 Git 原生行为、原生 hook 的安装与卸载。
- `commit-generation`: 从快照到候选消息的生成流程 —— 采集的确定性、秘密排除、输入预算、注入防护、
  输出 schema 与拒绝结果、解析与校验、语言与长度约束、历史样本的范围。
- `harness-adapter`: 多个 CLI 后端的统一契约 —— 副作用抑制与能力矩阵、版本兼容性状态、会话记录处理、子进程环境、
  传输层解析、profile 与回退链、统一时间预算、环境诊断、递归调用防护。
- `prewarm-cache`: 可选的预热与缓存 —— 启用与运行时授权、显式消息与预热的边界、触发与过滤、发送前复核、
  任务登记与接管、并发、缓存键构成、结果发布、卸载与清理。

### Modified Capabilities

（无。`openspec list --specs` 确认本项目当前没有任何已有 spec。）

## Impact

- **新建仓库**：目前仅有 README 与 OpenSpec 脚手架，无既有代码需要改动。
- **运行时前提**：Node ≥22。四个 harness 中只有 pi 是 Node 程序，claude、codex、opencode 都是原生二进制，
  因此只用后三者的用户需要为本工具单独安装 Node。需要免运行时分发时，以 `bun build --compile` 产出
  单文件二进制作为后路。
- **外部依赖**：不引入 npm 运行时依赖；四个 harness CLI 均为可选依赖，不可用时按失败规则处理。
- **写入范围**：
  - 本仓库自身默认 hooks 目录中属于本工具的 hook 文件。`core.hooksPath` 在任何一级配置中指向其他位置
    （包括多个仓库共用的全局目录、Husky 等管理器的目录）时，按冲突处理、不写入。默认 hooks 目录由同一仓库的
    所有 worktree 共享。
  - 每个 worktree 私有 Git 目录下的缓存目录。
  - 不修改任何一级的 `core.hooksPath`，不修改任何 hook 管理器的配置或脚本。
- **数据外发**：提交内容会发送至用户选定的后端。开启预热后，发送发生在暂存阶段；此后改用 `-m`、使用单次跳过开关
  或放弃提交，都无法撤回已发出的请求。提交命令自身对 index 的写入（包括 `git commit -m`）也可能触发预热请求；
  要确定某条命令不引发任何请求，需使用单次跳过开关。秘密排除、禁止外部 diff 转换、临时文件权限、子进程环境隔离
  与 prompt 注入防护是本变更的必要组成部分。
