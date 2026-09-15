# 正式 Host 闭环修复 Implementation Plan

> **For agentic workers:** 使用 executing-plans 技能按任务顺序执行，每项先复现失败、修复、验证，再进入下一项。默认在当前任务内串行执行。

**Goal:** 修复正式 Skill 创建，补全前台心跳上下文，支持可恢复的多事实记忆批次，并通过服务器真实 QQ/模型与重启验收。

**Architecture:** 保留 DSH public API、现有 MemoryService 和联系策略。只提取本次需要共用的 Skill draft 构造、心跳上下文和 Dream 批次执行单元，不重写 Agent Runtime。正式 Host 组合测试必须经过真实领域服务，避免 mock 隐藏参数与校验冲突。

**Tech Stack:** TypeScript、Node 24、pnpm 11.7.0、Vitest、锁定 DSH 0.1.1-rc.2、Ubuntu/systemd。

## 范围、证据与工作方式

- 规划基线：7093184。上一轮本地 61 文件 / 308 测试通过，仅作历史基线；执行时重新验证。
- 当前只制定计划，不修改业务代码、不连接服务器、不提交或部署。
- 本地工作区已有 findings.md / progress.md / task_plan.md 修改，必须保留。
- 三个修复分别形成可验收的小批次，全部完成后部署同一个验证过的 commit。
- 不升级 DSH、不新增 UI、不扩展多用户、不自动部署生成的插件。
- 无需直接在生产机编程。代码和完整回归在本地；Linux 兼容测试优先在已有 WSL/CI 中做，生产机只做有限的离线 smoke 和 live acceptance。
- 长命令、下载或权限失败最多尝试 3 次；一旦超时，按用户要求交用户执行，除非用户明确授权再试。优先国内下载镜像；不通过反复重试掩盖错误。

## Task 0：冻结接口与基线

**Files:** packages/dsh-host/src/plugin.ts、bridge.ts、state.ts；packages/personal-memory/src/service.ts；packages/personal-heartbeat/src/ledger.ts；docs/LINUX_DEPLOYMENT.md。

- [ ] 检查 git status / git diff，记录本地与服务器各自 commit（服务器读取放到部署阶段）。
- [ ] 执行 `pnpm verify`，记录退出码和测试数量；失败先区分既有问题与本次改动。
- [ ] 从 packages/dsh-host/node_modules 下锁定 SDK 核对固定 session 的 get_goal、schedule_list 与 session persistence 读接口。复用 Host 的公开工具调用模式，不读 DSH 私有磁盘结构。
- [ ] 确定 get_goal 返回状态/文本、schedule_list 返回条目、session event 的实际形状，为 Task 2 写真实 SDK 形状的 fixture。接口不支持时明确记录 unavailable，不能伪装成无目标/无任务。

## Task 1：修复 Skill 创建，覆盖真正的 Host → Writer 组合

**Modify:** packages/dsh-host/src/plugin.ts、packages/runtime/src/extension-writer.ts。

**Test:** 新建 packages/dsh-host/test/skill-creation.test.ts；保留 packages/runtime/test/extension-writer.test.ts。

已确认：前台 personal_skill_create 和后台 CREATE_SKILL 都构造 `Use when working on ...`，而 validateSkillDraft 拒绝 working 开头。不能删除“禁止过宽触发器”的校验来掩盖冲突。

- [ ] RED：用临时 isolated agentsHome 和真实 ExtensionWriter 调前台注册工具；合法 name/instructions 应落盘，目前应报 skill trigger is too broad。
- [ ] RED：让真实后台 action dispatch 返回 CREATE_SKILL，断言实际生成文件；不能只断言 writer mock 被调用。
- [ ] 在 extension-writer.ts 增加共用构造函数 buildPersonalSkillDraft，前后台调用同一函数；保留 safeSlug、隐私、路径、版本、正反触发器校验。采用具体的显式请求触发描述，输入/输出/停止条件不变：

```ts
export function buildPersonalSkillDraft(name: string, instructions: string): SkillDraft {
  return validateSkillDraft({
    name,
    description: `Use when the user explicitly requests the ${name} workflow.`,
    instructions: `Input:\nUser context supplied by the Agent.\n\nOutput:\n${instructions}\n\nStop:\nStop when the requested skill action is complete.`,
    positiveTriggers: [`explicit request for ${name}`],
    negativeTriggers: ['unrelated request'],
  });
}
```

