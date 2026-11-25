// 跨个案上门日程编排 —— 随题演示数据（全部虚构）
//
// 设计目标：
// 1) 两个个案各自都“可放进日历”，但同一名社工合在一起会因路程迟到；
// 2) 保持人员（W1 继续做东区 B）可行，但把 B 推到 10:30、总路程高；
// 3) 允许改派时 W2 在 10:00 到访 B，减少路程并多做一项，但改变服务关系、触发通知；
// 4) 12:00 的西区固定复诊接送是硬约束，B→接送点 45 分钟，任何超时都不得包装成可行；
// 5) 东区丹的客户不同意改派，即使改派能省路程也必须原样保留。
//
// 这里的“代号（西区·安 等）”只服务于调度板，与居民姓名无关；调度投影不包含
// 案情、住址、目标、观察等个案内容。

import type {
  Appointment,
  CaseFile,
  CaseNotification,
  FamilyPrepItem,
  VisitRecord,
} from '../types';
import { iso } from '../lib/time';

export const DISPATCH_DATE = '2026-11-25';

/** 当日分钟数常量（与演示时区一致，不依赖宿主时区） */
export const MIN = {
  '08:00': 480,
  '09:00': 540,
  '09:30': 570,
  '09:45': 585,
  '10:00': 600,
  '10:30': 630,
  '11:00': 660,
  '11:30': 690,
  '12:00': 720,
  '12:30': 750,
  '13:00': 780,
  '13:45': 825,
  '14:00': 840,
  '14:30': 870,
  '17:00': 1020,
} as const;

/** 当天已占用事项（不可用于上门或行驶） */
export interface DispatchBlock {
  workerId: string;
  start: number;
  end: number;
  label: string;
}

export const DISPATCH_BLOCKS: DispatchBlock[] = [
  {
    workerId: 'zhou',
    start: MIN['09:00'],
    end: MIN['09:30'],
    label: '东区服务点晨会（已占用）',
  },
];

export interface DispatchWorker {
  id: string;
  name: string;
  title: string;
  skills: string[];
  shiftStart: number;
  shiftEnd: number;
  startNode: string;
  endNode: string;
  /** 连续工作超过该分钟数后，必须在休息窗口内获得一段完整休息 */
  restRequiredAfterMin: number;
  restMinutes: number;
  restWindowStart: number;
  restWindowEnd: number;
  /** 仅用于说明，不参与计算 */
  note: string;
}

export const DISPATCH_WORKERS: DispatchWorker[] = [
  {
    id: 'lin',
    name: '林晓',
    title: '社工 · 第三网格',
    skills: ['助餐评估', '复诊陪同'],
    shiftStart: MIN['08:00'],
    shiftEnd: MIN['17:00'],
    startNode: 'hub-center',
    endNode: 'hub-center',
    restRequiredAfterMin: 240,
    restMinutes: 20,
    restWindowStart: MIN['11:00'],
    restWindowEnd: MIN['14:00'],
    note: '从街道服务中心出发；西区服务关系已确认。',
  },
  {
    id: 'zhou',
    name: '周明',
    title: '社工 · 第二网格',
    skills: ['助餐评估'],
    shiftStart: MIN['08:00'],
    shiftEnd: MIN['17:00'],
    startNode: 'east-start',
    endNode: 'east-start',
    restRequiredAfterMin: 240,
    restMinutes: 20,
    restWindowStart: MIN['11:00'],
    restWindowEnd: MIN['14:00'],
    note: '从东区服务点出发；具备助餐评估资质，可备选承接东区弹性访问。',
  },
];

/**
 * “直线距离估算”的分钟数（仅供反例演示）。
 * 真实道路用时见 roadNetwork.ts；本表刻意低估跨片区行程，用来证明
 * “按直线距离排序”会排出不可行的行程。
 */
export const STRAIGHT_LINE_MINUTES: Record<string, Record<string, number>> = {
  'hub-center': {
    'hub-center': 0,
    'west-a': 12,
    'west-c': 10,
    'east-b': 14,
    'east-d': 16,
    'east-f': 13,
    'east-start': 12,
    west_j: 10,
    east_m: 8,
  },
  'west-a': { 'hub-center': 12, 'west-a': 0, 'west-c': 4, 'east-b': 14, 'east-d': 17, 'east-f': 15, 'east-start': 16, west_j: 6 },
  'west-c': { 'hub-center': 10, 'west-a': 4, 'west-c': 0, 'east-b': 15, 'east-d': 10, 'east-f': 12, 'east-start': 14, west_j: 5 },
  'east-b': { 'hub-center': 14, 'west-a': 14, 'west-c': 15, 'east-b': 0, 'east-d': 5, 'east-f': 4, 'east-start': 5 },
  'east-d': { 'hub-center': 16, 'west-a': 17, 'west-c': 10, 'east-b': 5, 'east-d': 0, 'east-f': 6, 'east-start': 7 },
  'east-f': { 'hub-center': 13, 'west-a': 15, 'west-c': 12, 'east-b': 4, 'east-d': 6, 'east-f': 0, 'east-start': 5 },
  'east-start': { 'hub-center': 12, 'west-a': 16, 'west-c': 14, 'east-b': 5, 'east-d': 7, 'east-f': 5, 'east-start': 0 },
};

