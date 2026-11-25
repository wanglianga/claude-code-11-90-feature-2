import type {
  Appointment,
  CaseFile,
  CaseNotification,
  FamilyPrepItem,
} from '../types';
import { DISPATCH_WORKERS, type DispatchWorker } from '../data/dispatch';
import { hm as hmOf, isoFromDayMinute } from './time';
import { fmtMinute, type PlanResult, type SchedulerVisit } from './dispatch';
import { nodeLabel } from '../data/roadNetwork';

// ============================================================
// 把“排程方案”回写为个案改动。
// 关键点：
// 1) 预约时间变化 → 家庭准备事项的 dueAt/文案同步移动（不能只改日历）；
// 2) 改派 / 改约 → 生成给客户的“待发出通知”，由主管确认发出；
// 3) 只写排程必需字段，不碰案情、观察、目标等其它字段；
// 4) 固定访问时刻不可移动——回写前再次校验，任何超时都拒绝写入。
// ============================================================

export interface PrepDiff {
  id: string;
  before: string;
  after: string;
  beforeDue: string;
  afterDue: string;
}

export interface NotificationPlan {
  caseId: string;
  appointmentId: string;
  kind: CaseNotification['kind'];
  text: string;
}

export function workersById(): Map<string, DispatchWorker> {
  return new Map(DISPATCH_WORKERS.map((w) => [w.id, w]));
}

function shiftPrep(prep: FamilyPrepItem, startIso: string): FamilyPrepItem {
  const startMs = Date.parse(startIso);
  return {
    ...prep,
    dueAt: new Date(startMs - prep.leadMinutes * 60_000).toISOString(),
  };
}

export function notificationKind(timeChanged: boolean, workerChanged: boolean): CaseNotification['kind'] {
  if (timeChanged && workerChanged) return 'combined';
  if (workerChanged) return 'reassign';
  if (timeChanged) return 'reschedule';
  return 'kept';
}

/** 生成一条“待发出”的客户通知（不直接发送） */
export function buildNotification(args: {
  appointmentId: string;
  publicLabel: string;
  prevWorker?: string;
  nextWorker: string;
  prevStart?: number;
  nextStart: number;
  timeChanged: boolean;
  workerChanged: boolean;
  now: number;
}): CaseNotification {
  const kind = notificationKind(args.timeChanged, args.workerChanged);
  const workers = workersById();
  const nextName = workers.get(args.nextWorker)?.name ?? args.nextWorker;
  const prevName = args.prevWorker ? workers.get(args.prevWorker)?.name ?? args.prevWorker : '原社工';
  const timePart = args.timeChanged ? `到访时间改为 ${fmtMinute(args.nextStart)}` : `到访时间 ${fmtMinute(args.nextStart)}`;
  const workerPart = args.workerChanged ? `由 ${prevName} 改为 ${nextName}` : `仍由 ${nextName} 负责`;
  const tail = [timePart, workerPart].join('，');
  const text =
    kind === 'kept'
      ? `${args.publicLabel}：保持原安排（${fmtMinute(args.nextStart)}，${nextName}）。`
      : `${args.publicLabel}：${tail}。请确认家中可接待；如不便请立即联系调度。`;
  return {
    id: `notice-${args.appointmentId}-${args.now.toString(36)}`,
    appointmentId: args.appointmentId,
    kind,
    status: 'intended',
    text,
    createdAt: args.now,
  };
}

export interface ApplyPlanResult {
  changedCases: CaseFile[];
  /** 每个被移动预约的家庭准备事项差异（用于界面逐条展示“家庭准备也同步更新”） */
  prepDiffs: Array<{ caseId: string; appointmentId: string; label: string; items: PrepDiff[] }>;
  notifications: NotificationPlan[];
  /** 被跳过/拒绝的项与原因 */
  rejected: Array<{ caseId: string; appointmentId: string; reason: string }>;
}

/**
 * 依据排程结果与个案现状，计算需要写回的案卷（不直接落库）。
 * 固定访问会再次校验其开始时刻是否变化；变化即拒绝，避免“把超时包装成可行”。
 */