- [ ] GREEN：前台和后台都落盘、同内容重试不重复版本、恶意路径/秘密/过宽触发描述仍被拒绝。
- [ ] 验证生成目录被正式 DSH skill catalog 发现，并通过隔离 session 的明确请求验证可调用；仅有 SKILL.md 文件不算验收。
- [ ] 执行 `pnpm exec vitest run packages/dsh-host/test/skill-creation.test.ts packages/runtime/test/extension-writer.test.ts`，预期全绿；更新相关文档，形成独立提交候选。

## Task 2：补全正式前台心跳上下文

**Create:** packages/dsh-host/src/heartbeat-context.ts、packages/dsh-host/test/heartbeat-context.test.ts。

**Modify:** packages/dsh-host/src/plugin.ts、bridge.ts；按需要增加 packages/personal-heartbeat/src/service.ts 的只读联系状态方法。

**Test:** packages/dsh-host/test/bridge.test.ts、maintenance.test.ts、packages/personal-heartbeat/test/contact-policy.test.ts。

统一上下文输入：SOUL、Mission、PROFILE、Relevant Memory、固定用户最近真实对话、固定主 session 当前 Goal、有效 Schedule、最近联系时间、当前时间/时区和 Trigger。

```ts
export type ContextValue<T> =
  | { status: 'available'; value: T }
  | { status: 'unavailable'; reason: string };

export interface HeartbeatContextSnapshot {
  at: string;
  timeZone: string;
  triggerId: string;
  soul: string;
  mission: string;
  profile: string;
  memories: readonly string[];
  recentMessages: ContextValue<readonly { role: 'user' | 'assistant'; text: string; at: string }[]>;
  goal: ContextValue<string | null>;
  schedules: ContextValue<readonly { id: string; prompt: string; dueAt: string | null }[]>;
  lastContact: ContextValue<string | null>;
}
```

- [ ] RED：模拟 profile 内容相同但 goal/schedule/recent conversation 不同，检查交给 decision agent 的上下文随之变化，防止固定检索字符串替代真实状态。
- [ ] RED：重启后仍读取持久会话；排除 hidden session、内部快照和其他用户；真实无数据为 available/null 或 []，读取失败为 unavailable。
- [ ] 添加只读 provider 与统一 snapshot/render 函数；Goal/Schedule 从固定主 session 的公开接口读，最近对话从持久事件读，Last Contact 从现有联系账本读。不要使用管理台进程内 lastInteraction 作为唯一来源。
- [ ] 对最近对话限制 12 条、每条 1000 字符；记忆最多 8 条；Schedule 最多 20 项。最终提示设置 16 KiB 总预算，优先保留触发、状态标识、当前目标和最近对话，记录各来源计数/截断状态，不记录原文。
- [ ] 同一轮冻结 SOUL/Mission 版本。字段来源失败记录脱敏错误码，影响主动判断的必要状态不可用时返回 NOOP，不编造当前目标。
- [ ] 保留 quiet hours / cooldown / daily cap 和发送去重；原生 Schedule 已有触发输出不额外调用前台决策模型，避免重复提醒。
- [ ] GREEN：通过上述数据来源、超预算、缺失状态、重启、隔离与联系策略测试；断言 decision agent 仍无写入和发信工具。
- [ ] 执行 `pnpm exec vitest run packages/dsh-host/test packages/personal-heartbeat/test`，预期全绿；形成第二个提交候选。

## Task 3：多事实记忆批次，确保中断恢复不会重复写

**Create:** packages/dsh-host/src/dream-batch.ts、packages/dsh-host/test/dream-batch.test.ts、packages/personal-memory/test/multi-proposal.test.ts。

**Modify:** packages/dsh-host/src/plugin.ts、state.ts、bridge.ts；packages/personal-memory/src/service.ts；docs/DATA_MODEL.md。

两个限制需同时处理：Host 拒绝多项 mutation；MemoryService 发现同 history 已有其他 revision 就拒绝第二项。不能只删除 Host 的数组长度检查。

批次语义：整批先校验并持久化固定 proposals，再逐项经 MemoryService 写入；单项原子、整批可恢复，不宣称跨文件整批事务原子性。失败后继续同一批，不重新调用模型改变已执行计划。

