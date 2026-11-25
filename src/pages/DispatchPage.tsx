import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp } from '../state/AppStore';
import { Badge, EmptyState, StatusBadge } from '../components/ui';
import { comparePlans, nodeName, type PlanResult } from '../lib/dispatchModel';
import { buildDispatchSheet, applyPlanToCases } from '../lib/planWrite';
import { fmtMinute } from '../lib/dispatch';
import { nodeLabel, ROAD_EDGES, ROAD_NODES, shortestTravel } from '../data/roadNetwork';
import { DISPATCH_WORKERS, DISPATCH_BLOCKS, STRAIGHT_LINE_MINUTES } from '../data/dispatch';
import { hm } from '../lib/time';

const WORKER_NAME = new Map(DISPATCH_WORKERS.map((w) => [w.id, w.name]));

function minutesLabel(n: number): string {
  return Number.isFinite(n) ? `${Math.round(n)} 分钟` : '不可达';
}

/** 人员变更后的“服务关系”说明：改派会改变客户见到的社工 */
function relationChange(plan: PlanResult, labelOf: (visitId: string) => string): string[] {
  return plan.reassigned.map(
    (r) =>
      `${labelOf(r.visitId)}：${WORKER_NAME.get(r.fromWorkerId) ?? r.fromWorkerId} → ${
        WORKER_NAME.get(r.toWorkerId) ?? r.toWorkerId
      }`,
  );
}

