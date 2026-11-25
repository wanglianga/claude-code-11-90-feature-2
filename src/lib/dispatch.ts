// 跨个案上门日程编排 —— 纯函数排程器
//
// 输入是“调度投影”：只含工作人员所需的代号、地点节点、时长、时间窗、资质、
// 固定社工偏好/改派同意、最早可开始时刻与已占用事项，不含任何个案内容。
//
// 两种方案：
//   keep     —— 保留已向客户确认的社工，只调整尚未确认的弹性访问；
//   reassign —— 在客户明确同意改派的范围内重新分配访问（可减少路程、提高完成数，
//               但会改变客户见到的社工并需要补发通知）。
//
// 约束（两种方案一致）：
//   * 资质：责任社工必须具备访问所需全部资质；
//   * 时间窗：到访开始时刻须落在 [windowStart, windowEnd]，且服务时长完整落在当天；
//   * 休息：连续工作超过阈值时，须在休息窗口内留出不短于 restMinutes 的完整休息；
//   * 固定访问：时刻不可移动，任何超时/错窗都判为不可行，不得包装成“可行”；
//   * 已占用事项：与访问冲突的已占用时段直接判不可行。
//
// 排程器只使用路网最短路矩阵；不按直线距离排序（直线估算仅作为反例展示）。

export interface SchedulerWorker {
  id: string;
  name: string;
  skills: string[];
  shiftStart: number;
  shiftEnd: number;
  startNode: string;
  endNode: string;
  restRequiredAfterMin: number;
  restMinutes: number;
  restWindowStart: number;
  restWindowEnd: number;
}

export interface SchedulerVisit {
  /** 访问 id（= 预约 id） */
  id: string;
  caseId: string;
  /** 调度板代号，不含姓名等个案内容 */
  label: string;
  /** 最小服务说明 */
  task: string;
  node: string;
  durationMin: number;
  windowStart: number;
  windowEnd: number;
  requiredSkills: string[];
  preferredWorkerId: string | null;
  reassignConsent: boolean;
  confirmed: boolean;
  fixed: boolean;
  /** 责任社工（预约当前 workerId）；未指定时退回 preferred */
  currentWorkerId: string | null;
  /** 该访问今天不能早于此刻开始（已向客户确认的时段） */
  earliestStart: number;
  /** 原计划到访时刻（自当日 00:00）。用于判断“是否改约”，与调度用的 earliestStart 分开 */
  originalStart: number;
}

export interface SchedulerModel {
  /** 服务日期（YYYY-MM-DD，仅用于生成 ISO 与展示） */
  day: string;
  workers: SchedulerWorker[];
  visits: SchedulerVisit[];
  /** 任意两路网节点的最短路分钟数 */
  travel: Record<string, Record<string, number>>;
  /** 与 travel 同步的路径节点（用于解释行程） */
  travelPaths?: Record<string, Record<string, string[]>>;
  /** 已占用事项（如固定接送占用的车辆） */
  blocked: SchedulerBlock[];
  /** 允许把“已确认、未同意改派”的访问改派给固定社工（用于反例演示，默认关闭） */
  allowConfirmedReassign?: boolean;
}

export interface SchedulerBlock {
  workerId: string;
  start: number;
  end: number;
  label: string;
}

export type PlanMode = 'keep' | 'reassign';

export interface Stop {
  visitId: string;
  workerId: string;
  /** 访问开始（服务开始，不是出发） */
  start: number;
  end: number;
  /** 出发时刻（= 开始 − 驶入用时） */
  departAt: number;
  arriveAt: number;
  travelMin: number;
  fromNode: string;
  toNode: string;
  travelPath: string[];
  waitMin: number;
  fixed: boolean;
  changedFromPlan: boolean;
  reassignedFrom: string | null;
}

export interface WorkerSchedule {
  workerId: string;
  stops: Stop[];
  /** 含起点驶出的总路程（分钟） */
  travelMin: number;
  /** 空档总时长（分钟；含等待、休息与班次内闲置） */
  idleMin: number;
  /** 各段之间真实等待（到得过早、等到时间窗） */
  waitMin: number;
  workMin: number;
  restMin: number;
  overtimeMin: number;
  violations: string[];
}

