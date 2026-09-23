# git-ai-commit OpenSpec 第二轮评审

评审日期：2026-09-23

评审对象：`ai-commit-message`，基于提交 `20db258ce46d901cc6b131d571e90d22ae313a2b` 上尚未提交的 6 份修订文件。文件指纹见文末。

上一轮报告：[第一轮评审][review-v1]。

## 1. 结论

这版已解决上一轮的主要方向性冲突：fallback 与预热默认关闭；失败行为按是否需要生成、是否存在编辑步骤分类；自动安装范围收缩到原生 hooks；缓存改用有效参数摘要；输出支持拒绝结果，语义质量与机械校验的边界也更清楚。

新版关于提交快照的判断，在本机 Git 2.50.1 上得到复核支持。因此，上一轮提出的“编辑期间再次暂存需要第三个 hook 复核”不再作为修改要求；删除该能力是合理的修订。

本轮剩余 **4 项 P1、2 项 P2**。它们主要集中在预热过滤、运行时开关与 hook 安装边界，建议先统一这些契约，再进入相关模块实施。这里的优先级针对规划缺陷，不表示已经存在产品实现漏洞。

OpenSpec 严格校验仍通过：1 项通过、0 项失败。`tasks.md` 仍未创建，规划状态为未完成。

## 2. 上轮意见处理情况

| 上轮编号 | 本轮状态 | 结论 |
| --- | --- | --- |
| R01：索引 hook 参数语义 | 已解决 | 去掉 `$2` 守卫，修正触发矩阵，并定义内部重入标记。 |
| R02：fallback 默认策略 | 已解决 | proposal、design、spec 均要求用户显式配置，错误类别也已细分。 |
| R03：fail-open 的例外 | 已解决 | D14 与 Git 接入规格已统一条件、顺序和退出行为。 |
| R04：严格一致性与第三个 hook | 关闭，并修正上轮建议 | 本轮验证支持 D4；在声明的支持范围内不再要求 `commit-msg` 复核。 |
| R05：后端隔离与能力证明 | 设计已收敛，转实施验证 | 已改为受限调用而非 OS 隔离，补充版本矩阵及会话残留策略。待核实项仍需作为适配器启用门槛。 |
| R06：预热发送语义 | 部分解决 | 默认授权已明确，但关闭开关与 `commit -m` 的实际触发仍有缺口，见 B02、B04。 |
| R07：任务生命周期 | 基本解决 | 已增加状态、锁、代次、前台等待、并发上限和清理；刷新与互斥的组合需要在任务中具体化。 |
| R08：缓存身份 | 已解决主要问题 | 有效 profile、规则、历史样本、schema/模板版本进入 key，临时 index 不再必然失效。 |
| R09：差异采集边界 | 部分解决 | 正式采集已禁用转换，但预热前置检查仍会执行转换，见 B01。 |
| R10：消息协议 | 部分解决 | schema、拒绝、长度、conventional 范围已明确；通用尾注语法会误判已有模板标题，见 B05。 |
| R11：安装维护 | 部分解决 | 冲突处理和卸载归属规则已改善；跨仓库共享 hooks 及两类 hook 的模板仍需区分，见 B03、B06。 |
| R12：版本、性能和验收 | 设计已收敛，转实施验证 | 已给出版本、总预算与目标，单次采样也不再作为性能承诺；Linux 和真实后端合同测试尚待完成。 |

## 3. 本轮发现

| 编号 | 优先级 | 问题 | 证据类型 |
| --- | --- | --- | --- |
| B01 | P1 | 预热过滤仍执行 textconv / 外部 diff，并可能把有变化判断为无变化 | Git 行为实测 |
| B02 | P1 | 以 hook 是否安装代替运行时开关，关闭配置不能立即停止预热 | 配置与过滤规则实测 |
| B03 | P1 | 接受全局共享 hooks 目录，会使一次仓库安装影响其他仓库 | 路径解析实测 |
| B04 | P1 | `commit -m` 自身仍可能触发新的预热请求，与规格承诺冲突 | 过滤入口实测与状态机推导 |
| B05 | P2 | 通用尾注语法会将 `fix: ...` 模板标题误判为没有正文 | 按文档规则的最小实现验证 |
| B06 | P2 | D18 统一直接启动 Node，与 D3 的 shell 过滤及耗时边界冲突 | 跨章节直接冲突 |

### B01 — 预热过滤也必须禁用外部转换

**位置**：[design D3][d-prefilter]（L135–138）；对照 [D12][d-diff]（L324–328）和[采集规格][s-diff]（L23–35）。

