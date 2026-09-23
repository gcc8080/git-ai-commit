# git-ai-commit OpenSpec 第三轮评审

评审日期：2026-09-23

评审对象：`ai-commit-message` 的 6 份规划文件，对应提交 `a5421ca37bfdf4a1cb1e85b7083b8faf4e9fb137`。本轮开始时这些修订尚未提交，收尾时已形成该提交；前后内容指纹一致，文件指纹见文末。

历史报告：[第一轮][review-v1]、[第二轮][review-v2]。前两轮的行号对应各自评审时的文件，本报告的行号对应本轮快照。

## 1. 结论

这版的核心方案已基本收敛，**第二轮 B01–B06 均可在设计层面关闭**。预热授权、显式消息的承诺边界、安全差异检查、安装范围和两类 hook 的启动模板，现在都有明确且相互对应的修订；不需要重做整体架构，也不需要恢复第三个 hook。

本轮保留 **1 项 P1、2 项 P2**：

| 编号 | 优先级 | 剩余问题 | 处理时点 |
| --- | --- | --- | --- |
| C01 | P1 | 卸载流程遗漏尚在去抖、未登记到 key 锁的后台任务 | 预热模块实施前补齐生命周期协议 |
| C02 | P2 | 超龄锁可以直接回收，但旧进程及后端可能仍存活 | 锁与刷新模块交付前补齐规则及故障测试 |
| C03 | P2 | 运行时失效的 shell 分支先于完整的“是否需要生成”判断，会误拦本应放行的提交 | 同步入口交付前统一契约 |

**建议进入任务拆分。** C01、C02 主要影响第三阶段的可选预热，不必阻塞同步路径和后端适配的任务编写；C03 应随同步入口一起处理。这里评审的是规划缺口，不是在报告已经存在的产品漏洞。

`openspec validate ai-commit-message --strict` 通过。`tasks.md` 尚未创建，`isPlanningComplete` 仍为 `false`；结构校验通过不等于这些行为已经实现或验证。

## 2. 第二轮问题的关闭情况

| 编号 | 本轮依据 | 结论 |
| --- | --- | --- |
| B01：过滤执行外部转换 | D3 改为 `diff-index --cached --quiet --no-textconv --no-ext-diff`，明确区分退出码 0、1、错误；D12 与规格同步 | 已关闭；实现时保留外部程序零调用测试 |
| B02：关闭配置不生效 | D15 区分运行时授权与 hook 安装维护，触发时、发送前均复核；增加直接改配置与等待中关闭场景 | 已关闭；卸载不是关闭开关，另见 C01 |
| B03：共享 hooks 影响无关仓库 | D18、proposal、Git 规格统一为只自动写入本仓库默认 hooks 目录，其他有效目录一律冲突 | 已关闭 |
| B04：`commit -m` 仍触发预热 | D3、D15 和规格承认 index 写入可触发预热，保证限定到消息准备阶段；单次跳过开关覆盖两个入口 | 已关闭原先的无条件承诺冲突 |
| B05：冒号标题被误判为尾注 | D2 与规格改为只忽略空行和 Git 格式的 `Signed-off-by`；补充 conventional 标题及其他冒号行场景 | 已关闭 |
| B06：两类 hook 共用启动模板 | D18 分开模板，D17 区分性能边界，并补充入口计数验收 | 已关闭原有冲突；新增加的前台兜底边界见 C03 |

第二轮第 5 节的建议也大部分已吸收：兼容性三态、重复安装校验哈希、历史样本的“有正文”标记、关闭预热与卸载的区别，都已写入设计和规格。真实后端、Linux 与性能验证仍应作为实施验收，不要求在规划阶段提前宣称完成。

## 3. 本轮发现

### C01 — P1：卸载必须覆盖去抖中的任务，不能只扫描 key 锁

**位置**：[D16 后台执行顺序][d-worker]（L454–460）、[D16 卸载][d-uninstall]（L484–485）；对照[缓存清理要求][s-cleanup]（L237–249）与[卸载范围][s-uninstall]（L225–232）。

当前顺序是“启动后台进程 → 等待去抖 → 检查授权与快照 → 计算 key → 获取锁”。卸载只终止锁文件登记的任务；安装状态则直到发布结果前才检查。这中间存在一个尚未被卸载流程管理的阶段。

按文档顺序可以构造以下反例：

1. 预热已开启，暂存触发后台任务 A；A 仍在去抖，尚无 `<key>.lock`。
2. 用户卸载。没有锁可用于发现 A，hook 与当前缓存目录被移除；按卸载规格，其他配置保持原样，所以 `aicommit.prewarm` 仍可能为 `true`。
3. A 结束等待。授权仍为开启、暂存差异仍存在，D16 第 2、3 步均通过。
4. A 为获取生成权重新建立缓存目录和锁，并可以发起后端请求。
5. 发布时才发现 hook 已移除，即使丢弃候选，也已经发生了卸载后的目录重建和新请求。

