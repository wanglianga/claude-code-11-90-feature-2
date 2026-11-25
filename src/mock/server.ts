import type {
  Actor,
  AuditActorRole,
  AuditEntry,
  CaseFile,
  CommitResult,
  FieldGrant,
} from '../types';
import { DISPATCH_WORKERS, type DispatchWorker } from '../data/dispatch';
import type { PlanResult, SchedulerVisit } from '../lib/dispatch';
import { applyPlanToCases } from '../lib/planWrite';
import { planFromStored } from '../lib/dispatchModel';
import { seedAudits, seedCases } from '../data/seed';
import { uid } from '../lib/ids';
import { fingerprint } from '../lib/audit';
import { grantState, validateCandidate } from '../lib/rules';
import { remoteDb, type HistoryRecord } from '../db/remoteDb';
import { emit } from './bus';

// ============================================================
// 纯浏览器“模拟远端服务”：
// - 远端库 = 同源共享的 IndexedDB casedesk_remote_v1（两个标签页天然共享）
// - 用 online 开关 + 延迟模拟网络；离线时业务读/提交直接返回 NETWORK
// - 每次提交校验 baseRev 乐观锁并写 history 版本快照 + 审计
// ============================================================

let networkOnline = true;
export function setServerNetworkOnline(v: boolean): void {
  networkOnline = v;
}
export function isServerNetworkOnline(): boolean {
  return networkOnline;
}

const NETWORK_LATENCY: [number, number] = [180, 520];
function latency(): Promise<void> {
  const [lo, hi] = NETWORK_LATENCY;
  return new Promise((r) => setTimeout(r, lo + Math.random() * (hi - lo)));
}
function assertNetwork(): void {
  if (!networkOnline) {
    const e = new Error('模拟网络不可用（离线/地下室）') as Error & { code: 'NETWORK' };
    e.code = 'NETWORK';
    throw e;
  }
}

const SYSTEM_ACTOR: Actor = {
  id: 'system',
  account: '-',
  password: '-',
  name: '模拟环境',
  title: 'system',
  role: 'social_worker',
};

let seedPromise: Promise<void> | null = null;

export async function ensureSeeded(force = false): Promise<void> {
  if (seedPromise && !force) return seedPromise;
  seedPromise = (async () => {
    const db = await remoteDb();
    const seeded = await db.get('kv', 'seeded-v1');
    if (seeded && !force) return;

    if (force) {
      await db.clear('cases');
      await db.clear('grants');
      await db.clear('audit');
      await db.clear('history');
      await db.clear('kv');
    }

    const cases = seedCases();
    const auditSeeds = seedAudits(SYSTEM_ACTOR);
    // 所有异步指纹必须在开启 IndexedDB 事务前算完，避免事务在 await 期间自动提交
    const audits: AuditEntry[] = [];
    for (const a of auditSeeds) audits.push({ ...a, fingerprint: await fingerprint(stripFp(a)) });

    const tx = db.transaction(['cases', 'audit', 'history', 'kv'], 'readwrite');
    for (const c of cases) {
      await tx.objectStore('cases').put(c);
      const hist: HistoryRecord = {
        hid: `${c.id}@${c.rev}`,
        caseId: c.id,
        rev: c.rev,
        at: c.updatedAt,
        actorName: '种子数据',
        snapshot: structuredClone(c),
      };
      await tx.objectStore('history').put(hist);
    }
    for (const a of audits) {
      await tx.objectStore('audit').put(a);
    }
    await tx.objectStore('kv').put({ at: Date.now() }, 'seeded-v1');
    await tx.done;
  })();
  return seedPromise;
}

function stripFp(a: AuditEntry): Omit<AuditEntry, 'fingerprint'> {
  const { fingerprint: _fp, ...rest } = a;
  return rest;
}

// ---------- 脱敏：无有效授权不下发紧急联系人真值 ----------

export function redactCase(c: CaseFile, actor: Actor | null, grants: FieldGrant[], now: number): CaseFile {
  if (!actor) return { ...c, client: { ...c.client, emergencyContact: null } };
  const grant = grants.find(
    (g) => g.caseId === c.id && g.granteeActorId === actor.id && g.field === 'client.emergencyContact',
  );
  if (grantState(grant, now) === 'valid') return c;
  return { ...c, client: { ...c.client, emergencyContact: null } };
}

