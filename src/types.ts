// ============================================================
// 个案协作工作台 —— 领域模型（纯浏览器模拟，全部居民资料均为虚构）
// ============================================================

export type ActorRole = 'social_worker' | 'supervisor';

export interface Actor {
  id: string;
  account: string;
  password: string;
  name: string;
  title: string;
  role: ActorRole;
}

// ---------- 居民与受限字段 ----------

export interface EmergencyContact {
  name: string;
  relation: string;
  phone: string;
}

export interface ClientInfo {
  id: string;
  code: string;
  name: string;
  age: number;
  gender: '女' | '男';
  district: string;
  address: string;
  risk: '重点关注' | '常规';
  household: string;
  background: string;
  /** 受限字段：服务端仅在存在有效授权时下发真值，否则为 null */
  emergencyContact: EmergencyContact | null;
}

// ---------- 预约 ----------

export type AppointmentStatus = 'scheduled' | 'canceled' | 'fulfilled';

/**
 * 上门访问的排程约束（仅“可调度”的上门预约携带；其它预约不必填）。
 * 这里只放调度所需的“最小信息”：时间窗、资质、固定社工偏好/改派同意、服务地点节点。
 */
export interface AppointmentSchedule {
  /** 所在服务日期（YYYY-MM-DD，与列出的家访窗口同日） */
  serviceDate: string;
  /** 可接受到访时间窗（分钟，自当日 00:00 起算，按社区所在时区） */
  windowStart: number;
  windowEnd: number;
  /** 所需资质（如“助餐评估”） */
  requiredSkills: string[];
  /** 客户希望的固定社工 id；null 表示无固定偏好 */
  preferredWorkerId: string | null;
  /** 客户是否明确同意改派给其他合格社工（同意时主管才可以换人） */
  reassignConsent: boolean;
  /** 是否已与客户确认本次时间/人员（已确认的访问默认保留，可调整的只有未确认的弹性访问） */
  confirmed: boolean;
  /** 固定访问：时刻不可移动（例如固定复诊接送），排程只能满足或如实报不可行 */
  fixed: boolean;
  /** 服务对象的出发/到达节点（路网节点 id），调度只使用地点，不读取个案内容 */
  locationNode: string;
  /** 调度板上的代号（不含姓名等个案内容） */
  publicLabel: string;
  /** 最小服务说明：只够工作人员知道要做什么，不带个案背景 */
  task: string;
}

export interface Appointment {
  id: string;
  label: '今日家访' | '未来预约' | '过往记录' | '固定接送';
  startAt: string; // ISO 字符串
  durationMin: number;
  place: string;
  status: AppointmentStatus;
  cancelReason?: string;
  /** 当前责任社工（账号 id）；改派后排程器会更新该值 */
  workerId?: string;
  /** 调度约束；缺省表示该预约不进入跨个案上门日程编排 */
  schedule?: AppointmentSchedule;
}

// ---------- 家庭准备事项 / 通知（排程改动时须同步更新） ----------

export type FamilyPrepKind = 'prep' | 'key';

export interface FamilyPrepItem {
  id: string;
  appointmentId: string;
  kind: FamilyPrepKind;
  text: string;
  /** 家庭需在到访前完成的准备截止时刻（ISO）；改约后须随之移动 */
  dueAt: string;
  /** 相对到访时刻提前多少分钟完成（改约时据此重算 dueAt，而不是沿用旧日期） */
  leadMinutes: number;
  done: boolean;
}

export type NotificationKind = 'reschedule' | 'reassign' | 'combined' | 'confirmed' | 'kept';

export interface CaseNotification {
  id: string;
  appointmentId: string;
  kind: NotificationKind;
  /** intended=待发出；sent=已通知 */
  status: 'intended' | 'sent';
  text: string;
  createdAt: number;
  sentAt?: number;
}

// ---------- 服务目标 / 服务计划 ----------

export type GoalPublishState = 'active' | 'in_review' | 'returned' | 'confirmed';

export interface ServiceGoal {
  id: string;
  title: string;
  criteria: string;
  publishState: GoalPublishState;
  returnNote?: string;
  returnedByName?: string;
  returnedAt?: number;
}

export interface PlanEntry {
  id: string;
  goalId: string;
  text: string;
  ownerName: string;
  addedAt: number;
  sourceRecordId: string;
  rev: number;
}

// ---------- 家访 / 服务记录 ----------

export type FulfillmentStatus = '' | 'completed' | 'partial' | 'incomplete';
export type RecordStatus = 'draft' | 'submitted' | 'returned' | 'confirmed';
export type MaterialFlag = 'none' | 'pending_verification';

export interface VisitRecord {
  id: string;
  appointmentId: string;
  goalId: string;
  serviceDate: string; // YYYY-MM-DD
  /** 本次确认的服务目标（文本确认） */
  confirmedGoalText: string;
  /** 本次被授权可查看的字段范围 */
  visibleScopes: string[];
  checkInAt: string | null;
  checkOutAt: string | null;
  serviceMinutes: number | null;
  observations: string;
  actions: string;
  fulfillment: FulfillmentStatus;
  incompleteReasons: string[];
  incompleteNote: string;
  /** 被退回后重新提交时，必须补充的事实说明 */
  supplementNote: string;
  status: RecordStatus;
  supervisorNote?: string;
  /** 迟到签到撞上远端取消等情形：只能形成待核材料 */
  materialFlag: MaterialFlag;
  /** 整次确认单元模式下，被捆绑进同一包的未来预约 id（演示“无关约访改动也等待”） */
  bundledAppointmentId?: string | null;
}

