# Spec Delta

## Purpose

定义本工具与 Git 之间的接入边界：在哪些提交场景下生成消息、在哪些场景下必须原样保留 Git 或用户
已准备好的消息、如何取得本次提交真正生效的内容快照，以及 hook 的安装如何与既有 hook 管理器共存。

## ADDED Requirements

### Requirement: 仅对需要新消息的普通提交生成

系统 SHALL 只在本次提交确实需要一条新消息时生成草稿。用户已显式提供消息、Git 已准备好消息、
或本次为特殊 Git 操作时，系统 MUST 原样保留既有消息内容，不得调用模型。

#### Scenario: 无消息的普通提交
- **WHEN** 用户执行 `git commit` 且未提供 `-m` 或 `-F`
- **THEN** 系统生成草稿写入消息文件，随后由 Git 照常打开编辑器

#### Scenario: 用户显式提供消息
- **WHEN** 用户执行 `git commit -m "..."` 或 `git commit -F <file>`
- **THEN** 系统不调用任何后端，消息文件内容保持不变

#### Scenario: 重用已有消息
- **WHEN** 用户执行 `git commit --amend`、`-c <commit>` 或 `-C <commit>`
- **THEN** 系统保留已有消息，不自动重写

#### Scenario: fixup 与 squash 提交
- **WHEN** 用户执行 `git commit --fixup` 或 `--squash`
- **THEN** 系统保留 `fixup!`、`squash!`、`amend!` 前缀及其内容不变

#### Scenario: 空提交
- **WHEN** 用户执行 `git commit --allow-empty`
- **THEN** 系统不依据无关改动生成消息，交由用户手动说明用途

### Requirement: 识别特殊 Git 操作

Git 传入的消息来源参数不足以独立识别全部特殊操作。系统 MUST 同时检查 Git 的状态路径
（如 `rebase-merge`、`rebase-apply`、`CHERRY_PICK_HEAD`、`REVERT_HEAD`、`MERGE_HEAD`、
`sequencer`），且这些路径 MUST 通过 Git 提供的路径查询取得，不得硬编码。来源或操作无法识别时，
系统 MUST 保守地保留原有消息。

#### Scenario: 合并、拣选、回退、变基
- **WHEN** 本次提交处于 merge、cherry-pick、revert 或 rebase 流程中
- **THEN** 系统保留 Git 或用户已准备的消息，不生成草稿

#### Scenario: 无法识别的来源
- **WHEN** 消息来源参数或 Git 状态是系统未知的组合
- **THEN** 系统保留原有消息并正常退出，不视为错误

### Requirement: 使用本次提交的有效 index

系统 MUST 使用当前 Git 进程为本次提交准备的有效 index（包括通过环境继承的临时 index），
MUST NOT 硬编码仓库的默认索引路径。描述的内容必须与最终写入的 commit tree 一致。

#### Scenario: 同文件同时存在已暂存与未暂存修改
- **WHEN** 某文件既有已暂存的改动，又有未暂存的改动
- **THEN** 生成的消息只描述已暂存的部分

#### Scenario: 提交时自动暂存
- **WHEN** 用户执行 `git commit -a`
- **THEN** 系统描述 Git 本次准备的有效 index 的内容，而非仓库默认索引的内容

#### Scenario: 限定路径提交
- **WHEN** 用户执行 `git commit -- <path>`
- **THEN** 系统只描述本次真正提交的那些文件

#### Scenario: 先前 hook 修改了暂存内容
- **WHEN** `pre-commit` 阶段的格式化已修改并重新暂存了文件
- **THEN** 系统捕获的是格式化之后的内容

### Requirement: 首次提交的比较基准

仓库尚无 HEAD 时，系统 MUST 以与当前仓库对象格式相符的空 tree 作为比较基准，且该值 MUST 由
Git 计算得出，MUST NOT 硬编码任何空 tree 常量。

#### Scenario: 空仓库的第一次提交
- **WHEN** 仓库处于 unborn HEAD 状态且用户执行首次提交
- **THEN** 系统以仓库对象格式对应的空 tree 为基准，描述全部被提交的文件

### Requirement: 消息文件的读写规则

系统 MUST 按 Git 的注释、scissors 与 cleanup 规则解析消息文件，区分用户正文与非正文内容。
`git commit -v` 附带的 diff MUST NOT 被当作用户正文。系统写入草稿时 MUST NOT 破坏 Git 已经
放入该文件的内容，例如 `git commit -s` 添加的 `Signed-off-by`。

#### Scenario: 带 verbose diff 的提交
- **WHEN** 用户执行 `git commit -v`，消息文件中含有 scissors 线以下的 diff
- **THEN** 系统不将该 diff 视为用户已写正文，并在写入草稿后保持该 diff 区域不变

#### Scenario: 带签名的提交
- **WHEN** 用户执行 `git commit -s`
- **THEN** 系统可生成正文，并保留 Git 已添加的 `Signed-off-by` 尾注

### Requirement: 生成失败不改变 Git 既有行为

任何后端不可用、未认证、超额、网络错误、超时或输出不合规的情况下，系统 MUST 保留原消息文件
并让 Git 照常继续，MUST NOT 阻塞提交，MUST NOT 写入占位性的通用消息。系统 MUST NOT 在 hook
内发起登录流程或等待额度恢复。

#### Scenario: 后端不可用
- **WHEN** 所选后端的 CLI 不存在、未认证或已超出额度
- **THEN** 系统输出一行简短原因到诊断通道，保留原消息文件，Git 照常打开编辑器

#### Scenario: 明确无编辑步骤的提交
- **WHEN** 本次提交明确不会打开编辑器（如 `GIT_EDITOR=:`、`--no-edit`，或用户使用免编辑模式）
  且生成失败
- **THEN** 系统返回非零并中止本次提交，防止仅含尾注的空消息被意外提交

#### Scenario: 用户中断
- **WHEN** 用户在生成期间按下 Ctrl+C
- **THEN** 系统中止本次提交，且不将取消视为可自动重试的错误

### Requirement: 单次跳过开关

`--no-verify` 不会跳过消息准备阶段的 hook，因此系统 MUST 提供独立的、单次生效的跳过方式，
使用户无需卸载 hook 或修改仓库配置即可手动填写本次消息。

#### Scenario: 本次手动填写
- **WHEN** 用户在执行 `git commit` 时启用单次跳过开关
- **THEN** 系统不调用任何后端，Git 行为与未安装本工具时完全一致

### Requirement: Hook 安装与既有管理器共存

安装 MUST 在写入前检查 `core.hooksPath` 与既有 hook。检测到 Husky、Lefthook、pre-commit 等
管理器时，系统 MUST 在对应阶段追加调用并保留原有执行链，MUST NOT 覆盖管理器生成的文件。
系统 MUST NOT 将修改全局 `core.hooksPath` 作为默认接入方式。卸载 MUST 只移除本工具写入的内容。

#### Scenario: 仓库已使用 hook 管理器
- **WHEN** 目标仓库已由 Husky 或 Lefthook 接管 hook
- **THEN** 安装在该管理器的对应阶段追加调用，原有 hook 继续按原顺序执行

#### Scenario: 卸载
- **WHEN** 用户执行卸载
- **THEN** 仅本工具写入的 hook 内容与缓存目录被移除，其他 hook 与配置保持原样

#### Scenario: 安装前诊断
- **WHEN** 用户执行安装
- **THEN** 系统报告将写入的有效 hooks 目录、检测到的管理器，以及是否存在冲突
