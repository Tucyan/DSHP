/* global document, window */
const host = 'packages/dsh-host/src/';
const step = (title, component, description, example, source, type = '运行步骤') => ({ title, component, description, example, source, type });
const scenarios = [
  { id: 'chat', icon: '↗', name: 'QQ 对话', tag: '正式 Host', intro: '一次私聊进入固定会话，带着长期上下文生成回复，并把完成的回合交给 Memory。', steps: [
    step('接收 QQ 私聊', 'QQBot WebSocket', '腾讯 SDK 将 C2C 消息交给 Host。只接受配置中的固定用户；群聊和空消息被过滤。', '示例用户：我晚上学习更专注，帮我记住。', host + 'plugin.ts / createBot'),
    step('取得处理租约', 'PersonalGrowthBridge', '根据消息 ID 去重并领取租约。已有完成记录时跳过，处理期间持续续租。', 'messageId → claimed → processing\n重复消息 → 跳过', host + 'bridge.ts / process'),
    step('补充长期上下文', 'Memory → DSH Agent', '恢复或创建固定前台 Session，检索 PROFILE 和相关 Memory，并注入到当前 DSH 会话。', 'PROFILE + relevant memories\n+ 当前用户消息 → 模型上下文', host + 'bridge.ts / getForeground'),
    step('生成完整回复', 'DSH Agent + Tools', 'DSH 驱动模型调用和工具执行。Host 监听 session/event，按 turn/end 判断这一轮是否正常结束。', '示例回复：了解，我们可以优先在晚上安排学习。\n（此文本仅用于说明）', host + 'plugin.ts / completionTracker'),
    step('登记经历与回复', 'Memory Turn + Outbox', '完成事件启动 Memory consume 和 QQ 回复处理。Memory 序号与待处理回合同事务落盘；回复由当前入站 messageId 绑定并经过发送账本。', 'memory-turn → history.jsonl\noutbox → pending / sent / unknown', host + 'plugin.ts / consumeStandaloneTurn'),
    step('完成当前回合', 'Bridge State', '回合跟踪等待 Memory consume 完成，Bridge 随后完成入站状态。形成长期语义还需要后续 Dream；回复和 Memory 写入并非一个跨系统事务。', 'inbound → completed\n经历已登记，等待后台语义整理', host + 'bridge.ts / process'),
  ] },
  { id: 'memory', icon: '◈', name: '长期记忆', tag: '受控写入', intro: '经历先登记，长期结论再提案。Memory Tree 是唯一语义真源，PROFILE 与 INDEX 都是派生视图。', steps: [
    step('捕获完成回合', 'Session Events', '只消费固定前台会话的有效消息，过滤 Host 注入的上下文快照；隐藏会话不会被当作用户聊天。', 'user/message + assistant/message\n→ ConversationEvent[]', host + 'plugin.ts / consumeStandaloneTurn'),
    step('分配连续序号', 'Durable Memory Turn', '一次事务内同时保存待处理回合与连续序号，避免崩溃造成无法修复的游标缺口。', 'seq 1, 2 → pending batch\n重试复用原序号', host + 'state.ts / claimMemoryTurnBatch'),
    step('增量登记经历', 'CursorConsolidator', '按会话游标消费增量。当前正式 Host 的 compressor 只是角色与文本拼接，并非模型摘要；history 仍可能包含聊天正文。', 'history.jsonl：阶段性经历\n不是最终长期 Memory', 'packages/personal-memory/src/consolidator.ts'),
    step('Dream 提出结论', 'Hidden Dream Agent', '后台扫描未处理 history，将经历、PROFILE、INDEX 和检索结果交给 Dream。输出严格 JSON Proposal，没有可靠变化可 IGNORE。', '偏好示例 → CREATE proposal\n不确定推测 → 不写入', host + 'plugin.ts / dreamService'),
    step('受控应用提案', 'MemoryService', '验证提案、证据和版本，执行 CREATE / UPDATE / MERGE / ARCHIVE / IGNORE。修订账本和恢复日志支持可追踪修改。', 'proposal → validation → memory tree\nrevisions.jsonl 记录修改', 'packages/personal-memory/src/service.ts'),
    step('重新生成投影', 'PROFILE + INDEX', '从 Memory Tree 生成高频用户画像和导航。下一次会话将读取更新后的画像与相关记忆。', 'workspace/PROFILE.md\nworkspace/memory/INDEX.md', 'packages/personal-memory/src/profile-builder.ts'),
  ] },
  { id: 'foreground', icon: '◷', name: '前台 Heartbeat', tag: '默认每 60 分钟', intro: '主动联系先经过策略，再交给隐藏 Decision Agent 判断。NOOP 是正常结果。', caveat: '源码接线待修：plugin.ts 的默认 wakeForeground 没有返回 result，而 bridge.runForegroundWake 依赖该返回值发送 QQ。因此“决策 → 实际发送”当前未接通；本页不会将其显示为发送成功。', steps: [
    step('周期性唤醒', 'Foreground Timer', 'Host 默认每小时触发一次。每个 occurrence 有独立标识，重复触发由账本去重。', 'foreground occurrence → durable claim', host + 'bridge.ts / start'),
    step('检查联系策略', 'HeartbeatService', '默认 Asia/Singapore，23:00–07:00 安静时段，120 分钟冷却，每日最多 4 次普通主动联系。策略拒绝时直接 NOOP。', 'quiet hours / cooldown / daily cap\n不允许 → NOOP', 'packages/personal-heartbeat/src/contact-policy.ts'),
    step('判断是否有必要', 'Hidden Decision Agent', '读取用户画像与相关记忆，选择 MESSAGE_USER 或 NOOP。Decision 的工具限制只保留 skill，不具备 QQ 发送工具。', '没有明确事项 → NOOP\n存在跟进事项 → MESSAGE_USER 候选', host + 'plugin.ts / hiddenText'),
    step('记录决策结果', 'Occurrence Ledger', '记录 occurrence 结果与联系预留状态。这表示完成了策略与决策，不等于远端消息已经送达。', 'actionType: MESSAGE_USER / NOOP\n联系账本 ≠ QQ 送达回执', 'packages/personal-heartbeat/src/service.ts'),
    step('登记主动内容', 'Durable Memory Turn', 'Host 将 MESSAGE_USER 候选内容作为 assistant 事件交给 Memory consume；原子批次保护序号和重试。', '候选文本 → memory-turn → history', host + 'plugin.ts / wakeForeground'),
    step('发送接口衔接', 'QQ Outbound · 待修', '设计上 Bridge 应接收 WakeResult 并将 MESSAGE_USER 交给 Outbox。当前默认适配器遗漏返回值，实际走不到此发送分支。', '预期：return result → sendOutbound\n当前：返回 undefined', host + 'bridge.ts / runForegroundWake', '实现缺口'),
  ] },
  { id: 'background', icon: '☾', name: '后台维护', tag: '默认每 30 分钟', intro: '后台使用独立隐藏会话整理记忆、反思效果并发现能力缺口，随后执行受控扩展。', steps: [
    step('启动后台任务', 'Background Timer', '每半小时唤醒，先记录 occurrence。后台与用户前台会话分离，不直接向 QQ 投递输出。', 'background → claimed\n隐藏 maintenance 会话', host + 'bridge.ts / start'),
    step('领取待处理经历', 'History Ledger', '遍历 history，跳过已处理记录，为每条待处理经历领取和续期租约。', 'history record → claimHistory\n失败保留重试机会', host + 'plugin.ts / heartbeatService'),
    step('整理语义记忆', 'Dream + MemoryService', 'Dream 参考经历和记忆上下文给出提案。当前每条经历至多应用一个非 IGNORE mutation，再完成 history 状态。', 'Dream proposal → controlled apply\n→ completeHistory', host + 'plugin.ts / dreamAdapter'),
    step('分析能力缺口', 'Hidden Maintenance', 'Maintenance 根据本轮经历和画像反思，选择 REFLECT、CREATE_SKILL、PROPOSE_PLUGIN 或 NOOP。', '学习复盘流程重复出现\n→ 候选：创建学习复盘 Skill', host + 'plugin.ts / hiddenText'),
    step('执行受控扩展', 'ExtensionWriter', '优先创建有输入、输出、停止条件和正反触发器的 Skill。Plugin 只保存设计提案，部署仍需人工处理。', 'Skill → agents-home\nPlugin → plugin-proposals/*.md', 'packages/runtime/src/extension-writer.ts'),
    step('记录维护结果', 'Hidden Session + Trace', 'DSH 保存会话；Host Trace 记录脱敏的状态与 actionType。当前 REFLECT 完整摘要不会写入独立的反思报告。', 'actionType: REFLECT / CREATE_SKILL\n无 QQ 投递', host + 'plugin.ts / appendTrace'),
  ] },
  { id: 'schedule', icon: '▦', name: '定时任务', tag: 'DSH 官方能力', intro: '复用官方 Schedule 工具创建任务。任务产生的候选输出也通过前台联系策略。', caveat: 'Schedule 候选与前台 Heartbeat 共用 wakeForeground，因此同样受到结果未返回的接线缺口影响。流程展示到策略和候选阶段，不代表真实 QQ 已送达。', steps: [
    step('用户提出安排', 'Foreground Session', '用户通过 QQ 提出需要定时执行的事项，DSH Agent 理解时间与任务内容。', '示例：明天晚上提醒我复盘学习。', host + 'bridge.ts / process'),
    step('调用 Schedule 工具', 'DSH Schedule', '复用 schedule_create / schedule_list / schedule_delete。生产任务状态由官方 DSH 插件管理。', 'schedule_create → 持久化任务', host + 'composition.ts / buildHostPatch'),
    step('到期驱动回合', 'DSH Agent', '官方 Schedule 注入任务上下文，Agent 执行一轮。Host 从 session/event 中识别 schedule 来源。', 'plugin source: schedule\nturn/end: completed', host + 'plugin.ts / session/event'),
    step('提取候选回复', 'Schedule Candidate', '固定前台会话中的 Schedule 输出被转成候选内容，并生成确定性的 occurrence ID。', 'sessionId + turn → occurrenceId', host + 'plugin.ts / dispatchScheduleCandidate'),
    step('进行策略审核', 'Foreground Policy', '候选经过同一 quiet hours、cooldown、daily cap。任务到期并不保证消息一定外发。', '允许 → MESSAGE_USER 候选\n拒绝 → NOOP', 'packages/personal-heartbeat/src/service.ts'),
    step('交给发送边界', 'QQ Outbound · 待修', '预期通过发送账本发送候选；当前默认 wakeForeground 的返回值缺口仍需修复。', '候选已生成 ≠ 已送达', host + 'bridge.ts / runForegroundWake', '实现缺口'),
  ] },
  { id: 'recovery', icon: '⟳', name: '重启与恢复', tag: '持久化边界', intro: '本地账本保护已持久化的工作。远端结果不确定时保留 unknown，由人工核实。', steps: [
    step('校验隔离目录', 'Launcher + Host', '启动器设置仓库内路径，CLI 与插件校验 canonical 路径及 symlink/junction，随后加载独立 DSH Profile。', 'runtime/dsh-home\nruntime/agents-home\nworkspace/', host + 'cli.ts / runPersonalGrowthHost'),
    step('恢复 DSH 会话', 'Session Persistence', '前台采用用户哈希对应的固定会话 ID。收到新消息时，存在快照则 resume，否则 create。', 'peer hash → stable sessionId\nresume / create', host + 'plugin.ts / createDshAgentRegistry'),
    step('扫描 Memory Turn', 'Bridge State', '启动时和运行中扫描待处理回合。有效租约尚未到期则等待，到期后重新领取，沿用原有 Conversation 序号。', 'pending + lease expired → claimed\n→ consume → completed', host + 'plugin.ts / recoverPendingMemoryTurns'),
    step('恢复语义写入', 'Memory Journal', 'MemoryService 恢复可证明的未完成修改，通过 hash、revision 和路径校验保持数据一致。', 'journal + revisions + hashes\n不一致 → 拒绝继续写入', 'packages/personal-memory/src/service.ts'),
    step('核实出站结果', 'Outbound Ledger', '未确认的远端发送保持 unknown，不盲目重发。需要核实 QQ 实际结果，再调用 reconciliation API。', 'sent → 跳过\nunknown → 人工核实', host + 'state.ts / outbound state'),
    step('理解恢复边界', 'Host / Runtime', '当前正式 Host 入站账本保存消息 ID 和租约，没有完整 payload spool。内存中尚未持久化的消息不能承诺在硬崩溃后重放。', '本地 Runtime 有 durable inbox\n正式 Host 与之不是同一接收实现', host + 'bridge.ts / claimInbound', '当前边界'),
  ] },
];
const storage = [
  { name: '长期记忆', note: '语义真源与派生视图区分保存。history 在当前 Host 中仍可能包含聊天正文；Trace 脱敏不代表全部存储均脱敏。', rows: [ ['workspace/memory/{category}/*.md', '长期语义真源：偏好、背景、决策与关键事件。'], ['workspace/PROFILE.md · memory/INDEX.md', '由 Memory Tree 生成的用户画像和导航。'], ['workspace/memory/history.jsonl', '游标消费后的经历记录，等待 Dream 处理。'], ['workspace/memory/revisions.jsonl', '语义修改的追加式审计账本。'] ] },
  { name: '运行状态', note: '备份应同时保存 workspace 与 runtime，并取自同一停机时间点。账本不是可以随意删除的缓存。', rows: [ ['workspace/.personal-growth/bridge-state.json', '生产 Host 的入站 ID、出站、Memory turn、序号与租约。'], ['workspace/data/heartbeat-state.json', 'Heartbeat occurrence、联系记录与预留。'], ['runtime/dsh-home/sessions/', 'DSH 配置的持久化会话，包含前台和隐藏会话。'], ['runtime/storage/', '本地 Runtime / Demo 的 QQ 与 Schedule 适配器状态。'] ] },
  { name: '身份与扩展', note: 'SOUL.md 与 AGENT.md 是项目身份文件；正式 Host 如何加载这些文件取决于 DSH 指令机制，不能把文件存在等同于已注入。', rows: [ ['workspace/SOUL.md · AGENT.md', 'Agent 身份与使命文本。'], ['runtime/agents-home/', '独立的 Agents Home 与版本化 Skills。'], ['runtime/plugin-proposals/*.md', '待人工审查的 Plugin 方案。'], ['runtime/credentials/start-live.local.ps1', '被 Git 忽略的本地启动配置；本页不读取。'] ] },
  { name: '追踪与审计', note: '本页不读取这些文件。展示的是静态架构说明，而非运行状态查询。', rows: [ ['workspace/.personal-growth/trace.jsonl', 'Host 事件元数据，包含类型、状态及关联哈希。'], ['runtime/extension-trace.jsonl', 'ExtensionWriter 独立审计记录。'], ['workspace/data/traces.jsonl', '本地 Runtime 的 Trace 账本。'], ['runtime/sessions/background/', '本地 Runtime 的后台记录；正式 Host 使用 DSH 隐藏会话。'] ] },
];
let selected = 0;
let position = 0;
let timer;
const $ = id => document.getElementById(id);
function stop() { window.clearInterval(timer); timer = undefined; $('play').textContent = position === 5 ? '↻ 重新播放' : '▶ 播放流程'; }
function selectScenario(index) { stop(); selected = index; position = 0; render(); }
function jump(index) { stop(); position = index; render(); }
function render() {
  const scenario = scenarios[selected];
  document.querySelectorAll('.nav-item').forEach((button, index) => button.setAttribute('aria-current', String(index === selected)));
  $('scenario-code').textContent = `FLOW ${String(selected + 1).padStart(2, '0')} / ${scenario.id.toUpperCase()}`;
  $('scenario-title').textContent = scenario.name;
  $('scenario-tag').textContent = scenario.tag;
  $('scenario-intro').textContent = scenario.intro;
  $('caveat').hidden = !scenario.caveat;
  $('caveat').textContent = scenario.caveat || '';
  $('map').replaceChildren();
  $('timeline').replaceChildren();
  scenario.steps.forEach((item, index) => {
    const state = index === position ? 'active' : index < position ? 'done' : '';
    const node = document.createElement('button');
    node.className = `node ${state}`;
    node.setAttribute('aria-pressed', String(index === position));
    node.innerHTML = `<span class="node-icon">${['↗', '◇', '◈', '⌘', '▤', '↻'][index]}</span><span class="node-index">0${index + 1}</span><strong>${item.title}</strong><small>${item.component}</small>`;
    node.onclick = () => jump(index);
    $('map').append(node);
    const line = document.createElement('button');
    line.className = `timeline-step ${state}`;
    line.innerHTML = `<b>${index + 1}</b><span>${item.title}</span>`;
    line.setAttribute('aria-current', String(index === position));
    line.onclick = () => jump(index);
    $('timeline').append(line);
  });
  const current = scenario.steps[position];
  $('step-number').textContent = `0${position + 1}`;
  $('step-content').innerHTML = `<span class="step-type">${current.type}</span><h3>${current.title}</h3><p>${current.description}</p><div class="example"><div class="example-label">EXAMPLE / 示意</div>${current.example}</div>`;
  $('source').textContent = current.source;
  $('counter').textContent = `${position + 1} / ${scenario.steps.length}`;
  $('progress').style.width = `${(position + 1) / scenario.steps.length * 100}%`;
  $('next').disabled = position === scenario.steps.length - 1;
  $('play').textContent = timer ? 'Ⅱ 暂停播放' : position === 5 ? '↻ 重新播放' : '▶ 播放流程';
}
scenarios.forEach((scenario, index) => {
  const button = document.createElement('button');
  button.className = 'nav-item';
  button.innerHTML = `<span class="nav-icon">${scenario.icon}</span>${scenario.name}<span>0${index + 1}</span>`;
  button.onclick = () => selectScenario(index);
  $('scenarios').append(button);
});
$('play').onclick = () => {
  if (timer) { stop(); return; }
  if (position === 5) position = 0;
  timer = window.setInterval(() => { position++; if (position === 5) stop(); render(); }, 2600);
  render();
};
$('next').onclick = () => jump(Math.min(5, position + 1));
$('reset').onclick = () => jump(0);
document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); });
function showStorage(index) {
  document.querySelectorAll('#storage-tabs button').forEach((tab, i) => { tab.setAttribute('aria-selected', String(i === index)); tab.tabIndex = i === index ? 0 : -1; });
  $('storage-content').setAttribute('aria-labelledby', `storage-tab-${index}`);
  $('storage-content').innerHTML = storage[index].rows.map(([path, description]) => `<div class="file-row"><span>▱</span><div><code>${path}</code><p>${description}</p></div></div>`).join('') + `<p class="storage-note">${storage[index].note}</p>`;
}
storage.forEach((item, index) => {
  const tab = document.createElement('button');
  tab.id = `storage-tab-${index}`;
  tab.textContent = item.name;
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-controls', 'storage-content');
  tab.onclick = () => showStorage(index);
  tab.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? storage.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + storage.length) % storage.length;
    showStorage(next); $(`storage-tab-${next}`).focus();
  };
  $('storage-tabs').append(tab);
});
render(); showStorage(0);