// ---------- 查询 ----------

export async function apiListCases(actor: Actor): Promise<CaseFile[]> {
  assertNetwork();
  await latency();
  const db = await remoteDb();
  const [cases, grants] = await Promise.all([db.getAll('cases'), db.getAll('grants')]);
  const now = Date.now();
  return cases
    .map((c) => redactCase(c, actor, grants, now))
    .sort((a, b) => (a.id === 'case-chen' ? -1 : b.id === 'case-chen' ? 1 : a.id.localeCompare(b.id)));
}

export async function apiGetCase(caseId: string, actor: Actor | null): Promise<CaseFile> {
  assertNetwork();
  await latency();
  const db = await remoteDb();
  const c = await db.get('cases', caseId);
  if (!c) throw new Error(`case not found: ${caseId}`);
  const grants = await db.getAll('grants');
  return redactCase(c, actor, grants, Date.now());
}

/** 内部/测试用：取未脱敏原始案卷 */
export async function rawGetCase(caseId: string): Promise<CaseFile | undefined> {
  const db = await remoteDb();
  return db.get('cases', caseId);
}

export async function apiListAudit(): Promise<AuditEntry[]> {
  const db = await remoteDb();
  const all = await db.getAll('audit');
  return all.sort((a, b) => b.at - a.at);
}

export async function apiListGrants(): Promise<FieldGrant[]> {
  const db = await remoteDb();
  return db.getAll('grants');
}

// ---------- 审计写入 ----------

export interface AuditDesc {
  actorId: string;
  actorName: string;
  actorRole?: AuditActorRole;
  tabId: string;
  action: string;
  target: string;
  summary: string;
  caseId?: string;
  rev?: number;
  at?: number;
}

async function buildEntries(descs: AuditDesc[]): Promise<AuditEntry[]> {
  const out: AuditEntry[] = [];
  for (const d of descs) {
    const base: Omit<AuditEntry, 'id' | 'fingerprint'> = {
      at: d.at ?? Date.now(),
      actorId: d.actorId,
      actorName: d.actorName,
      actorRole: d.actorRole ?? 'social_worker',
      tabId: d.tabId,
      action: d.action,
      target: d.target,
      summary: d.summary,
      caseId: d.caseId,
      rev: d.rev,
    };
    out.push({
      ...base,
      id: uid('aud'),
      fingerprint: await fingerprint(base),
    });
  }
  return out;
}

// ---------- 提交案卷（乐观锁 + 守卫） ----------

export interface CommitArgs {
  actor: Actor;
  tabId: string;
  caseId: string;
  baseRev: number;
  candidate: CaseFile;
  auditEvents?: AuditDesc[];
}

export async function apiCommitCase(args: CommitArgs): Promise<CommitResult> {
  assertNetwork();
  await latency();
  const db = await remoteDb();
  const stored = await db.get('cases', args.caseId);
  if (!stored) return { ok: false, code: 'GUARD', violations: [] };

  if (stored.rev !== args.baseRev) {
    const baseHist = await db.get('history', `${args.caseId}@${args.baseRev}`);
    const grants = await db.getAll('grants');
    return {
      ok: false,
      code: 'CONFLICT',
      serverRev: stored.rev,
      current: redactCase(stored, args.actor, grants, Date.now()),
      baseSnapshot: baseHist
        ? redactCase(baseHist.snapshot, args.actor, grants, baseHist.at)
        : null,
    };
  }

  const grants = (await db.getAll('grants')).filter((g) => g.caseId === args.caseId);
  const violations = validateCandidate(args.candidate, {
    current: stored,
    grants,
    now: Date.now(),
    actorId: args.actor.id,
  });
  if (violations.length) {
    return { ok: false, code: 'GUARD', violations, current: structuredClone(stored) };
  }

  const next: CaseFile = structuredClone(args.candidate);
  next.id = args.caseId;
  next.rev = stored.rev + 1;
  next.updatedAt = Date.now();

  const descs: AuditDesc[] = args.auditEvents?.length
    ? args.auditEvents.map((e) => ({ ...e, caseId: args.caseId, rev: next.rev }))
    : [
        {
          actorId: args.actor.id,
          actorName: args.actor.name,
          actorRole: args.actor.role,
          tabId: args.tabId,
          action: 'commit',
          target: args.caseId,
          summary: `提交案卷修改，版本 ${args.baseRev} → ${next.rev}`,
          caseId: args.caseId,
          rev: next.rev,
        },
      ];
  const entries = await buildEntries(descs);

  const tx = db.transaction(['cases', 'history', 'audit'], 'readwrite');
  await tx.objectStore('cases').put(next);
  await tx.objectStore('history').put({
    hid: `${next.id}@${next.rev}`,
    caseId: next.id,
    rev: next.rev,
    at: next.updatedAt,
    actorName: args.actor.name,
    snapshot: structuredClone(next),
  } satisfies HistoryRecord);
  for (const e of entries) await tx.objectStore('audit').put(e);
  await tx.done;

  emit({ type: 'remote-changed', caseId: args.caseId, rev: next.rev, at: next.updatedAt, actorName: args.actor.name });
  emit({ type: 'audit-added' });

  return {
    ok: true,
    case: redactCase(next, args.actor, await db.getAll('grants'), Date.now()),
    audits: entries,
  };
}

