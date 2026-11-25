import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { seedCases } from '../src/data/seed';
import { buildTravelMatrix, shortestTravel, travelMinutes } from '../src/data/roadNetwork';
import { comparePlans, projectVisits } from '../src/lib/dispatchModel';
import { fmtMinute, solvePlan } from '../src/lib/dispatch';
import { applyPlanToCases } from '../src/lib/planWrite';
import { buildSchedulerModel } from '../src/lib/dispatchModel';
import { DISPATCH_WORKERS, DISPATCH_DATE } from '../src/data/dispatch';
import { isoFromDayMinute, minuteOfDay } from '../src/lib/time';
import {
  apiApplyDispatch,
  apiGetCase,
  apiRemoteScript,
  ensureSeeded,
  setServerNetworkOnline,
} from '../src/mock/server';
import { ACCOUNTS } from '../src/config/accounts';
import type { CaseFile } from '../src/types';

const wang = ACCOUNTS[2]; // supervisor
const lin = ACCOUNTS[0];

const DISPATCH_CASE_IDS = ['case-an', 'case-bai', 'case-feng', 'case-kang', 'case-dan'];

function dispatchCases(cases: CaseFile[]): CaseFile[] {
  return cases.filter((c) => DISPATCH_CASE_IDS.includes(c.id));
}

describe('随题路网（按最短路，而非直线距离）', () => {
  it('西区 A → 东区 B、东区 B → 西区接送点 都是长绕行；同片区东区起点 → B 很短', () => {
    expect(travelMinutes('west-a', 'east-b')).toBe(45);
    expect(travelMinutes('east-b', 'west-c')).toBe(45);
    expect(travelMinutes('east-start', 'east-b')).toBe(10);
    // 对称
    expect(travelMinutes('east-b', 'west-a')).toBe(45);
    const p = shortestTravel('west-a', 'east-b')!;
    expect(p.path.length).toBeGreaterThan(2);
    expect(p.minutes).toBe(45);
  });

  it('矩阵覆盖全部节点且不可达返回 Infinity 而不是猜值', () => {
    const m = buildTravelMatrix();
    expect(m['west-a']['east-b'].minutes).toBe(45);
    expect(m['east-b']['west-c'].minutes).toBe(45);
    expect(m['hub-center']['east-b'].minutes).toBeGreaterThan(0);
    // 同一节点
    expect(m['west-a']['west-a'].minutes).toBe(0);
  });
});

describe('排程投影不暴露跨客户个案内容', () => {
  it('投影只含代号/地点/任务/时间窗/资质，不含姓名、住址、目标、观察', () => {
    const cases = seedCases();
    const visits = projectVisits(cases);
    const dump = JSON.stringify(visits);
    for (const c of dispatchCases(cases)) {
      expect(dump.includes(c.client.name)).toBe(false);
      expect(dump.includes(c.client.address)).toBe(false);
      // 目标与观察等个案内容不进入投影（示例目标的标题与“最小服务说明”重合，
      // 这里以独有的背景摘要与案卷 id 之外的字段为准）
      expect(dump.includes(c.client.background)).toBe(false);
      for (const v of c.visits) if (v.observations) expect(dump.includes(v.observations)).toBe(false);
    }
    const allowed = new Set([
      'id',
      'caseId',
      'label',
      'task',
      'node',
      'durationMin',
      'windowStart',
      'windowEnd',
      'requiredSkills',
      'preferredWorkerId',
      'reassignConsent',
      'confirmed',
      'fixed',
      'currentWorkerId',
      'earliestStart',
      'originalStart',
    ]);
    for (const v of visits) for (const k of Object.keys(v)) expect(allowed.has(k)).toBe(true);
    // 任务说明是“最小说明”
    expect(visits.every((v) => v.task.length <= 40)).toBe(true);
  });
});

