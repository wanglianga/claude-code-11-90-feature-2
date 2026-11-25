import type { CaseFile } from '../types';
import { DISPATCH_WORKERS, DISPATCH_DATE, DISPATCH_BLOCKS, type DispatchWorker } from '../data/dispatch';
import { buildTravelMatrix, nodeLabel } from '../data/roadNetwork';
import { minuteOfDay } from './time';
import {
  solvePlan,
  naiveStraightLineCheck,
  type PlanMode,
  type PlanResult,
  type SchedulerBlock,
  type SchedulerModel,
  type SchedulerVisit,
} from './dispatch';
import { straightLineLookup } from '../data/dispatch';

/**
 * 调度投影：从多个个案里只抽取“工作人员所需的地点、任务与最小服务说明”。
 * 明确排除案情、住址、目标、观察、转介、提醒等个案内容，避免跨客户暴露。
 */
export function projectVisits(cases: CaseFile[]): SchedulerVisit[] {
  const out: SchedulerVisit[] = [];
  for (const c of cases) {
    for (const a of c.appointments) {
      if (!a.schedule) continue;
      if (a.status === 'canceled') continue;
      const startMin = minuteOfDay(a.startAt);
      if (startMin === null) continue;
      out.push({
        id: a.id,
        caseId: c.id,
        label: a.schedule.publicLabel,
        task: a.schedule.task,
        node: a.schedule.locationNode,
        durationMin: a.durationMin,
        windowStart: a.schedule.windowStart,
        windowEnd: a.schedule.windowEnd,
        requiredSkills: [...a.schedule.requiredSkills],
        preferredWorkerId: a.schedule.preferredWorkerId,
        reassignConsent: a.schedule.reassignConsent,
        confirmed: a.schedule.confirmed,
        fixed: a.schedule.fixed,
        currentWorkerId: a.workerId ?? a.schedule.preferredWorkerId,
        // 已确认访问不能早于已承诺的时刻；未确认的弹性访问最早可到时间窗起点
        earliestStart: a.schedule.confirmed
          ? Math.max(startMin, a.schedule.windowStart)
          : a.schedule.windowStart,
        originalStart: startMin,
      });
    }
  }
  return out;
}

/** 已占用事项：既不能用来到访，也不能用来在路上；排程器会拒绝与这些时段重叠的行程 */
export function blockedFromVisits(_visits: SchedulerVisit[]): SchedulerBlock[] {
  return DISPATCH_BLOCKS.map((b) => ({ ...b }));
}

export function buildSchedulerModel(cases: CaseFile[], workers: DispatchWorker[] = DISPATCH_WORKERS): SchedulerModel {
  const matrix = buildTravelMatrix();
  const travel: Record<string, Record<string, number>> = {};
  const travelPaths: Record<string, Record<string, string[]>> = {};
  for (const [from, row] of Object.entries(matrix)) {
    travel[from] = {};
    travelPaths[from] = {};
    for (const [to, cell] of Object.entries(row)) {
      travel[from][to] = cell.minutes;
      travelPaths[from][to] = cell.path;
    }
  }
  const visits = projectVisits(cases);
  return {
    day: DISPATCH_DATE,
    workers: workers.map((w) => ({
      id: w.id,
      name: w.name,
      skills: [...w.skills],
      shiftStart: w.shiftStart,
      shiftEnd: w.shiftEnd,
      startNode: w.startNode,
      endNode: w.endNode,
      restRequiredAfterMin: w.restRequiredAfterMin,
      restMinutes: w.restMinutes,
      restWindowStart: w.restWindowStart,
      restWindowEnd: w.restWindowEnd,
    })),
    visits,
    travel,
    travelPaths,
    blocked: blockedFromVisits(visits),
  };
}

export type { PlanResult, PlanMode, SchedulerVisit, SchedulerModel };

/**
 * 服务端权威校验辅助：用“当前远端案卷”重新投影与求解，确认客户端提交的方案
 * 在最新数据上仍然得到同样的结论（人员、时刻、可完成集合）。生产系统应在服务端
 * 运行同一份排程器；这里把纯函数直接复用，避免信任过期的客户端结果。
 */
export function planFromStored(cases: CaseFile[], mode: PlanMode): PlanResult {
  return solvePlan(buildSchedulerModel(cases), mode);
}

export interface DispatchComparison {
  day: string;
  visits: SchedulerVisit[];
  keep: PlanResult;
  reassign: PlanResult;
  /** 直线距离贪心排序的反例（按当前责任社工执行） */
  straightLine: Array<{ workerId: string; result: ReturnType<typeof naiveStraightLineCheck> }>;
  winner: PlanMode | null;
}

export function comparePlans(cases: CaseFile[]): DispatchComparison {
  const model = buildSchedulerModel(cases);
  const keep = solvePlan(model, 'keep');
  const reassign = solvePlan(model, 'reassign');
  const straightLine = model.workers
    .map((w) => ({
      workerId: w.id,
      result: naiveStraightLineCheck(model, straightLineLookup, w.id),
    }))
    .filter((x) => x.result.stops.length > 0);

  // 只在两者都可行时比较；改派更“划算”才推荐改派
  let winner: PlanMode | null = null;
  if (keep.feasible && reassign.feasible) {
    const moreVisits = reassign.visitCount > keep.visitCount;
    const sameVisitsMuchShorter =
      reassign.visitCount === keep.visitCount && reassign.totalTravelMin + 20 < keep.totalTravelMin;
    winner = moreVisits || sameVisitsMuchShorter ? 'reassign' : 'keep';
  } else if (keep.feasible) winner = 'keep';
  else if (reassign.feasible) winner = 'reassign';

  return { day: DISPATCH_DATE, visits: model.visits, keep, reassign, straightLine, winner };
}

export function nodeName(id: string): string {
  return nodeLabel(id);
}
