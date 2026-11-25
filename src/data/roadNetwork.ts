// 小型路网（随题演示数据，虚构）
//
// 每个节点有“片区归属”，路网只用于计算“从一个上门地点到下一个上门地点”的
// 实际道路行驶时间（分钟）。边为双向，用时为道路实测中位数。
//
// 样例可达性自检（Dijkstra 最短路，分钟）：
//   west-a --east-b = 45（west-j → center-k → east-m → east-b，跨片区长绕行）
//   east-b --west-c = 45（east-b → east-m → center-k → west-j → west-c）
//   east-start --east-b = 10（同片区直达）
// 直线距离会把这些跨片区行程估成 14–15 分钟，从而排出“看似更短、实际迟到”的
// 行程；排程器只使用本路网最短路，并在结果中保留经过节点以便核对。

export interface RoadNode {
  id: string;
  /** 片区归属（仅用于展示，不参与路径计算） */
  zone: 'west' | 'east' | 'north' | 'center';
}

export interface RoadEdge {
  a: string;
  b: string;
  /** 分钟 */
  minutes: number;
}

export const ROAD_NODES: RoadNode[] = [
  { id: 'hub-center', zone: 'center' }, // 街道服务中心（社工起点）
  { id: 'west-a', zone: 'west' }, // 清河里（西区）
  { id: 'west-c', zone: 'west' }, // 清河里复诊接送点（西区）
  { id: 'east-b', zone: 'east' }, // 晨光里（东区）
  { id: 'east-d', zone: 'east' }, // 晨光里北（东区，不同意改派）
  { id: 'east-f', zone: 'east' }, // 晨光里南（东区，弹性）
  { id: 'east-start', zone: 'east' }, // 东区服务点（周明起点）
  { id: 'west-j', zone: 'west' }, // 西区路口
  { id: 'east-m', zone: 'east' }, // 东区枢纽
  { id: 'center-k', zone: 'center' }, // 中心环岛
  { id: 'north-l', zone: 'north' }, // 滨桥
];

export const ROAD_EDGES: RoadEdge[] = [
  // 中心 ↔ 东区
  { a: 'hub-center', b: 'east-m', minutes: 18 },
  // 西区支线
  { a: 'west-j', b: 'west-a', minutes: 8 },
  // 东区支线
  { a: 'east-m', b: 'east-b', minutes: 12 },
  { a: 'east-m', b: 'east-f', minutes: 8 },
  { a: 'east-f', b: 'east-b', minutes: 6 },
  { a: 'east-m', b: 'east-d', minutes: 14 },
  { a: 'east-d', b: 'east-f', minutes: 9 },
  { a: 'east-m', b: 'east-start', minutes: 5 },
  { a: 'east-start', b: 'east-b', minutes: 10 },
  // 西区内部
  { a: 'west-j', b: 'west-c', minutes: 8 },
  // 跨片区：经北环为“长绕行”，恰是 A/B、B/接送点 三段行程的最短路
  { a: 'north-l', b: 'east-m', minutes: 9 },
  { a: 'north-l', b: 'west-j', minutes: 16 },
  { a: 'east-m', b: 'center-k', minutes: 6 },
  { a: 'center-k', b: 'west-j', minutes: 19 },
];

export interface RoadLetter {
  from: string;
  to: string;
  minutes: number;
  /** 经过的中间节点（用于解释“为什么不是直线距离”） */
  path: string[];
}

const adjacency = new Map<string, Array<{ to: string; minutes: number }>>();
for (const n of ROAD_NODES) adjacency.set(n.id, []);
for (const e of ROAD_EDGES) {
  adjacency.get(e.a)?.push({ to: e.b, minutes: e.minutes });
  adjacency.get(e.b)?.push({ to: e.a, minutes: e.minutes });
}

/** 无向加权图上的 Dijkstra；返回用时与路径节点序列 */
export function shortestTravel(from: string, to: string): RoadLetter | null {
  if (from === to) return { from, to, minutes: 0, path: [from] };
  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const visited = new Set<string>();
  for (const n of ROAD_NODES) dist.set(n.id, Infinity);
  dist.set(from, 0);

  while (visited.size < ROAD_NODES.length) {
    let cur: string | null = null;
    let best = Infinity;
    for (const [id, d] of dist) {
      if (!visited.has(id) && d < best) {
        best = d;
        cur = id;
      }
    }
    if (cur === null || best === Infinity) break;
    if (cur === to) break;
    visited.add(cur);
    for (const edge of adjacency.get(cur) ?? []) {
      if (visited.has(edge.to)) continue;
      const nd = best + edge.minutes;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, cur);
      }
    }
  }

  const total = dist.get(to) ?? Infinity;
  if (!Number.isFinite(total)) return null;
  const path: string[] = [to];
  let node = to;
  while (node !== from) {
    const p = prev.get(node);
    if (!p) return null;
    path.unshift(p);
    node = p;
  }
  return { from, to, minutes: total, path };
}

/** 取用时；不可达时返回 Infinity（排程器据此报不可行，而不是猜一个数） */
export function travelMinutes(from: string, to: string): number {
  return shortestTravel(from, to)?.minutes ?? Infinity;
}

export interface MatrixCell {
  minutes: number;
  path: string[];
}

/** 打表：任意两节点最短路（矩阵复制后交给 WebWorker 计算排程） */
export function buildTravelMatrix(): Record<string, Record<string, MatrixCell>> {
  const m: Record<string, Record<string, MatrixCell>> = {};
  for (const a of ROAD_NODES) {
    m[a.id] = {};
    for (const b of ROAD_NODES) {
      const r = shortestTravel(a.id, b.id);
      m[a.id][b.id] = r ? { minutes: r.minutes, path: r.path } : { minutes: Infinity, path: [] };
    }
  }
  return m;
}

export function nodeLabel(id: string): string {
  return (
    {
      'hub-center': '街道服务中心',
      'west-a': '清河里（西区）',
      'west-c': '清河里复诊接送点',
      'east-b': '晨光里（东区）',
      'east-d': '晨光里北（东区）',
      'east-f': '晨光里南（东区）',
      'east-start': '东区服务点',
      'west-j': '西区路口',
      'east-m': '东区枢纽',
      'center-k': '中心环岛',
      'north-l': '滨桥',
    }[id] ?? id
  );
}