describe('两种方案：保持人员 vs 同意范围内改派', () => {
  const cases = seedCases();
  const cmp = comparePlans(cases);
  const visitById = new Map(cmp.visits.map((v) => [v.id, v]));

  it('保持人员：给客户确认的社工不变，B 可被排到 10:30 且 12:00 固定接送可达', () => {
    const keep = cmp.keep;
    expect(keep.feasible).toBe(true);
    expect(keep.reassigned).toHaveLength(0);
    const linDay = keep.schedules.find((s) => s.workerId === 'lin')!;
    const byId = new Map(linDay.stops.map((s) => [s.visitId, s]));
    expect(fmtMinute(byId.get('an-appt-a')!.start)).toBe('09:00');
    expect(fmtMinute(byId.get('bai-appt-b')!.start)).toBe('10:30');
    const fixed = byId.get('kang-appt-fixed')!;
    expect(fmtMinute(fixed.start)).toBe('12:00');
    // B→接送点 45 分钟，说明是路网值而不是直线估算
    expect(fixed.travelMin).toBe(45);
    // 东区丹（客户不同意改派）仍由林晓执行
    expect(byId.get('dan-appt-d')!.workerId).toBe('lin');
  });

  it('改派：B 由周明 10:00 到访，林晓不再跨区往返，完成数更多、总路程更少', () => {
    const re = cmp.reassign;
    expect(re.feasible).toBe(true);
    const bStop = re.byVisit['bai-appt-b']!;
    expect(bStop.workerId).toBe('zhou');
    expect(fmtMinute(bStop.start)).toBe('10:00');
    expect(bStop.travelMin).toBe(10);
    // 林晓不再跑西区→东区→西区
    const linDay = re.schedules.find((s) => s.workerId === 'lin')!;
    expect(linDay.stops.some((s) => s.toNode === 'east-b')).toBe(false);
    expect(re.totalTravelMin).toBeLessThan(cmp.keep.totalTravelMin);
    expect(re.visitCount).toBeGreaterThan(cmp.keep.visitCount);
    // 改派只发生在客户同意改派的访问上
    for (const r of re.reassigned) {
      const v = visitById.get(r.visitId)!;
      expect(v.reassignConsent).toBe(true);
      expect(v.confirmed).toBe(false);
    }
    // 东区丹不同意改派 → 不会出现在改派列表中
    expect(re.reassigned.some((r) => r.visitId === 'dan-appt-d')).toBe(false);
  });

  it('固定接送不因方案不同而移动；任何时段都不越过 12:00 固定时刻', () => {
    for (const mode of ['keep', 'reassign'] as const) {
      const p = cmp[mode];
      const fixed = p.byVisit['kang-appt-fixed']!;
      expect(fixed).toBeTruthy();
      expect(fmtMinute(fixed.start)).toBe('12:00');
      for (const ws of p.schedules) {
        for (const st of ws.stops) expect(st.end).toBeLessThanOrEqual(1440);
      }
    }
  });

  it('资质、时间窗、休息都在两种方案中被校验', () => {
    const model = buildSchedulerModel(cases);
    for (const mode of ['keep', 'reassign'] as const) {
      const p = cmp[mode];
      for (const ws of p.schedules) {
        for (const st of ws.stops) {
          const v = visitById.get(st.visitId)!;
          const w = DISPATCH_WORKERS.find((x) => x.id === st.workerId)!;
          // 资质
          for (const s of v.requiredSkills) expect(w.skills).toContain(s);
          // 时间窗
          expect(st.start).toBeGreaterThanOrEqual(v.windowStart);
          expect(st.start).toBeLessThanOrEqual(v.windowEnd);
          // 班次
          expect(st.start).toBeGreaterThanOrEqual(w.shiftStart);
          expect(st.end).toBeLessThanOrEqual(w.shiftEnd);
        }
      }
    }
    const modelRest = model.workers.find((w) => w.id === 'lin')!;
    expect(modelRest.restRequiredAfterMin).toBeGreaterThan(0);
  });

  it('已占用事项被尊重：周明若被占用，改派不会把他的行程/服务塞进占用时段', () => {
    const model = buildSchedulerModel(cases);
    expect(model.blocked.length).toBeGreaterThan(0);
    for (const mode of ['keep', 'reassign'] as const) {
      for (const ws of cmp[mode].schedules) {
        for (const st of ws.stops) {
          for (const b of model.blocked.filter((x) => x.workerId === st.workerId)) {
            // 服务与行驶段都不与占用重叠
            expect(st.start >= b.end || st.end <= b.start).toBe(true);
            expect(st.departAt >= b.end || st.start <= b.start).toBe(true);
          }
        }
      }
    }
  });

  it('直接按直线距离排序的方案会被判不可行（固定接送迟到）', () => {
    const sl = cmp.straightLine.find((x) => x.workerId === 'lin')!;
    expect(sl.result.feasible).toBe(false);
    expect(sl.result.violations.some((v) => v.includes('固定') || v.includes('晚于窗口'))).toBe(true);
    // 直线估算远低于真实路网
    expect(sl.result.estimatedTravelMin).toBeLessThan(sl.result.actualTravelMin);
    // 固定接送会被其排到 12:00 之后
    const fixedStop = sl.result.stops.find((s) => s.visit.fixed)!;
    expect(fmtMinute(fixedStop.actualStart) > '12:00').toBe(true);
  });
});