export function applyPlanToCases(
  cases: CaseFile[],
  visits: SchedulerVisit[],
  plan: PlanResult,
  now: number,
): ApplyPlanResult {
  const byCase = new Map(cases.map((c) => [c.id, structuredClone(c)]));
  const visitById = new Map(visits.map((v) => [v.id, v]));
  const changed = new Map<string, CaseFile>();
  const prepDiffs: ApplyPlanResult['prepDiffs'] = [];
  const notifications: NotificationPlan[] = [];
  const rejected: ApplyPlanResult['rejected'] = [];

  for (const [visitId, stop] of Object.entries(plan.byVisit)) {
    if (!stop) continue;
    const visit = visitById.get(visitId);
    if (!visit) continue;
    const caseDoc = byCase.get(visit.caseId);
    if (!caseDoc) continue;
    const appt = caseDoc.appointments.find((a) => a.id === visitId);
    if (!appt) continue;

    const prevStart = visit.originalStart;
    const prevWorker = appt.workerId ?? visit.preferredWorkerId ?? undefined;
    const timeChanged = stop.start !== prevStart;
    const workerChanged = stop.workerId !== prevWorker;

    if (appt.schedule?.fixed && timeChanged) {
      rejected.push({
        caseId: visit.caseId,
        appointmentId: visitId,
        reason: `固定访问 ${visit.label} 的时刻 ${fmtMinute(appt.schedule.windowStart)} 不可移动；吸收了这一改动的行程不能称为可行。`,
      });
      continue;
    }

    if (!timeChanged && !workerChanged) continue;

    // 只在日期部分更新到排程日，避免用“当前系统日期”覆盖案卷原有日期
    const dayKeyOfAppt = appt.schedule?.serviceDate ?? visitDateOf(caseDoc, appt);
    const startIso = isoFromDayMinute(dayKeyOfAppt, stop.start);
    appt.startAt = startIso;
    appt.workerId = stop.workerId;

    // 家庭准备事项随到访时刻/人员同步移动
    const diffs: PrepDiff[] = [];
    caseDoc.familyPreps = caseDoc.familyPreps.map((prep) => {
      if (prep.appointmentId !== visitId) return prep;
      const next = shiftPrep(prep, startIso);
      if (timeChanged) {
        diffs.push({
          id: prep.id,
          before: prep.text,
          after: withTimeInText(prep.text, startIso),
          beforeDue: prep.dueAt,
          afterDue: next.dueAt,
        });
        next.text = withTimeInText(prep.text, startIso);
      }
      return next;
    });
    if (diffs.length) {
      prepDiffs.push({ caseId: visit.caseId, appointmentId: visitId, label: visit.label, items: diffs });
    }

    // 旧通知若已发出、承诺过原安排，必须同步标注被替代，避免家庭拿旧通知对新时间
    for (const old of caseDoc.notifications) {
      if (old.appointmentId === visitId && old.status === 'sent' && !old.text.includes('已被后续改约替代')) {
        old.text = `${old.text}（此安排已被后续改约/改派替代，请以最新通知为准。）`;
      }
    }

    // 客户通知（待发出）
    const notice = buildNotification({
      appointmentId: visitId,
      publicLabel: visit.label,
      prevWorker,
      nextWorker: stop.workerId,
      prevStart,
      nextStart: stop.start,
      timeChanged,
      workerChanged,
      now,
    });
    caseDoc.notifications.push(notice);
    notifications.push({
      caseId: visit.caseId,
      appointmentId: visitId,
      kind: notice.kind,
      text: notice.text,
    });

    caseDoc.updatedAt = now;
    changed.set(caseDoc.id, caseDoc);
  }

  // 被延后的弹性访问：也生成“待改期”提示（不是完成），但不改预约本身
  for (const vid of plan.deferredVisitIds) {
    const visit = visitById.get(vid);
    if (!visit) continue;
    const caseDoc = byCase.get(visit.caseId);
    if (!caseDoc) continue;
    notifications.push({
      caseId: visit.caseId,
      appointmentId: vid,
      kind: 'reschedule',
      text: `${visit.label}：今日约束内无法按时段完成，将另行联系改期（未计入已完成）。`,
    });
  }

  return { changedCases: [...changed.values()], prepDiffs, notifications, rejected };
}

function visitDateOf(caseDoc: CaseFile, appt: Appointment): string {
  const start = caseDoc.visits.find((v) => v.appointmentId === appt.id)?.serviceDate;
  if (start) return start;
  // 兜底：用开始时刻的日期（+08:00）
  const shifted = new Date(Date.parse(appt.startAt) + 8 * 3600_000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(
    shifted.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** 在家庭准备文案里同步新的到访时刻（若原文已含“HH:MM”则替换，否则前置时间） */
export function withTimeInText(text: string, startIso: string): string {
  const hhmm = hmOf(startIso);
  if (/\d{1,2}:\d{2}/.test(text)) return text.replace(/\d{1,2}:\d{2}/, hhmm);
  return `到访时间 ${hhmm}：${text}`;
}

/** 一屏“派工单”：只含地点、任务、最小服务说明（不含个案内容） */
export interface DispatchSheetRow {
  workerName: string;
  rows: Array<{
    start: string;
    end: string;
    label: string;
    location: string;
    task: string;
    travelMin: number;
    fixed: boolean;
  }>;
}

export function buildDispatchSheet(plan: PlanResult, visits: SchedulerVisit[]): DispatchSheetRow[] {
  const workers = workersById();
  const byId = new Map(visits.map((v) => [v.id, v]));
  return plan.schedules.map((s) => ({
    workerName: workers.get(s.workerId)?.name ?? s.workerId,
    rows: s.stops.map((st) => {
      const v = byId.get(st.visitId);
      return {
        start: fmtMinute(st.start),
        end: fmtMinute(st.end),
        label: v?.label ?? st.visitId,
        location: nodeLabel(st.toNode),
        task: v?.task ?? '',
        travelMin: st.travelMin,
        fixed: st.fixed,
      };
    }),
  }));
}