// ---------- 主管动作：退回 / 确认进入服务计划 ----------

export async function apiSupervisorDecision(args: {
  actor: Actor;
  tabId: string;
  caseId: string;
  recordId: string;
  decision: 'return' | 'confirm';
  note: string;
  ownerName?: string;
}): Promise<{ ok: true; case: CaseFile } | { ok: false; message: string }> {
  assertNetwork();
  await latency();
  const db = await remoteDb();
  const stored = await db.get('cases', args.caseId);
  if (!stored) return { ok: false, message: '案卷不存在' };

  const next = structuredClone(stored);
  const visit = next.visits.find((v) => v.id === args.recordId);
  if (!visit) return { ok: false, message: '服务记录不存在' };
  const goal = next.goals.find((g) => g.id === visit.goalId);
  const at = Date.now();
  let summary = '';
  let action = '';

  if (args.decision === 'return') {
    visit.status = 'returned';
    visit.supervisorNote = args.note;
    if (goal) {
      goal.publishState = 'returned';
      goal.returnNote = args.note;
      goal.returnedByName = args.actor.name;
      goal.returnedAt = at;
    }
    action = 'supervisor-return';
    summary = `主管${args.actor.name}退回记录 ${args.recordId} 及服务目标${goal ? `「${goal.title}」` : ''}：${args.note}`;
  } else {
    visit.status = 'confirmed';
    visit.supervisorNote = args.note || '事实完整，确认进入服务计划。';
    if (goal) goal.publishState = 'confirmed';
    next.plan.push({
      id: uid('plan'),
      goalId: visit.goalId,
      text: `${visit.confirmedGoalText || goal?.title || '服务目标'}（依据 ${visit.serviceDate} 家访记录 ${visit.id}）`,
      ownerName: args.ownerName || '责任社工',
      addedAt: at,
      sourceRecordId: visit.id,
      rev: next.rev + 1,
    });
    action = 'supervisor-confirm';
    summary = `主管${args.actor.name}确认记录 ${args.recordId}，目标「${goal?.title ?? ''}」进入服务计划。转介回执/提醒未被计为服务完成。`;
  }

  next.rev += 1;
  next.updatedAt = at;
  const entries = await buildEntries([
    {
      actorId: args.actor.id,
      actorName: args.actor.name,
      actorRole: 'supervisor',
      tabId: args.tabId,
      action,
      target: args.recordId,
      summary,
      caseId: args.caseId,
      rev: next.rev,
    },
  ]);

  const tx = db.transaction(['cases', 'history', 'audit'], 'readwrite');
  await tx.objectStore('cases').put(next);
  await tx.objectStore('history').put({
    hid: `${next.id}@${next.rev}`,
    caseId: next.id,
    rev: next.rev,
    at,
    actorName: args.actor.name,
    snapshot: structuredClone(next),
  });
  for (const e of entries) await tx.objectStore('audit').put(e);
  await tx.done;

  emit({ type: 'remote-changed', caseId: args.caseId, rev: next.rev, at, actorName: args.actor.name });
  emit({ type: 'audit-added' });

  const grants = await db.getAll('grants');
  return { ok: true, case: redactCase(next, args.actor, grants, Date.now()) };
}

