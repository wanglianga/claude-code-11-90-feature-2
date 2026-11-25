# 邻里个案协作工作台（纯浏览器模拟）

面向社工与主管的浏览器端个案协作原型：React + TypeScript + IndexedDB + WebWorker。
**不依赖任何真实居民资料、外部账号或未提供的后端服务**：“远端接口”由同源共享的 IndexedDB
（`casedesk_remote_v1`）+ `BroadcastChannel` 模拟，两个浏览器标签页即可真实重放双社工同步；
每个标签页另有按 `tabId` 隔离的本地草稿库（`casedesk_local_v1`）。

---

## 1. 一键启动

### 方式 A：Docker / Compose（推荐交付方式）

```bash
docker compose up --build
# 或：docker build -t case-collab-workbench . && docker run -p 8080:8080 case-collab-workbench
```

打开 <http://localhost:8080>。容器为多阶段构建：Node 22 构建静态产物，nginx 托管。

### 方式 B：本地 Node（需要 Node ≥ 20，开发验证使用 22.14.0）

```bash
npm install        # 若 ~/.npm 缓存有权限问题：npm_config_cache=/tmp/npm-cache npm install
npm run dev        # http://localhost:5173
```

生产构建与本地预览：

```bash
npm run build      # tsc --noEmit + vite build
npm run preview    # http://localhost:4173
```

### 测试账号（密码统一为 `test1234`）

| 账号 | 姓名 | 角色 |
| --- | --- | --- |
| `lin.xiao` | 林晓 | 社工（样例中的 A，第三网格） |
| `zhou.ming` | 周明 | 社工（样例中的 B，第二网格） |
| `wang.min` | 王敏 | 主管（跨个案上门日程编排需要此身份应用方案） |

登录页可直接点账号卡片填充。URL 支持 `?as=lin|zhou|wang` 直达登录，便于双标签脚本。

---

## 2. 题目要求与实现位置对照