/** 直线估算表缺省项用固定值代替，保证反例计算不会算出 Infinity */
export function straightLineLookup(from: string, to: string): number {
  return STRAIGHT_LINE_MINUTES[from]?.[to] ?? STRAIGHT_LINE_MINUTES[to]?.[from] ?? 20;
}

export function straightLinePath(from: string, to: string): string[] {
  return [from, to];
}

// ---------------- 个案种子 ----------------

interface DispatchCaseArgs {
  id: string;
  code: string;
  name: string;
  age: number;
  gender: '女' | '男';
  district: string;
  address: string;
  household: string;
  appt: {
    id: string;
    label: Appointment['label'];
    startAt: string;
    durationMin: number;
    place: string;
    publicLabel: string;
    task: string;
    node: string;
    windowStart: number;
    windowEnd: number;
    skills: string[];
    preferredWorkerId: string | null;
    reassignConsent: boolean;
    confirmed: boolean;
    fixed: boolean;
  };
  prepText: string;
  /** 已发出的初始通知（可选） */
  initialNotice?: { kind: CaseNotification['kind']; text: string };
}

function dispatchCase(a: DispatchCaseArgs): CaseFile {
  const apptId = a.appt.id;
  const goalId = `${a.id}-goal`;
  const visitId = `${a.id}-visit`;
  const at = Date.parse(a.appt.startAt);
  const schedule = {
    serviceDate: DISPATCH_DATE,
    windowStart: a.appt.windowStart,
    windowEnd: a.appt.windowEnd,
    requiredSkills: [...a.appt.skills],
    preferredWorkerId: a.appt.preferredWorkerId,
    reassignConsent: a.appt.reassignConsent,
    confirmed: a.appt.confirmed,
    fixed: a.appt.fixed,
    locationNode: a.appt.node,
    publicLabel: a.appt.publicLabel,
    task: a.appt.task,
  };

  const appointment: Appointment = {
    id: apptId,
    label: a.appt.label,
    startAt: a.appt.startAt,
    durationMin: a.appt.durationMin,
    place: a.appt.place,
    status: 'scheduled',
    workerId: a.appt.preferredWorkerId ?? 'lin',
    schedule,
  };

  const visit: VisitRecord = {
    id: visitId,
    appointmentId: apptId,
    goalId,
    serviceDate: DISPATCH_DATE,
    confirmedGoalText: a.appt.task,
    visibleScopes: ['基本档案', '服务计划'],
    checkInAt: null,
    checkOutAt: null,
    serviceMinutes: null,
    observations: '',
    actions: '',
    fulfillment: '',
    incompleteReasons: [],
    incompleteNote: '',
    supplementNote: '',
    status: 'draft',
    supervisorNote: '',
    materialFlag: 'none',
    bundledAppointmentId: null,
  };

  const prepStart = new Date(at).getTime();
  const familyPreps: FamilyPrepItem[] = [
    {
      id: `${a.id}-prep-1`,
      appointmentId: apptId,
      kind: 'prep',
      text: a.prepText,
      dueAt: new Date(prepStart - 15 * 60_000).toISOString(),
      leadMinutes: 15,
      done: false,
    },
    {
      id: `${a.id}-prep-2`,
      appointmentId: apptId,
      kind: 'key',
      text: '确认门禁可开、联系卡放在门边（改约时需同步提醒）',
      dueAt: new Date(prepStart - 30 * 60_000).toISOString(),
      leadMinutes: 30,
      done: false,
    },
  ];

  const notifications: CaseNotification[] = a.initialNotice
    ? [
        {
          id: `${a.id}-notice-0`,
          appointmentId: apptId,
          kind: a.initialNotice.kind,
          status: 'sent',
          text: a.initialNotice.text,
          createdAt: at - 86_400_000,
          sentAt: at - 86_400_000,
        },
      ]
    : [];

  return {
    id: a.id,
    rev: 2,
    updatedAt: at - 86_400_000,
    client: {
      id: `${a.id}-client`,
      code: a.code,
      name: a.name,
      age: a.age,
      gender: a.gender,
      district: a.district,
      address: a.address,
      risk: '常规',
      household: a.household,
      background: '调度演示个案（虚构）：仅用于验证跨个案上门编排，不包含真实居民资料。',
      emergencyContact: { name: '家属（虚构）', relation: '子女', phone: '139-0000-0000（虚构号码）' },
    },
    appointments: [appointment],
    goals: [
      {
        id: goalId,
        title: a.appt.task,
        criteria: '按约定时间窗完成本次上门服务，并由责任社工登记事实。',
        publishState: 'active',
      },
    ],
    visits: [visit],
    referrals: [],
    reminders: [],
    plan: [],
    familyPreps,
    notifications,
  };
}