// ---------- 脚本化“远端他人动作”（B 改约、家属取消等；不受本标签离线开关影响） ----------

export async function apiRemoteScript(args: {
  actor: { id: string; name: string; role?: AuditActorRole };
  tabId: string;
  caseId: string;
  action: string;
  target: string;
  summary: string;
  mutate: (c: CaseFile) => void;
}): Promise<CaseFile> {
  const db = await remoteDb();
  const stored = await db.get('cases', args.caseId);
  if (!stored) throw new Error('case missing');
  const next = structuredClone(stored);
  args.mutate(next);
  next.rev = stored.rev + 1;
  next.updatedAt = Date.now();

  const entries = await buildEntries([
    {
      actorId: args.actor.id,
      actorName: args.actor.name,
      actorRole: args.actor.role ?? 'social_worker',
      tabId: args.tabId,
      action: args.action,
      target: args.target,
      summary: args.summary,
      caseId: args.caseId,
      rev: next.rev,
    },
  ]);

  const tx = db.transaction(['cases', 'history', 'audit'], 'readwrite');
  await tx.objectStore('cases').put(next);
  await tx.objectStore('history').put({
    hid: `${next.id}@${next.rev}`,
    caseId: next.id,
    rev: next.rev,
    at: next.updatedAt,
    actorName: args.actor.name,
    snapshot: structuredClone(next),
  });
  for (const e of entries) await tx.objectStore('audit').put(e);
  await tx.done;

  emit({
    type: 'remote-changed',
    caseId: args.caseId,
    rev: next.rev,
    at: next.updatedAt,
    actorName: args.actor.name,
  });
  emit({ type: 'audit-added' });
  return next;
}

// ---------- 字段授权 ----------

export async function apiIssueGrant(args: {
  caseId: string;
  actor: Actor;
  tabId: string;
  ttlMs: number;
  ttlLabel: string;
  reason: string;
}): Promise<{ grant: FieldGrant; secret: NonNullable<CaseFile['client']['emergencyContact']> }> {
  const db = await remoteDb();
  const c = await db.get('cases', args.caseId);
  if (!c?.client.emergencyContact) throw new Error('no restricted value');
  const now = Date.now();
  const grant: FieldGrant = {
    id: uid('grant'),
    caseId: args.caseId,
    field: 'client.emergencyContact',
    granteeActorId: args.actor.id,
    granteeName: args.actor.name,
    reason: args.reason,
    issuedAt: now,
    expiresAt: now + args.ttlMs,
    ttlLabel: args.ttlLabel,
    revoked: false,
  };
  const entries = await buildEntries([
    {
      actorId: args.actor.id,
      actorName: args.actor.name,
      actorRole: args.actor.role,
      tabId: args.tabId,
      action: 'grant-issue',
      target: grant.id,
      summary: `家属授权 ${args.actor.name} 查看紧急联系人，有效期至 ${new Date(grant.expiresAt).toLocaleTimeString()}（${args.ttlLabel}）。缓存将绑定该到期时刻。`,
      caseId: args.caseId,
    },
  ]);
  const tx = db.transaction(['grants', 'audit'], 'readwrite');
  await tx.objectStore('grants').put(grant);
  for (const e of entries) await tx.objectStore('audit').put(e);
  await tx.done;
  emit({ type: 'grants-changed', caseId: args.caseId });
  emit({ type: 'audit-added' });
  return { grant, secret: c.client.emergencyContact };
}