| 要求 | 实现 |
| --- | --- |
| 待访清单按服务对象、预约时段呈现必要资料 | `src/pages/VisitListPage.tsx`：按日期分组，卡片含时间、姓名年龄、网格地址、风险级、当前目标、草稿/取消状态、搜索与筛选 |
| 进入个案确认服务目标、可查看字段、授权有效期 | 个案页「概览与授权」：目标文本、字段范围多选、授权剩余有效期核对 |
| 登记到访、观察、实际时长、未完成原因、后续转介 | 「到访登记」「转介与提醒」标签：签到/签退、分钟数、观察、服务动作、履约状态、原因多选、转介新增/回执 |
| 主管退回补充 / 确认进入服务计划 | 「主管确认队列」`src/pages/SupervisorPage.tsx`；确认后向 `case.plan` 写入计划条目 |
| 提醒或转介回执不能算服务完成 | 回执/提醒只改自身状态；不会填写 `fulfillment`/`serviceMinutes`，UI 多处明示，规则校验要求“已完成”必须有时长与观察事实 |
| 断网继续编辑 + 本地待同步状态 | 顶栏网络开关（按标签页模拟，`sessionStorage` 记忆）；草稿/outbox 持久化在本地 IndexedDB，顶条、清单、同步面板均有状态 |
| 每项编辑记录所依据的远端版本 | `OutboxOp.baseRev` 与 `DraftEnvelope.baseRev/base`；「同步记录」标签可见 |
| 恢复后三方核对，不被最后提交者覆盖 | `src/lib/merge.ts` + `ConflictPage.tsx`：基线 v7 / 本地 / 远端新值三列并列，逐项选择保留远端 / 本地作为新版 / 暂缓 |
| 字段级三方比较 | 独立路径自动并存；关联字段组 `corr:<visit>` 整体裁决 |
| 整次家访确认单元 | 粒度切换为「unit」后，`unit:<visit>` 包含该次记录全部字段 + 关联目标 + `bundledAppointmentId` 指向的未来预约，整包裁决 |
| 9:00 rev7 标准样例（A 观察 / B 改周三 / 主管退回） | 「样例演练 / 双标签」页逐步播放两类合并结果、审计主体、最终计划；并可一键植入真实草稿跳到冲突中心动手复现 |
| 预约远端取消后迟到签到只形成待核材料 | 守卫 `APPT_CANCELED_CHECKIN` / `FULFILLMENT_NEEDS_FACTS` + 一键修正 `materialFlag=pending_verification`，取消态不会被改回 fulfilled |
| 被退回目标禁止旧草稿越过退回重新发布 | 守卫 `GOAL_RETURNED_LOCK` + `MISSING_SUPPLEMENT`：必须填写回应退回意见的补充事实才能重提 |
| 紧急联系人撤权后从界面/复制内容/持久缓存删除 | BroadcastChannel `grant-revoked` → React 状态、IndexedDB `sensitive`、尽力清空剪贴板、清除选区 |
| 离线无法即时知道撤权；缓存绑定明确到期时刻，到期离线也遮蔽并清除 | `SensitiveCacheEntry{grantId,expiresAt}`；主线程 5s + `sync.worker.ts` 4s 清扫 `expiresAt<=now`；界面秒级遮蔽；UI 明确“不承诺即时远程擦除” |
| WebWorker | `src/workers/sync.worker.ts`：后台三方合并 + 到期缓存清扫；主线程客户端 `src/workers/client.ts`（Worker 失败时回退主线程计算） |
| 键盘操作 / 焦点提示 / 窄窗覆盖冲突全程 | 原生 radio/button/input（方向键切换单选项）、可见焦点框、跳转链接、焦点陷阱 Modal、“定位第一个未决项并聚焦”、aria-live；≤860px 三列堆叠并显示列名，另有“窄窗布局预览”按钮 |
| 虚构个案/预约/转介 | `src/data/seed.ts`：陈桂兰（核心样例）、梁广生、吴小梅家庭、赵德海、何丽娟，含预约、目标、家访、转介、提醒、计划 |
| 两个标签页间重放同步的模拟接口 | 共享远端 IndexedDB + `BroadcastChannel`；样例页提供 A/B/主管三个 `?as=` 直达新标签按钮 |
| 跨个案上门日程编排（服务时长 / 时间窗 / 资质 / 固定社工偏好与改派同意 / 工作起止 / 已占用事项） | 「上门日程编排」页与 `src/lib/dispatch.ts`、`src/lib/dispatchModel.ts`：把多案已批准预约投影为调度对象，枚举分配与顺序，逐项校验 |
| 路段用时用随题小型路网计算，不按直线距离排序 | `src/data/roadNetwork.ts`：Dijkstra 最短路；页面同时展示“按计划时刻 + 直线估算”的反例，并证明它会把康的 12:00 固定接送排到约 12:41（迟到），因此只作反例、不参与排程 |
| 排程不向不同客户互相暴露个案内容 | `projectVisits()` 只输出代号 / 路网节点 / 任务 / 时间窗 / 资质等最小信息；测试逐字段断言不含姓名、住址、目标、观察、背景 |
| 两种方案：保持已确认人员（只调弹性） vs 客户同意范围内改派 | 方案一 `keep`（人员冻结）、方案二 `reassign`（仅对 `reassignConsent=true` 的未确认访问放开）；对比总路程、完成数、改派与留待改期 |
| 预约被移时家庭准备与通知同步更新 | `src/lib/planWrite.ts` + `apiApplyDispatch`：改约同时移动 `familyPreps.dueAt` 与文案、生成 `intended` 客户通知；服务端复核“未同步即拒绝” |
| 超时行程不得包装成“可行” | 固定访问/时间窗/班次/休息/已占用任一违反即判不可行并列出原因；无法排入的弹性访问显式列为“留待改期”，不计入完成 |
| 资质、时间窗、休息、固定访问在两种方案都必须满足 | 排程器统一约束；测试覆盖改派仅在同意范围内、不同意改派者不动、资质不足时不硬塞 |
| 样例：W1 已确认西区 A 9:00–9:45、东区 B 需同资质 30 分钟 10:00–11:30 且同意改派；W1 A→B 45 分钟，W2 东区起点→B 10 分钟 | 种子 `src/data/dispatch.ts`：西区·安（A）9:00–9:45、东区·柏（B）10:00–11:30。保持人员方案 W1 把 B 排 10:30；改派方案 W2 10:00 到访 |
| 再加 W1 12:00 西区固定复诊接送（B→该处 45 分钟）与一项客户不同意改派的访问 | 西区·康固定接送 12:00、东区·丹 13:45（客户明确要求固定社工）；两种方案都不得移动固定接送，丹不参与改派 |

