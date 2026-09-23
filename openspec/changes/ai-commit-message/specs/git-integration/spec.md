# Spec Delta

## Purpose

定义本工具与 Git 之间的接入边界：哪些提交场景需要生成消息、哪些场景必须原样保留 Git 或用户已准备好的消息、
本次提交的内容快照如何取得、消息文件如何读写、生成失败时按什么条件处理，以及原生 hook 如何安装与卸载。

## ADDED Requirements

### Requirement: 仅对需要新消息的提交生成

系统 SHALL 只在本次提交确实需要一条新消息时生成草稿。判断 MUST 依据 Git 传给 hook 的来源参数、Git 状态、消息文件内容
与内容快照，MUST NOT 假设能获得用户的原始命令行。用户已显式提供消息、Git 已准备好消息、或本次为特殊 Git 操作时，
系统 MUST 原样保留消息文件，消息准备阶段 MUST NOT 调用任何后端。开启预热时，提交命令自身对 index 的写入仍可能触发预热，
其边界由预热规格定义。

#### Scenario: 无消息的普通提交
- **WHEN** 用户执行 `git commit`，且未提供 `-m` 或 `-F`
- **THEN** 系统生成草稿并写入消息文件，随后 Git 照常打开编辑器

#### Scenario: 用户显式提供消息
- **WHEN** 用户执行 `git commit -m "..."` 或 `git commit -F <file>`
- **THEN** 消息准备阶段不调用任何后端，消息文件内容保持不变

#### Scenario: 重用已有消息
- **WHEN** 用户执行 `git commit --amend`、`-c <commit>` 或 `-C <commit>`
- **THEN** 系统保留已有消息，不自动重写

#### Scenario: fixup 与 squash 提交
- **WHEN** 用户执行 `git commit --fixup` 或 `--squash`
- **THEN** 系统保留 `fixup!`、`squash!`、`amend!` 前缀及其内容不变

### Requirement: 按消息文件内容判断是否已有正文

来源参数为空或为模板时，系统 MUST 依据消息文件内容判断是否需要生成：去除注释行，以及 scissors 行及其以下的部分后，
只有空行与 Git 自动添加格式的 `Signed-off-by` 行可以忽略；只要还剩其他任何非空行，系统 MUST 视为已有用户正文，保留原样，
MUST NOT 调用后端。形如 `Token: Value` 的行（包括 conventional 标题）MUST NOT 仅因符合尾注语法而被忽略。注释字符无法确定时，
系统 MUST 保留原样。系统 MUST NOT 仅凭来源参数为模板就跳过生成。

#### Scenario: 全局配置了空模板
- **WHEN** 用户的 `commit.template` 指向一个空文件，并执行普通 `git commit`
- **THEN** 系统照常生成草稿

#### Scenario: 模板只含注释
- **WHEN** 用户的模板中只有注释行
- **THEN** 系统照常生成草稿

#### Scenario: 只有签名行
- **WHEN** 用户执行 `git commit -s`，消息文件中除注释外只有 Git 添加的 `Signed-off-by` 行
- **THEN** 系统照常生成草稿，并保留该签名行

#### Scenario: 模板含有 conventional 标题
- **WHEN** 用户的模板中含有 `fix: preserve my intended message` 或 `feat: ...` 这样的标题
- **THEN** 系统保留消息文件原样，不调用后端

#### Scenario: 模板含有其他冒号行
- **WHEN** 用户的模板中含有 `说明: ...` 或 `Co-authored-by: ...` 这样的行
- **THEN** 系统保留消息文件原样，不调用后端

#### Scenario: 注释字符由 Git 自动选择
- **WHEN** 注释字符配置为自动选择，系统无法确定哪些行是注释
- **THEN** 系统保留消息文件原样

### Requirement: 识别特殊 Git 操作

来源参数不足以识别全部特殊操作。系统 MUST 同时检查 Git 的状态路径（如 `rebase-merge`、`rebase-apply`、`CHERRY_PICK_HEAD`、
`REVERT_HEAD`、`MERGE_HEAD`、`sequencer`），这些路径 MUST 通过 Git 提供的路径查询取得，MUST NOT 硬编码。来源或操作
无法识别时，系统 MUST 保守地保留原有消息。

#### Scenario: 合并、拣选、回退、变基
- **WHEN** 本次提交处于 merge、cherry-pick、revert 或 rebase 流程中
- **THEN** 系统保留 Git 或用户已准备的消息，不生成草稿

#### Scenario: 无法识别的来源
- **WHEN** 来源参数与 Git 状态是系统未知的组合
- **THEN** 系统保留原有消息并以成功状态退出

### Requirement: 空提交不生成

本次提交的基准快照与目标快照相同时，系统 MUST 视为没有内容变化，保留原消息且不生成。系统 MUST NOT 仅因用户允许空提交
就跳过有内容变化的提交。

