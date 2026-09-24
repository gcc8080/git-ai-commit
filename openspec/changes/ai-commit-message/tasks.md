# Tasks

## 1. 项目骨架与测试基建（第一期：同步路径）

- [x] 1.1 初始化 TypeScript 工程：`package.json` 设 `engines.node >=22` 与 `bin.git-ai-commit`，`dependencies` 为空（只有 typescript、esbuild 等开发依赖），`tsconfig` 开启 strict；验证：`npx tsc --noEmit` 通过，`npm ls --omit=dev` 不列出任何运行时依赖
- [x] 1.2 用 esbuild 打包为带 shebang 的单文件 `dist/git-ai-commit.js`；验证：把产物单独复制到没有 `node_modules` 的临时目录，`node git-ai-commit.js --version` 正常输出
- [x] 1.3 CLI 入口用 `util.parseArgs` 分派 `install`、`uninstall`、`prewarm on|off`、`doctor`、`preview`、`hook <name>` 与后台入口 `warm`；验证：`node --test` 覆盖各子命令的参数解析，未知子命令以非零退出并打印用法
- [x] 1.4 测试基建：临时仓库夹具（`GIT_CONFIG_GLOBAL=/dev/null`、独立 user 配置、可选 linked worktree）、只计数的诊断入口、可编程的 fake backend（可返回候选、拒绝、超时、截断与各类错误）；验证：一个示例测试在夹具仓库中完成 `git commit` 并读到诊断入口的启动次数

## 2. 配置与 profile（第一期）

- [x] 2.1 仓库共享配置 `.ai-commit.json` 的解析与校验（手写窄类型 parse）：只接受提交规范字段（语言、格式、长度上限、type 枚举、scope 规则、输入预算、排除清单）；出现凭证、可执行命令、回退链或预热开关时拒绝该项并在诊断中说明；验证：表驱动测试覆盖合法配置与四类被拒字段
- [x] 2.2 本机配置 `$XDG_CONFIG_HOME/git-ai-commit/config.json`（默认 `~/.config/git-ai-commit/config.json`）：profile 的 harness、provider、model、effort 四个独立字段，回退链，拒绝未验证后端的严格模式开关；验证：测试确认 effort 不会拼进模型标识，缺少必填字段时给出明确报错
- [x] 2.3 profile 选择优先级：`--profile` → `AI_COMMIT_PROFILE` → `git config --local aicommit.profile` → 本机默认；验证：逐级覆盖的测试，并确认用环境变量单次切换时不修改任何配置文件

## 3. Git 快照与状态检测（第一期）

- [x] 3.1 git 子进程封装：参数数组启动；保留 Git 环境，`GIT_INDEX_FILE` 为相对路径时先解析为绝对路径；统一带上 `AI_COMMIT_ACTIVE=1` 与 `GIT_LITERAL_PATHSPECS=1`；验证：单元测试确认切换工作目录后相对的 `GIT_INDEX_FILE` 仍指向正确文件，所有 git 子进程的环境中都有重入标记
- [x] 3.2 快照（D4）：hook 开始时执行一次 `git write-tree` 取得 target tree；base 取 HEAD 的 tree，unborn HEAD 时用 `git hash-object -t tree /dev/null`；base 等于 target 判为空提交；验证：夹具测试覆盖普通提交、部分暂存、`-a`、路径提交、首次提交、pre-commit 格式化后重新暂存，捕获的 tree 都等于最终 commit tree
- [x] 3.3 并发暂存的合同测试（D4）；验证：hook 运行期间另一进程执行 `git add`——普通提交的最终 tree 等于起始快照，新文件在提交后仍处于暂存状态；`-a` 与路径提交时并发的 `git add` 以 128 失败
- [x] 3.4 特殊流程检测：用一次 `git rev-parse --git-path` 查询 MERGE_HEAD、CHERRY_PICK_HEAD、REVERT_HEAD、rebase-merge、rebase-apply、sequencer，不硬编码路径；验证：在夹具中分别制造 merge、cherry-pick、revert、rebase 流程，判定都是"保留原消息"，在 linked worktree 中同样正确

## 4. 消息文件处理（第一期）