export async function apiRevokeGrant(args: {
  grantId: string;
  actor: { id: string; name: string };
  tabId: string;
  reason: string;
}): Promise<FieldGrant | null> {
  const db = await remoteDb();
  const g = await db.get('grants', args.grantId);
  if (!g) return null;
  g.revoked = true;
  g.revokedAt = Date.now();
  g.revokeReason = args.reason;
  const entries = await buildEntries([
    {
      actorId: args.actor.id,
      actorName: args.actor.name,
      actorRole: 'system',
      tabId: args.tabId,
      action: 'grant-revoke',
      target: g.id,
      summary: `家属撤回紧急联系人查看授权：${args.reason}。所有在线标签页立即清除界面、剪贴板尝试清空并删除持久缓存。`,
      caseId: g.caseId,
    },
  ]);
  const tx = db.transaction(['grants', 'audit'], 'readwrite');
  await tx.objectStore('grants').put(g);
  for (const e of entries) await tx.objectStore('audit').put(e);
  await tx.done;
  emit({ type: 'grant-revoked', grantId: g.id, caseId: g.caseId, at: g.revokedAt });
  emit({ type: 'grants-changed', caseId: g.caseId });
  emit({ type: 'audit-added' });
  return g;
}

// ---------- 跨个案上门日程编排：应用排程方案 ----------

export interface DispatchApplyArgs {
  actor: Actor;
  tabId: string;
  /** 排程方案（由排程器在客户端计算；服务端只复核写入） */
  plan: PlanResult;
  visits: SchedulerVisit[];
  /** 前台展示用的摘要（写入审计，便于跨标签核对） */
  summary: string;
}

export type DispatchApplyResult =
  | { ok: true; cases: CaseFile[]; audits: AuditEntry[]; warnings: string[] }
  | { ok: false; code: 'FORBIDDEN' | 'NETWORK' | 'CONFLICT' | 'VALIDATION'; message: string; caseId?: string };

/**
 * 主管应用排程方案：
 * - 只允许 supervisor；
 * - 每个个案都必须以“主管看到的版本”为乐观锁基准，任何一案已前进则整批拒绝（不做半截写入）；
 * - 逐案复核：固定访问时刻不得改变、不同意改派的访问不得换人、必须保留资质；
 * - 预约被移动时，家庭准备事项必须同步移动（dueAt 与文案都要变）——未变则拒绝。
 */
export async function apiApplyDispatch(args: DispatchApplyArgs): Promise<DispatchApplyResult> {
  try {
    assertNetwork();
  } catch {
    return { ok: false, code: 'NETWORK', message: '当前离线：排程方案尚未写入远端，请恢复网络后重试。' };
  }
  await latency();

  if (args.actor.role !== 'supervisor') {
    return { ok: false, code: 'FORBIDDEN', message: '只有主管可以应用跨个案排程方案。' };
  }

  const db = await remoteDb();
  const warnings: string[] = [];
  const visitById = new Map(args.visits.map((v) => [v.id, v]));
  const now = Date.now();

  // 1) 只读复核：先用“当前远端案卷”重新生成写回内容，再逐案检查约束
  const storedById = new Map<string, CaseFile>();
  for (const c of await db.getAll('cases')) storedById.set(c.id, c);
  const storedCases = args.visits
    .map((v) => storedById.get(v.caseId))
    .filter((c): c is CaseFile => Boolean(c));
  const uniqueStored = [...new Map(storedCases.map((c) => [c.id, c])).values()];
  // 1a) 以最新案卷重新求解同一方案，拒绝“按过期数据得出的可行结论”
  const authoritative = planFromStored(uniqueStored, args.plan.mode);
  const mismatch = compareAuthoritative(authoritative, args.plan);
  if (mismatch) {
    return { ok: false, code: 'CONFLICT', message: mismatch + ' 请刷新后重新排程。' };
  }

  const dry = applyPlanToCases(uniqueStored, args.visits, args.plan, now);
  if (dry.rejected.length) {
    const r = dry.rejected[0];
    return { ok: false, code: 'VALIDATION', caseId: r.caseId, message: r.reason };
  }

  const prepared: CaseFile[] = [];
  for (const w of dry.changedCases) {
    const stored = storedById.get(w.id);
    if (!stored) return { ok: false, code: 'VALIDATION', message: `案卷 ${w.id} 不存在`, caseId: w.id };
    if (w.rev !== stored.rev) {
      // 生成写回时的基线已落后：说明在读取与写入之间有人改过，整批拒绝，避免覆盖
      return {
        ok: false,
        code: 'CONFLICT',
        caseId: w.id,
        message: `案卷 ${w.id} 在你排程期间被他人更新（rev ${w.rev} → ${stored.rev}）。为避免覆盖，请刷新后重新排程。`,
      };
    }
    const violation = verifyDispatchWrite(stored, w, visitById, args.plan);
    if (violation) {
      return { ok: false, code: 'VALIDATION', caseId: w.id, message: violation };
    }
    if (w.rev !== stored.rev) {
      // applyPlanToCases 会克隆基线；rev 必须以当前远端为准
      w.rev = stored.rev;
    }
    w.rev = stored.rev + 1;
    w.updatedAt = now;
    prepared.push(w);
  }

  // 2) 事务化写入
  const entries: AuditEntry[] = [];
  for (const next of prepared) {
    const audits = await buildEntries([
      {
        actorId: args.actor.id,
        actorName: args.actor.name,
        actorRole: 'supervisor',
        tabId: args.tabId,
        action: 'dispatch-apply',
        target: next.id,
        summary: args.summary,
        caseId: next.id,
        rev: next.rev,
      },
    ]);
    entries.push(...audits);
  }

  const tx = db.transaction(['cases', 'history', 'audit'], 'readwrite');
  for (const next of prepared) {
    await tx.objectStore('cases').put(next);
    await tx.objectStore('history').put({
      hid: `${next.id}@${next.rev}`,
      caseId: next.id,
      rev: next.rev,
      at: now,
      actorName: args.actor.name,
      snapshot: structuredClone(next),
    } satisfies HistoryRecord);
  }
  for (const e of entries) await tx.objectStore('audit').put(e);
  await tx.done;

  for (const next of prepared) {
    emit({ type: 'remote-changed', caseId: next.id, rev: next.rev, at: now, actorName: args.actor.name });
  }
  emit({ type: 'audit-added' });

  const grants = await db.getAll('grants');
  return {
    ok: true,
    cases: prepared.map((c) => redactCase(c, args.actor, grants, now)),
    audits: entries,
    warnings,
  };
}