export default function DispatchPage() {
  const app = useApp();
  const { cases, actor, loginAs, applyDispatch, now } = app;
  const [selected, setSelected] = useState<'keep' | 'reassign'>('keep');
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<null | { mode: 'keep' | 'reassign'; caseCount: number }>(null);

  const comparison = useMemo(() => comparePlans(cases), [cases]);
  const plan = comparison[selected];
  const preview = useMemo(
    () => applyPlanToCases(cases, comparison.visits, plan, now),
    [cases, comparison.visits, plan, now],
  );
  const sheet = useMemo(() => buildDispatchSheet(plan, comparison.visits), [plan, comparison.visits]);

  const isSupervisor = actor?.role === 'supervisor';
  const visitById = new Map(comparison.visits.map((v) => [v.id, v]));

  async function doApply() {
    if (!plan.feasible) return;
    setBusy(true);
    try {
      const summary =
        selected === 'keep'
          ? `主管采用“保持服务人员”方案：调整未确认弹性访问，总路程 ${Math.round(plan.totalTravelMin)} 分钟，家庭准备与通知同步。`
          : `主管采用“客户同意范围内改派”方案：${plan.reassigned.length} 项改派，总路程 ${Math.round(plan.totalTravelMin)} 分钟，客户通知待发出。`;
      const res = await applyDispatch(plan, comparison.visits, summary);
      if (res.ok) {
        setApplied({ mode: selected, caseCount: res.cases.length });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">主管 · 跨个案上门日程编排</h1>
          <div className="page-sub">
            把多个个案已批准的服务预约放在同一名社工的一天里核对：服务时长、可接受时间窗、资质、
            固定社工偏好/改派同意、工作起止与已占用事项；路段用时用随题小型路网计算，不按直线距离排序。
          </div>
        </div>
        <div className="head-actions">
          <Link className="btn" to="/">
            返回待访清单
          </Link>
          {!isSupervisor && (
            <button className="btn btn-warn" onClick={() => loginAs('wang')}>
              一键切换为主管王敏
            </button>
          )}
        </div>
      </div>

      {!isSupervisor && (
        <div className="banner warn" role="status">
          当前账号是社工。可查看两种方案与派工单；<b>应用方案</b>需要主管身份（可用右上角按钮切换）。
        </div>
      )}

      <div className="banner info">
        <b>隐私边界：</b>本页只使用调度所需的“代号 + 路网节点 + 任务 + 时间窗 + 资质”。案情、住址、目标、
        观察、转介与提醒不会进入排程投影；跨客户个案内容不会在排程结果中互相暴露。
      </div>

      <div className="small muted" style={{ marginBottom: 10 }}>
        <b>已占用事项：</b>
        {DISPATCH_BLOCKS.map((b) => (
          <span key={b.workerId + b.label} style={{ marginRight: 16 }}>
            {DISPATCH_WORKERS.find((w) => w.id === b.workerId)?.name ?? b.workerId} · {b.label}{' '}
            {fmtMinute(b.start)}–{fmtMinute(b.end)}
          </span>
        ))}
        排程不会把服务或行驶塞进这些时段。
      </div>

      <div className="grid-2">
        <section className="card">
          <div className="card-hd">
            <h3>路网（随题小型数据）</h3>
            <Badge tone="gray">{ROAD_NODES.length} 个节点 · {ROAD_EDGES.length} 段道路</Badge>
          </div>
          <div className="card-bd">
            <div className="table-wrap">
              <table className="small">
                <thead>
                  <tr>
                    <th>关键路段</th>
                    <th>道路用时</th>
                    <th>直线估算</th>
                    <th>最短路径</th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['west-a', 'east-b'],
                      ['east-b', 'west-c'],
                      ['east-start', 'east-b'],
                    ] as const
                  ).map(([a, b]) => {
                    const r = shortestTravel(a, b);
                    const straight = STRAIGHT_LINE_MINUTES[a]?.[b] ?? STRAIGHT_LINE_MINUTES[b]?.[a] ?? 20;
                    return (
                      <tr key={`${a}-${b}`}>
                        <td>
                          {nodeLabel(a)} → {nodeLabel(b)}
                        </td>
                        <td>
                          <b>{r ? minutesLabel(r.minutes) : '不可达'}</b>
                        </td>
                        <td className="muted">{straight} 分钟</td>
                        <td className="mono tiny">{r?.path.map(nodeLabel).join(' → ')}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="small muted mt8" style={{ marginBottom: 0 }}>
              跨片区最短路恰好是“长绕行”；直线距离会明显低估，从而把会迟到的行程误判为可行。
            </p>
          </div>
        </section>

        <section className="card">
          <div className="card-hd">
            <h3>只看直线距离排序的反例</h3>
            <Badge tone="red">不可作为可行依据</Badge>
          </div>
          <div className="card-bd small">
            {comparison.straightLine.length === 0 && <p className="muted">暂无访问。</p>}
            {comparison.straightLine.map(({ workerId, result }) => (
              <div key={workerId} className="entity" style={{ margin: '0 0 10px' }}>
                <div className="entity-hd">
                  <b>{WORKER_NAME.get(workerId) ?? workerId}</b>
                  <Badge tone={result.feasible ? 'green' : 'red'}>
                    {result.feasible ? '恰好可行（不可依赖）' : '实际不可行'}
                  </Badge>
                </div>
                <div className="small muted">
                  直线估算总路程 {Math.round(result.estimatedTravelMin)} 分钟；路网实际总路程{' '}
                  {minutesLabel(result.actualTravelMin)}。{result.estimatedVerdict}。
                </div>
                <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                  {result.stops.map((s) => (
                    <li key={s.visit.id}>
                      {s.visit.label}：直线以为 {fmtMinute(s.plannedStart)} 可开始，路网实际{' '}
                      {fmtMinute(s.actualStart)}
                    </li>
                  ))}
                </ul>
                {result.violations.length > 0 && (
                  <ul className="small" style={{ margin: '6px 0 0 18px', padding: 0, color: 'var(--red-700)' }}>
                    {result.violations.map((v, i) => (
                      <li key={i}>{v}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="card">
        <div className="card-hd">
          <h3>今天要编排的访问（调度投影，仅最小信息）</h3>
          <span className="small muted">{comparison.visits.length} 项访问，来自多个个案</span>
        </div>
        <div className="card-bd table-wrap">
          <table className="dispatch-table">
            <thead>
              <tr>
                <th>代号</th>
                <th>地点</th>
                <th>任务（最小说明）</th>
                <th>时长</th>
                <th>可接受时间窗</th>
                <th>资质</th>
                <th>固定社工 / 改派</th>
                <th>确认</th>
              </tr>
            </thead>
            <tbody>
              {comparison.visits.map((v) => (
                <tr key={v.id}>
                  <td>
                    <b>{v.label}</b>
                    {v.fixed && <Badge tone="purple">固定</Badge>}
                  </td>
                  <td>{nodeName(v.node)}</td>
                  <td className="small">{v.task}</td>
                  <td>{v.durationMin}′</td>
                  <td className="small">
                    {fmtMinute(v.windowStart)}–{fmtMinute(v.windowEnd)}
                  </td>
                  <td className="small">{v.requiredSkills.join('、')}</td>
                  <td className="small">
                    {v.preferredWorkerId ? WORKER_NAME.get(v.preferredWorkerId) : '无固定偏好'}
                    <br />
                    {v.reassignConsent ? (
                      <Badge tone="green">同意改派</Badge>
                    ) : (
                      <Badge tone="amber">不同意改派</Badge>
                    )}
                  </td>
                  <td className="small">
                    {v.confirmed ? <Badge tone="blue">已确认</Badge> : <Badge tone="gray">弹性未确认</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="plan-toggle" role="tablist" aria-label="方案切换">
        {(
          [
            ['keep', '方案一 · 保持已确认的服务人员'],
            ['reassign', '方案二 · 在客户同意范围内改派'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={selected === k}
            className="tab-btn"
            onClick={() => setSelected(k)}
          >
            {label}
            {comparison.winner === k && <Badge tone="green">推荐</Badge>}
          </button>
        ))}
      </div>

      <div className="grid-2">
        <PlanCard
          plan={comparison.keep}
          visits={comparison.visits}
          title="方案一 · 保持人员"
          hint="保留已向客户确认的社工，只调整尚未确认的弹性访问；连续性较好，但可能保留较长空驶。"
          selected={selected === 'keep'}
          onSelect={() => setSelected('keep')}
        />
        <PlanCard
          plan={comparison.reassign}
          visits={comparison.visits}
          title="方案二 · 同意范围内改派"
          hint="只在客户明确同意改派的访问上换人；可减少路程、提高当天完成数，但会改变客户见到的社工并触发通知。"
          selected={selected === 'reassign'}
          onSelect={() => setSelected('reassign')}
        />
      </div>

      <section className="card">
        <div className="card-hd">
          <h3>所选方案 · 逐人时间线</h3>
          <div className="flex">
            <StatusBadge value={plan.feasible ? 'scheduled' : 'canceled'} />
            <span className="small muted">
              总路程 {minutesLabel(plan.totalTravelMin)} · 等待 {minutesLabel(plan.totalWaitMin)} · 完成{' '}
              {plan.visitCount} 项
            </span>
          </div>
        </div>
        <div className="card-bd">
          {!plan.feasible && (
            <div className="banner error" role="alert">
              <div>
                <b>该方案在约束内不可行（不包装成可行）：</b>
                <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
                  {plan.violations.map((v, i) => (
                    <li key={i}>{v}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {plan.feasible && (
            <>
              <div className="timeline-grid">
                {plan.schedules.map((ws) => {
                  const worker = DISPATCH_WORKERS.find((w) => w.id === ws.workerId);
                  return (
                    <div className="worker-day" key={ws.workerId}>
                      <div className="worker-day-hd">
                        <b>{worker?.name ?? ws.workerId}</b>
                        <span className="small muted">
                          {fmtMinute(worker?.shiftStart ?? 0)}–{fmtMinute(worker?.shiftEnd ?? 0)} · 起终点{' '}
                          {nodeLabel(worker?.startNode ?? '')}
                        </span>
                      </div>
                      <div className="worker-metrics">
                        <span>路程 {minutesLabel(ws.travelMin)}</span>
                        <span>工作 {minutesLabel(ws.workMin)}</span>
                        <span>休息 {minutesLabel(ws.restMin)}</span>
                        <span>等待 {minutesLabel(ws.waitMin)}</span>
                      </div>
                      {ws.stops.length === 0 && <p className="muted small">本方案中无上门访问。</p>}
                      <ol className="route-list">
                        <li className="route-node start">
                          <span className="route-time">{fmtMinute(worker?.shiftStart ?? 0)}</span>
                          <span>{nodeLabel(worker?.startNode ?? '')} 出发</span>
                        </li>
                        {ws.stops.map((st) => {
                          const v = visitById.get(st.visitId);
                          return (
                            <li key={st.visitId} className={`route-node ${st.fixed ? 'fixed' : ''}`}>
                              <span className="route-travel">
                                ↓ 路程 {st.travelMin} 分钟
                                {st.waitMin > 0 ? ` · 等待 ${st.waitMin} 分钟` : ''}
                              </span>
                              <div className="route-stop">
                                <span className="route-time">
                                  {fmtMinute(st.start)}–{fmtMinute(st.end)}
                                </span>
                                <div>
                                  <b>{v?.label ?? st.visitId}</b>{' '}
                                  {st.fixed && <Badge tone="purple">固定</Badge>}
                                  {st.reassignedFrom && (
                                    <Badge tone="amber">
                                      改派：{WORKER_NAME.get(st.reassignedFrom) ?? st.reassignedFrom} →{' '}
                                      {WORKER_NAME.get(st.workerId) ?? st.workerId}
                                    </Badge>
                                  )}
                                  <div className="small muted">
                                    {nodeName(st.toNode)} · {v?.task}
                                  </div>
                                </div>
                              </div>
                            </li>
                          );
                        })}
                        <li className="route-node end">
                          <span className="route-travel">↓ 收工回路 {minutesLabel(travelBack(ws.workerId))}</span>
                          <span className="route-time">
                            {fmtMinute(
                              (ws.stops[ws.stops.length - 1]?.end ?? DISPATCH_WORKERS.find((w) => w.id === ws.workerId)?.shiftStart ?? 0) +
                                travelBack(ws.workerId),
                            )}{' '}
                            回到 {nodeLabel(DISPATCH_WORKERS.find((w) => w.id === ws.workerId)?.endNode ?? '')}
                          </span>
                        </li>
                      </ol>
                    </div>
                  );
                })}
              </div>
              {plan.deferredVisitIds.length > 0 && (
                <div className="banner warn">
                  <b>留待另行安排（不计入已完成）：</b>
                  {plan.deferredVisitIds
                    .map((id) => visitById.get(id)?.label ?? id)
                    .join('、')}{' '}
                  —— 在资质/时间窗/休息/固定访问约束内，今天无法按时完成；本方案不把它们算作已完成。
                </div>
              )}
            </>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-hd">
          <h3>人员关系变化与客户通知（应用前预览）</h3>
          <Badge tone={preview.notifications.length ? 'amber' : 'gray'}>
            {preview.notifications.length} 条待发出
          </Badge>
        </div>
        <div className="card-bd small">
          {preview.notifications.length === 0 && <p className="muted">本方案不改动任何客户的预约或人员。</p>}
          {preview.notifications.map((n, i) => (
            <div key={i} className="notice-line">
              <Badge tone={n.kind === 'reassign' || n.kind === 'combined' ? 'amber' : 'blue'}>
                {n.kind === 'combined' ? '改约并改派' : n.kind === 'reassign' ? '改派' : '改约'}
              </Badge>
              <span>{n.text}</span>
              <span className="mono tiny muted">{n.caseId}</span>
            </div>
          ))}
          {preview.prepDiffs.length > 0 && (
            <>
              <h4 style={{ marginTop: 12 }}>家庭准备事项同步更新</h4>
              {preview.prepDiffs.map((p) => (
                <div key={p.appointmentId} className="prep-diff">
                  <b>{p.label}</b>
                  {p.items.map((it) => (
                    <div key={it.id} className="small">
                      <span className="muted">截止 {hm(it.beforeDue)} → </span>
                      <b>{hm(it.afterDue)}</b> · {it.after}
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
          {preview.rejected.length > 0 && (
            <div className="banner error mt8" style={{ marginBottom: 0 }}>
              {preview.rejected.map((r, i) => (
                <div key={i}>{r.reason}</div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="card">
        <div className="card-hd">
          <h3>派工单（工作人员只看到这些）</h3>
          <span className="small muted">地点 · 任务 · 最小服务说明 · 路程</span>
        </div>
        <div className="card-bd">
          <div className="dispatch-sheet">
            {sheet.map((w) => (
              <div className="sheet-worker" key={w.workerName}>
                <h4>{w.workerName}</h4>
                {w.rows.length === 0 && <p className="muted small">本方案无上门。</p>}
                <table className="small">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>地点</th>
                      <th>代号</th>
                      <th>任务</th>
                      <th>路程</th>
                    </tr>
                  </thead>
                  <tbody>
                    {w.rows.map((r, i) => (
                      <tr key={i}>
                        <td className="mono">
                          {r.start}–{r.end}
                          {r.fixed && <Badge tone="purple">固定</Badge>}
                        </td>
                        <td>{r.location}</td>
                        <td>{r.label}</td>
                        <td>{r.task}</td>
                        <td>{r.travelMin}′</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="sync-panel" aria-label="应用排程">
        <StatusBadge value={plan.feasible ? 'confirmed' : 'canceled'} />
        <span className="small">
          {plan.feasible
            ? `将写入 ${preview.changedCases.length} 个个案：改约/改派 + 家庭准备事项 + 待发通知`
            : '当前方案不可行，不能应用'}
        </span>
        <span className="spacer" />
        <button
          className="btn btn-primary"
          disabled={!isSupervisor || busy || !plan.feasible}
          onClick={doApply}
          title={isSupervisor ? '写入预约、家庭准备与待发通知，并记审计' : '需主管身份'}
        >
          {busy ? <span className="spinner" /> : null}
          应用「{selected === 'keep' ? '保持人员' : '同意范围内改派'}」方案
        </button>
      </div>

      {applied && (
        <section className="card" aria-live="polite">
          <div className="card-hd">
            <h3>已应用：{applied.mode === 'keep' ? '保持人员' : '改派'}方案</h3>
            <Badge tone="green">{applied.caseCount} 个个案已更新</Badge>
          </div>
          <div className="card-bd small">
            <p>
              预约时间、责任社工与家庭准备事项已在各案卷中同步更新；改动过的访问会生成“待发出”的客户通知，
              可在对应个案的「准备与通知」标签中逐条确认发出。
            </p>
            <div className="flex">
              <Link className="btn btn-sm" to="/case/case-bai">
                查看个案 柏文山 → 准备与通知
              </Link>
              <Link className="btn btn-sm" to="/audit">
                查看审计日志
              </Link>
            </div>
          </div>
        </section>
      )}

      {comparison.visits.length === 0 && <EmptyState title="今天没有可编排的上门访问" hint="到样例页重置数据后再试。" />}
    </>
  );

  function travelBack(workerId: string): number {
    const worker = DISPATCH_WORKERS.find((w) => w.id === workerId);
    const ws = plan.schedules.find((s) => s.workerId === workerId);
    const last = ws?.stops[ws?.stops.length ? ws.stops.length - 1 : 0];
    if (!worker || !last) return 0;
    return shortestTravel(last.toNode, worker.endNode)?.minutes ?? 0;
  }
}

function PlanCard({
  plan,
  visits,
  title,
  hint,
  selected,
  onSelect,
}: {
  plan: PlanResult;
  visits: Array<{ id: string; label: string }>;
  title: string;
  hint: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const labelOf = (id: string) => visits.find((v) => v.id === id)?.label ?? id;
  return (
    <section className={`card plan-card ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <div className="card-hd">
        <h3>{title}</h3>
        <Badge tone={plan.feasible ? 'green' : 'red'}>{plan.feasible ? '可行' : '不可行'}</Badge>
      </div>
      <div className="card-bd">
        <p className="small muted">{hint}</p>
        <div className="metric-row">
          <div>
            <span className="metric-num">{plan.visitCount}</span>
            <span className="small muted">完成访问</span>
          </div>
          <div>
            <span className="metric-num">{Number.isFinite(plan.totalTravelMin) ? Math.round(plan.totalTravelMin) : '—'}</span>
            <span className="small muted">总路程（分钟）</span>
          </div>
          <div>
            <span className="metric-num">{plan.reassigned.length}</span>
            <span className="small muted">改变人员关系</span>
          </div>
          <div>
            <span className="metric-num">{plan.deferredVisitIds.length}</span>
            <span className="small muted">留待改期</span>
          </div>
        </div>
        {!plan.feasible && (
          <p className="small" style={{ color: 'var(--red-700)' }}>
            不可行原因：{plan.violations[0]}
          </p>
        )}
        {plan.feasible && plan.deferredVisitIds.length > 0 && (
          <p className="small" style={{ color: 'var(--amber-700)' }}>
            延后：{plan.deferredVisitIds.join('、')}（不计入已完成）
          </p>
        )}
        {plan.feasible && plan.reassigned.length > 0 && (
          <p className="small">
            改派：
            {plan.reassigned
              .map(
                (r) =>
                  `${WORKER_NAME.get(r.fromWorkerId) ?? r.fromWorkerId} → ${WORKER_NAME.get(r.toWorkerId) ?? r.toWorkerId}`,
              )
              .join('；')}
          </p>
        )}
      </div>
    </section>
  );
}