- [x] 4.1 来源判断：来源为 `message`、`merge`、`squash`、`commit` 时保留原消息；来源为空或 `template` 时进入内容判断；来源或状态无法识别时保留原消息；验证：`-m`、`-F`、`--amend`、`-c`、`-C`、`--fixup`、`--squash` 的夹具测试中后端调用次数都为零
- [x] 4.2 注释与 scissors：按 `core.commentChar` 识别注释（默认 `#`，取值为 `auto` 或无法确定时保留原内容），scissors 行及其以下不视为正文；验证：`-v`、`-vv` 的夹具测试中 scissors 以下内容保持不变；`core.commentChar=auto` 时消息文件保持原样
- [x] 4.3 正文白名单（D2）：只忽略空行与 Git 格式的 `Signed-off-by: 姓名 <邮箱>` 行，不依赖 `git interpret-trailers --parse`；验证：空模板、纯注释模板、只有签名行时判为需要生成；模板含 `fix: …`、`feat: …`、`说明: …`、`Co-authored-by: …`，或有 `--trailer` 追加的尾注时保留原样，后端调用次数为零
- [x] 4.4 写入：生成内容插入文件最前，其后内容全部保留；验证：`-s` 的最终消息为"标题 + 空行 + Signed-off-by"；`-v` 的最终消息只含插入内容；`--no-edit` 时生成的消息被直接提交

## 5. 差异采集与模型输入（第一期）

- [x] 5.1 差异采集（D12）：用 `git diff-tree -p -z --no-textconv --no-ext-diff` 比较 base 与 target，固定重命名检测参数，文件清单按 NUL 读取；验证：配置会留下标记的 textconv 与受信任的外部 diff 时，外部程序调用次数为零；修改 `diff.context`、`diff.noprefix` 不改变变化集合；路径含空格、中文、换行、shell 元字符时正确识别且不执行任何命令
- [x] 5.2 秘密排除（D13）：默认清单涵盖环境变量文件、私钥、证书、密钥库，可由仓库配置扩展；新路径与重命名或复制的源路径任一匹配即排除内容，被删除文件同样适用，排除后仍报告"发生了变化"；验证：修改 `.env`、`.env → notes.txt`、删除私钥三个用例中，模型输入不含任何内容行
- [x] 5.3 预算与覆盖标注：按文件分配字节预算，逐文件标注完整、部分省略、仅统计、二进制、内容排除；lockfile 与生成物只给统计；二进制、LFS 指针、子模块只给变化事实，不进入子模块读取；验证：超预算时列出被省略的内容；只改锁文件时仍报告变化；子模块更新只包含从旧提交到新提交的事实
- [x] 5.4 历史样本（D9）：HEAD 的 first-parent 历史中最近 20 条非 merge 提交的标题，加本地判定的"有正文"标记，固定字节上限；验证：模型输入中不含任何正文内容；提交 oid 列表可供缓存键使用
- [x] 5.5 prompt 构造：数据区与指令区分隔，显式声明输入是待分析的数据；语言由配置强制（默认中文）；从历史只取结构特征；写入证据约束与"显示宽度 ≤50 列"的软目标；验证：golden 测试覆盖含"忽略此前全部指令"文本的差异，该文本只出现在数据区；英文历史加中文配置时 prompt 要求输出中文

## 6. 输出协议与渲染（第一期）

- [x] 6.1 schema 与校验（D6）：候选 `{type, scope, subject, body[], breakingChange}` 或拒绝 `{refusal}`；禁止额外字段与控制字符；type 取可配置的枚举（默认 conventional 的 11 种）；body 的条数与单条长度有上限；body 中不得有尾注格式的行，也不得有输入中不存在的 issue 编号；验证：合法与非法样例的表驱动测试
- [x] 6.2 兜底解析：只剥去最外层代码围栏，剥去后必须是完整合法的 JSON；截断的输出、普通文本、不完整的 JSON 一律判为失败，不做修补；验证：覆盖围栏包裹、中途截断、前后夹带说明文字的样例
- [x] 6.3 header 长度（D9）：对完整 header（含 `type(scope)!: `）同时校验显示宽度 ≤72（自带 East Asian Width 范围表，CJK 与 emoji 计 2 列，组合字符计 0 列）与字符串长度 ≤72（默认按码点，可配置为 UTF-16 码元），仓库配置可以覆盖；超长时至多一次纠正，不裁剪；验证：中文字符数未超限但显示宽度超限时判为超长；纠正后仍超长时判为失败，原文未被裁剪
- [x] 6.4 renderer：依 breakingChange 生成 `!` 与 `BREAKING CHANGE:`；验证：渲染快照测试覆盖有无 scope、有无破坏性变更、有无正文的组合