这是**设计时序推导**，不是产品运行实测。它说明目前描述的卸载算法不足以兑现“在途任务受控、卸载后不重建缓存”的规格；发布前检查只能拦住最后一步。

**建议**：把去抖阶段也纳入任务登记与取消范围。后台任务应携带可失效的安装身份/代次，并在创建状态目录、获取生成权和发送之前确认身份仍有效；卸载先关闭该安装的任务入口，再终止已登记任务和清理目录。身份失效与任务登记需要协调，避免任务恰好在卸载扫描后登记。不能只把“hook 文件存在”当作身份，否则卸载后立即重装会让旧任务误认成仍然有效。

**验收**：用可控屏障将任务停在“进程已启动、尚未获取 key 锁”，执行卸载后再放行；要求后端请求计数为零、缓存目录不重建。再测卸载后立即重装，旧任务不能进入新安装的状态目录或发布结果。这里只约束尚未发出的请求，不要求撤回已经发出的请求。

### C02 — P2：锁超龄不代表旧生成进程已经停止

**位置**：[D16 锁回收与刷新][d-lock]（L465–475）；对照[同 key 唯一生成权][s-lock]（L134–155）。

失效锁目前采用“pid 不存在，**或**存活时间超过总预算加余量”即可回收。强制刷新也允许旧锁被判定失效后启动新任务，没有把“旧进程组已停止”作为必要条件。

反例是旧 worker 被暂停或失去调度，无法执行自己的超时清理，而后端子进程仍在运行。另一个进程仅凭锁超龄就回收、启动同 key 的任务后，会出现两个仍在执行的后端调用。即使给新任务递增代次并拒绝旧结果，也只能保护结果发布，不能兑现“同 key 同时最多一个生成任务”。这是异常恢复路径的协议缺口，不是常规流程已经失败的实测结论。

**建议**：将“超龄”定义为需要核验和接管，而不是直接获得新生成权。接管方确认旧 owner 身份，终止并确认本工具管理的旧进程组退出后，再转移生成权；无法确认时应按剩余预算失败或继续等待，不能仅凭时间已过就并发启动。即使 owner 已退出，也要考虑其后端子进程是否遗留。