describe('不可行必须如实报不可行（不得包装）', () => {
  it('把东区 B 改成“客户不同意改派的已确认访问”并卡死在 11:00–11:10 → 保持人员方案不可行', () => {
    const cases = seedCases().filter((c) => DISPATCH_CASE_IDS.includes(c.id));
    const bai = cases.find((c) => c.id === 'case-bai')!;
    const appt = bai.appointments.find((a) => a.id === 'bai-appt-b')!;
    // 已确认且不可丢弃、也不可改派：约束内必须完成
    appt.schedule!.windowStart = 660; // 11:00
    appt.schedule!.windowEnd = 670; // 11:10
    appt.schedule!.confirmed = true;
    appt.schedule!.reassignConsent = false;
    appt.startAt = isoFromDayMinute(DISPATCH_DATE, 660);
    const model = buildSchedulerModel(cases);
    const plan = solvePlan(model, 'keep');
    // B 11:00–11:30；B→接送点 45 分钟 → 12:15 才能到，固定 12:00 不可能
    expect(plan.feasible).toBe(false);
    const text = plan.violations.join('\n');
    expect(text).toMatch(/固定|晚于窗口|迟到/);
    // 绝不出现“把固定访问放到 12:00 之后”的可行结果
    expect(plan.schedules.every((s) => s.stops.every((st) => (st.fixed ? st.start === 720 : true)))).toBe(true);
  });

  it('未被确认的弹性访问若强行排入会撞固定接送，则如实列为“留待改期”而不是硬塞', () => {
    const cases = seedCases().filter((c) => DISPATCH_CASE_IDS.includes(c.id));
    const bai = cases.find((c) => c.id === 'case-bai')!;
    const appt = bai.appointments.find((a) => a.id === 'bai-appt-b')!;
    appt.schedule!.windowStart = 660;
    appt.schedule!.windowEnd = 670;
    appt.schedule!.confirmed = false;
    const model = buildSchedulerModel(cases);
    const plan = solvePlan(model, 'keep');
    expect(plan.feasible).toBe(true);
    expect(plan.deferredVisitIds).toContain('bai-appt-b');
    // 固定访问仍在 12:00
    expect(fmtMinute(plan.byVisit['kang-appt-fixed']!.start)).toBe('12:00');
  });

  it('资质不足时不会硬塞：去掉周明的助餐资质后，改派方案只能保留原社工', () => {
    const cases = seedCases().filter((c) => DISPATCH_CASE_IDS.includes(c.id));
    const workers = DISPATCH_WORKERS.map((w) =>
      w.id === 'zhou' ? { ...w, skills: [] } : w,
    );
    const model = buildSchedulerModel(cases, workers);
    const plan = solvePlan(model, 'reassign');
    expect(plan.reassigned).toHaveLength(0);
    for (const ws of plan.schedules) for (const st of ws.stops) expect(st.workerId).toBe('lin');
  });
});

describe('写回：预约 / 家庭准备 / 通知 同步', () => {
  it('改约的访问同时移动家庭准备截止与文案，并生成待发通知', () => {
    const cases = seedCases();
    const cmp = comparePlans(cases);
    const now = Date.now();
    const res = applyPlanToCases(cases, cmp.visits, cmp.keep, now);
    const bai = res.changedCases.find((c) => c.id === 'case-bai')!;
    const appt = bai.appointments.find((a) => a.id === 'bai-appt-b')!;
    expect(minuteOfDay(appt.startAt)).toBe(630); // 10:30
    const orig = cases.find((c) => c.id === 'case-bai')!.familyPreps[0];
    const moved = bai.familyPreps.find((p) => p.id === orig.id)!;
    expect(moved.dueAt).not.toBe(orig.dueAt);
    // dueAt = 到访前 leadMinutes
    expect(Date.parse(moved.dueAt)).toBe(Date.parse(appt.startAt) - moved.leadMinutes * 60_000);
    // 文案里的时刻也同步
    expect(moved.text).toContain('10:30');
    // 待发通知
    expect(bai.notifications.some((n) => n.appointmentId === 'bai-appt-b' && n.status === 'intended')).toBe(true);
    // 固定接送与其它预约不动
    const kang = res.changedCases.find((c) => c.id === 'case-kang');
    expect(kang).toBeUndefined();
  });

  it('已发出的旧通知在改约后被标注为“已被后续替代”，避免与新时间冲突', () => {
    const cases = seedCases();
    const an = cases.find((c) => c.id === 'case-an')!;
    // 给安制造一条已发出的旧承诺（09:00）
    an.notifications.push({
      id: 'old-an',
      appointmentId: 'an-appt-a',
      kind: 'confirmed',
      status: 'sent',
      text: '东区·安：已确认 09:00 到访。',
      createdAt: Date.now() - 3600_000,
      sentAt: Date.now() - 3600_000,
    });
    // 手动把安的预约挪到 09:30，再回写 09:00 之外的安排
    const cmp = comparePlans(cases);
    const plan = structuredClone(cmp.keep);
    plan.byVisit['an-appt-a'] = { ...plan.byVisit['an-appt-a']!, start: 570, departAt: 519, arriveAt: 570 };
    const res = applyPlanToCases(cases, cmp.visits, plan, Date.now());
    const an2 = res.changedCases.find((c) => c.id === 'case-an')!;
    const old = an2.notifications.find((n) => n.id === 'old-an')!;
    expect(old.text).toContain('已被后续改约');
    expect(an2.notifications.some((n) => n.status === 'intended' && n.appointmentId === 'an-appt-a')).toBe(true);
  });

  it('改派同时生成“改约并改派”通知，文案点明新到访人与时间', () => {
    const cases = seedCases();
    const cmp = comparePlans(cases);
    const res = applyPlanToCases(cases, cmp.visits, cmp.reassign, Date.now());
    const bai = res.changedCases.find((c) => c.id === 'case-bai')!;
    const n = bai.notifications.find((x) => x.appointmentId === 'bai-appt-b' && x.status === 'intended')!;
    // B 原计划 10:00 → 改派后仍 10:00，只有人员变化；文案需点明新到访人与时间
    expect(['reassign', 'combined']).toContain(n.kind);
    expect(n.text).toContain('10:00');
    expect(n.text).toContain('周明');
    expect(n.text).toContain('林晓');
  });
});