## 7. 后端执行器与第一个真实后端（第一期）

- [x] 7.1 进程执行器（D12、D17）：参数数组启动，stdin 传入 prompt；后端运行在任务自己的进程组中，工作目录为只允许当前用户访问的临时目录，清除 `GIT_DIR`、`GIT_INDEX_FILE` 等指向原仓库的变量但保留重入标记；用单调时钟计时，超时后终止整个进程组并清理临时文件；捕获 stderr，只向用户呈现分类后的一行原因；验证：fake backend 覆盖超时（进程组内的子进程也被终止）、把完整输入回显到 stderr（终端只见一行原因）、子进程环境检查
- [x] 7.2 传输解析（D7）：envelope、file、text、jsonl 四种；非零退出、错误事件、截断、空结果、缺少完成标记一律判为失败；验证：每种传输都有正常、截断、非零退出的样例
- [x] 7.3 claude adapter（第一个真实后端，实测可用）：`-p --safe-mode --tools "" --strict-mcp-config --no-session-persistence --output-format json`，支持的版本加 `--json-schema` 并读取 `structured_output`，模型与 effort 取自 profile；验证：在夹具仓库中完成一次真实提交，消息通过 schema 校验

## 8. prepare-commit-msg 入口与失败语义（第一期）

- [x] 8.1 shell 模板（D18）：标记行、安装标识，以及正确转义的 Node 与脚本绝对路径；先放行 `AI_COMMIT_SKIP`、重入标记与来源为 `message`/`merge`/`squash`/`commit` 的情形（以 0 退出，不启动主程序）；运行时路径失效时输出一行诊断并以 0 退出；其余情形 `exec` 主程序；验证：入口计数——`git commit -m` 与跳过开关下主程序启动次数为零；模板里已有标题时主程序启动一次后放行，后端调用次数为零
- [x] 8.2 主流程与失败语义（D14）：判断是否需要生成 → 生成 → 校验 → 写入；后端失败、超时、输出不合规、模型拒绝时消息文件不变，输出一行诊断并以 0 退出；收到 SIGINT/SIGTERM 时以非零退出，不重试、不回退；前台总预算默认 45s，纠正与回退不重置预算；同步生成期间在 stderr 显示进度（非 TTY 时不输出控制字符）；验证：fake backend 逐一覆盖上述失败，消息文件都未改变，退出码符合 D14
- [x] 8.3 失败语义的合同测试（D14、[评审] C03）；验证：不打开编辑器且生成失败时，空消息、只剩签名行、空模板都由 Git 中止；`-m`、跳过开关、`commit --allow-empty --allow-empty-message --no-edit`、模板含 `fix:` 标题并带 `--allow-empty-message --no-edit` 四个用例，分别在运行时有效或失效、打开或不打开编辑器下核对入口计数与最终退出码，运行时失效时的结果与不装 hook 时一致

## 9. 安装与卸载（第一期）

- [x] 9.1 hooks 目录判定（D18）：有效 hooks 目录（`--git-path hooks`）必须等于 `--git-common-dir` 下的 `hooks`，否则按冲突处理，不修改任何文件，并打印接入指引；验证：两个无关仓库共用全局 `core.hooksPath` 时在 A 安装，共享目录未被写入，B 的提交与暂存不启动模型；Husky 目录与手写的同名 hook 都报告冲突，文件保持不变
- [x] 9.2 安装：生成随机的安装标识；写入 `prepare-commit-msg`（带标记行，记录内容哈希）；为现有的每个 worktree 创建状态目录 `<--git-path ai-commit>/<安装标识>/`；输出说明 hooks 由所有 worktree 共享；重复安装时校验哈希，被用户改过的 hook 不覆盖并报告；验证：重复安装的结果与安装一次相同；手动改过 hook 后再次安装，文件保留改后的内容
- [x] 9.3 卸载（D19 的顺序）：对每个 worktree，先把本次安装的状态目录原子改名，再读取其中的任务登记与锁、终止对应进程并确认退出，然后删除目录，最后移除带标记且哈希一致的 hook；被改过的 hook 保留并报告；重复卸载无副作用；验证：在含 linked worktree 的夹具中，卸载后所有 worktree 的状态目录都已移除，被改过的 hook 仍在，再次卸载不报错
- [x] 9.4 GUI 环境：hook 中只用绝对路径；验证：在用 `env -i` 构造的最小环境中执行 `git commit`，hook 仍能启动主程序