// ---------- 转介 / 提醒 ----------

export interface Referral {
  id: string;
  org: string;
  service: string;
  reason: string;
  status: '草稿' | '已发出' | '已接收回执' | '已办结';
  receiptNo?: string;
  receiptAt?: string;
  recordId?: string;
}

export interface Reminder {
  id: string;
  text: string;
  dueAt: string;
  done: boolean;
}

// ---------- 案卷聚合根（模拟 REST /api/cases/:id 的整体文档与版本号） ----------

export interface CaseFile {
  id: string;
  rev: number;
  updatedAt: number;
  client: ClientInfo;
  appointments: Appointment[];
  goals: ServiceGoal[];
  visits: VisitRecord[];
  referrals: Referral[];
  reminders: Reminder[];
  plan: PlanEntry[];
  /** 家庭准备事项（改约后 dueAt/文案随之更新） */
  familyPreps: FamilyPrepItem[];
  /** 改约/改派产生的客户通知（intended 待发出，sent 已通知） */
  notifications: CaseNotification[];
}

// ---------- 字段授权凭据（绑定明确到期时刻） ----------

export interface FieldGrant {
  id: string;
  caseId: string;
  field: 'client.emergencyContact';
  granteeActorId: string;
  granteeName: string;
  reason: string;
  issuedAt: number;
  expiresAt: number;
  ttlLabel: string;
  revoked: boolean;
  revokedAt?: number;
  revokeReason?: string;
}

/** IndexedDB sensitive store 中的持久缓存：值必须与到期凭据一起存放 */
export interface SensitiveCacheEntry {
  cacheKey: string; // `${caseId}:client.emergencyContact`
  caseId: string;
  field: 'client.emergencyContact';
  value: EmergencyContact;
  grantId: string;
  expiresAt: number;
  cachedAt: number;
}

// ---------- 审计 ----------

export type AuditActorRole = ActorRole | 'system' | 'sync-engine';

export interface AuditEntry {
  id: string;
  at: number;
  actorId: string;
  actorName: string;
  actorRole: AuditActorRole;
  tabId: string;
  action: string;
  target: string;
  summary: string;
  caseId?: string;
  rev?: number;
  fingerprint: string;
}

// ---------- 本地草稿 / 待同步操作 ----------

export type Granularity = 'field' | 'unit';

export interface DraftEnvelope {
  caseId: string;
  /** 每项编辑所依据的远端版本 */
  baseRev: number;
  base: CaseFile;
  value: CaseFile;
  granularity: Granularity;
  updatedAt: number;
  tabId: string;
}

export type OutboxStatus = 'queued' | 'syncing' | 'synced' | 'blocked';

export interface OutboxOp {
  id: string;
  caseId: string;
  tabId: string;
  actorId: string;
  label: string;
  at: number;
  /** 该编辑依据的远端版本 */
  baseRev: number;
  status: OutboxStatus;
  syncedRev?: number;
  detail?: string;
}

// ---------- 三方比较 / 合并 ----------

export type TriadStatus =
  | 'unchanged'
  | 'local-only'
  | 'remote-only'
  | 'same-both'
  | 'conflict';

export interface PathDiff {
  path: string;
  label: string;
  groupId: string | null;
  unitId: string | null;
  base: unknown;
  local: unknown;
  remote: unknown;
  status: TriadStatus;
  changed: boolean;
}

export type ItemKind = 'independent' | 'correlated' | 'unit';
export type ItemAuto = 'auto-local' | 'auto-remote' | 'auto-same' | 'needs-decision';
export type Decision = 'remote' | 'local' | 'defer';

export interface MergeItem {
  id: string;
  kind: ItemKind;
  title: string;
  why: string;
  paths: string[];
  auto: ItemAuto;
  /** needs-decision 时必须由人工选择 */
  decision: Decision | null;
  /** 人工裁决时直接编辑后的路径值（路径 -> JSON 值） */
  manual: Record<string, unknown>;
}

export interface MergeAnalysis {
  caseId: string;
  baseRev: number;
  localRev: number;
  remoteRev: number;
  granularity: Granularity;
  paths: PathDiff[];
  items: MergeItem[];
  /** 不需要人工介入、可自动保留的路径说明 */
  autoNotes: string[];
}

// ---------- 领域守卫 ----------

export type ViolationCode =
  | 'APPT_CANCELED_CHECKIN'
  | 'GOAL_RETURNED_LOCK'
  | 'GRANT_REQUIRED'
  | 'GRANT_EXPIRED'
  | 'GRANT_REVOKED'
  | 'MISSING_SUPPLEMENT'
  | 'FULFILLMENT_NEEDS_FACTS';

export interface Violation {
  code: ViolationCode;
  path?: string;
  title: string;
  detail: string;
  /** 可一键修正时给出修正动作标识 */
  fix?: 'mark-pending-verification';
}

// ---------- 模拟接口返回 ----------

export type CommitResult =
  | { ok: true; case: CaseFile; audits: AuditEntry[] }
  | { ok: false; code: 'NETWORK'; message: string }
  | {
      ok: false;
      code: 'CONFLICT';
      current: CaseFile;
      baseSnapshot: CaseFile | null;
      serverRev: number;
    }
  | { ok: false; code: 'GUARD'; violations: Violation[]; current?: CaseFile };

export interface TabPresence {
  tabId: string;
  actorId?: string;
  actorName?: string;
  at: number;
}