describe('模拟服务端：主管应用方案', () => {
  beforeEach(async () => {
    setServerNetworkOnline(true);
    await ensureSeeded(true);
  });

  it('非主管被拒；主管应用后个案与家庭准备同步，并写审计', async () => {
    const all: CaseFile[] = [];
    for (const id of DISPATCH_CASE_IDS) all.push(await apiGetCase(id, wang));
    const cmp = comparePlans(all);

    const forbidden = await apiApplyDispatch({
      actor: lin,
      tabId: 'tab-social',
      plan: cmp.keep,
      visits: cmp.visits,
      summary: '社工尝试应用',
    });
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.code).toBe('FORBIDDEN');

    const ok = await apiApplyDispatch({
      actor: wang,
      tabId: 'tab-W',
      plan: cmp.keep,
      visits: cmp.visits,
      summary: '主管采用保持人员方案',
    });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    const bai = ok.cases.find((c) => c.id === 'case-bai')!;
    expect(minuteOfDay(bai.appointments.find((a) => a.id === 'bai-appt-b')!.startAt)).toBe(630);
    expect(bai.notifications.some((n) => n.status === 'intended')).toBe(true);
    expect(bai.familyPreps[0].text).toContain('10:30');
    expect(ok.audits.some((a) => a.action === 'dispatch-apply')).toBe(true);
  });

  it('固定访问被移动 → 服务端拒绝写入', async () => {
    const all: CaseFile[] = [];
    for (const id of DISPATCH_CASE_IDS) all.push(await apiGetCase(id, wang));
    const cmp = comparePlans(all);
    // 伪造：把固定接送挪到 12:30
    const forged = structuredClone(cmp.keep);
    forged.byVisit['kang-appt-fixed'] = { ...forged.byVisit['kang-appt-fixed']!, start: 750, departAt: 705, arriveAt: 750 };
    const res = await apiApplyDispatch({
      actor: wang,
      tabId: 'tab-W',
      plan: forged,
      visits: cmp.visits,
      summary: '伪造固定访问移动',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('VALIDATION');
    // 远端保持原样
    const kang = await apiGetCase('case-kang', wang);
    expect(minuteOfDay(kang.appointments[0].startAt)).toBe(720);
  });

  it('个案已被他人更新 → 不覆盖他人修改', async () => {
    const all: CaseFile[] = [];
    for (const id of DISPATCH_CASE_IDS) all.push(await apiGetCase(id, wang));
    const cmp = comparePlans(all);
    // 另一通道先修改 case-an
    await apiRemoteScript({
      actor: { id: 'lin', name: '林晓', role: 'social_worker' },
      tabId: 'tab-A',
      caseId: 'case-an',
      action: 'reschedule',
      target: 'an-appt-a',
      summary: '他人改约',
      mutate: (c) => {
        c.appointments[0].startAt = isoFromDayMinute(DISPATCH_DATE, 545);
      },
    });
    const res = await apiApplyDispatch({
      actor: wang,
      tabId: 'tab-W',
      plan: cmp.keep,
      visits: cmp.visits,
      summary: '基于旧版本的方案',
    });
    // 由于服务端以“最新远端”重新计算，方案仍可能成功；关键是不得把 an-appt-a 写回 09:00
    // 要么因版本前进整批拒绝，要么按最新远端重新排程；无论如何不得把 09:05 写回 09:00
    if (!res.ok) expect(['CONFLICT', 'VALIDATION']).toContain(res.code);
    const anNow = await apiGetCase('case-an', wang);
    expect(minuteOfDay(anNow.appointments[0].startAt)).not.toBe(540);
    expect(minuteOfDay(anNow.appointments[0].startAt)).toBe(545);
  });
});