/**
 * 复核单个案卷的排程写回是否自洽。返回 null 表示通过。
 * 重点：固定访问、改派同意、资质、家庭准备同步。
 */
export function verifyDispatchWrite(
  stored: CaseFile,
  next: CaseFile,
  visits: Map<string, SchedulerVisit>,
  plan: PlanResult,
  workers: DispatchWorker[] = DISPATCH_WORKERS,
): string | null {
  if (next.client.id !== stored.client.id) return '排程写回不得改动服务对象档案。';
  const workerMap = new Map(workers.map((w) => [w.id, w]));
  for (const appt of next.appointments) {
    const before = stored.appointments.find((a) => a.id === appt.id);
    if (!before) return `排程写回不得新增预约 ${appt.id}。`;
    const sched = before.schedule;
    if (!sched) continue;
    const startChanged = appt.startAt !== before.startAt;
    const workerChanged = appt.workerId !== before.workerId;
    if (!startChanged && !workerChanged) continue;
    if (sched.fixed && startChanged) {
      return `固定访问 ${sched.publicLabel} 的时刻不可移动（${before.startAt} → ${appt.startAt}）。`;
    }
    if (appt.status !== before.status) {
      return `排程写回不得改动预约状态（${sched.publicLabel}）。`;
    }
    if (workerChanged) {
      const nextWorker = workerMap.get(appt.workerId ?? '');
      if (!nextWorker) return `排程写回指派了未知社工 ${appt.workerId}。`;
      if (!sched.reassignConsent && sched.preferredWorkerId && appt.workerId !== sched.preferredWorkerId) {
        return `${sched.publicLabel}：客户不同意改派，不得换人（${sched.preferredWorkerId} → ${appt.workerId}）。`;
      }
      if (!sched.requiredSkills.every((s) => nextWorker.skills.includes(s))) {
        return `${sched.publicLabel}：${nextWorker.name} 不具备所需资质 ${sched.requiredSkills.join('、')}。`;
      }
    }
    if (startChanged) {
      const prepBefore = stored.familyPreps.filter((p) => p.appointmentId === appt.id);
      const prepAfter = next.familyPreps.filter((p) => p.appointmentId === appt.id);
      if (prepBefore.length !== prepAfter.length) return `${sched.publicLabel}：家庭准备事项数量被改动。`;
      const moved = prepBefore.every((pb) => {
        const pa = prepAfter.find((p) => p.id === pb.id);
        return !!pa && pa.dueAt !== pb.dueAt;
      });
      if (!moved) {
        return `${sched.publicLabel}：预约已改时，但家庭准备事项的截止时刻没有随之更新（必须同步）。`;
      }
      const hasNotice = next.notifications.some(
        (n) => n.appointmentId === appt.id && n.status === 'intended',
      );
      if (!hasNotice) return `${sched.publicLabel}：预约已改时，但没有生成待发出的客户通知。`;
    }
  }
  // 延后访问只影响所属个案；相应预约必须仍存在，不能被静默删除
  for (const vid of plan.deferredVisitIds) {
    const nextHas = next.appointments.some((a) => a.id === vid);
    const storedHas = stored.appointments.some((a) => a.id === vid);
    if (storedHas && !nextHas) return `延后的访问 ${vid} 不应从案卷中删除。`;
  }
  return null;
}