---

## 3. 推荐的人工验证路径

### 3.1 双标签实时同步（最贴近题目叙述）

1. `npm run dev` 后打开 <http://localhost:5173>，用 `lin.xiao / test1234` 登录。
2. 进入「样例演练 / 双标签」，点右上角 **开标签 A · 林晓**、**开标签 B · 周明**（可再开主管标签）。
3. 在 A 标签顶栏点 **📶 网络在线** 切到离线（出现斜纹离线条），进入「陈桂兰」个案 →「到访登记」，
   修改观察、签到、填时长并“保存登记到本机”。
4. 在 B 标签进入陈桂兰个案 →「预约管理」，把未来预约改到周三 12-02 10:00 并保存同步；
   也可在主管标签把 `visit-main` 退回。
5. 回到 A 标签恢复网络，点“保存并同步”，自动进入三方核对中心：
   - 三列：远端基线 **v7** / 本地改动 / 远端新值 **v8/v9**；
   - 观察记录为“仅本地改”，预约时间为“仅远端改”，均有自动决策；
   - 目标↔履约关联组显示“必须人工裁决”；
   - 选“将本地内容作为新版本提交”但不补说明时，提交按钮被守卫禁用；
     在“人工裁决修订”或到访页填写 `supplementNote`（≥5 字）后放行；
   - 可对任意项选“暂缓”：提交后本地 hunk 会 rebase 到新版本草稿，仍显示待同步。
6. 用主管标签确认该记录，到「目标与计划」查看新增计划条目，到「审计日志」查看
   周明、王敏、林晓、`sync-engine` 各审计主体与指纹。

> 想在 10 秒内看到完全一致的冲突页：样例页左侧 **“植入 A 草稿并打开字段级冲突中心”**
> 会自动 重置 → 写 rev7 基线草稿 → B 改约 rev8 → 主管退回 rev9 → 跳转冲突中心。
> 另一个按钮可复现“整单元 + A 提议周四改约”的版本。

### 3.2 取消预约 × 迟到签到

样例页 →「② 预约取消 × 迟到签到」→ 一键布置。冲突中心底部实时校验会列出两条红色拦截，
点“一键修正为待核材料”后校验通过，再提交。可在「预约管理」用“⚡ 模拟远端取消此预约”做在线版本。

### 3.3 撤权与授权到期

样例页 →「③ 撤权与授权到期」：

- 点“授予 20 秒（到期演示）”，观察真值、倒计时进度条；到期瞬间界面先遮蔽，
  随后 WebWorker/主线程删除 IndexedDB 中的 `sensitive` 记录（DevTools → Application → IndexedDB 可查）。
- 申请 30 分钟授权后点“模拟家属撤权”，或在第二个同账号标签中触发撤权：
  两个标签都会立即遮蔽并删除缓存，并尽力写空剪贴板；若浏览器拒绝剪贴板写，会明确提示手动处理。

### 3.4 键盘与窄窗

- 冲突页所有操作均为原生控件：`Tab/Shift+Tab` 移动，radio 组内 `↑↓/←→` 切换；
  未决项横幅按钮可把焦点直接送到第一个待裁决卡片。
- 拖动窗口到 860px 以下，或点“📱 窄窗布局预览”，三列比较堆叠为带“基线/本地/远端新值”标签的单列。

### 3.5 跨个案上门日程编排（两种方案）

1. 登录任意账号，进入左侧「上门日程编排」。页面默认以社工身份查看；此时“应用方案”按钮禁用。
2. 读「今天要编排的访问」表：西区·安（A，09:00–09:45，已确认）、东区·柏（B，10:00–11:30，30 分钟，同意改派）、
   东区·枫（F，11:30–13:00，弹性未确认，同意改派）、西区·康（固定接送 12:00，不可移动）、
   东区·丹（D，13:45，客户明确要求固定社工、不同意改派）。