export function seedDispatchCases(): CaseFile[] {
  return [
    dispatchCase({
      id: 'case-an',
      code: 'DP-2026-101',
      name: '安秀兰',
      age: 81,
      gender: '女',
      district: '清河街道 · 西区',
      address: '清河里 3 号楼 2 单元 102（虚构地址）',
      household: '独居',
      appt: {
        id: 'an-appt-a',
        label: '今日家访',
        startAt: iso(2026, 11, 25, 9, 0),
        durationMin: 45,
        place: '服务对象家中',
        publicLabel: '西区·安（A）',
        task: '助餐评估与居家安全核对（45 分钟）',
        node: 'west-a',
        windowStart: MIN['09:00'],
        windowEnd: MIN['09:45'],
        skills: ['助餐评估'],
        preferredWorkerId: 'lin',
        reassignConsent: true,
        confirmed: true,
        fixed: false,
      },
      prepText: '今日 9:00 家访：请家中留人，把常用药盒放在桌上。',
      initialNotice: { kind: 'confirmed', text: '西区·安：已确认 9:00 上门（林晓），请家中留人。' },
    }),
    dispatchCase({
      id: 'case-bai',
      code: 'DP-2026-102',
      name: '柏文山',
      age: 76,
      gender: '男',
      district: '清河街道 · 东区',
      address: '晨光里 2 号楼 1 单元 401（虚构地址）',
      household: '与配偶同住',
      appt: {
        id: 'bai-appt-b',
        label: '今日家访',
        startAt: iso(2026, 11, 25, 10, 0),
        durationMin: 30,
        place: '服务对象家中',
        publicLabel: '东区·柏（B）',
        task: '助餐评估（30 分钟）',
        node: 'east-b',
        windowStart: MIN['10:00'],
        windowEnd: MIN['11:30'],
        skills: ['助餐评估'],
        preferredWorkerId: 'lin',
        reassignConsent: true,
        confirmed: false,
        fixed: false,
      },
      prepText: '本次上门 30 分钟：请准备好近一周的助餐签收单。',
    }),
    dispatchCase({
      id: 'case-feng',
      code: 'DP-2026-103',
      name: '冯桂芝',
      age: 79,
      gender: '女',
      district: '清河街道 · 东区',
      address: '晨光里 8 号楼 3 单元 205（虚构地址）',
      household: '与子女同住',
      appt: {
        id: 'feng-appt-f',
        label: '今日家访',
        startAt: iso(2026, 11, 25, 11, 30),
        durationMin: 30,
        place: '服务对象家中',
        publicLabel: '东区·枫（F）',
        task: '助餐评估（30 分钟）',
        node: 'east-f',
        windowStart: MIN['11:30'],
        windowEnd: MIN['13:00'],
        skills: ['助餐评估'],
        preferredWorkerId: null,
        reassignConsent: true,
        confirmed: false,
        fixed: false,
      },
      prepText: '本次弹性访问：请家中留人，准备助餐服务记录。',
    }),
    dispatchCase({
      id: 'case-kang',
      code: 'DP-2026-104',
      name: '康志远',
      age: 77,
      gender: '男',
      district: '清河街道 · 西区',
      address: '清河里 5 号楼 1 单元 302（虚构地址）',
      household: '与配偶同住',
      appt: {
        id: 'kang-appt-fixed',
        label: '固定接送',
        startAt: iso(2026, 11, 25, 12, 0),
        durationMin: 30,
        place: '清河里复诊接送点',
        publicLabel: '西区·康（固定接送）',
        task: '固定复诊接送（12:00，不可移动，30 分钟）',
        node: 'west-c',
        windowStart: MIN['12:00'],
        windowEnd: MIN['12:00'],
        skills: ['复诊陪同'],
        preferredWorkerId: 'lin',
        reassignConsent: false,
        confirmed: true,
        fixed: true,
      },
      prepText: '固定复诊接送：请提前 10 分钟在楼下等候。',
      initialNotice: { kind: 'confirmed', text: '西区·康：已确认 12:00 固定复诊接送（林晓）。' },
    }),
    dispatchCase({
      id: 'case-dan',
      code: 'DP-2026-105',
      name: '单玉芬',
      age: 74,
      gender: '女',
      district: '清河街道 · 东区',
      address: '晨光里北 4 号楼 2 单元 101（虚构地址）',
      household: '独居',
      appt: {
        id: 'dan-appt-d',
        label: '今日家访',
        startAt: iso(2026, 11, 25, 13, 45),
        durationMin: 45,
        place: '服务对象家中',
        publicLabel: '东区·丹（D）',
        task: '助餐评估与辅具使用核对（45 分钟）',
        node: 'east-d',
        windowStart: MIN['11:30'],
        windowEnd: MIN['14:30'],
        skills: ['助餐评估'],
        preferredWorkerId: 'lin',
        reassignConsent: false,
        confirmed: true,
        fixed: false,
      },
      prepText: '本次上门 45 分钟：请把助行器放在客厅，家中留人。（客户明确要求固定社工，不同意改派）',
      initialNotice: { kind: 'confirmed', text: '东区·丹：已确认 13:45 上门（林晓），客户明确要求固定社工，不同意改派。' },
    }),
  ];
}
