// 命令行引擎（纯函数，无副作用）。把一行命令文本 + 当前地图上下文，解释成一个声明式的
// ResolvedCommand（数据，不含闭包），交给 App 的执行器落地。这样解析/解析-解析全可单测。
//
// 设计要点（见 docs/command-system-plan.md）：
// - 名字一律加引号；关键字/数字/颜色裸写 → 语法零歧义。
// - 能对上现有 AIOperation 的走 kind:'ops'（复用 applyAIOperations）；
//   命令独有的（建空线/连接/孤立站/途经点）走 kind:'effect'（新 handler）；
//   视图/设置/文件/选择走 kind:'action'。
// - 引用：`"名"` ｜ `"名"@id前缀` ｜ `@完整id`，重名时报错列候选。

import { AIOperation } from '../api';
import { Line, Station, LINE_COLORS } from '../types';

export interface CommandContext {
  lines: Pick<Line, 'id' | 'name' | 'color' | 'stationIds'>[];
  stations: Pick<Station, 'id' | 'name' | 'x' | 'y'>[];
  currentLineId?: string | null;
}

// 命令独有的图变更（不在 AIOperation 集里，由 App 新 handler 落地）
export type CommandEffect =
  | { type: 'create_empty_line'; name: string; color: string }
  | { type: 'connect'; lineId: string; stationIds: string[] }
  | { type: 'add_station'; name: string; x: number; y: number }
  | { type: 'set_waypoints'; lineId: string; startStationId: string; endStationId: string; points: { x: number; y: number }[] }
  | { type: 'clear_waypoints'; lineId: string; startStationId: string; endStationId: string };

// 视图 / 设置 / 文件 / 选择
export type AppAction =
  | { type: 'zoom'; value: number }
  | { type: 'zoom_in' }
  | { type: 'zoom_out' }
  | { type: 'fit' }
  | { type: 'reset' }
  | { type: 'center'; stationId: string }
  | { type: 'set_style'; mapStyle: 'classic-badge' | 'dot-label' }
  | { type: 'set_theme'; canvasTheme: 'light' | 'dark' }
  | { type: 'set_corner'; cornerRadius: number }
  | { type: 'select_line'; lineId: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'save' }
  | { type: 'new' };

export type ResolvedCommand =
  | { kind: 'ops'; ops: AIOperation[]; summary: string }
  | { kind: 'effect'; effect: CommandEffect; summary: string }
  | { kind: 'action'; action: AppAction; undoable: boolean; summary: string }
  | { kind: 'error'; message: string }
  | { kind: 'guide'; topic?: string };

// 命名色 → hex（对齐 LINE_COLORS 顺序）
export const NAMED_COLORS: Record<string, string> = {
  blue: LINE_COLORS[0],
  red: LINE_COLORS[1],
  green: LINE_COLORS[2],
  yellow: LINE_COLORS[3],
  purple: LINE_COLORS[4],
  cyan: LINE_COLORS[5],
  pink: LINE_COLORS[6],
  orange: LINE_COLORS[7]
};

export const COMMAND_VERBS = [
  'create', 'line', 'connect', 'extend', 'attach', 'recolor', 'rename', 'delete', 'select',
  'station', 'insert', 'waypoint', 'zoom', 'fit', 'reset', 'center', 'style', 'theme', 'corner',
  'undo', 'redo', 'save', 'new', 'help'
] as const;