3. 对比两张方案卡片：
   - **方案一 · 保持人员**：B 仍由林晓做，排在 **10:30–11:00**；随后 12:00 固定接送仍可达（B→接送点 **45 分钟**），
     当天完成 4 项、总路程约 **220 分钟**；弹性未确认的枫（F）因排进去会撞 12:00 固定接送，被如实列为“留待改期”，不计入完成。
     人员连续性好（东区丹等固定社工访问不变），但保留较长空驶与等待。
   - **方案二 · 同意范围内改派**：B 改由周明 **10:00–10:30** 在东区到访（东区起点→B **10 分钟**），
     枫（F）也由周明 11:30–12:00 顺路完成；林晓留在西区（安 → 12:00 固定接送 → 丹），
     当天完成 5 项、总路程约 **175 分钟**，比方案一更少且能多做一项；但 B/F 的客户会见到不同社工，
     并生成待发出的改派/改约通知。
4. 看「只看直线距离排序的反例」：同一批访问若按“计划时刻 + 直线估算”排，会把康的 12:00 固定接送排到约 **12:41**，
   页面会标红“错过固定时刻 —— 不能作为可行依据”。
5. 看下方「逐人时间线」「人员关系变化与客户通知」「派工单」：派工单只含地点、代号、任务与路程，不含案情；
   页首还列出“已占用事项”（周明 09:00–09:30 东区晨会），排程不会把服务或行驶塞进占用时段。
6. 点右上「一键切换为主管王敏」，再点 **应用「保持人员」方案**（或切到方案二后应用）。
7. 打开个案 柏文山 →「准备与通知」：预约时间已移动到 **10:30**，家庭准备事项的截止与文案同步更新，
   并出现“待发出”的客户通知（方案二时，B 保持 10:00 但改由周明到访，通知文案点明时间与“由林晓改为周明”）。
8. 主管可点「确认发出全部待发通知（写审计）」；在「审计日志」中可看到 `dispatch-apply` 与 `notification-sent` 条目。

---

## 4. 自动化验证（实际执行过）

在本工作区（Node v22.14.0 / npm 10.9.2）实际执行并通过：

```bash
npm test
# Test Files  8 passed (8)，Tests 38 passed (38)
```

覆盖：

- `test/merge.test.ts`：9:00 rev7 样例的字段级自动合并、关联组必须人工裁决、
  退回锁拦截→补事实放行、整单元捆绑预约、取消预约场景；
- `test/rules.test.ts`：授权 valid/expired/revoked、携带真值时的 GRANT_* 拦截、待核材料修正；
- `test/sensitive-cache.test.ts`：fake-indexeddb 下到期清扫与按 grantId 撤权删除；
- `test/server-sync.test.ts`：共享 IndexedDB 模拟服务端的完整链路
  rev7→rev8 改约→rev9 退回→旧 base7 提交得 CONFLICT→合并补事实→以 base9 提交 rev10→主管确认 rev11，
  以及断网抛 `NETWORK`；
- `test/flow.test.tsx`：jsdom + Testing Library 真实渲染 `<AppProviders/>`，
  跑通 登录→清单→个案登记→远端 rev9→快速同步跳冲突中心→选本地关联组→
  未补事实时提交禁用→补 `supplementNote`→提交并出现“已提交为 rev 10”；
- `test/pages-smoke.test.tsx`：主管/审计/样例/个案各 tab 渲染冒烟、授权申请显示真值、
  上门日程编排页两种方案/时间线/派工单渲染且社工身份不可应用；
- `test/dispatch.test.ts`（18 例）：路网最短路（A→B、B→接送点均 45 分钟，东区起点→B 10 分钟）、
  调度投影不含姓名/住址/背景/观察、两种方案的路程/完成数/改派范围、固定访问不动、
  资质/时间窗/已占用事项校验、直线排序反例被判不可行、不可行如实报不可行、
  家庭准备与文案同步、旧通知被标注为“已被后续替代”、通知类型与文案、
  模拟服务端权限/固定访问/并发版本拒绝与权威复算；
- `test/dispatch-flow.test.tsx`：jsdom 全链路——主管应用“保持人员”方案后，
  柏文山个案预约与家庭准备改到 10:30 并出现待发通知；社工身份应用按钮禁用。

其余实际执行的验证：

```bash
npx tsc --noEmit     # 0 error
npm run build        # 成功：dist/index.html、assets/index-*.js/css、assets/sync.worker-*.js
npm run preview      # HTTP 冒烟：/ 200、JS 200、worker chunk 200、SPA 回退 200
npm ci               # 可依据 package-lock.json 干净安装（Docker 构建路径）
```