此外，“比较 pid/代次后删除”“比较代次后 rename”需要与回收、刷新置于同一受保护的状态转换中；两个分离的文件操作本身并不构成条件原子操作。Node 官方文档也提醒，先检查文件状态、再操作会留下并发变更窗口，见 [文件系统竞态说明](https://nodejs.org/api/fs.html#fsaccesspath-mode-callback)。这里需要明确协议，不要求使用某个特定锁库。

**验收**：用 fake backend 与可控时钟覆盖“锁超龄但 owner/子进程仍存活”“取消未及时退出”“旧任务在归属检查后暂停”等场景；同时验证无重叠生成、旧任务不删新锁、不覆盖新结果。不要只测旧 pid 已消失的容易路径。

### C03 — P2：运行时失效时，完整的跳过判定尚未执行

**位置**：[D18 前台模板及路径失效][d-bootstrap]（L515–522）；对照[D14 先判断是否需要生成][d-failure]（L411–421）、[空提交要求][s-empty]（L78–89）和[安装要求][s-install]（L185–191）。

shell 只根据跳过/重入标记及 `message`、`merge`、`squash`、`commit` 来源放行。已有模板正文、空提交、部分特殊流程则要进入 Node 才能判断。但 Node/脚本路径失效时，shell 会直接根据 `GIT_EDITOR=:` 返回非零；此时尚不能确定本次需要生成，与 D14“无需生成时，失败规则不适用”冲突。

本轮在 Git 2.50.1 的隔离临时仓库中，把 D18 分派逻辑写成诊断 hook，主程序替换为只计数、以成功状态退出的程序；没有调用 AI。结果如下：

| 提交场景 | 不装诊断 hook | 运行时有效 | 运行时路径失效 |
| --- | --- | --- | --- |
| 无内容变化：`commit --allow-empty --allow-empty-message --no-edit` | 退出 0，成功提交 | 退出 0；主程序进入 1 次 | 退出 1，提交被拦 |
| 模板已有 `fix: preserve my intended message`：`commit --template <file> --allow-empty-message --no-edit` | 退出 0，保留模板标题 | 退出 0；主程序进入 1 次 | 退出 1，提交被拦 |

第二行使用 `--allow-empty-message` 是为了排除 Git 自己的“模板未编辑”中止条件，单独验证 hook 的行为；它不表示模板为空。该条件可对照 [Git v2.50.1 源码](https://github.com/git/git/blob/v2.50.1/builtin/commit.c#L1876)。两种情况下，hook 收到的来源分别为空、`template`，`GIT_EDITOR` 均为 `:`；非零 hook 会中止提交，符合 [Git hook 文档](https://git-scm.com/docs/githooks#_prepare_commit_msg)。

同一个边界还使规格 L191 的“无需生成的提交 MUST NOT 启动主程序”过宽：即使运行时正常，已有模板正文和空提交也会启动一次主程序，之后才知道不需要生成。

**建议**：明确区分“shell 可以直接识别的跳过场景”与“需主程序判定的场景”。零启动承诺限定到前者即可。对于运行时失效，要么在 shell 中提供足以兑现 D14 的保守分类，要么明确增加“无法完成判定时的启动失败例外”，并同步调整 D14 与规格；不要同时保留普遍的无需生成放行保证和当前无编辑器即中止规则。后者是产品取舍，需要明确记录，不能作为实现中的隐含行为。

**验收**：除 `-m`、跳过开关外，加入上表两例；分别覆盖运行时有效/失效、编辑/不编辑，以及入口计数和最终退出码。

## 4. 实施安排建议

- **同步路径**：沿用现有设计；把 C03 的判定边界和退出矩阵写进任务。普通提交、部分暂存、`-a`、路径提交、模板、签名和取消仍是首批合同测试。
- **后端适配**：接受本版“未验证默认可调用、可开启严格模式”的明确取舍，不把它重新列为未决架构问题。缺少任何必需限制能力仍不得调用；参数存在不等于已证明限制有效，待核实项和真实调用证据必须分开。
- **可选预热**：先解决 C01 的全生命周期登记，再将 C02 的接管与故障场景落实到锁协议测试。去抖时长、容量和保留天数可在实施测量后定值，不是本轮阻塞项。
- **不再扩大范围**：不要求加入第三个 hook、常驻守护进程、自动管理共享 hooks 或直连 API。已有的非目标可以继续保留。

本轮按 `openspec-explore` 的探索边界进行：保留原规范，只记录评审和可验证的修订建议；没有替用户选择上述未确认的产品取舍。

## 5. 验证范围与文件快照

- 完整阅读最新 proposal、design 和四份 specs，逐项对照第二轮 B01–B06 与实施验收建议。
- OpenSpec 严格校验通过；规划状态检查确认尚无 `tasks.md`。
- C03 的 Git 退出行为及入口计数在临时仓库验证；临时仓库只使用合成文件与独立配置，不读取用户提交内容作为模型输入。
- C01、C02 是按当前设计规则推导的反例及后续测试要求，未声称产品测试已经复现。
- 未调用真实 AI 后端，未重新测量原文中的性能数据，未验证 Linux 或 GUI 环境；当前也没有产品实现可供端到端验收。
- 当前项目只新增本轮评审、更新历史报告导航；未修改 OpenSpec、项目 hooks 或 Git 配置。

本轮评审的 SHA-256：

```text
proposal.md                          1c5d883d2fd03656f436db8d1e5e11d1fe966333c138ee209ee3a3b89a6ac114
design.md                            99a61ee13f8a61437999afdfc784a7f4a97cf806c720d8f01733491812600ae9
specs/commit-generation/spec.md       25e2f9ec83e5da30be3603f6de31c377f3fa8dc4e30b61d79cc11b5e7e762771
specs/git-integration/spec.md         1f7da2313cbe19f234289dd764d9aba0991baaf59ba77e445c3a109db1339c48
specs/harness-adapter/spec.md         910e65a6587679ce1da65718fe9df15bc2a9318fb29e33bb75c6f8cc09868037
specs/prewarm-cache/spec.md           fc0601dc167f173e333bc991f52f86340f0d576e819799905e5b65f76130173f
```

[review-v1]: /Users/project/tools/git-ai-commit/docs/openspec-review-ai-commit-message.md
[review-v2]: /Users/project/tools/git-ai-commit/docs/openspec-review-ai-commit-message-v2.md
[d-worker]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/design.md:454
[d-uninstall]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/design.md:484
[d-lock]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/design.md:465
[d-bootstrap]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/design.md:515
[d-failure]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/design.md:411
[s-cleanup]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/specs/prewarm-cache/spec.md:237
[s-lock]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/specs/prewarm-cache/spec.md:134
[s-uninstall]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/specs/git-integration/spec.md:225
[s-empty]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/specs/git-integration/spec.md:78
[s-install]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/specs/git-integration/spec.md:185