export interface PlanResult {
  mode: PlanMode;
  feasible: boolean;
  violations: string[];
  schedules: WorkerSchedule[];
  totalTravelMin: number;
  totalWaitMin: number;
  /** 真正在客户处的时间合计（不含空驶/等待） */
  totalServiceMin: number;
  visitCount: number;
  /** 与原始预约相比被移动的访问 */
  movedVisitIds: string[];
  /** 被改派的访问 → 原社工 */
  reassigned: Array<{ visitId: string; fromWorkerId: string; toWorkerId: string }>;
  /** 保持原时间与人员、但客户尚未确认的访问（不触发通知） */
  untouchedVisitIds: string[];
  /** 因当天无法在约束内完成而留待另行安排的弹性访问（显式列出，绝不隐藏） */
  deferredVisitIds: string[];
  /** 被延后访问的窗口截止之和：同等完成数下越大，说明被延后的是越不急的访问 */
  deferredDeadlineSum: number;
  /** 越早截止的访问越早开始（越小越好），避免“先做不急的、把急的往后推” */
  servedUrgencyScore: number;
  /** 改派后由谁在何时到访（供通知与差异表使用） */
  byVisit: Record<string, Stop | null>;
}

// ---------------- 小工具 ----------------

function travelOf(model: SchedulerModel, from: string, to: string): number {
  if (from === to) return 0;
  const v = model.travel[from]?.[to];
  return Number.isFinite(v) ? v : Infinity;
}

function pathOf(model: SchedulerModel, from: string, to: string): string[] {
  const p = model.travelPaths?.[from]?.[to];
  return p && p.length ? p : from === to ? [from] : [];
}

function overlaps(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1;
}

function workerById(model: SchedulerModel, id: string): SchedulerWorker | undefined {
  return model.workers.find((w) => w.id === id);
}

/**
 * 某访问在当前方案下允许由哪些社工执行。
 * - keep：人员冻结（只调整时刻），全部访问只由当前责任社工执行；
 * - reassign：仅在客户明确同意改派的访问上放开给合格社工；其余仍只由当前/固定社工执行。
 */
export function eligibleWorkers(model: SchedulerModel, visit: SchedulerVisit, mode: PlanMode): string[] {
  const qualified = model.workers.filter((w) => visit.requiredSkills.every((s) => w.skills.includes(s)));
  const frozen = visit.currentWorkerId ?? visit.preferredWorkerId;
  if (mode === 'keep') return qualified.filter((w) => w.id === frozen).map((w) => w.id);
  if (visit.reassignConsent || model.allowConfirmedReassign) return qualified.map((w) => w.id);
  return qualified.filter((w) => w.id === frozen).map((w) => w.id);
}

/** 已占用事项是否与 [start,end) 冲突 */
function blockedBy(model: SchedulerModel, workerId: string, start: number, end: number): SchedulerBlock | null {
  return (
    model.blocked.find((b) => b.workerId === workerId && overlaps(start, end, b.start, b.end)) ?? null
  );
}

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const p of permutations(rest)) out.push([items[i], ...p]);
  }
  return out;
}

// ---------------- 单社工的时间线评估 ----------------

interface CandidateStop {
  visit: SchedulerVisit;
  start: number;
  end: number;
  travelMin: number;
  path: string[];
  fromNode: string;
  waitMin: number;
  fixed: boolean;
}

interface RouteEval {
  feasible: boolean;
  violations: string[];
  stops: CandidateStop[];
  totalTravelMin: number;
  waitMin: number;
  idleMin: number;
  restMin: number;
  workMin: number;
  overtimeMin: number;
}

/**
 * 按给定顺序为某社工排出一条时间线。
 * 顺序是启发式候选，是否可行要在这里逐条判定（绝不“先排再假设可行”）。
 */