// ── 词法 ────────────────────────────────────────────────────────────────
interface Token {
  quoted: boolean;   // 是否在引号内（= 名字）
  value: string;     // 内容
  idHint?: string;   // "名"@hint 里的 hint，或 @id 形式的 id
  isRef: boolean;    // 裸 @id 形式
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t') { i += 1; continue; }
    if (ch === '"') {
      // 引号名
      let j = i + 1;
      let value = '';
      while (j < n && input[j] !== '"') { value += input[j]; j += 1; }
      if (j >= n) { tokens.push({ quoted: true, value, isRef: false }); break; } // 未闭合：尽力而为
      j += 1; // 跳过闭合引号
      let idHint: string | undefined;
      if (j < n && input[j] === '@') {
        j += 1;
        let hint = '';
        while (j < n && input[j] !== ' ' && input[j] !== '\t') { hint += input[j]; j += 1; }
        idHint = hint;
      }
      tokens.push({ quoted: true, value, idHint, isRef: false });
      i = j;
      continue;
    }
    if (ch === '@') {
      // 裸 @id
      let j = i + 1;
      let id = '';
      while (j < n && input[j] !== ' ' && input[j] !== '\t') { id += input[j]; j += 1; }
      tokens.push({ quoted: false, value: '', idHint: id, isRef: true });
      i = j;
      continue;
    }
    // 裸词（关键字/数字/颜色/坐标）
    let j = i;
    let value = '';
    while (j < n && input[j] !== ' ' && input[j] !== '\t') { value += input[j]; j += 1; }
    tokens.push({ quoted: false, value, isRef: false });
    i = j;
  }
  return tokens;
}

// ── 小工具 ──────────────────────────────────────────────────────────────
const err = (message: string): ResolvedCommand => ({ kind: 'error', message });
const checkName = (s: string) => s.trim().length > 0 && Array.from(s.trim()).length <= 32;

