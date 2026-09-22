# Design

> 本文的事实基础有两个来源，文中逐处标注：
> **[实测]** = 2026-09-22 在本机（macOS 15.5 / Darwin 25.5.0、git 2.50.1、Node 22.19）
> 对已安装的四个 harness 与 git 行为的直接测量；
> **[桌面稿]** = 先行设计稿 `git-ai-commit-design.md`（基于官方文档核实，作者环境未安装这四个
> harness，另在 git 2.51.1 的临时仓库验证过 7 种提交场景的 tree 一致性）。
> 两份来源在 harness 调用面上相互印证：桌面稿引用的 `--safe-mode`、`--tools`、`--json-schema`、
> `--effort`、codex 的 `-c` 配置键、pi 的四个 `--no-*`、opencode 的 `--file/--agent/--format`
> 经 **[实测]** 逐一确认在本机存在。

## Context

动机见 `proposal.md` - Why。此处只记录塑造架构的约束。

**四个 harness 的非交互调用面高度同构** [实测]：

| harness | 一次性出参 | 抑制副作用 | 不落 session | 取结果 |
| --- | --- | --- | --- | --- |
| claude | `-p` | `--restricted` / `--tools ""` + `--disallowedTools 'mcp__*'` | `--no-session-persistence` | `--output-format json` 的 envelope |
| codex | `exec` | `-s read-only` + `-c features.shell_tool=false` 等 | `--ephemeral` | `-o <file>` 写最后一条消息 |
| pi | `-p` | `-nt --no-extensions --no-skills --no-prompt-templates --no-context-files` | `--no-session` | stdout 文本 |
| opencode | `run` | 专用 agent + `permission: deny` | （独立运行） | `--format json` 事件流 |

**真机延迟与成本** [实测]：

```
claude -p --model haiku   完整 prompt   14s     （空 prompt 6.7s，即冷启动占一半）
opencode run              完整 prompt    7s     input 13858 tokens / cost $0.0021
codex exec                              10s     失败：usage limit
pi -p                                    6s     失败：底层 openai-codex，同一份额度
node 冷启动                                60-68ms
git write-tree                             33ms
```

opencode 报告的 13858 input tokens 中，本次 prompt 仅约 200 tokens，其余为 harness 自注入的
system prompt 与工具定义 —— 这是 harness 路线的固有税，也是延迟的主要来源之一。

**后端可用性是常态问题而非异常** [实测]：`pi auth check` 显示 anthropic / openai / google 均
`not_ready`，唯一 `ready` 的 `openai-codex` 恰好额度耗尽；codex 直接报
`You've hit your usage limit ... try again at Sep 27th`。设计当日四个后端有两个不可用。

## Goals / Non-Goals

**Goals:**

- 常规 `git commit` 的感知延迟接近于零，而非把 7~14s 摊到每一次提交上。
- 生成结果始终只描述**本次真正提交的内容**，与最终 commit tree 一致。
- 任何后端故障都不改变 git 的既有行为：退回人工填写，不阻塞提交。
- 增加一个新 harness 的成本接近于"加一段配置"，而非"写一个新模块"。

**Non-Goals:**

- 不追求模型输出的语义正确性保证。结构化输出只能约束格式；默认保留编辑步骤。
- 不做常驻守护进程。预热是一次性的后台子进程。
- 不把本地 hook 当作策略边界 —— 规范的强制执行属于 `commit-msg` 与 CI。
- 不支持同一 worktree 的并发提交。

## Decisions

### D1. harness CLI 作为推理后端，而非直连 API

复用四个 CLI 已持有的订阅认证，不引入 API key 管理。代价是冷启动与冗余 system prompt
（见 Context 的实测数字）。

**备选**：直连 Anthropic / OpenAI API，同样任务约 700 tokens、1~2s。被否的理由是它与"复用
已有 harness"的出发点相悖，且引入密钥管理。架构上保留为 adapter 表中的一类后端，不在第一版实现。

### D2. 入口选 `prepare-commit-msg`

此时默认消息文件已创建、编辑器尚未打开，hook 可直接改写 Git 传入的文件 [桌面稿]。
`commit-msg` 留给最终格式检查。注意 `--no-verify` **不会**跳过 `prepare-commit-msg` [桌面稿]，
因此必须提供独立的单次跳过开关（环境变量），不能指望 `--no-verify`。