function evaluateRoute(
  model: SchedulerModel,
  worker: SchedulerWorker,
  ordered: SchedulerVisit[],
): RouteEval {
  const violations: string[] = [];
  const stops: CandidateStop[] = [];
  let cursor = worker.shiftStart;
  let node = worker.startNode;
  let travelSum = 0;
  let waitSum = 0;
  let lastEnd = worker.shiftStart;

  for (const visit of ordered) {
    const travel = travelOf(model, node, visit.node);
    if (!Number.isFinite(travel)) {
      violations.push(`${visit.label}：路网不可达（${worker.name} 无法从上一地点到达）。`);
      return { feasible: false, violations, stops, totalTravelMin: Infinity, waitMin: 0, idleMin: 0, restMin: 0, workMin: 0, overtimeMin: 0 };
    }
    const arrive = cursor + travel;
    // 固定访问必须准点：到得早要等，迟到则不可行
    const canStart = Math.max(arrive, visit.earliestStart);
    let start = canStart;
    if (visit.fixed) {
      // 固定访问的时间窗收窄为单点（seed 已如此，这里再确认一次）
      if (canStart > visit.windowEnd) {
        violations.push(
          `${visit.label}（固定）：若由 ${worker.name} 从上一地点出发，${fmt(arrive)} 才能到达，已晚于固定时刻 ${fmt(visit.windowStart)}（迟到 ${Math.round(canStart - visit.windowStart)} 分钟）。`,
        );
        return { feasible: false, violations, stops, totalTravelMin: Infinity, waitMin: 0, idleMin: 0, restMin: 0, workMin: 0, overtimeMin: 0 };
      }
      start = visit.windowStart;
    }
    // 行驶段本身也属于占用时间：与已占用事项重叠同样不可行
    const legFrom = cursor;
    const legBlock = blockedBy(model, worker.id, legFrom, Math.min(arrive, start));
    if (legBlock) {
      violations.push(
        `${visit.label}：${worker.name} 在前往途中会与已占用事项「${legBlock.label}」（${fmt(legBlock.start)}–${fmt(legBlock.end)}）重叠。`,
      );
      return { feasible: false, violations, stops, totalTravelMin: Infinity, waitMin: 0, idleMin: 0, restMin: 0, workMin: 0, overtimeMin: 0 };
    }
    const wait = Math.max(0, start - arrive);
    // 时间窗
    if (start > visit.windowEnd) {
      violations.push(
        `${visit.label}：若由 ${worker.name} 执行，最早 ${fmt(start)} 才能开始，晚于窗口截止 ${fmt(visit.windowEnd)}（迟到 ${Math.round(start - visit.windowEnd)} 分钟）。`,
      );
      return { feasible: false, violations, stops, totalTravelMin: Infinity, waitMin: 0, idleMin: 0, restMin: 0, workMin: 0, overtimeMin: 0 };
    }
    if (start < visit.windowStart) {
      violations.push(`${visit.label}：开始 ${fmt(start)} 早于窗口起点 ${fmt(visit.windowStart)}。`);
      return { feasible: false, violations, stops, totalTravelMin: Infinity, waitMin: 0, idleMin: 0, restMin: 0, workMin: 0, overtimeMin: 0 };
    }
    const end = start + visit.durationMin;
    if (end > worker.shiftEnd) {
      violations.push(
        `${visit.label}：${fmt(start)}–${fmt(end)} 超出 ${worker.name} 的班次结束 ${fmt(worker.shiftEnd)}（超时 ${Math.round(end - worker.shiftEnd)} 分钟）。`,
      );
      return { feasible: false, violations, stops, totalTravelMin: Infinity, waitMin: 0, idleMin: 0, restMin: 0, workMin: 0, overtimeMin: 0 };
    }
    if (end > 1440) {
      violations.push(`${visit.label}：结束时刻已越过当日 24:00。`);
      return { feasible: false, violations, stops, totalTravelMin: Infinity, waitMin: 0, idleMin: 0, restMin: 0, workMin: 0, overtimeMin: 0 };
    }
    // 已占用事项：服务与行驶都不能占用这些时段
    const occupiedStart = Math.min(start, start - travel);
    const block =
      blockedBy(model, worker.id, start, end) ??
      blockedBy(model, worker.id, occupiedStart, start) ??
      blockedBy(model, worker.id, occupiedStart, end);
    if (block) {
      violations.push(
        `${visit.label}：${worker.name} 的已占用事项「${block.label}」（${fmt(block.start)}–${fmt(block.end)}）与本段行程/服务重叠。`,
      );
      return { feasible: false, violations, stops, totalTravelMin: Infinity, waitMin: 0, idleMin: 0, restMin: 0, workMin: 0, overtimeMin: 0 };
    }

    stops.push({
      visit,
      start,
      end,
      travelMin: travel,
      path: pathOf(model, node, visit.node),
      fromNode: node,
      waitMin: wait,
      fixed: visit.fixed,
    });
    travelSum += travel;
    waitSum += wait;
    cursor = end;
    node = visit.node;
    lastEnd = end;
  }

  // 收工回路（空跑也算工作人员在路上的时间，因此一并计入当日路程）
  const back = travelOf(model, node, worker.endNode);
  if (!Number.isFinite(back)) {
    violations.push(`${worker.name}：收工回程路网不可达。`);
    return { feasible: false, violations, stops, totalTravelMin: Infinity, waitMin: 0, idleMin: 0, restMin: 0, workMin: 0, overtimeMin: 0 };
  }
  travelSum += back;

  // 休息：连续工作超过阈值时，必须在休息窗口内留出完整休息
  const workMin = lastEnd - worker.shiftStart;
  const restState = computeRest(model, worker, stops);
  const restMin = restState.longest;
  if (workMin > worker.restRequiredAfterMin && restMin < worker.restMinutes) {
    violations.push(
      `${worker.name}：连续工作 ${workMin} 分钟（超过 ${worker.restRequiredAfterMin} 分钟阈值），但在 ${fmt(worker.restWindowStart)}–${fmt(worker.restWindowEnd)} 内没有 ${worker.restMinutes} 分钟完整休息。`,
    );
  }
  const idleMin = Math.max(0, worker.shiftEnd - worker.shiftStart - workMin);

  return {
    feasible: violations.length === 0,
    violations,
    stops,
    totalTravelMin: travelSum,
    waitMin: waitSum,
    idleMin,
    restMin,
    workMin,
    overtimeMin: Math.max(0, lastEnd - worker.shiftEnd),
  };
}