#### Scenario: 没有任何内容变化的提交
- **WHEN** 用户执行 `git commit --allow-empty`，且暂存区与 HEAD 无差异
- **THEN** 系统不生成消息，交由用户说明提交用途

#### Scenario: 允许空提交但确有变化
- **WHEN** 用户执行 `git commit --allow-empty`，但暂存区确有变化
- **THEN** 系统照常生成草稿

### Requirement: 使用本次提交的有效快照

系统 MUST 使用 Git 为本次提交准备的有效 index（包括通过环境继承的临时 index），MUST NOT 硬编码仓库的默认索引路径。
系统 MUST 在 hook 开始时捕获一次目标快照，并以它作为本次提交的唯一描述对象。hook 开始之后暂存区的变化不属于本次提交，
系统 MUST NOT 因此丢弃候选或中止提交。

#### Scenario: 同一文件同时有已暂存与未暂存的修改
- **WHEN** 某文件既有已暂存的改动，又有未暂存的改动
- **THEN** 生成的消息只描述已暂存的部分

#### Scenario: 提交时自动暂存
- **WHEN** 用户执行 `git commit -a`
- **THEN** 系统描述 Git 本次准备的有效 index 的内容，与最终 commit tree 一致

#### Scenario: 限定路径提交
- **WHEN** 用户执行 `git commit -- <path>`
- **THEN** 系统只描述本次真正提交的文件，与最终 commit tree 一致

#### Scenario: 之前的 hook 修改了暂存内容
- **WHEN** `pre-commit` 阶段的格式化修改并重新暂存了文件
- **THEN** 系统捕获的是格式化之后的内容

#### Scenario: 生成期间另一进程暂存了新文件
- **WHEN** 普通提交的 hook 运行期间，另一个进程暂存了一个新文件
- **THEN** 消息仍描述 hook 开始时的快照，该新文件不出现在本次提交与消息中，提交后仍保持暂存状态

### Requirement: 首次提交的比较基准

仓库尚无 HEAD 时，系统 MUST 以与当前仓库对象格式相符的空 tree 作为比较基准。该值 MUST 由 Git 计算得出，
MUST NOT 硬编码任何空 tree 常量。

#### Scenario: 空仓库的第一次提交
- **WHEN** 仓库处于 unborn HEAD 状态，用户执行首次提交
- **THEN** 系统以仓库对象格式对应的空 tree 为基准，描述全部被提交的文件

### Requirement: 消息文件的读写规则

系统 MUST 按 Git 的注释与 scissors 规则解析消息文件。scissors 行及其以下的内容 MUST NOT 被当作用户正文。
系统写入草稿时 MUST 将其插入文件最前面，并保留其后的全部原有内容，包括尾注、注释、scissors 行及其以下的内容。

#### Scenario: 带签名的提交
- **WHEN** 用户执行 `git commit -s`
- **THEN** 最终提交消息为生成的内容加上 Git 已添加的 `Signed-off-by` 尾注

#### Scenario: 带 verbose diff 的提交
- **WHEN** 用户执行 `git commit -v`
- **THEN** 系统不把 scissors 行以下的 diff 视为用户正文，且该区域保持不变

#### Scenario: 不打开编辑器的提交
- **WHEN** 用户执行 `git commit --no-edit`，且生成成功
- **THEN** 生成的消息被直接提交

### Requirement: 生成失败按条件处理

系统 MUST 先判断本次是否需要生成；不需要生成时，任何生成失败规则都不适用。需要生成而生成失败时（包括后端不可用、超时、
输出不合规、模型拒绝生成），系统 MUST 按是否存在编辑步骤处理：有编辑步骤时 MUST 保留原消息文件、输出一行简短原因并以成功
状态退出；无编辑步骤时 MUST 以非零状态退出并中止提交。是否存在编辑步骤 MUST 以 Git 提供的无编辑器信号判断。用户取消时，
系统 MUST 中止本次提交，MUST NOT 重试或切换后端。系统 MUST NOT 写入占位性的通用消息，MUST NOT 在 hook 内发起登录或等待
额度恢复。

#### Scenario: 显式消息且无编辑器
- **WHEN** 用户执行 `git commit -m "..."`，本次提交不会打开编辑器
- **THEN** 系统不进入生成流程，以成功状态退出

#### Scenario: 有编辑步骤时后端不可用
- **WHEN** 需要生成，所选后端未认证或额度耗尽，且本次提交会打开编辑器
- **THEN** 系统输出一行简短原因，保留原消息文件，Git 照常打开编辑器

#### Scenario: 模型拒绝生成
- **WHEN** 需要生成，后端返回"证据不足、拒绝生成"的结果，且本次提交会打开编辑器
- **THEN** 系统保留原消息文件，Git 照常打开编辑器

#### Scenario: 无编辑步骤时生成失败
- **WHEN** 用户执行 `git commit --no-edit` 或 `git commit -s --no-edit`，且生成失败
- **THEN** 系统以非零状态退出，本次提交被中止，不会产生只含尾注的提交