### D3. 预热：`post-index-change` + `$2` 守卫

这是本设计相对 [桌面稿] 的主要增量 —— 桌面稿是纯同步的，其缓存只在重试时生效。

git 各命令对 `post-index-change` 的触发情况 [实测]：

```
                     触发?   args        
git add               ✓     [0 1]   <- 唯一稳定的「索引被更新」
git reset             ✓     [1 0]
git commit            ✓     [0 0]
touch + git status    ✓     [0 0]
git checkout -b       ✓     [0 0]
git stash             ✓     [0 0]
git status（干净）     ✗      —
git diff --cached     ✗      —
```

`$1`=工作区被更新、`$2`=索引被更新。`[ "$2" = 1 ]` 一个判断即可把 `git add` 从噪音中精确
挑出，连 `git commit` 自身触发的那次也被过滤。

**备选**：包一层 `git` shell function。被否，因为 IDE 的 Stage 按钮、lazygit、以及 coding agent
自己执行的 `git add` 全部绕过 shell wrapper；`post-index-change` 是 git 进程级 hook，无此问题。

**备选**：监听 `.git/index` 的文件系统守护进程。被否，成本高于收益。

### D4. 快照用 `git write-tree`，且必须使用**有效 index**

`git commit -a` 与 `git commit -- <path>` 使用临时 index 而非 `.git/index`，Git 通过
`GIT_INDEX_FILE` 传给 hook [桌面稿，并经其 git 2.51.1 实测：`-a` 走 `index.lock`，pathspec
提交走另一临时 index]。硬编码 `.git/index` 会描述错误的文件集合。

`git write-tree` 本身尊重 `GIT_INDEX_FILE`，因此只要不覆盖该环境变量，正确性自动成立，并顺带
产生一个理想的降级行为：

```
普通 git commit       warm 时 tree=T1，commit 时仍为 T1   -> 命中缓存，约 120ms
git commit -a         warm 时 T1，commit 时临时 index=T2  -> 未命中，同步生成
git commit -- path    同上 = T3                           -> 未命中，同步生成
```

预热天然只服务常规提交，其余自动退回同步路径，无需额外分支逻辑。

首次提交（unborn HEAD）的基准是**按仓库对象格式计算的空 tree**，用
`git hash-object -t tree /dev/null` 取得，不得硬编码 SHA-1 的 `4b825dc6...` [桌面稿]。

### D5. 缓存键用 tree oid，不用 diff 文本摘要

同一 staged 内容在不同 git 配置下的 diff 文本哈希 [实测]：

```
               diff 文本哈希         write-tree
默认            392aabef6568ab5b     cbd8b9b6b2b3f00f...
diff.noprefix   91e2ba878bc5c524 ✗变  cbd8b9b6b2b3f00f... ✓
diff.context=1  d6304e9769a036b4 ✗变  cbd8b9b6b2b3f00f... ✓
```

diff 文本受 `diff.noprefix`、`diff.context` 等用户配置污染，tree oid 不受影响。

最终键（融合 [桌面稿] §8 的完整度与本设计的规范化）：

```
key = sha256(baseTree ‖ targetTree ‖ profileId ‖ model ‖ effort
             ‖ promptTemplateVersion ‖ configVersion ‖ redactionListVersion)
```

`promptTemplateVersion` / `configVersion` 使模板或规则变更后缓存自动失效；`profileId` / `model`
使切换后端不会误命中他人的结果。

该键同时是预热的**去重器**：误触发时 tree 未变即命中，直接 noop，零成本。与 `$2` 守卫构成双保险。

### D6. 输出协议：结构化 JSON + 本地 renderer

采纳 [桌面稿] §5。模型只返回：

```json
{ "type": "fix", "scope": "chat", "subject": "...", "body": ["...", "..."], "breakingChange": null }
```

`!` 与 `BREAKING CHANGE:` 由本程序的 renderer 依 `breakingChange` 字段统一生成，不由模型产出。
人工 trailer 单独解析后合并，不允许模型新增作者身份、签名或未提供的 issue 编号。

codex 用 `--output-schema` 原生约束；claude 在兼容版本上用 `--json-schema` 并读
`structured_output`，否则读 envelope 的 `result` 再解析候选 JSON。对不支持 schema 的后端，
保留"剥代码围栏 / 掐前言 / 长度裁剪"的文本兜底解析。