interface RestState {
  longest: number;
  /** 最长休息段的起止（限定在休息窗口内） */
  at: { start: number; end: number } | null;
}

/** 在休息窗口内、两站之间能塞下的最长连续空档 */
function computeRest(model: SchedulerModel, worker: SchedulerWorker, stops: CandidateStop[]): RestState {
  const segs: Array<{ from: number; to: number }> = [];
  let prevEnd = worker.shiftStart;
  for (const s of stops) {
    // 到达前的空档：上一站结束 → 本站出发（出发 = 开始 − 驶入）
    const depart = s.start - s.travelMin;
    segs.push({ from: prevEnd, to: depart });
    prevEnd = s.end;
  }
  segs.push({ from: prevEnd, to: worker.shiftEnd });
  let longest = 0;
  let at: RestState['at'] = null;
  for (const seg of segs) {
    const lo = Math.max(seg.from, worker.restWindowStart);
    const hi = Math.min(seg.to, worker.restWindowEnd);
    if (hi > lo && hi - lo > longest) {
      longest = hi - lo;
      at = { start: lo, end: hi };
    }
  }
  return { longest, at };
}

function fmt(minute: number): string {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// ---------------- 分配枚举 ----------------

/**
 * 生成一个访问分配（visit → worker）。采用回溯 + 剪枝：
 * 每个访问在“允许的社工”中择一；已确认且不同意改派的访问只剩一个候选。
 */
function* assignments(model: SchedulerModel, mode: PlanMode): Generator<Record<string, string>> {
  const visits = [...model.visits].sort((a, b) => a.windowStart - b.windowStart);
  const chosen: Record<string, string> = {};

  function* walk(i: number): Generator<Record<string, string>> {
    if (i >= visits.length) {
      yield { ...chosen };
      return;
    }
    const v = visits[i];
    const options = eligibleWorkers(model, v, mode);
    if (options.length === 0) return; // 无合格社工：该分配不存在
    for (const wid of options) {
      chosen[v.id] = wid;
      yield* walk(i + 1);
    }
    delete chosen[v.id];
  }
  yield* walk(0);
}

/** 给定分配，为每个社工枚举顺序并保留最优可行路线（路程最小，其次等待最小） */
function assessAssignment(
  model: SchedulerModel,
  mode: PlanMode,
  assign: Record<string, string>,
): { feasible: boolean; totalTravelMin: number; violations: string[]; schedules: WorkerSchedule[]; byVisit: Record<string, Stop | null> } {
  const violations: string[] = [];
  const schedules: WorkerSchedule[] = [];
  const byVisit: Record<string, Stop | null> = {};
  for (const v of model.visits) byVisit[v.id] = null;
  let totalTravel = 0;
  let allFeasible = true;

  for (const worker of model.workers) {
    const mine = model.visits.filter((v) => assign[v.id] === worker.id);
    if (mine.length === 0) {
      // 空的社工：只计算其班次空档（无访问）
      schedules.push({
        workerId: worker.id,
        stops: [],
        travelMin: 0,
        idleMin: worker.shiftEnd - worker.shiftStart,
        waitMin: 0,
        workMin: 0,
        restMin: 0,
        overtimeMin: 0,
        violations: [],
      });
      continue;
    }

    let best: { eval: RouteEval; ordered: SchedulerVisit[] } | null = null;
    let bestInfeasible: RouteEval | null = null;
    const limit = mine.length <= 6 ? Infinity : 720; // 最多枚举 6! = 720 种顺序
    let tried = 0;
    for (const order of permutations(mine)) {
      if (++tried > limit) break;
      const ev = evaluateRoute(model, worker, order);
      if (ev.feasible) {
        if (!best || ev.totalTravelMin < best.eval.totalTravelMin || (ev.totalTravelMin === best.eval.totalTravelMin && ev.waitMin < best.eval.waitMin)) {
          best = { eval: ev, ordered: order };
        }
      } else if (!bestInfeasible) {
        bestInfeasible = ev;
      }
    }

    if (!best) {
      allFeasible = false;
      const reasons = bestInfeasible?.violations ?? [`${worker.name}：找不到任何可行顺序。`];
      violations.push(...reasons);
      schedules.push({
        workerId: worker.id,
        stops: [],
        travelMin: Infinity,
        idleMin: 0,
        waitMin: 0,
        workMin: 0,
        restMin: 0,
        overtimeMin: 0,
        violations: reasons,
      });
      continue;
    }

    totalTravel += best.eval.totalTravelMin;
    const stops: Stop[] = best.eval.stops.map((s) => {
      const departAt = s.start - s.travelMin;
      const reassignedFrom =
        assign[s.visit.id] !== (s.visit.currentWorkerId ?? s.visit.preferredWorkerId)
          ? s.visit.currentWorkerId ?? s.visit.preferredWorkerId ?? null
          : null;
      return {
        visitId: s.visit.id,
        workerId: worker.id,
        start: s.start,
        end: s.end,
        departAt,
        arriveAt: departAt + s.travelMin,
        travelMin: s.travelMin,
        fromNode: s.fromNode,
        toNode: s.visit.node,
        travelPath: s.path,
        waitMin: s.waitMin,
        fixed: s.visit.fixed,
        changedFromPlan:
          s.start !== s.visit.originalStart ||
          assign[s.visit.id] !== (s.visit.currentWorkerId ?? s.visit.preferredWorkerId),
        reassignedFrom,
      };
    });
    for (const st of stops) byVisit[st.visitId] = st;

    schedules.push({
      workerId: worker.id,
      stops,
      travelMin: best.eval.totalTravelMin,
      idleMin: best.eval.idleMin,
      waitMin: best.eval.waitMin,
      workMin: best.eval.workMin,
      restMin: best.eval.restMin,
      overtimeMin: best.eval.overtimeMin,
      violations: [],
    });
  }

  return {
    feasible: allFeasible && violations.length === 0,
    totalTravelMin: totalTravel,
    violations,
    schedules,
    byVisit,
  };
}

function originalStartOf(model: SchedulerModel, visit: SchedulerVisit): { start: number; workerId: string | null } {
  return { start: visit.originalStart, workerId: visit.currentWorkerId ?? visit.preferredWorkerId };
}

// ---------------- 对外：求解 ----------------

/** 可以“本方案今天不做、留待调度”的访问：未确认且非固定的弹性访问 */
export function isDroppable(v: SchedulerVisit): boolean {
  return !v.fixed && !v.confirmed;
}

/** 给定一组访问（已确定要完成），在分配空间里搜索最优可行解 */
function solveFixedSet(model: SchedulerModel, mode: PlanMode): { best: PlanResult | null; reasons: string[] } {
  let best: PlanResult | null = null;
  let infeasibleReasons: string[] = [];
  let tried = 0;
  for (const assign of assignments(model, mode)) {
    if (++tried > 4000) break;
    const assessed = assessAssignment(model, mode, assign);
    if (!assessed.feasible) {
      if (infeasibleReasons.length === 0) infeasibleReasons = assessed.violations;
      continue;
    }
    const visitCount = assessed.schedules.reduce((n, s) => n + s.stops.length, 0);
    const totalWaitMin = assessed.schedules.reduce((n, s) => n + s.waitMin, 0);
    const totalServiceMin = assessed.schedules.reduce(
      (n, s) => n + s.stops.reduce((m, st) => m + (st.end - st.start), 0),
      0,
    );
    const movedVisitIds: string[] = [];
    const reassigned: PlanResult['reassigned'] = [];
    const untouchedVisitIds: string[] = [];
    for (const v of model.visits) {
      const st = assessed.byVisit[v.id];
      if (!st) continue;
      const origWorker = v.currentWorkerId ?? v.preferredWorkerId ?? null;
      const timeChanged = st.start !== originalStartOf(model, v).start;
      const workerChanged = st.workerId !== origWorker;
      if (workerChanged) reassigned.push({ visitId: v.id, fromWorkerId: origWorker ?? '', toWorkerId: st.workerId });
      else if (timeChanged) movedVisitIds.push(v.id);
      else if (!v.confirmed) untouchedVisitIds.push(v.id);
    }

    const allStops = assessed.schedules.flatMap((s) => s.stops);
    const servedUrgencyScore = allStops.reduce((n, st) => {
      const v = model.visits.find((x) => x.id === st.visitId);
      return n + st.start * (1440 - (v?.windowEnd ?? 1440));
    }, 0);
    const result: PlanResult = {
      mode,
      feasible: true,
      violations: [],
      schedules: assessed.schedules,
      totalTravelMin: assessed.totalTravelMin,
      totalWaitMin,
      totalServiceMin,
      visitCount,
      movedVisitIds,
      reassigned,
      untouchedVisitIds,
      deferredVisitIds: [],
      deferredDeadlineSum: 0,
      servedUrgencyScore,
      byVisit: assessed.byVisit,
    };
    if (!best || better(result, best)) best = result;
  }
  return { best, reasons: infeasibleReasons };
}

/**
 * 求解某方案。可完全跳过的只有“未确认且非固定的弹性访问”（在结果中会列为
 * deferredVisitIds，界面必须提示“留待另行安排”，不能当成已完成）；若为完成它必然导致
 * 时间窗/固定访问/休息违约，则该访问留待另行安排并在结果中显式列出，绝不硬塞。
 */
export function solvePlan(model: SchedulerModel, mode: PlanMode): PlanResult {
  const droppable = model.visits.filter(isDroppable);
  const mandatory = model.visits.filter((v) => !isDroppable(v));
  const subsets = 1 << Math.min(droppable.length, 12);
  let best: PlanResult | null = null;
  let bestReasons: string[] = [];

  for (let mask = 0; mask < subsets; mask++) {
    const included = droppable.filter((_, i) => (mask & (1 << i)) !== 0);
    const visits = [...mandatory, ...included];
    const sub: SchedulerModel = { ...model, visits };
    const { best: res, reasons } = solveFixedSet(sub, mode);
    if (!res) {
      if (bestReasons.length === 0) bestReasons = reasons;
      continue;
    }
    const deferred = model.visits.filter(
      (v) => isDroppable(v) && !included.some((x) => x.id === v.id),
    );
    const deferredVisitIds = deferred.map((v) => v.id);
    const deferredDeadlineSum = deferred.reduce((n, v) => n + v.windowEnd, 0);
    const withDeferred: PlanResult = { ...res, deferredVisitIds, deferredDeadlineSum };
    // 已完成访问越多越好；同等时路程、等待更少更好；再同等时，尽量避免“为改派而改派”
    if (!best || better(withDeferred, best)) best = withDeferred;
  }

  if (!best) {
    const reason = bestReasons.length
      ? bestReasons
      : ['没有任何分配与顺序满足全部约束；固定访问或已确认访问无法排入当天。'];
    const emptySchedules: WorkerSchedule[] = model.workers.map((w) => ({
      workerId: w.id,
      stops: [],
      travelMin: 0,
      idleMin: w.shiftEnd - w.shiftStart,
      waitMin: 0,
      workMin: 0,
      restMin: 0,
      overtimeMin: 0,
      violations: [],
    }));
    return {
      mode,
      feasible: false,
      violations: reason,
      schedules: emptySchedules,
      totalTravelMin: 0,
      totalWaitMin: 0,
      totalServiceMin: 0,
      visitCount: 0,
      movedVisitIds: [],
      reassigned: [],
      untouchedVisitIds: [],
      deferredVisitIds: model.visits.map((v) => v.id),
      deferredDeadlineSum: 0,
      servedUrgencyScore: 0,
      byVisit: Object.fromEntries(model.visits.map((v) => [v.id, null])),
    };
  }
  return best;
}

/**
 * 选择方案：先保证“完成数更多”，再减少总路程，最后减少等待；“为改派而改派”
 * 不是目标——若两种方案完成数、路程接近，优先保持人员。
 */
function better(a: PlanResult, b: PlanResult): boolean {
  // 1) 完成得越多越好；
  if (a.visitCount !== b.visitCount) return a.visitCount > b.visitCount;
  // 2) 同等完成数下，优先把“截止更晚、最不急”的弹性访问留待改期
  //    （被延后者的截止之和越大，越说明舍弃的是容易改期的访问）；
  if (a.deferredDeadlineSum !== b.deferredDeadlineSum) return a.deferredDeadlineSum > b.deferredDeadlineSum;
  // 3) 同等完成数下，总路程更少更好（改派的价值正在于减少跨片区空驶）；
  if (a.totalTravelMin !== b.totalTravelMin) return a.totalTravelMin < b.totalTravelMin;
  // 4) 然后比较等待与“紧窗口优先开始”；
  if (a.totalWaitMin !== b.totalWaitMin) return a.totalWaitMin < b.totalWaitMin;
  if (a.servedUrgencyScore !== b.servedUrgencyScore) return a.servedUrgencyScore < b.servedUrgencyScore;
  // 5) 最后才是“少改派”；为改派而改派不是目标。
  return a.reassigned.length < b.reassigned.length;
}

// ---------------- 反例：按直线距离排序 ----------------

export interface NaiveStop {
  visit: SchedulerVisit;
  /** 按直线估算的到访开始 */
  plannedStart: number;
  /** 按真实路网推算的到访开始 */
  actualStart: number;
  end: number;
  travelMin: number;
}

export interface NaiveResult {
  feasible: boolean;
  violations: string[];
  stops: NaiveStop[];
  /** 直线估算的总路程 */
  estimatedTravelMin: number;
  /** 真实路网的总路程 */
  actualTravelMin: number;
  /** 直线估算认为可行的偏好结论（用于对比） */
  estimatedVerdict: string;
}

/**
 * “只按直线距离排序”的朴素做法：
 * 1) 按计划到访时刻先后决定访问顺序（最自然的手工排法）；
 * 2) 每段行程用直线估算分钟数来推算能否赶上；
 * 3) 再用真实路网最短路复核。
 * 注意：该反例只用于说明“直线距离不可靠”；它的顺序并不保证可行，也不代表
 * 排程器会这样排。
 *
 * 演示目的：直线估算会低估跨片区行程（例如 west-a→east-b 实际 45 分钟，
 * 直线估 14 分钟），从而把“其实会迟到”的行程误判为可行。
 */
export function naiveStraightLineCheck(
  model: SchedulerModel,
  straight: (from: string, to: string) => number,
  workerId: string,
): NaiveResult {
  const worker = workerById(model, workerId);
  if (!worker) {
    return { feasible: false, violations: [`未知社工 ${workerId}`], stops: [], estimatedTravelMin: 0, actualTravelMin: 0, estimatedVerdict: '未知社工' };
  }
  // 典型手工排法：按“计划到访时刻”先后排序（而不是按真实路网与固定访问约束）
  const visits = model.visits
    .filter((v) => (v.currentWorkerId ?? v.preferredWorkerId) === workerId)
    .sort((a, b) => {
      // 先按各自“今天计划里最自然”的先后：已确认看确认时刻，未确认看时间窗起点
      const ka = a.confirmed ? a.earliestStart : a.windowStart;
      const kb = b.confirmed ? b.earliestStart : b.windowStart;
      return ka - kb || a.id.localeCompare(b.id);
    });

  const violations: string[] = [];
  const stops: NaiveStop[] = [];
  let node = worker.startNode;
  let plannedCursor = worker.shiftStart;
  let actualCursor = worker.shiftStart;
  let estimatedTravel = 0;
  let actualTravel = 0;

  for (const v of visits) {
    const est = straight(node, v.node);
    const real = travelOf(model, node, v.node);
    estimatedTravel += est;
    actualTravel += Number.isFinite(real) ? real : Infinity;

    const plannedStart = Math.max(plannedCursor + est, v.earliestStart, v.windowStart);
    const actualArrive = actualCursor + (Number.isFinite(real) ? real : Infinity);
    let actualStart = Math.max(actualArrive, v.earliestStart, v.windowStart);
    if (v.fixed) actualStart = Math.max(actualStart, v.windowStart);
    const end = actualStart + v.durationMin;
    stops.push({ visit: v, plannedStart, actualStart, end, travelMin: Number.isFinite(real) ? real : Infinity });

    if (!Number.isFinite(real)) {
      violations.push(`${v.label}：路网不可达。`);
    } else if (actualStart > v.windowEnd) {
      violations.push(
        `${v.label}：按直线估算 ${fmt(plannedStart)} 就能开始，但路网实际 ${fmt(actualStart)} 才到，晚于窗口截止 ${fmt(v.windowEnd)}（迟到 ${Math.round(actualStart - v.windowEnd)} 分钟）。`,
      );
    }
    if (v.fixed && actualStart !== v.windowStart) {
      violations.push(
        `${v.label}（固定）：直线估算以为 ${fmt(plannedStart)} 可到，路网实际 ${fmt(actualStart)}，错过固定时刻 ${fmt(v.windowStart)}。`,
      );
    }
    if (end > worker.shiftEnd) {
      violations.push(`${v.label}：${fmt(end)} 超出班次结束 ${fmt(worker.shiftEnd)}。`);
    }
    plannedCursor = plannedStart + v.durationMin;
    actualCursor = end;
    node = v.node;
  }

  const estimatedVerdict = violations.length
    ? '直线估算表也会忽略时间窗，不能作为可行依据'
    : `直线估算看起来可行（总路程约 ${estimatedTravel} 分钟），但实际路网总路程约 ${actualTravel} 分钟`;
  return {
    feasible: violations.length === 0,
    violations,
    stops,
    estimatedTravelMin: estimatedTravel,
    actualTravelMin: actualTravel,
    estimatedVerdict,
  };
}

export const fmtMinute = fmt;