## 10. preview 与 doctor（第一期）

- [x] 10.1 `preview`：只生成、不提交；验证：执行前后 `git rev-parse HEAD` 与 `git write-tree` 的结果都不变
- [x] 10.2 `doctor`（第一期部分）：实际解析到的 Node 可执行文件与版本、hook 中记录的路径是否有效、当前生效的配置、hooks 目录是否冲突，不发起任何模型请求；验证：Node 路径失效时报告问题并给出"重新安装"的修复方式；执行期间后端调用次数为零

## 11. 第一期端到端验收

- [x] 11.1 在一个真实仓库的副本中安装后，依次执行 `git commit`、`git commit -s`、`git commit -v`、`git commit --no-edit`、`git commit -m`，再在全局配置了空 `commit.template` 的环境下重复一遍；验证：前四种都得到中文 conventional 草稿并保留签名行；`-m` 不启动主程序；空模板环境下照常生成

## 12. 其余后端 adapter（第二期：后端覆盖）

- [x] 12.1 codex adapter：`exec --ephemeral --skip-git-repo-check --color never -s read-only -c features.shell_tool=false -c mcp_servers={} -c web_search="disabled" -c approval_policy="never" --output-schema <文件> -o <文件> -`，结果从 `-o` 指定的文件读取（13.2 实测 `-c mcp_servers={}` 无效，已改为 `--ignore-user-config` 等，见 D7）；验证：合同测试覆盖正常、截断、非零退出；失败时 codex 会把 prompt 回显到 stderr，终端只见一行原因（设计时实测额度已耗尽，需在额度恢复后运行）
- [x] 12.2 pi adapter：`-p -nt --no-extensions --no-skills --no-prompt-templates --no-context-files --no-session`，provider 与模型标识必须显式指定，用 `pi auth check --json` 探活；验证：合同测试覆盖正常与失败；模型标识不明确时报告配置错误，而不是模糊匹配
- [x] 12.3 opencode adapter：专用 agent 经 `OPENCODE_CONFIG_CONTENT` 注入（全局与 agent 两级 `permission: deny`），加 `--pure --format json --title <本工具标记>`，从事件流中取最后一条 text 事件，结束后执行 `opencode session delete <id>`；验证：调用结束后 `opencode session list` 中没有本工具的会话；超时取消后 `doctor` 能按标题列出残留会话

## 13. 能力探测、兼容性三态与合同测试（第二期）

- [x] 13.1 能力探测与三态（D7）：从帮助文本或 `--strict-config` 探测必需的限制参数，判定为兼容（在合同测试基线内且没有待核实项）、未验证或不兼容；不兼容永不调用；未验证默认调用，每次调用在诊断中注明，严格模式下拒绝；不兼容或被严格模式拒绝都不触发回退；验证：模拟参数齐全但不在基线内的版本，判为未验证且照常调用；模拟缺参数的版本，判为不兼容，既不调用也不回退
- [x] 13.2 能力矩阵的合同测试：在受控配置中启用可观测的扩展、MCP、上下文文件与会话记录，逐后端验证工具、MCP、插件/hook/上下文文件、会话持久化、结构化输出、认证保留，以及子进程是否留在进程组内；验证：结果回填 D7 中的"待核实"项，并更新合同测试基线的版本清单

## 14. 回退链、诊断与递归防护（第二期）

- [x] 14.1 回退链（D8）：只读本机配置，默认关闭；一次生成至多切换一次，共用总预算；按 D8 的失败类别决定是否回退；回退产出的结果在诊断中注明实际后端；验证：未配置时第二后端的调用次数为零；额度耗尽时切换一次并在诊断中说明；配置错误、纠正后仍不合规、模型拒绝、用户取消、版本不兼容或被严格模式拒绝都不回退
- [x] 14.2 `doctor` 补全：各后端的可执行文件、版本、兼容性状态与认证状态；回退链中共用同一账户额度的后端（例如 codex 与走 openai-codex 的 pi）给出提示；列出本工具残留的 opencode 会话；验证：执行期间后端调用次数为零
- [x] 14.3 递归防护：后端子进程带重入标记；后端拒绝嵌套运行时按 D14 处理，不清除后端的保护性环境变量；验证：在带 `AI_COMMIT_ACTIVE=1` 的环境中执行 `git commit` 不触发生成；在 Claude Code 会话中执行不带 `-m` 的 `git commit`，结果要么是正常生成，要么是按 D14 放行