> 说明：当前开发容器内没有 Docker 可执行文件，也缺少运行系统 Chromium 所需的部分图形库且无 sudo，
> 因此 **Docker 镜像构建与真实像素级浏览器截图未在本容器执行**；Dockerfile/Compose 已按标准
> node:22-alpine → nginx:1.27-alpine 多阶段编写。浏览器行为由上述 jsdom 全链路测试、
> 生产构建与 preview HTTP 冒烟保证；合并/守卫/缓存等核心逻辑另有纯 Node 测试。

---

## 5. 目录结构与核心设计

```
src/
  types.ts                 全部领域模型与合并/守卫契约
  data/seed.ts             虚构个案与 rev7 基线
  data/
    dispatch.ts            跨个案编排样例（路网节点/社工/五个预约）+ 直线估算反例表
    roadNetwork.ts         小型路网：Dijkstra 最短路 + 全节点用时矩阵
  lib/
    dispatch.ts            纯函数排程器：分配枚举、顺序、时间窗/资质/休息/固定访问校验
    dispatchModel.ts       调度投影（去个案内容）+ 两种方案对比 + 直线反例
    planWrite.ts           方案回写：预约/家庭准备/通知；派工单构造
    paths.ts               文档扁平化 / 按 id 数组寻址 / setPath 补元素
    merge.ts               三方分析、两类粒度裁决项、候选构造、暂缓 rebase
    rules.ts               预约取消、退回锁、履约事实、授权守卫（前后端共用）
    audit.ts               审计条目 SHA-256 截断指纹
    labels.ts/time.ts      中文标签、枚举、时间与倒计时
  db/
    remoteDb.ts            “远端” IndexedDB：cases/grants/audit/history/kv
    localDb.ts             本地 IndexedDB：drafts(tabId:caseId)/outbox/sensitive
    schema.ts              库名、频道名、键约定
  mock/
    server.ts              模拟 API：延迟+网络开关、baseRev 乐观锁、history、守卫、审计、授权
    bus.ts                 BroadcastChannel 类型消息
  workers/
    sync.worker.ts         Worker：merge 计算 + 敏感缓存到期清扫
    client.ts              Worker 单例与回退
  state/AppStore.tsx       全局状态、会话、在线态、草稿/outbox/密钥/presence/提交编排
  components/ ...          顶栏外的业务组件与 case/* 标签页
  pages/ ...               Login / VisitList / Case / Conflict / Supervisor / Dispatch / Audit / Scenario
  components/case/PrepNoticeTab.tsx  个案「准备与通知」：家庭准备截止与客户通知
test/                      8 个测试文件（36 个用例）
Dockerfile docker-compose.yml nginx.conf
```

### 同步语义（为什么不会互相覆盖）

1. 每次进入编辑都有 `DraftEnvelope{baseRev,base,value}`；outbox 操作也带 `baseRev`。
2. 提交时服务端比较 `stored.rev === baseRev`；不一致返回 `CONFLICT + current`。
3. `analyzeMerge(base, local, remote, granularity)` 扁平化到叶子路径并分类：
   `local-only / remote-only / same-both / conflict`。
4. 字段级：独立路径各自成项并给出自动决策；`corr:<visit>` 关联状态组只要两侧都碰过就整体待裁决。
   单元级：`unit:<visit>` 打包全部记录字段、关联目标与被捆绑预约。
5. `buildCandidate` 以**远端最新文档为底**，只套用裁决为 local 的项与人工修订；defer 项保留远端值，
   提交成功后再把这些本地 hunk rebase 到新 rev 的草稿。
6. 候选在 UI 与 `apiCommitCase` 各跑一次 `validateCandidate`（服务端权威），
   所以即使选“本地值”也必须通过预约状态与授权复验。

### 敏感字段策略

- 服务端 `redactCase`：没有该社工的有效 `FieldGrant` 时，`client.emergencyContact` 永不下发真值。
- 真值只写入 `sensitive` store，记录 `grantId/expiresAt`；草稿 `CaseFile` 中该字段恒为 `null`。
- 在线撤权：总线消息触发各标签清除；离线到期：不依赖网络，时间一到界面遮蔽、Worker/主线程删缓存。
- 无法承诺对离线设备实现即时远程擦除——这是题目明确要求保留的现实边界。