#### Scenario: 运行时路径失效
- **WHEN** hook 中记录的运行时或程序路径已失效，且本次提交需要生成
- **THEN** 有编辑步骤时，系统提示一行原因并以成功状态退出，Git 照常打开编辑器；无编辑步骤时，系统以非零状态退出，本次提交被中止

#### Scenario: 用户中断
- **WHEN** 用户在生成期间按下 Ctrl+C
- **THEN** 本次提交被中止，系统不重试、不切换后端

### Requirement: 单次跳过开关

`--no-verify` 不会跳过消息准备阶段的 hook，因此系统 MUST 提供独立的、单次生效的跳过方式。启用时，系统 MUST NOT 在该次
提交中调用任何后端，并且 MUST NOT 触发预热；开启预热时，它是确保一条 Git 命令不引发任何后端请求的唯一方式。跳过开关
MUST NOT 被描述为能够撤回此前暂存阶段已发出的预热请求。

#### Scenario: 本次手动填写
- **WHEN** 用户在执行 `git commit` 时启用单次跳过开关
- **THEN** 系统不调用任何后端，Git 行为与未安装本工具时一致

### Requirement: 原生 hook 的安装

系统 MUST 只向本仓库自身的默认 hooks 目录写入。Git 解析出的有效 hooks 目录与默认目录不同时（无论 `core.hooksPath` 来自
哪一级配置），系统 MUST 按冲突处理。系统 MUST NOT 假设工作区中的 `.git` 一定是目录。只有当目标 hook 文件不存在、或属于
本工具且安装后未被修改时，系统才 SHALL 写入；其他情况下 MUST NOT 修改任何文件，MUST 报告冲突，并给出需要手动加入既有 hook
或管理器配置的调用。系统 MUST NOT 修改任何一级的 `core.hooksPath`，MUST NOT 修改任何 hook 管理器的配置或脚本。默认 hooks
目录由同一仓库的所有 worktree 共享，安装输出 MUST 说明这一点。无需生成的提交 MUST NOT 启动本工具的主程序。

#### Scenario: 无冲突的仓库
- **WHEN** 有效 hooks 目录就是本仓库的默认目录，且其中没有同名 hook
- **THEN** 系统写入本工具的 hook，并报告写入位置及其由所有 worktree 共享

#### Scenario: 全局配置了共享 hooks 目录
- **WHEN** 全局 `core.hooksPath` 让多个互不相关的仓库共用同一个 hooks 目录，用户在其中一个仓库执行安装
- **THEN** 系统不写入该共享目录，报告冲突并给出指引；其他仓库的提交与暂存不因此发生任何生成或后端请求

#### Scenario: 已有手写 hook
- **WHEN** 默认 hooks 目录中已存在不属于本工具的同名 hook
- **THEN** 系统不修改该文件，报告冲突，并给出需要手动加入的调用

#### Scenario: 仓库使用 hook 管理器
- **WHEN** 有效 hooks 目录指向 Husky 等管理器维护的目录
- **THEN** 系统不修改该目录，报告冲突，并给出接入指引

#### Scenario: 重复安装
- **WHEN** 用户在已安装、且 hook 未被修改的仓库中再次执行安装
- **THEN** 系统只更新本工具自己的 hook，结果与安装一次相同

#### Scenario: 重复安装时 hook 已被用户修改
- **WHEN** 用户修改过本工具写入的 hook，然后再次执行安装
- **THEN** 系统不覆盖该文件，并报告它已被修改

#### Scenario: GUI 客户端执行 hook
- **WHEN** 提交由不继承交互式 shell PATH 的 GUI 客户端发起
- **THEN** hook 仍能找到本工具及其运行时

#### Scenario: 无需生成时不启动主程序
- **WHEN** 用户执行 `git commit -m "..."`，或启用了单次跳过开关
- **THEN** 消息准备阶段的 hook 直接放行，本工具主程序的启动次数为零

### Requirement: 原生 hook 的卸载

卸载 MUST 只移除本工具写入、且安装后未被修改的 hook 文件。安装后被用户修改过的文件 MUST 保留并报告。卸载 MUST 移除当前
worktree 的缓存目录。重复卸载 MUST NOT 产生错误或副作用。

#### Scenario: 正常卸载
- **WHEN** 用户执行卸载
- **THEN** 本工具写入的 hook 与当前 worktree 的缓存目录被移除，其他 hook 与配置保持原样

#### Scenario: 安装后用户修改了 hook
- **WHEN** 用户在安装后编辑过本工具写入的 hook 文件，然后执行卸载
- **THEN** 该文件被保留，系统报告它已被修改

#### Scenario: 重复卸载
- **WHEN** 用户在已卸载的仓库中再次执行卸载
- **THEN** 系统不做任何修改，正常退出