```ts
// 以下为新增持久化记录的设计；proposals 使用现有 MemoryProposal 类型。
type DreamBatch = {
  version: 1;
  historyId: string;
  batchId: string;
  proposals: readonly MemoryProposal[];
  applied: readonly number[];
  status: 'pending' | 'completed' | 'blocked';
};
```

- [ ] RED：同一 history 包含 3 个独立稳定事实，产生 3 个 CREATE 并全部写入。重复调用不增加 revision。
- [ ] RED：第 2 项写入故障、第一项写入后未确认故障、最后一项完成但 history 未 complete 三种中断；重开服务后仅补未完成操作，不重复模型调用与已提交 revision。
- [ ] 为 history 状态增加可选的 versioned batch，使用原有原子事务和租约；claim/renew/fail 不能覆盖或删除已持久化 batch。旧记录缺少 batch 时保持可读，completed 历史不重新 Dream。
- [ ] 先用 ProposalSchema 校验整个数组，最多 8 项且序列化不超过 64 KiB；超过限制拒绝并保留 history 待处理，不静默丢弃事实。重复相同 proposal 去重；同一批写相同目标或 MERGE 涉及交叉路径时拒绝，不猜测覆盖顺序。
- [ ] 为规范化的固定批次生成 hash；逐项生成稳定身份（batch hash + index + proposal hash），由程序添加保留 evidence，模型不得自行指定 history/proposal/batch 身份。
- [ ] MemoryService 去重改为精确 proposal 身份匹配；同 history 的不同操作可写不同路径，已执行同一身份但 payload 不同必须拒绝。兼容旧 history/proposal evidence，不能削弱 expectedHash 和原有 journal 恢复。
- [ ] 每次写入成功后确认项进度；写入成功而确认失败时通过 revision 精确去重恢复。失败 batch 保留 pending/blocked 原因；不将 CREATE 冲突无条件转 UPDATE，不覆盖用户后来编辑的事实。
- [ ] 全批成功才 completeHistory；空数组/全 IGNORE 正常完成；一条失败不阻塞其他独立 history 的维护，轮次结果报告部分失败而非全部成功。
- [ ] 每个新 history Dream 前刷新 PROFILE/INDEX/relevant memory；批次完成后后台 reflection 使用刷新后的投影。
- [ ] 明确本轮保留有界原文增量，暂不另加有损摘要模型；多事实先保留来源与内容，避免额外压缩漏事实。单次维护限制处理数量，剩余历史留待下轮，适配小内存服务器。
- [ ] GREEN：3 个事实、重复事实、IGNORE、混合动作、冲突 hash、旧状态读取、双 worker 竞争、损坏 journal、上述 3 个中断点全部通过。
- [ ] 执行 `pnpm exec vitest run packages/personal-memory/test packages/dsh-host/test`，预期全绿；形成第三个提交候选。

## Task 4：正式 Host 集成与 Linux 发布准备

**Create:** packages/dsh-host/test/host-acceptance.test.ts、scripts/host-offline-smoke.mjs、docs/HOST_ACCEPTANCE.md。

**Modify:** docs/LINUX_DEPLOYMENT.md、docs/OPERATIONS.md。

- [ ] 正式 Host 集成 fixture 使用真实 MemoryService、ExtensionWriter、HeartbeatService 和持久状态，仅替换 QQ 网络及模型。覆盖 inbound → history → 多事实 Dream → PROFILE → heartbeat decision → outbound，并重开 Host 再断言去重。
- [ ] 离线 smoke 脚本只接受新建临时根目录，拒绝 /opt/dshp/workspace 和 runtime；使用构建后的正式模块验证路径、原生 shell、Skill Writer、批次恢复，不连接 QQ、不调用模型、不读取凭据；退出时汇总机器可读结果。
- [ ] 全量 `pnpm verify` 与 `git diff --check`。如果现有 WSL/CI 可用，在 Linux 跑 Host/Memory/Skill 聚焦回归；没有现成环境时不为此安装大型工具链，在服务器仅串行跑有限离线 smoke。
- [ ] 记录精确发布 SHA、依赖锁文件变化、状态格式兼容性、测试结果。生成部署与回滚步骤后再进入发布；不要把仅通过 Demo 的版本交付服务器。

## Task 5：服务器构建、发布、回滚