**备选**：让模型直接输出成品文本。**[实测]** 表明 `claude -p --output-format text` 的输出确实
干净（36 字节，无前言、无围栏、无 ANSI），但纯文本路径无法区分"空结果"与"调用失败"，也无法
可靠生成 breaking change 标记。故采用结构化方案，文本解析降级为兜底。

### D7. adapter 是配置表，不是每后端一个模块

四个后端的取值方式恰好落在三种策略上 [实测]：

```
claude    -> envelope    （--output-format json 的 result / structured_output）
pi        -> text        （stdout 纯文本）
codex     -> file        （-o <file>）
opencode  -> jsonl       （事件流中最后一条 assistant text）
```

因此 `backend/` 下不存在 per-harness 文件：harness 定义是数据，解析器只有上述几类。新增后端
= 新增一段配置 + 复用既有策略。

harness / provider / model / reasoning effort 是**四个正交维度** [桌面稿] —— pi 与 opencode
可连接不同 provider，切换 harness 不代表模型不变，effort 不得拼接进模型 ID。

Profile 选择优先级 [桌面稿]：`--profile` → 环境变量 → `git config --local aicommit.profile`
→ 本机默认。仓库共享文件只放提交规范，不放凭证，也不允许定义任意 shell 命令。

### D8. 默认开启 fallback 链与 doctor 探活

[桌面稿] §8 建议默认**不**开跨 profile fallback。本设计改为默认开启一条有序链（至多切换一次，
计入总超时），依据是 Context 中"四个后端当日有两个不可用"的实测。失败原因仍需分类：配置错误
不得靠轮流重试其他后端掩盖。`doctor` 默认不发模型请求，用各 CLI 自带的探活手段
（如 `pi auth check --json`）。

### D9. 中文标题按显示宽度约束

[桌面稿] §5 的"不超过 72 个 Unicode 码点"对中文不适用：72 个汉字的显示宽度为 144 列。
按 East Asian Width 计算，中文默认目标 ≤50 显示列（约 25 字）。该值同时满足 commitlint
`header-max-length`（按 JS 字符串长度计，中文一字计 1）的 72 上限，两个约束同时通过。

"学风格"与"定语言"必须分开表达：从 `git log` 推断的是**结构**（是否用 conventional 前缀、
scope 习惯、是否带正文、祈使句还是名词短语），**语言由配置强制**，否则英文历史会把中文要求带偏。

### D10. TypeScript / Node ≥22 / 零运行时依赖

[桌面稿] §2 推荐 Go，理由是单文件二进制、避免 Android / iOS / Flutter / Java 仓库各装一套
运行时。该理由在本项目的主要使用场景下不成立：claude、opencode、pi 三个 harness 本身即 Node
程序，Node 已是事实前提。

选 Node ≥22 可直接使用 `util.parseArgs`、原生 fetch、`node:test`。零运行时依赖的具体兑现：
配置用 JSON（省去 TOML 解析器）、schema 校验手写窄类型 parse（省去 zod）、East Asian Width
自带范围表（省去 string-width）。esbuild 打包单文件 + shebang。

启动开销不构成约束 [实测]：预热路径是 detach 后台，`git add` 不等待；同步命中路径
`write-tree + rev-parse + node` 合计 120ms，相对 7~14s 的生成是 1% 噪音。但 60ms 是**空脚本**
的数字，每多一个 require 都会抬高它 —— 这正是坚持零依赖的理由。

需要单文件二进制分发时（例如交付给没有 Node 的团队），`bun build --compile` 是可行的后路。

### D11. 只读 sandbox ≠ 禁用工具

[桌面稿] 的重要提醒。`--sandbox read-only` 不等于"无副作用"：该安装环境启用的 MCP、插件、
生命周期 hook 仍会加载。因此每个 adapter 必须分别处理：claude 用 `--tools ""` 并
`--disallowedTools 'mcp__*'`；pi 的 `-nt` 只关工具，扩展 / skills / prompt 模板 / AGENTS.md
需要四个独立开关；opencode 用专用 primary agent 并把全局与 agent 两级 `permission` 均设为
`deny`，通过 `OPENCODE_CONFIG_CONTENT` 注入运行时配置。

旧版本 CLI 缺少所需参数时，由 `doctor` 报不兼容，**不得静默删掉限制参数**。

### D12. 子进程环境分两类处理

