// 时间与展示格式化。
//
// 场景固定日期为 2026-11-25（周三）。种子里的时间均以 +08:00 书写，
// 但容器/CI 的进程时区可能是 UTC；为保证“9:30 就是 9:30”，这里统一按演示时区
// UTC+08:00 计算与展示，不依赖宿主时区。

export const DEMO_OFFSET_MIN = 8 * 60;
export const DEMO_TZ_LABEL = 'UTC+08:00（社区所在地演示时区）';

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function iso(y: number, m: number, d: number, hh = 9, mm = 0): string {
  return `${y}-${pad2(m)}-${pad2(d)}T${pad2(hh)}:${pad2(mm)}:00+08:00`;
}

function toMs(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Date.parse(value);
  return Number.isNaN(n) ? null : n;
}

/** 演示时区下的日期/时间分量 */
export function demoParts(value: number | string | null | undefined): {
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
  weekday: number;
} | null {
  const n = toMs(value);
  if (n === null) return null;
  const shifted = new Date(n + DEMO_OFFSET_MIN * 60_000);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(),
    mm: shifted.getUTCMinutes(),
    ss: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay(),
  };
}

export function dayKey(value: number | string): string | null {
  const p = demoParts(value);
  return p ? `${p.y}-${pad2(p.m)}-${pad2(p.d)}` : null;
}

/** 演示时区下，自当日 00:00 起算的分钟数 */
export function minuteOfDay(value: number | string | null | undefined): number | null {
  const p = demoParts(value);
  return p ? p.hh * 60 + p.mm : null;
}

/** 由“日期 + 当日分钟数”构造带 +08:00 的 ISO 字符串 */
export function isoFromDayMinute(day: string, minute: number): string {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${day}T${pad2(Math.floor(m / 60))}:${pad2(m % 60)}:00+08:00`;
}

export function minuteLabel(minute: number): string {
  const m = ((Math.round(minute) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

export function hm(isoStr: string | null | undefined): string {
  const p = demoParts(isoStr);
  return p ? `${pad2(p.hh)}:${pad2(p.mm)}` : '—';
}

export function mdWeek(isoStr: string): string {
  const p = demoParts(isoStr);
  if (!p) return '—';
  const weeks = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${p.m}月${p.d}日 ${weeks[p.weekday]}`;
}

export function fullTime(ts: number | string | null | undefined): string {
  const p = demoParts(ts);
  if (!p) return '—';
  return `${p.m}-${pad2(p.d)} ${pad2(p.hh)}:${pad2(p.mm)}:${pad2(p.ss)}`;
}

/** <input type="datetime-local"> 的值：按演示时区展开，避免宿主时区把 9:00 显示成 1:00 */
export function toLocalInputValue(isoStr: string | null): string {
  const p = demoParts(isoStr);
  if (!p) return '';
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}T${pad2(p.hh)}:${pad2(p.mm)}`;
}

export function fromLocalInputValue(v: string): string | null {
  if (!v) return null;
  // datetime-local 的字符串本身就是演示时区的墙上时间
  const m = v.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!m) return null;
  return `${m[1]}T${m[2]}:${m[3]}:00+08:00`;
}

/** 授权剩余时间文案 */
export function remainLabel(expiresAt: number, now: number): string {
  const ms = expiresAt - now;
  if (ms <= 0) return '已到期';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s} 秒后到期`;
  const min = Math.ceil(s / 60);
  if (min < 60) return `${min} 分钟后到期`;
  const h = Math.floor(min / 60);
  return `${h} 小时 ${min % 60} 分后到期`;
}