正式采集已经改用 plumbing 并传入 `--no-textconv --no-ext-diff`，但预热过滤第 3 步仍是裸的 `git diff --cached --quiet`。`--quiet` 不代表禁止全部外部转换；对被配置为信任退出码的 external diff，它也不能替代 `--no-ext-diff`。官方说明见 [git-diff 的 quiet 与转换选项](https://git-scm.com/docs/git-diff#Documentation/git-diff.txt---quiet)。

在合成仓库中，让 textconv 把新旧内容转换为相同文本，并分别测试受信任的 external diff：

| 过滤命令 | 外部程序调用次数 | 退出码 | 结果 |
| --- | --- | --- | --- |
| 原命令，配置 textconv | 2 | 0 | index 明明有内容变化，却判为无差异 |
| 加 `--no-textconv --no-ext-diff` | 0 | 1 | 正确识别有差异 |
| 原命令，配置受信任的 external diff | 1 | 0 | 外部程序的结果影响过滤 |
| 加 `--no-textconv --no-ext-diff` | 0 | 1 | 正确识别有差异 |

**影响**：用户仅执行暂存就可能运行额外程序；转换可以改变预热判断或消耗不可控时间。后续采集再禁用转换已来不及，因为副作用发生在过滤阶段。

**建议**：把禁止转换的规则扩展到全部差异检查入口，包括 shell 过滤。明确区分退出码 0、1 和错误；错误应静默跳过预热，不把错误当作“发现变化”。

**验收**：对过滤和正式采集分别配置有标记输出的 textconv、受信任 external diff；两条路径的外部程序调用次数都必须为零。

### B02 — 预热是否允许，应在执行时重新读取配置

**位置**：[design D15][d-prewarm]（L364–368）、[D3 过滤][d-prefilter]（L132–141）；对照[预热授权规格][s-prewarm-enable]（L10–17）。

D15 使用 `git config aicommit.prewarm` 作为开关，并写道“开关变化时同步安装或移除该 hook”。但没有定义哪个命令执行这个联动；普通 `git config` 不会自动安装、移除或通知本工具。D3 的完整过滤列表也没有读取当前的 `aicommit.prewarm`。

实测：安装诊断用的索引 hook 后，执行 `git config aicommit.prewarm false`，hook 文件仍存在；按 D3 的三个条件过滤，下一次 `git add` 仍产生一次可进入预热的事件。该验证只记录事件，没有调用模型。

**影响**：用户明确关闭后，按当前设计实现的旧 hook 仍可能发送 diff。仅靠“安装时开启过”不能表示“执行时仍获准”。共享 hook 的情况下，更不能用文件是否存在判断当前仓库/worktree 的有效设置。

**建议**：在过滤入口最先读取当前有效的本机配置，仅 `true` 才继续；后台在实际发送前也确认开关，处理关闭时已排队但尚未发送的任务。明确管理命令或要求重新安装来同步 hook 文件；这一同步只做安装维护，不能替代运行时授权判断。

**验收**：先开启并安装，再直接关闭配置，不重装也不重启进程；随后暂存不得启动新请求。已有任务是否取消、已发请求不可撤回，要分别定义。

### B03 — 有效 hooks 目录可能跨仓库共享

**位置**：[design D18][d-install]（L408–414）；[安装规格][s-install]（L168–175）；[proposal 的写入范围][p-impact]（L70–74）。

当前允许写入“不在工作区内，且目标文件不存在或属于本工具”的有效 hooks 目录，并把共享范围描述为“同一仓库的所有 worktree”。这个范围描述不完整：全局 `core.hooksPath` 可以让互不相关的仓库使用同一个外部目录。

本轮用单独的临时全局配置，让两个互不相关的临时仓库解析 hooks 路径，得到：

```text
两个仓库的 Git 目录不同：true
解析到同一个 hooks 目录：true
```

Git 官方也将集中管理 hooks 列为该设置的用途，参见 [core.hooksPath 文档](https://git-scm.com/docs/git-config#Documentation/git-config.txt-corehooksPath)。

**影响**：在仓库 A 执行安装即可把 `prepare-commit-msg` 带到未安装本工具的仓库 B；D18 写入的是同一个固定程序入口，B 没有仓库启用登记时也可能生成消息。若本机全局开启预热，影响还会扩展到 B 的暂存操作。卸载则可能反过来移除其他仓库正在使用的入口。

**建议**：第一版优先只自动写入当前仓库自身的默认 hooks 目录；继承的全局/系统级共享 hooks 目录按冲突处理并提供指引。如果确实要支持共享目录，需要增加按仓库启用的运行时判断，以及安装归属/引用关系，不能直接沿用当前全目录安装、卸载逻辑。只检查目录在工作区外并不足够。

**验收**：两个无关联仓库共用全局 hooks 目录，只在 A 安装；B 的提交与暂存均不得因此启动模型。A 卸载不得移除 B 或用户拥有的接入逻辑。

### B04 — 显式消息不能阻止此前触发的索引 hook

**位置**：[design D3][d-prefilter]（L147–148）已经明确 `git commit` 自身会通过过滤；与[预热规格][s-prewarm-explicit]（L27–34）的“提交阶段不新增后端请求”冲突。

可复现场景：

```sh
AI_COMMIT_SKIP=1 git add file.txt
git commit -m "fix: explicit human message"
```

假设预热已开启、当前 key 没有缓存或在途任务。第一条命令因单次开关没有预热；第二条命令会在 HEAD 更新之前写 index。实测第二条命令产生一次通过 D3 过滤的事件。按 D16 的 absent 规则，后台随后可以启动生成；`prepare-commit-msg` 再看到 `message` 来源已经无法阻止这个入口。

这不是重用暂存阶段旧请求的情形，也不能由“同 key 去重”解决，因为该 key 一开始没有任务。

**建议**：在现有原生 hook 架构下，最小且诚实的修订是把保证限定为“`prepare-commit-msg` 对显式消息不生成”，并说明开启预热后，`commit` 等 index 写入也可能触发后台请求。要保证本次命令不新增预热，使用 `AI_COMMIT_SKIP=1 git commit -m ...`。若必须保留“任何 `-m` 提交都不新增请求”的更强保证，需要提供索引 hook 能可靠识别并抑制该来源的机制；当前三个过滤条件做不到。

**验收**：使用没有缓存、没有在途任务的 key 测试上述流程；分别验证普通 `-m` 与同时设置跳过开关的 `-m`。诊断计数与公开承诺应一致。

### B05 — 冒号行不一定是尾注

**位置**：[模板规格][s-template]（L34–44）和 [design D2][d-template]（L94–100）。

新规则将“去掉注释后，所有非空行都符合尾注语法”视为没有用户正文。但合法的 conventional 标题 `fix: preserve my intended message` 也符合常见的 `Token: Value` 语法。

本轮按这一通用语法制作最小诊断 hook，模板只含上述标题时，来源确为 `template`，被误判成只有尾注；最终消息变成：

```text
fix: generated replacement header

fix: preserve my intended message
```

这是文档规则的反例，不是产品实现测试。现有仓库尚无产品实现。该反例说明，仅规定“尾注格式”无法同时保证模板内已有标题被保留。

**影响**：用户提供的标题被降为正文，且可能意外触发模型调用；`--no-edit` 时新生成的标题还会直接提交。

**建议**：不要把所有 `Key: Value` 行都当成可忽略尾注。优先识别明确允许的自动尾注，例如独立的 `Signed-off-by`；未知冒号行保守视为已有正文。将具体语法、允许集合与首行处理写入 spec，尤其要覆盖 conventional 类型标题。

**验收**：空模板、纯注释模板、只有已知签名尾注的模板仍可生成；`fix: ...`、`feat: ...`、普通 `说明: ...` 模板必须原样保留且不调用模型。

### B06 — 两类 hook 不能沿用同一个启动模板

**位置**：[design D3][d-prefilter]（L132–146）、[D17][d-budget]（L400–402）与 [D18][d-install]（L415–416）。

D3 承诺过滤全部在 shell 中完成，命中排除条件时“不启动 node”；D18 却将 hook 内容统一定义为 shell 直接 `exec Node ... hook <名称>`。按后者实现，所有索引事件都会先启动 Node，再有机会过滤，和前述启动边界不一致。

50ms 的预热过滤预算来自 shell 过滤路径，不能直接套用到先启动 Node 的路径。这里不需要争论 Node 一定有多慢，两份设计描述本身已经是不同实现。

**建议**：分别定义两个 hook 模板：`prepare-commit-msg` 可以进入前台程序；`post-index-change` 在 shell 内执行授权、重入、状态和安全差异过滤，全部通过后才分离后台程序。若选择先启动 Node，则统一修改 D3 和测量边界，用真实生成的 hook 重新测量。

**验收**：将 Node 入口替换为仅计数的诊断程序；关闭预热、设置跳过/重入、特殊 Git 流程、无暂存变化时，符合 shell 方案的入口启动次数必须为零。

## 4. 对 D4 快照修订的复核

本轮在临时仓库内，在 `prepare-commit-msg` 开始时获取 tree，再由独立 Git 子进程向默认 index 暂存新文件，最后比较实际 commit tree。所有文件均为合成数据。

| 提交方式 | hook 期间向默认 index 暂存 | 起始快照等于最终 commit tree | 结果 |
| --- | --- | --- | --- |
| 普通提交 | 成功，退出码 0 | 是 | 新文件留在暂存区，不进入本次 commit；结束时磁盘 index 已不同 |
| `commit -a` | 失败，退出码 128 | 是 | 默认 index 锁阻止这次额外暂存 |
| 路径提交 | 失败，退出码 128 | 是 | 同样受到默认 index 锁约束 |

Git v2.50.1 的 `prepare_to_commit` 在调用 `prepare-commit-msg` 前更新内存 cache-tree，随后才启动编辑器及 `commit-msg`；这与上述结果相符。源码依据：[builtin/commit.c](https://github.com/git/git/blob/v2.50.1/builtin/commit.c#L1080)。

因此接受新版“捕获一次、后续不再用变化后的磁盘 index 否定该候选”的做法。Git 读入 index 到 hook 捕获之间的窗口仍应按新版声明排除同 worktree 并发操作，并在支持版本升级时回归；本轮不把这个已声明的边界重新列为缺陷。

## 5. 进入实施时的验收要求

以下项目已有合理设计方向，不要求为了规划完成而先实现全部功能；但应落到 `tasks.md` 的验证条件中：

- **后端限制**：D7 中未验证的参数组合，要以合同测试证明实际关闭工具、插件、上下文与 MCP，且保留预期认证。明确“未验证”状态是否允许调用；不能仅根据参数存在就升级为兼容。
- **刷新与锁**：同 key 至多一个生成任务的规则，要与强制刷新衔接。明确旧任务取消、退出确认、代次递增与发布校验顺序；旧进程的延迟清理不能释放新代次的锁，也不能覆盖新结果。
- **安装维护**：重复安装也应检查用户修改后的哈希；Node/脚本绝对路径失效时，明确 bootstrap 如何遵循失败规则；关闭预热与完全卸载不要混为一项操作。
- **历史输入**：当前 D9 只读取历史标题，却要求推断“是否写正文”。至少补充是否存在正文的元数据，或缩减这项推断要求，无需发送完整历史正文。
- **性能与平台**：Linux、真实后端、GUI PATH、缓存命中、连续暂存都需对应验收。当前预算是目标，临时诊断不代表产品性能测试。

建议先关闭 B01–B04 的行为问题，同时处理 B05、B06 的明确规则缺口，再按既定的“同步路径 → 后端覆盖 → 可选预热”顺序拆任务。无需恢复第三个 hook，也无需重做已经收敛的缓存和输出协议。

## 6. 本轮验证范围与快照

- 完整阅读新版 proposal、design 和四份 specs，并逐项对照第一轮 R01–R12。
- `openspec validate --changes --json --strict --no-interactive`：通过。
- 本机 Git：`2.50.1 (Apple Git-155)`；上表中的 Git 行为、转换程序计数、过滤事件和共享路径均在独立临时仓库中验证。
- 诊断 hook 只处理合成文本或计数，未调用四个真实后端或发起模型 API 请求；没有修改当前项目的 hooks、Git 配置或 OpenSpec 文件。
- 当前没有产品代码，因此本轮不声称任何 adapter、Linux 支持或完整生命周期测试已经通过。

本轮评审时 6 份文件的 SHA-256：

```text
proposal.md                          d8399c1cd3665121ebb3be390adac8a0a96be7354dd66fd951792450f8c33cd9
design.md                            22e2811e2481ce999c00bcb4f18a4e337a3f848f4675d99f6665c72f0f54b832
specs/commit-generation/spec.md       9383df18b88ca84faac915d287e47228d0e6e6b1e2a51f53ac3a60cb36fdcbfa
specs/git-integration/spec.md         ce0733d977bb99f46ccb6031ff74afe116cc41d6b4cb5dfe5f58adeb53e5c720
specs/harness-adapter/spec.md         a5258f97f8012c57e9704b3d611a222f64a1493f443d7901079b839ea376d323
specs/prewarm-cache/spec.md           363a579da3ac476d786715086a8d32282e675fa2f64eae5de7d872c744fef5d8
```

[review-v1]: /Users/project/tools/git-ai-commit/docs/openspec-review-ai-commit-message.md
[d-prefilter]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/design.md:132
[d-diff]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/design.md:318
[d-prewarm]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/design.md:360
[d-install]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/design.md:404
[d-template]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/design.md:94
[d-budget]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/design.md:392
[s-diff]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/specs/commit-generation/spec.md:23
[s-prewarm-enable]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/specs/prewarm-cache/spec.md:10
[s-prewarm-explicit]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/specs/prewarm-cache/spec.md:27
[s-install]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/specs/git-integration/spec.md:166
[s-template]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/specs/git-integration/spec.md:32
[p-impact]: /Users/project/tools/git-ai-commit/openspec/changes/ai-commit-message/proposal.md:70