## 15. 预热开关、授权与 hook 模板（第三期：可选预热）

- [x] 15.1 `prewarm on|off`（D15）：设置 `git config aicommit.prewarm` 并安装或移除 `post-index-change`；`install` 在该项未设置时交互式询问一次（非交互环境保持关闭），首次开启时说明暂存阶段即会外发且不可撤回；`.ai-commit.json` 中出现预热开关时拒绝；验证：`prewarm off` 后 `prepare-commit-msg` 与缓存仍在；卸载后 `aicommit.prewarm` 保持原值，重新安装时输出说明将直接启用预热
- [x] 15.2 `post-index-change` shell 模板（D3）：过滤顺序为 跳过或重入标记 → `git config --bool aicommit.prewarm` 为 `true` → 特殊流程（逐行读取 `rev-parse --git-path` 的结果）→ `git diff-index --cached --quiet --no-textconv --no-ext-diff HEAD --`（只有退出码 1 才继续，其余一律静默跳过）；全部通过后以脱离方式启动后台入口并传入安装标识；运行时路径失效时静默以 0 退出；验证：入口计数——预热关闭、跳过、重入、特殊流程、暂存为空、仓库尚无提交时主程序启动次数为零；配置了 textconv 与受信任的外部 diff 时外部程序调用次数为零，且能正确识别出变化；仓库路径含空格时过滤结果正确
- [x] 15.3 执行时授权；验证：开启并安装后直接执行 `git config aicommit.prewarm false`（不重装、不重启任何进程），随后的暂存不启动任何请求
- [x] 15.4 开销测量：用真实生成的 hook 测量 `git add` 的耗时（热身后多次取平均）；验证：全部通过路径的额外开销 ≤50ms（原型为 +36–42ms），测量结果写回 design 的 D3 与 D17

## 16. 后台任务、锁与接管（第三期）

- [x] 16.1 后台任务流程（D16、D19）：启动后先在已存在的状态目录中排他创建登记文件（从不创建目录）→ 去抖 → 复核授权、跳过条件与特殊流程，并重新计算快照（base 等于 target 就退出）→ 取得生成权 → 确认锁文件仍在原路径 → 发送 → 发布；全程不向终端输出，失败记为 failed 并进入冷却；验证：等待期间撤回了暂存、提交已经完成、预热被关闭这三种情况都不发送请求
- [x] 16.2 去抖与并发上限：每个 worktree 至多一个后台生成任务，以最新快照为准，按接管规则终止旧任务；去抖窗口可配置，默认值按真实的 `git add` 节奏测量后确定（design 的 Open Question）；验证：几秒内连续三次暂存、产生三个不同快照时，任一时刻至多一个后台任务在运行，最终只为最新快照发起请求
- [x] 16.3 锁（D16）：`<key>.lock.<代次>` 以排他方式创建，记录 pid、进程组、启动时间、代次与任务令牌（令牌同时出现在进程命令行中）；释放时只删自己代次的锁文件；发布前确认没有更高代次的锁，再以 rename 替换；验证：同一 key 被并发触发时，只有一个任务发起请求
- [x] 16.4 接管规则（D16、[评审] C02）：先按任务令牌核对进程身份（不匹配即视为已退出，不发任何信号）；超龄或强制刷新时向进程组发终止信号、等待、再强制终止，确认整个进程组都已退出后才建立下一代次的锁；确认不了就不接管；验证：用 fake backend 与可控时钟覆盖"锁已超龄但持有者或其后端子进程仍存活""取消后未及时退出""旧任务在身份核对之后被暂停""pid 已被无关进程复用"四种情形，均不出现重叠生成，旧任务不删新代次的锁、不覆盖新结果，也不向无关进程发信号
- [x] 16.5 前台协作：同 key 处于 running 时，前台在剩余预算内等待，不重复发请求；failed 当作 absent，尝试一次同步生成；验证：预热未完成时执行 `git commit`，整个流程的后端请求总数为一

## 17. 缓存（第三期）