1. 读取当前 SHA、dirty 状态、Node、可用内存、服务状态、3182 listener；不输出 env 内容。下载/拉取尽量在停机前预取，超时即交用户操作。
2. 确认仅一个实例使用 QQ AppID。停止服务后同时备份 runtime 与 workspace，记录旧 SHA；备份目录 0700，文件保留权限。
3. 更新到已验证 SHA；不直接在服务器修 TS 文件。依赖未变不重复 install；依赖变化才执行受限安装。
4. 用 Node 24 构建后端依赖图，不能只 build dsh-host，因为本次同时修改 runtime/memory。命令如下：

```sh
cd /opt/dshp
# 仅 lockfile 变化时执行安装；使用已配置 npmmirror。
NODE_OPTIONS=--max-old-space-size=768 corepack pnpm@11.7.0 install --frozen-lockfile --child-concurrency=1 --network-concurrency=4
NODE_OPTIONS=--max-old-space-size=768 corepack pnpm@11.7.0 exec tsc -b
# admin 源码/依赖未变化时复用已有静态产物，否则单独构建：
NODE_OPTIONS=--max-old-space-size=768 corepack pnpm@11.7.0 --filter @personal-growth/admin-web build
node scripts/host-offline-smoke.mjs
```

5. smoke 退出 0 才启动 dshp。验证 enabled/active、NRestarts、不发生 OOM、QQ ready、127.0.0.1:3182、认证 API、Nginx 原服务保持正常。
6. 任意发布门槛失败，停止新版本；旧版不能读取新状态时不可只回滚代码。保留失败现场并评估旧版读兼容，再恢复旧代码与一致备份；备份之后若有真实新对话，先归档增量并由用户决定恢复范围，禁止静默丢数据。

## Task 6：真实验收，所有条目有证据才算服务器跑通

真实主动消息测试由用户触发，或在用户明确授权测试发信后执行；本计划本身不代表已发送或验证。

| 场景 | 操作 | 成功证据 |
|---|---|---|
| 正常回复 | 固定 QQ 用户发送唯一测试标识 | 实际收到模型回复，无 processing_failure |
| Skill | 请求创建一个明确的测试工作流，再请求执行它 | 创建成功、catalog 可见、模型可调用；文件不越界 |
| 多事实 | 使用明确标为验收的数据提供 3 项稳定偏好 | history 来源、3 项记忆、对应 revisions；只有高频事实才要求进入 PROFILE |
| 幂等 | 再执行后台维护 | 原 batch 不重复写入，不出现冲突错误 |
| 心跳上下文 | 设置测试 Goal/Schedule 并发送近况，再触发前台维护 | 上下文来源元数据齐全；相关主动回复或合理 NOOP；不能只以是否发消息判断成功 |
| 后台隔离 | 后台 Dream / Skill 操作 | 默认对话无后台输出、无直接 QQ 消息 |
| 联系策略 | 在 fixture 覆盖 quiet/cooldown/cap，真实只验证正常策略 | 不改生产策略强行制造主动发送 |
| 重启 | 创建未到期提醒后重启 dshp | 同一用户/session、记忆与 Skill 保留，提醒到期只收到一次 |
| 恢复 | 临时隔离目录跑批次中断 smoke | 重启只补未完成项；不在真实数据上 kill 写入进程制造故障 |
| 收尾 | 取消测试提醒，验收事实经 MemoryService 归档 | 保留审计，真实偏好不被测试数据混淆 |

- [ ] 记录本地测试、Linux smoke、部署 SHA、每条 live case 的时间/脱敏 trace 标识/用户收信结果到 docs/HOST_ACCEPTANCE.md。
- [ ] 若缺少真实消息或模型结果，只能标记“代码完成、服务器在线、live 验收待完成”，不能宣布完整跑通。
- [ ] 最终检查后台维护至少一次真实完成，重启后一次提醒实际送达；记录稳定观察期间资源、错误与重启计数。

## 完成定义

- [ ] 三项代码修复和组合回归通过。
- [ ] 同一已验证 SHA 在服务器构建、启动和离线 smoke 通过。
- [ ] 真实 QQ 回复、Skill 创建/调用、多事实整理、心跳上下文和提醒重启恢复有证据。
- [ ] 没有把测试通过、QQ ready 或 HTTP 200 替代真实闭环。
- [ ] 文档包含发布结果、剩余限制与可执行回滚路径。