// ---------- 客户通知：主管确认后标记为已发出 ----------

/** 比较客户端方案与服务端权威方案；返回差异说明或 null */
export function compareAuthoritative(server: PlanResult, client: PlanResult): string | null {
  if (server.feasible !== client.feasible) {
    return server.feasible
      ? '服务端复核显示方案可行，但客户端提交的是不可行方案。'
      : `服务端按最新数据复核后该方案已不可行：${server.violations[0] ?? '约束不再满足'}。`;
  }
  if (!server.feasible) return null;
  if (server.visitCount !== client.visitCount) {
    return `服务端复核可完成 ${server.visitCount} 项，与客户端提交的 ${client.visitCount} 项不一致。`;
  }
  const ser = server.schedules
    .flatMap((s) => s.stops.map((st) => `${st.visitId}@${st.workerId}#${st.start}`))
    .sort();
  const cli = client.schedules
    .flatMap((s) => s.stops.map((st) => `${st.visitId}@${st.workerId}#${st.start}`))
    .sort();
  if (ser.join('|') !== cli.join('|')) {
    return '服务端按最新数据重新排程后，访问的时间或人员与提交方案不一致。';
  }
  return null;
}

export async function apiMarkNotificationsSent(args: {
  actor: Actor;
  tabId: string;
  caseId: string;
  notificationIds: string[];
}): Promise<{ ok: boolean; message?: string }> {
  assertNetwork();
  await latency();
  const db = await remoteDb();
  const stored = await db.get('cases', args.caseId);
  if (!stored) return { ok: false, message: '案卷不存在' };
  const now = Date.now();
  const next = structuredClone(stored);
  let changed = 0;
  for (const n of next.notifications) {
    if (args.notificationIds.includes(n.id) && n.status === 'intended') {
      n.status = 'sent';
      n.sentAt = now;
      changed += 1;
    }
  }
  if (!changed) return { ok: true };
  next.rev += 1;
  next.updatedAt = now;

  const entries = await buildEntries([
    {
      actorId: args.actor.id,
      actorName: args.actor.name,
      actorRole: args.actor.role,
      tabId: args.tabId,
      action: 'notification-sent',
      target: args.caseId,
      summary: `确认发出 ${changed} 条客户通知（改约/改派）。`,
      caseId: args.caseId,
      rev: next.rev,
    },
  ]);
  const tx = db.transaction(['cases', 'history', 'audit'], 'readwrite');
  await tx.objectStore('cases').put(next);
  await tx.objectStore('history').put({
    hid: `${next.id}@${next.rev}`,
    caseId: next.id,
    rev: next.rev,
    at: now,
    actorName: args.actor.name,
    snapshot: structuredClone(next),
  } satisfies HistoryRecord);
  for (const e of entries) await tx.objectStore('audit').put(e);
  await tx.done;

  emit({ type: 'remote-changed', caseId: next.id, rev: next.rev, at: now, actorName: args.actor.name });
  emit({ type: 'audit-added' });
  return { ok: true };
}

export async function resetRemote(): Promise<void> {
  const db = await remoteDb();
  await db.clear('cases');
  await db.clear('grants');
  await db.clear('audit');
  await db.clear('history');
  await db.clear('kv');
  seedPromise = null;
  await ensureSeeded(true);
  emit({ type: 'data-reset', at: Date.now() });
  emit({ type: 'audit-added' });
}