- [x] 17.1 缓存键（D5）：base 与 target tree，加上规范化有效 profile 的摘要（含后端版本）、有效生成规则的摘要、历史样本 oid 列表的摘要、提示模板与 schema 的版本；摘要只覆盖非敏感字段；验证：改变 diff 显示配置仍然命中；同名 profile 更换 provider、修改语言或排除清单、历史样本变化时都不命中；所有修改都已暂存后执行 `git commit -a` 时命中
- [x] 17.2 条目与校验：记录实际产出结果的后端与模型、schema 版本、候选与生成时间，不保存 diff、prompt 原文或凭证；读取时按当前 schema 重新校验，损坏的条目视为未命中；回退产出的结果存在主 profile 的 key 下，并标注实际后端；验证：条目损坏时提交退回同步生成；回退结果命中时，诊断中能看到实际后端
- [x] 17.3 命中路径与强制刷新：命中时直接使用；`preview --refresh` 按接管规则替换条目；验证：测量命中路径从 hook 启动到写入消息文件的耗时（目标 ≤300ms），结果写回 D17；强制刷新与旧任务竞速后，缓存中保留的是刷新结果
- [x] 17.4 容量与保留：为每个 worktree 的条目数与保留天数设置上限（默认值按实测占用确定，design 的 Open Question），发布新条目时顺带清理；验证：超出上限后，最旧的条目被清理

## 18. 第三期验收

- [x] 18.1 卸载与在途任务（D19、[评审] C01）；验证：用可控屏障让任务停在"已启动、尚未取得 key 锁"，执行卸载后再放行，后端请求次数为零，状态目录不被重建；正在生成的任务被终止并确认退出，结果不发布；卸载后立即重装，旧任务既不能进入新目录，也不能发布结果；以上在 linked worktree 中同样成立
- [x] 18.2 显式消息与预热的边界（D15）：用没有缓存、没有在途任务的 key 测试；验证：普通 `git commit -m` 在去抖窗口内完成时请求次数为零；`AI_COMMIT_SKIP=1 git commit -m` 无论耗时多久，请求次数都为零；暂存阶段已为同一快照预热过时，提交阶段不新增请求

## 19. 平台验证与兼容性基线

- [ ] 19.1 Linux 验证（design 的 Open Question）：在 Linux 上运行全部测试与合同测试，重点关注 `ps` 输出、进程组与路径解析的差异；验证：全部通过，或者差异已记录并修复
- [x] 19.2 兼容性基线：把合同测试通过的 git、Node 与四个后端的版本写入基线；验证：`doctor` 对基线内的版本显示"兼容"，对基线外但参数齐全的版本显示"未验证"

## 20. 更新 README.md：安装操作指南（最后一步，在以上全部任务完成后进行）

- [x] 20.1 编写安装操作指南（命令以实际实现为准）：前置条件（Node ≥22，只用 claude、codex、opencode 的用户需要另外安装 Node；git 版本基线；至少一个已安装并登录的后端 CLI）→ 获取与构建（克隆仓库、`npm ci`、`npm run build`）→ 安装到 PATH（`npm install -g .` 或 `npm link`，用 `git ai-commit --version` 确认）→ 在目标仓库接入（`git ai-commit install`；说明 hooks 由该仓库所有 worktree 共享；遇到 `core.hooksPath`、Husky 等冲突时按输出的指引手动接入）→ 配置 profile（本机配置文件示例、`AI_COMMIT_PROFILE`、`git config aicommit.profile`）→ 自检（`git ai-commit doctor`、`git ai-commit preview`）→ 可选开启预热（`git ai-commit prewarm on`，并说明暂存阶段即会外发）→ 关闭预热与卸载（`prewarm off` 与 `uninstall` 的区别）→ 升级或切换 Node 后重新执行 `install`；验证：在临时 HOME 与一个新的夹具仓库中严格按 README 的步骤从零操作一遍，最终完成一次由工具生成消息的提交
- [x] 20.2 编写日常使用说明：`git commit` 生成草稿、`git commit --no-edit` 免编辑提交、`git commit -m` 与 `AI_COMMIT_SKIP=1` 跳过生成、`git ai-commit preview [--refresh]`、切换 profile；GUI 客户端的注意事项（需要执行原生 git hook，传入 `-m` 时不生成）；已知限制（有 `--trailer` 时不生成；`--allow-empty-message` 或 `commit.cleanup=verbatim` 下生成失败会按 Git 原生行为提交；不支持同一 worktree 内的并发操作；opencode 会话可能残留；基于模式的秘密排除不保证发现全部秘密）；验证：文档中的每条命令都在夹具仓库中实际执行通过
- [x] 20.3 更新 README 开头的功能概述，沿用现有 README 的中文写法：支持的后端、已验证的平台（macOS；Linux 以 19.1 的结果为准）、兼容性基线版本；验证：README 中的版本与平台信息与 19.2 的兼容性基线一致
