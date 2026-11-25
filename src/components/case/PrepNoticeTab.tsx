import type { CaseFile } from '../../types';
import { useApp } from '../../state/AppStore';
import { Badge, StatusBadge } from '../ui';
import { fullTime, hm, mdWeek } from '../../lib/time';

const KIND_LABEL: Record<string, string> = {
  reschedule: '改约',
  reassign: '改派',
  combined: '改约并改派',
  confirmed: '确认',
  kept: '保持原安排',
};

/** 「准备与通知」：预约被移动/改派后，家庭准备事项与通知必须同步更新 */
export default function PrepNoticeTab({ caseId, value }: { caseId: string; value: CaseFile }) {
  const { markNotificationsSent, online, pushToast, actor } = useApp();
  const intended = value.notifications.filter((n) => n.status === 'intended');
  const sent = value.notifications.filter((n) => n.status === 'sent');

  const apptLabel = (id: string) => value.appointments.find((a) => a.id === id)?.label ?? id;

  async function send(ids: string[]) {
    if (!ids.length) return;
    const r = await markNotificationsSent(caseId, ids);
    if (r.ok) pushToast('通知已标记为发出', 'success');
    else pushToast(r.message ?? '发送失败', 'error');
  }

  return (
    <div className="grid-2">
      <section className="card">
        <div className="card-hd">
          <h3>家庭准备事项</h3>
          <Badge tone="gray">{value.familyPreps.length} 项</Badge>
        </div>
        <div className="card-bd">
          {value.familyPreps.length === 0 && (
            <p className="muted small">本案暂无需要家庭提前准备的固定事项。</p>
          )}
          {value.familyPreps.map((p) => {
            const appt = value.appointments.find((a) => a.id === p.appointmentId);
            return (
              <div className="entity" key={p.id}>
                <div className="entity-hd">
                  <span className="entity-title">
                    {p.kind === 'key' ? '门禁/联系卡' : '到访准备'} · {apptLabel(p.appointmentId)}
                  </span>
                  <Badge tone={p.done ? 'green' : 'amber'}>
                    {p.done ? '已完成' : `到访前 ${p.leadMinutes} 分钟截止`}
                  </Badge>
                </div>
                <p className="small" style={{ margin: '6px 0' }}>
                  {p.text}
                </p>
                <div className="small muted">
                  截止：{hm(p.dueAt)} · 关联预约：{appt ? `${mdWeek(appt.startAt)} ${hm(appt.startAt)}` : '—'}
                </div>
              </div>
            );
          })}
          <p className="small muted mt8" style={{ marginBottom: 0 }}>
            预约一旦被移动，上面每一条的截止时刻与文案都会由排程写回同步更新；
            不会出现“日历改了、家庭准备还停在旧时间”的情况。
          </p>
        </div>
      </section>

      <section className="card">
        <div className="card-hd">
          <h3>客户通知</h3>
          <div className="flex">
            <Badge tone={intended.length ? 'amber' : 'gray'}>待发出 {intended.length}</Badge>
            <Badge tone="green">已发出 {sent.length}</Badge>
          </div>
        </div>
        <div className="card-bd">
          {value.notifications.length === 0 && <p className="muted small">本个案暂无改约/改派通知。</p>}
          {[...intended, ...sent].map((n) => (
            <div className="entity" key={n.id}>
              <div className="entity-hd">
                <span className="entity-title">
                  {KIND_LABEL[n.kind] ?? n.kind} · {apptLabel(n.appointmentId)}
                </span>
                <StatusBadge value={n.status} />
              </div>
              <p className="small" style={{ margin: '6px 0' }}>
                {n.text}
              </p>
              <div className="small muted">
                生成 {fullTime(n.createdAt)}
                {n.sentAt ? ` · 发出 ${fullTime(n.sentAt)}` : ''}
              </div>
            </div>
          ))}
          {intended.length > 0 && (
            <button
              className="btn btn-primary btn-sm mt8"
              disabled={!online || actor?.role !== 'supervisor'}
              onClick={() => send(intended.map((n) => n.id))}
              title={actor?.role === 'supervisor' ? '标记为已发出并写审计' : '需主管身份'}
            >
              {online ? '确认发出全部待发通知（写审计）' : '离线：恢复网络后可发出'}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