function parseColor(token: Token | undefined): { color: string } | { error: string } {
  if (!token || token.quoted) return { error: '颜色不要加引号，用如 blue / #1890ff / 1' };
  const v = token.value.toLowerCase();
  if (NAMED_COLORS[v]) return { color: NAMED_COLORS[v] };
  if (/^#[0-9a-f]{6}$/.test(v)) return { color: v };
  if (/^[1-8]$/.test(v)) return { color: LINE_COLORS[Number(v) - 1] };
  return { error: `无法识别的颜色「${token.value}」。可用：${Object.keys(NAMED_COLORS).join('/')} / #rrggbb / 1-8` };
}

function parseCoords(value: string): { x: number; y: number } | null {
  const parts = value.split(',');
  if (parts.length !== 2) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

const DIRECTIONS: Record<string, { dx: number; dy: number }> = {
  left: { dx: -1, dy: 0 }, right: { dx: 1, dy: 0 }, up: { dx: 0, dy: -1 }, down: { dx: 0, dy: 1 }
};

// 引用解析：token → 线路 id / 站点 id（含重名消歧）
function resolveRef(
  token: Token | undefined,
  items: { id: string; name: string }[],
  label: string
): { id: string } | { error: string } {
  if (!token) return { error: `缺少${label}` };
  if (token.isRef) {
    const hit = items.find(it => it.id === token.idHint);
    return hit ? { id: hit.id } : { error: `找不到 id 为 @${token.idHint} 的${label}` };
  }
  if (!token.quoted) return { error: `${label}需加引号，如 "名称"` };
  let candidates = items.filter(it => it.name === token.value);
  if (token.idHint) candidates = candidates.filter(it => it.id.startsWith(token.idHint!));
  if (candidates.length === 0) return { error: `${label}「${token.value}」不存在` };
  if (candidates.length > 1) {
    const list = candidates.slice(0, 6).map(c => `"${c.name}"@${c.id.slice(0, 6)}`).join(' / ');
    return { error: `${label}「${token.value}」有 ${candidates.length} 个，请加 @id前缀 指定：${list}` };
  }
  return { id: candidates[0].id };
}

const requireName = (token: Token | undefined, label: string): { name: string } | { error: string } => {
  if (!token) return { error: `缺少${label}` };
  if (!token.quoted) return { error: `${label}需加引号，如 "名称"` };
  if (!checkName(token.value)) return { error: `${label}无效（非空、≤32 字）` };
  return { name: token.value.trim() };
};

// ── 主入口 ──────────────────────────────────────────────────────────────
export function interpretCommand(input: string, ctx: CommandContext): ResolvedCommand {
  const tokens = tokenize(input);
  if (tokens.length === 0) return err('请输入命令');
  const head = tokens[0];
  if (head.quoted || head.isRef) return err('命令应以动词开头，如 create / line / station / help');
  const verb = head.value.toLowerCase();
  const rest = tokens.slice(1);

  const resolveLine = (t: Token | undefined) => resolveRef(t, ctx.lines, '线路');
  const resolveStation = (t: Token | undefined) => resolveRef(t, ctx.stations, '站点');
  const stationName = (id: string) => ctx.stations.find(s => s.id === id)?.name || id.slice(0, 6);
  const lineName = (id: string) => ctx.lines.find(l => l.id === id)?.name || id.slice(0, 6);

  switch (verb) {
    case 'create': {
      // create line "名" 颜色
      if (rest[0]?.value?.toLowerCase() !== 'line') return err('用法：create line "线名" 颜色');
      const nameR = requireName(rest[1], '线名');
      if ('error' in nameR) return err(nameR.error);
      const colorR = parseColor(rest[2]);
      if ('error' in colorR) return err(colorR.error);
      return { kind: 'effect', effect: { type: 'create_empty_line', name: nameR.name, color: colorR.color }, summary: `新建空线路「${nameR.name}」` };
    }

    case 'line': {
      // line "线" connect "站1" "站2" ...
      const lineR = resolveLine(rest[0]);
      if ('error' in lineR) return err(lineR.error);
      if (rest[1]?.value?.toLowerCase() !== 'connect') return err('用法：line "线" connect "站1" "站2" …');
      return buildConnect(lineR.id, rest.slice(2), ctx, resolveStation, lineName, stationName);
    }

    case 'connect': {
      // connect "站1" "站2" ...（当前线路）
      if (!ctx.currentLineId) return err('没有当前线路，请先 create line 或 select "线"');
      return buildConnect(ctx.currentLineId, rest, ctx, resolveStation, lineName, stationName);
    }

    case 'extend': {
      // extend "线" start|end "新站1" ...
      const lineR = resolveLine(rest[0]);
      if ('error' in lineR) return err(lineR.error);
      const pos = rest[1]?.value?.toLowerCase();
      if (pos !== 'start' && pos !== 'end') return err('用法：extend "线" start|end "新站1" …');
      const line = ctx.lines.find(l => l.id === lineR.id)!;
      if (line.stationIds.length < 2) return err('extend 需要线路至少有 2 个站（先 connect 两个已有站）');
      const namesR = collectNames(rest.slice(2), '新站名');
      if ('error' in namesR) return err(namesR.error);
      const op: AIOperation = { type: 'create_station_at_line_end', lineId: lineR.id, position: pos, names: namesR.names };
      return { kind: 'ops', ops: [op], summary: `「${lineName(lineR.id)}」${pos === 'start' ? '起点' : '终点'}延伸 ${namesR.names.length} 个新站` };
    }

    case 'attach': {
      // attach "线" start|end "已有站"
      const lineR = resolveLine(rest[0]);
      if ('error' in lineR) return err(lineR.error);
      const pos = rest[1]?.value?.toLowerCase();
      if (pos !== 'start' && pos !== 'end') return err('用法：attach "线" start|end "已有站"');
      const stR = resolveStation(rest[2]);
      if ('error' in stR) return err(stR.error);
      const op: AIOperation = { type: 'attach_station_to_line', lineId: lineR.id, stationId: stR.id, position: pos };
      return { kind: 'ops', ops: [op], summary: `把「${stationName(stR.id)}」接到「${lineName(lineR.id)}」${pos === 'start' ? '起点' : '终点'}` };
    }

    case 'recolor': {
      const lineR = resolveLine(rest[0]);
      if ('error' in lineR) return err(lineR.error);
      const colorR = parseColor(rest[1]);
      if ('error' in colorR) return err(colorR.error);
      const op: AIOperation = { type: 'recolor_line', lineId: lineR.id, color: colorR.color };
      return { kind: 'ops', ops: [op], summary: `「${lineName(lineR.id)}」改色 ${colorR.color}` };
    }

    case 'rename': {
      const what = rest[0]?.value?.toLowerCase();
      if (what === 'line') {
        const lineR = resolveLine(rest[1]);
        if ('error' in lineR) return err(lineR.error);
        const nameR = requireName(rest[2], '新线名');
        if ('error' in nameR) return err(nameR.error);
        const op: AIOperation = { type: 'rename_line', lineId: lineR.id, name: nameR.name };
        return { kind: 'ops', ops: [op], summary: `线路「${lineName(lineR.id)}」改名为「${nameR.name}」` };
      }
      if (what === 'station') {
        const stR = resolveStation(rest[1]);
        if ('error' in stR) return err(stR.error);
        const nameR = requireName(rest[2], '新站名');
        if ('error' in nameR) return err(nameR.error);
        const op: AIOperation = { type: 'rename_station', stationId: stR.id, name: nameR.name };
        return { kind: 'ops', ops: [op], summary: `站点「${stationName(stR.id)}」改名为「${nameR.name}」` };
      }
      return err('用法：rename line "线" "新名"  或  rename station "站" "新名"');
    }

    case 'delete': {
      const what = rest[0]?.value?.toLowerCase();
      if (what === 'line') {
        const lineR = resolveLine(rest[1]);
        if ('error' in lineR) return err(lineR.error);
        const op: AIOperation = { type: 'delete_line', lineId: lineR.id };
        return { kind: 'ops', ops: [op], summary: `删除线路「${lineName(lineR.id)}」` };
      }
      if (what === 'station') {
        const stR = resolveStation(rest[1]);
        if ('error' in stR) return err(stR.error);
        const op: AIOperation = { type: 'delete_station', stationId: stR.id };
        return { kind: 'ops', ops: [op], summary: `删除站点「${stationName(stR.id)}」` };
      }
      return err('用法：delete line "线"  或  delete station "站"');
    }

    case 'select': {
      const lineR = resolveLine(rest[0]);
      if ('error' in lineR) return err(lineR.error);
      return { kind: 'action', action: { type: 'select_line', lineId: lineR.id }, undoable: false, summary: `当前线路：「${lineName(lineR.id)}」` };
    }

    case 'station': {
      const nameR = requireName(rest[0], '站名');
      if ('error' in nameR) return err(nameR.error);
      const kw = rest[1]?.value?.toLowerCase();
      if (kw === 'at') {
        const coords = rest[2] && !rest[2].quoted ? parseCoords(rest[2].value) : null;
        if (!coords) return err('用法：station "名" at x,y（如 at 800,450）');
        return { kind: 'effect', effect: { type: 'add_station', name: nameR.name, x: coords.x, y: coords.y }, summary: `建独立站「${nameR.name}」@(${coords.x},${coords.y})` };
      }
      // station "名" 方向 距离 [方向 距离 …] from "锚站"
      const offset = parseRelativeOffset(rest.slice(1));
      if ('error' in offset) return err(offset.error);
      const anchorR = resolveStation(offset.anchorToken);
      if ('error' in anchorR) return err(anchorR.error);
      const anchor = ctx.stations.find(s => s.id === anchorR.id)!;
      const x = anchor.x + offset.dx;
      const y = anchor.y + offset.dy;
      return { kind: 'effect', effect: { type: 'add_station', name: nameR.name, x, y }, summary: `建独立站「${nameR.name}」（相对「${stationName(anchorR.id)}」）` };
    }

    case 'insert': {
      // insert "线" between "A" "B" "新站1" ...
      const lineR = resolveLine(rest[0]);
      if ('error' in lineR) return err(lineR.error);
      if (rest[1]?.value?.toLowerCase() !== 'between') return err('用法：insert "线" between "A" "B" "新站1" …');
      const aR = resolveStation(rest[2]);
      if ('error' in aR) return err(aR.error);
      const bR = resolveStation(rest[3]);
      if ('error' in bR) return err(bR.error);
      const namesR = collectNames(rest.slice(4), '新站名');
      if ('error' in namesR) return err(namesR.error);
      const op: AIOperation = { type: 'create_station_between', lineId: lineR.id, afterStationId: aR.id, beforeStationId: bR.id, names: namesR.names };
      return { kind: 'ops', ops: [op], summary: `在「${lineName(lineR.id)}」「${stationName(aR.id)}」「${stationName(bR.id)}」间插 ${namesR.names.length} 站` };
    }

    case 'waypoint': {
      if (rest[0]?.value?.toLowerCase() === 'clear') {
        // waypoint clear "线" between "A" "B"
        const lineR = resolveLine(rest[1]);
        if ('error' in lineR) return err(lineR.error);
        if (rest[2]?.value?.toLowerCase() !== 'between') return err('用法：waypoint clear "线" between "A" "B"');
        const aR = resolveStation(rest[3]);
        if ('error' in aR) return err(aR.error);
        const bR = resolveStation(rest[4]);
        if ('error' in bR) return err(bR.error);
        return { kind: 'effect', effect: { type: 'clear_waypoints', lineId: lineR.id, startStationId: aR.id, endStationId: bR.id }, summary: `清空「${stationName(aR.id)}-${stationName(bR.id)}」途经点` };
      }
      // waypoint "线" between "A" "B" at x,y [at x,y …]
      const lineR = resolveLine(rest[0]);
      if ('error' in lineR) return err(lineR.error);
      if (rest[1]?.value?.toLowerCase() !== 'between') return err('用法：waypoint "线" between "A" "B" at x,y [at x,y …]');
      const aR = resolveStation(rest[2]);
      if ('error' in aR) return err(aR.error);
      const bR = resolveStation(rest[3]);
      if ('error' in bR) return err(bR.error);
      const points = parseWaypoints(rest.slice(4));
      if ('error' in points) return err(points.error);
      return { kind: 'effect', effect: { type: 'set_waypoints', lineId: lineR.id, startStationId: aR.id, endStationId: bR.id, points: points.points }, summary: `「${stationName(aR.id)}-${stationName(bR.id)}」设 ${points.points.length} 个途经点` };
    }

    case 'zoom': {
      const a = rest[0]?.value?.toLowerCase();
      if (a === 'in') return { kind: 'action', action: { type: 'zoom_in' }, undoable: false, summary: '放大一档' };
      if (a === 'out') return { kind: 'action', action: { type: 'zoom_out' }, undoable: false, summary: '缩小一档' };
      const v = Number(rest[0]?.value);
      if (!Number.isFinite(v) || v <= 0) return err('用法：zoom 1.5 | zoom in | zoom out');
      return { kind: 'action', action: { type: 'zoom', value: Math.max(0.1, Math.min(5, v)) }, undoable: false, summary: `缩放到 ${v}×` };
    }

    case 'fit': return { kind: 'action', action: { type: 'fit' }, undoable: false, summary: '适配全图' };
    case 'reset': return { kind: 'action', action: { type: 'reset' }, undoable: false, summary: '复位视图' };

    case 'center': {
      const stR = resolveStation(rest[0]);
      if ('error' in stR) return err(stR.error);
      return { kind: 'action', action: { type: 'center', stationId: stR.id }, undoable: false, summary: `居中到「${stationName(stR.id)}」` };
    }

    case 'style': {
      const v = rest[0]?.value?.toLowerCase();
      if (v === 'classic') return { kind: 'action', action: { type: 'set_style', mapStyle: 'classic-badge' }, undoable: true, summary: '地图样式：经典圆标' };
      if (v === 'dot') return { kind: 'action', action: { type: 'set_style', mapStyle: 'dot-label' }, undoable: true, summary: '地图样式：专业线网' };
      return err('用法：style classic | dot');
    }

    case 'theme': {
      const v = rest[0]?.value?.toLowerCase();
      if (v === 'light' || v === 'dark') return { kind: 'action', action: { type: 'set_theme', canvasTheme: v }, undoable: true, summary: `画布主题：${v === 'dark' ? '深色' : '浅色'}` };
      return err('用法：theme light | dark');
    }

    case 'corner': {
      const v = Number(rest[0]?.value);
      if (!Number.isFinite(v) || v < 0 || v > 40) return err('用法：corner 0-40（0=直角）');
      return { kind: 'action', action: { type: 'set_corner', cornerRadius: Math.round(v) }, undoable: true, summary: v === 0 ? '线路转角：直角' : `线路圆角半径：${Math.round(v)}` };
    }

    case 'undo': return { kind: 'action', action: { type: 'undo' }, undoable: false, summary: '撤销' };
    case 'redo': return { kind: 'action', action: { type: 'redo' }, undoable: false, summary: '重做' };
    case 'save': return { kind: 'action', action: { type: 'save' }, undoable: false, summary: '保存地图' };
    case 'new': return { kind: 'action', action: { type: 'new' }, undoable: false, summary: '新建空白方案' };

    case 'help': {
      const topic = rest[0] ? (rest[0].quoted ? rest[0].value : rest[0].value.toLowerCase()) : undefined;
      return { kind: 'guide', topic };
    }

    default:
      return err(`未知命令「${verb}」。输入 help 查看全部命令`);
  }
}

// connect 公共逻辑：解析站点序列 + 校验（≥2、存在、空线路或首站为端点）
function buildConnect(
  lineId: string,
  stationTokens: Token[],
  ctx: CommandContext,
  resolveStation: (t: Token | undefined) => { id: string } | { error: string },
  lineName: (id: string) => string,
  stationName: (id: string) => string
): ResolvedCommand {
  if (stationTokens.length < 2) return err('connect 至少需要 2 个站');
  const ids: string[] = [];
  for (const t of stationTokens) {
    const r = resolveStation(t);
    if ('error' in r) return err(r.error);
    ids.push(r.id);
  }
  const line = ctx.lines.find(l => l.id === lineId)!;
  if (line.stationIds.length > 0) {
    const ends = [line.stationIds[0], line.stationIds[line.stationIds.length - 1]];
    if (!ends.includes(ids[0])) {
      return err(`「${lineName(lineId)}」非空，connect 的第一个站必须是它的端点（${ends.map(stationName).map(s => `「${s}」`).join(' 或 ')}）`);
    }
  }
  return { kind: 'effect', effect: { type: 'connect', lineId, stationIds: ids }, summary: `「${lineName(lineId)}」连接 ${ids.length} 个站` };
}

function collectNames(tokens: Token[], label: string): { names: string[] } | { error: string } {
  if (tokens.length === 0) return { error: `缺少${label}` };
  const names: string[] = [];
  for (const t of tokens) {
    if (!t.quoted) return { error: `${label}需加引号，如 "名称"` };
    if (!checkName(t.value)) return { error: `${label}「${t.value}」无效（非空、≤32 字）` };
    names.push(t.value.trim());
  }
  return { names };
}

function parseRelativeOffset(tokens: Token[]): { dx: number; dy: number; anchorToken: Token } | { error: string } {
  // [方向 距离]+ from "锚站"
  let dx = 0;
  let dy = 0;
  let i = 0;
  let consumedPair = false;
  while (i < tokens.length && tokens[i].value.toLowerCase() !== 'from') {
    const dir = DIRECTIONS[tokens[i].value.toLowerCase()];
    if (!dir) return { error: 'station 用法：station "名" at x,y  或  station "名" left/right/up/down 距离 … from "锚站"' };
    const dist = Number(tokens[i + 1]?.value);
    if (!Number.isFinite(dist)) return { error: `方向 ${tokens[i].value} 后需要一个距离数字` };
    dx += dir.dx * dist;
    dy += dir.dy * dist;
    consumedPair = true;
    i += 2;
  }
  if (!consumedPair) return { error: 'station 相对放置需至少一组「方向 距离」' };
  if (tokens[i]?.value?.toLowerCase() !== 'from') return { error: '相对放置需以 from "锚站" 结尾' };
  const anchorToken = tokens[i + 1];
  if (!anchorToken) return { error: '缺少锚站，用法 … from "锚站"' };
  return { dx, dy, anchorToken };
}

function parseWaypoints(tokens: Token[]): { points: { x: number; y: number }[] } | { error: string } {
  // (at x,y)+
  const points: { x: number; y: number }[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i].value.toLowerCase() !== 'at') return { error: '途经点用法：… at x,y [at x,y …]' };
    const coords = tokens[i + 1] && !tokens[i + 1].quoted ? parseCoords(tokens[i + 1].value) : null;
    if (!coords) return { error: 'at 后需要坐标 x,y（如 at 820,300）' };
    points.push(coords);
    i += 2;
  }
  if (points.length === 0) return { error: '至少需要一个途经点 at x,y' };
  return { points };
}