[桌面稿] §4 末。读取原仓库的 git 子进程必须**保留** Git 环境（否则拿不到有效 index）；启动
AI 的子进程必须**清理** `GIT_DIR` / `GIT_INDEX_FILE` 等指向原仓库的变量，并在受控临时目录中
运行，避免其误操作正在提交的仓库。两类子进程不共用环境处理逻辑。

进程一律以参数数组启动，禁止 `sh -c` / `eval` / 字符串拼接执行 diff、模型输出或文件名。

### D13. prompt 注入防护与秘密排除是两件独立的事

- **注入防护**：diff 内容、文件名、历史 commit 消息、分支名一律作为**待分析数据**呈现，
  不作为指令。prompt 明确声明这一点，并禁止模型声称测试通过、线上问题解决或性能提升等
  无法从 diff 证实的结论 [桌面稿]。
- **秘密排除**：`.env` / `*.pem` / `*.key` / `*.keystore` / `*.jks` 等按内容排除，出发点是
  不把密钥发往云端 —— 与 lockfile / 生成物"只给统计"的**预算降噪**是两份清单、两个目的。
  正则脱敏不保证发现全部秘密，这一点需向用户明示。

## Risks / Trade-offs

- **预热在连续 `git add` 时重复生成** → `git add a; git add b; git add c` 产生三个不同 tree、
  三次生成，前两次浪费（约 $0.002/次）。第一版接受；后续加延迟去抖（新请求重置计时器）。
- **`post-index-change` 的 args 语义跨版本/平台可能不同** → 触发矩阵为 macOS git 2.50.1 实测。
  以 tree 缓存作第二道保险：即便守卫失效，tree 未变即 noop。`doctor` 中加入该 hook 的行为探测。
- **候选在生成期间失效** → 预热缓存可能任意陈旧，同步路径也有 7~14s 窗口。写入消息文件前复核
  HEAD 与有效 index 的 tree；不一致则丢弃候选，至多重新生成一次 [桌面稿]。用户在编辑器停留
  期间继续 stage 时，由 `commit-msg` 末端再复核，中止而**不**覆盖用户已编辑的文字。
- **后端额度耗尽** → 已是实测事实而非假设。由 fallback 链 + fail-open + `doctor` 共同处理；
  hook 内不发起登录、不等待额度恢复。
- **diff 外泄** → 秘密排除清单 + 临时文件仅当前用户权限并及时清理 + 默认不记录原始 diff 或
  完整 stdout。仍需用户知悉：提交内容会发送至所选后端。
- **coding agent 提交时递归** → agent 执行 `git commit` 会再次拉起同种 harness。
  `CLAUDECODE` 等环境标记已确认存在 [实测]；以内部重入标记 + 生成子进程不得提交代码为第一
  原则；某些 harness 禁止嵌套会话时返回明确失败，不清除其保护变量。agent 已用 `-m` 提供消息
  的情况本就不生成。
- **GUI 客户端的 PATH 与 hook 执行** → 是否生效取决于该 GUI 是否执行 hooks、是否允许无消息
  开始提交；安装器需诊断 GUI 环境的 CLI 路径，不能假设它继承交互式 shell 的 PATH [桌面稿]。
- **失败时的 stderr 噪音** → codex 失败时会把完整 prompt（含整个 diff）回显到 stderr 两次
  [实测]。adapter 必须吞掉 stderr，只提取错误行，否则提交失败瞬间终端会被 diff 刷屏。

## Migration Plan

全新项目，无迁移负担。建议分两期交付：

1. **第一期**：同步路径打通 —— `prepare-commit-msg` + 有效 index 快照 + 四 adapter +
   结构化输出 + fail-open + `doctor` / `preview` / `install`。此时体验等同于 [桌面稿] 的方案。
2. **第二期**：叠加 `post-index-change` 预热与缓存。二者解耦：预热失效时系统自然退回第一期
   行为，因此可独立开关、独立回滚。

卸载（`uninstall`）只移除本程序写入的内容，保留已有 hook 管理器生成的文件与调用链。

## Open Questions

- 预热去抖的具体窗口（500ms / 1.5s）需要按真实 `git add` 节奏测量后定，不影响 specs 与架构。
- Windows 支持的优先级。原生 CLI 的进程启动与 Git for Windows 的 hook 环境需单独适配
  [桌面稿]，第一版可先只保证 macOS / Linux。
- 是否以及何时实现 D1 中保留的直连 API 后端。
