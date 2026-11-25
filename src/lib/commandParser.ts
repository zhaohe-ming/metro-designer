// 灵动命令行引擎 2.0（纯函数，无副作用）：
// 1. 全面容错：兼容免引号裸写站名/线名、英文单双引号、中文全角引号“”‘’、中文颜色名与 #rgb/#rrggbb；
// 2. 高阶快捷语法：一行建干线 (`line`)、建环线 (`loop`)、闭环 (`close`)、Y 型支线 (`branch`)、合站 (`merge`)、对调并行 (`swap`)、轻城市底图 (`city`)、途经点显隐 (`waypoints`)；
// 3. 多命令流水线：支持 `;` / `；` / 多行批量输入（由上层一次原子应用，一次 Ctrl+Z 整体撤销）；
// 4. 上下文级 Tab 自动补全 + 自然语言一键穿透 AI 助手 (`ai ...` / `? ...` / 非指令语句自动识别)。

import { AIOperation } from '../api';
import { Line, Station, LINE_COLORS } from '../types';

export interface CommandContext {
  lines: Pick<Line, 'id' | 'name' | 'color' | 'stationIds'>[];
  stations: Pick<Station, 'id' | 'name' | 'x' | 'y'>[];
  currentLineId?: string | null;
}

// 命令独有的精细图变更（与 AIOperation 互补）
export type CommandEffect =
  | { type: 'create_empty_line'; name: string; color: string }
  | { type: 'connect'; lineId: string; stationIds: string[] }
  | { type: 'add_station'; name: string; x: number; y: number }
  | { type: 'set_waypoints'; lineId: string; startStationId: string; endStationId: string; points: { x: number; y: number }[] }
  | { type: 'clear_waypoints'; lineId: string; startStationId: string; endStationId: string }
  | { type: 'swap_parallel'; lineId: string; startStationId: string; endStationId: string };

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
  | { type: 'set_basemap_plain' }
  | { type: 'select_line'; lineId: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'save' }
  | { type: 'new' };

export type ResolvedCommand =
  | { kind: 'ops'; ops: AIOperation[]; summary: string }
  | { kind: 'effect'; effect: CommandEffect; summary: string }
  | { kind: 'action'; action: AppAction; undoable: boolean; summary: string }
  | { kind: 'ai'; prompt: string; summary: string }
  | { kind: 'error'; message: string; aiPromptSuggestion?: string }
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

const ZH_COLOR_ALIASES: Record<string, string> = {
  蓝: LINE_COLORS[0],
  蓝色: LINE_COLORS[0],
  红: LINE_COLORS[1],
  红色: LINE_COLORS[1],
  绿: LINE_COLORS[2],
  绿色: LINE_COLORS[2],
  黄: LINE_COLORS[3],
  黄色: LINE_COLORS[3],
  紫: LINE_COLORS[4],
  紫色: LINE_COLORS[4],
  青: LINE_COLORS[5],
  青色: LINE_COLORS[5],
  粉: LINE_COLORS[6],
  粉色: LINE_COLORS[6],
  橙: LINE_COLORS[7],
  橙色: LINE_COLORS[7]
};

export const COMMAND_VERBS = [
  'line', 'loop', 'branch', 'close', 'extend', 'insert', 'connect', 'attach', 'merge', 'swap',
  'create', 'station', 'recolor', 'rename', 'delete', 'select', 'waypoint', 'waypoints',
  'city', 'preset', 'theme', 'corner', 'style', 'zoom', 'fit', 'reset', 'center',
  'ai', 'undo', 'redo', 'save', 'new', 'help'
] as const;

const VERB_HINTS: Record<string, string> = {
  line: '一行建线/连站',
  loop: '新建环线',
  branch: '拉Y型支线',
  close: '首尾闭环',
  extend: '端点延伸',
  insert: '区间插站',
  connect: '连接已有站',
  attach: '接已有站到端点',
  merge: '两站合并换乘',
  swap: '对调并行顺序',
  create: '建空线/建线',
  station: '坐标/相对落站',
  recolor: '修改线路色',
  rename: '重命名线/站',
  delete: '删除线/站',
  select: '切换当前线',
  waypoint: '设/清途经点',
  waypoints: '显隐途经点',
  city: '轻城市底图',
  preset: '城市视觉风格',
  theme: '浅色/深色画布',
  corner: '转角圆弧半径',
  zoom: '缩放画布',
  fit: '全图居中',
  center: '定位到站点',
  ai: 'AI自然语言规划',
  help: '查看语法示例'
};

export interface Token {
  quoted: boolean;
  value: string;
  idHint?: string;
  isRef: boolean;
  start: number;
  end: number;
}

const OPEN_TO_CLOSE_QUOTE: Record<string, string> = {
  '"': '"',
  "'": "'",
  '“': '”',
  '”': '”',
  '‘': '’',
  '’': '’'
};

/**
 * 将包含分号 `;` / `；` 或换行符的批量命令安全切分为独立语句（忽略引号内的分号）。
 */
export function splitCommandStatements(raw: string): string[] {
  const out: string[] = [];
  let cur = '';
  let closeQuote: string | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (closeQuote) {
      cur += ch;
      if (ch === closeQuote || (closeQuote === '”' && ch === '“') || (closeQuote === '"' && ch === '"')) {
        closeQuote = null;
      }
      continue;
    }
    if (OPEN_TO_CLOSE_QUOTE[ch]) {
      closeQuote = OPEN_TO_CLOSE_QUOTE[ch];
      cur += ch;
      continue;
    }
    if (ch === ';' || ch === '；' || ch === '\n' || ch === '\r') {
      const trimmed = cur.trim();
      if (trimmed) out.push(trimmed);
      cur = '';
      continue;
    }
    cur += ch;
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    const expectedClose = OPEN_TO_CLOSE_QUOTE[ch];
    if (expectedClose) {
      const start = i;
      let j = i + 1;
      let value = '';
      while (j < n && input[j] !== expectedClose && !(expectedClose === '”' && input[j] === '"')) {
        value += input[j];
        j += 1;
      }
      if (j >= n) {
        tokens.push({ quoted: true, value, isRef: false, start, end: n });
        break;
      }
      j += 1;
      let idHint: string | undefined;
      if (j < n && input[j] === '@') {
        j += 1;
        let hint = '';
        while (j < n && input[j] !== ' ' && input[j] !== '\t') {
          hint += input[j];
          j += 1;
        }
        idHint = hint;
      }
      tokens.push({ quoted: true, value, idHint, isRef: false, start, end: j });
      i = j;
      continue;
    }
    if (ch === '@') {
      const start = i;
      let j = i + 1;
      let id = '';
      while (j < n && input[j] !== ' ' && input[j] !== '\t') {
        id += input[j];
        j += 1;
      }
      tokens.push({ quoted: false, value: '', idHint: id, isRef: true, start, end: j });
      i = j;
      continue;
    }
    const start = i;
    let j = i;
    let raw = '';
    while (j < n && input[j] !== ' ' && input[j] !== '\t') {
      raw += input[j];
      j += 1;
    }
    // 支持裸写 环线@Ldup1 形式的 @id前缀 消歧
    const atIdx = raw.indexOf('@');
    if (atIdx > 0 && atIdx < raw.length - 1) {
      tokens.push({
        quoted: false,
        value: raw.slice(0, atIdx),
        idHint: raw.slice(atIdx + 1),
        isRef: false,
        start,
        end: j
      });
    } else {
      tokens.push({ quoted: false, value: raw, isRef: false, start, end: j });
    }
    i = j;
  }
  return tokens;
}

const err = (message: string, aiPromptSuggestion?: string): ResolvedCommand =>
  aiPromptSuggestion ? { kind: 'error', message, aiPromptSuggestion } : { kind: 'error', message };

const checkName = (s: string) => s.trim().length > 0 && Array.from(s.trim()).length <= 32;

export function parseColorToken(token: Token | undefined): { color: string } | { error: string } {
  if (!token) return { error: '缺少颜色，可用如 blue / red / 蓝 / #2563eb / 1-8' };
  const raw = token.value.trim();
  const lower = raw.toLowerCase();
  if (NAMED_COLORS[lower]) return { color: NAMED_COLORS[lower] };
  if (ZH_COLOR_ALIASES[raw]) return { color: ZH_COLOR_ALIASES[raw] };
  if (/^#[0-9a-f]{6}$/i.test(lower)) return { color: lower };
  if (/^#[0-9a-f]{3}$/i.test(lower)) {
    const r = lower.charAt(1);
    const g = lower.charAt(2);
    const b = lower.charAt(3);
    return { color: `#${r}${r}${g}${g}${b}${b}` };
  }
  if (/^[1-8]$/.test(lower)) return { color: LINE_COLORS[Number(lower) - 1] };
  return {
    error: `无法识别的颜色「${token.value}」。可用：${Object.keys(NAMED_COLORS).join('/')} / 红蓝绿黄紫青粉橙 / #rrggbb / 1-8`
  };
}

function isLikelyColorToken(token: Token | undefined): boolean {
  if (!token || token.isRef) return false;
  return 'color' in parseColorToken(token);
}

function parseCoords(value: string): { x: number; y: number } | null {
  const parts = value.replace('，', ',').split(',');
  if (parts.length !== 2) return null;
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

const DIRECTIONS: Record<string, { dx: number; dy: number }> = {
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  west: { dx: -1, dy: 0 },
  east: { dx: 1, dy: 0 },
  north: { dx: 0, dy: -1 },
  south: { dx: 0, dy: 1 }
};

function resolveRef(
  token: Token | undefined,
  items: { id: string; name: string }[],
  label: string
): { id: string } | { error: string } {
  if (!token) return { error: `缺少${label}` };
  if (token.isRef) {
    const hit = items.find((it) => it.id === token.idHint || it.id.startsWith(token.idHint!));
    return hit ? { id: hit.id } : { error: `找不到 id 为 @${token.idHint} 的${label}` };
  }
  const targetName = token.value.trim();
  if (!targetName) return { error: `缺少${label}` };
  let candidates = items.filter((it) => it.name.trim() === targetName);
  if (token.idHint) candidates = candidates.filter((it) => it.id.startsWith(token.idHint!));
  if (candidates.length === 0) return { error: `${label}「${targetName}」不存在` };
  if (candidates.length > 1) {
    const list = candidates
      .slice(0, 6)
      .map((c) => `${c.name}@${c.id.slice(0, 6)}`)
      .join(' / ');
    return { error: `${label}「${targetName}」有 ${candidates.length} 个，请加 @id前缀 指定：${list}` };
  }
  return { id: candidates[0].id };
}

const requireName = (token: Token | undefined, label: string): { name: string } | { error: string } => {
  if (!token || token.isRef) return { error: `缺少${label}` };
  if (!checkName(token.value)) return { error: `${label}无效（非空、≤32 字）` };
  return { name: token.value.trim() };
};

const LIGHT_CITY_ARCH_ALIASES: Record<
  string,
  'river' | 'confluence' | 'bay' | 'ring' | 'delta' | 'lake' | 'shuffle' | 'plain'
> = {
  river: 'river',
  大江: 'river',
  穿城大江: 'river',
  confluence: 'confluence',
  交汇: 'confluence',
  两江交汇: 'confluence',
  bay: 'bay',
  海湾: 'bay',
  湾区: 'bay',
  湾区海港: 'bay',
  ring: 'ring',
  环城: 'ring',
  平原环城: 'ring',
  delta: 'delta',
  水乡: 'delta',
  河网水乡: 'delta',
  lake: 'lake',
  湖山: 'lake',
  湖山新城: 'lake',
  shuffle: 'shuffle',
  random: 'shuffle',
  换城: 'shuffle',
  plain: 'plain',
  off: 'plain',
  纯画布: 'plain'
};

const PRESET_ALIASES: Record<string, 'standard' | 'beijing' | 'shanghai' | 'mtr'> = {
  standard: 'standard',
  modern: 'standard',
  现代: 'standard',
  beijing: 'beijing',
  classic: 'beijing',
  经典: 'beijing',
  shanghai: 'shanghai',
  bold: 'shanghai',
  粗体: 'shanghai',
  mtr: 'mtr',
  tube: 'mtr',
  管道: 'mtr'
};

function looksLikeNaturalLanguage(trimmed: string): boolean {
  if (Array.from(trimmed).length < 4) return false;
  // 含有常见自然语言规划词或整句中文指令
  return /(帮我|规划|新建|创建|生成|重命名|起名|延长|延伸|环线|支线|过江|换乘|改成|把|给|设计)/.test(trimmed);
}

// ── 主入口 ──────────────────────────────────────────────────────────────
export function interpretCommand(input: string, ctx: CommandContext): ResolvedCommand {
  const trimmed = input.trim();
  if (!trimmed) return err('请输入命令');

  // `? 自然语言` 或 `？自然语言` 直接转交 AI 规划助手
  if (trimmed.startsWith('?') || trimmed.startsWith('？')) {
    const prompt = trimmed.slice(1).trim();
    if (!prompt) return { kind: 'guide' };
    return { kind: 'ai', prompt, summary: `已转交 AI 规划：${prompt}` };
  }

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return err('请输入命令');
  const head = tokens[0];
  if (head.quoted || head.isRef) {
    return err(
      '命令应以动作词开头，如 line / loop / branch / extend / city / ai / help',
      looksLikeNaturalLanguage(trimmed) ? trimmed : undefined
    );
  }
  const verb = head.value.toLowerCase();
  const rest = tokens.slice(1);

  if (verb === 'ai' || verb === 'ask') {
    const prompt = trimmed.slice(head.end).trim();
    if (!prompt) return err('用法：ai 你的规划需求（如 ai 给所有默认站按江南水乡风格起名）');
    return { kind: 'ai', prompt, summary: `已转交 AI 规划：${prompt}` };
  }

  const resolveLine = (t: Token | undefined) => resolveRef(t, ctx.lines, '线路');
  const resolveStation = (t: Token | undefined) => resolveRef(t, ctx.stations, '站点');
  const stationName = (id: string) => ctx.stations.find((s) => s.id === id)?.name || id.slice(0, 6);
  const lineName = (id: string) => ctx.lines.find((l) => l.id === id)?.name || id.slice(0, 6);

  switch (verb) {
    case 'create': {
      const sub = rest[0]?.value?.toLowerCase();
      if (sub === 'loop') {
        return parseLoopCreation(rest.slice(1));
      }
      if (sub !== 'line') return err('用法：create line 线名 颜色 [站1 站2 …]  或  create loop 环线名 颜色 站1 站2 站3 …');
      const nameR = requireName(rest[1], '线名');
      if ('error' in nameR) return err(nameR.error);
      const colorR = parseColorToken(rest[2]);
      if ('error' in colorR) return err(colorR.error);
      if (rest.length >= 5) {
        return parseOneShotLineCreation(nameR.name, colorR.color, rest.slice(3));
      }
      return {
        kind: 'effect',
        effect: { type: 'create_empty_line', name: nameR.name, color: colorR.color },
        summary: `新建空线路「${nameR.name}」`
      };
    }

    case 'line': {
      // 形态 1（兼容既有）：line <已有线> connect <站1> <站2> ...
      if (rest[1]?.value?.toLowerCase() === 'connect') {
        const lineR = resolveLine(rest[0]);
        if ('error' in lineR) return err(lineR.error);
        return buildConnect(lineR.id, rest.slice(2), ctx, resolveStation, lineName, stationName);
      }
      // 形态 2（2.0 极速一行建线）：line 1号线 red 西站 市民中心 人民广场 东站
      if (rest.length >= 2 && isLikelyColorToken(rest[1])) {
        const nameR = requireName(rest[0], '线名');
        if ('error' in nameR) return err(nameR.error);
        const colorR = parseColorToken(rest[1]);
        if ('error' in colorR) return err(colorR.error);
        if (rest.length === 2) {
          return {
            kind: 'effect',
            effect: { type: 'create_empty_line', name: nameR.name, color: colorR.color },
            summary: `新建空线路「${nameR.name}」`
          };
        }
        return parseOneShotLineCreation(nameR.name, colorR.color, rest.slice(2));
      }
      return err('用法：line 1号线 blue 站1 站2 …（一行建线） 或 line 1号线 connect 站1 站2 …');
    }

    case 'loop': {
      return parseLoopCreation(rest);
    }

    case 'close': {
      let targetLineId: string | null = null;
      if (rest.length === 0) {
        if (!ctx.currentLineId) return err('用法：close 线名（或先选中一条线路后直接输入 close）');
        targetLineId = ctx.currentLineId;
      } else {
        const lineR = resolveLine(rest[0]);
        if ('error' in lineR) return err(lineR.error);
        targetLineId = lineR.id;
      }
      const line = ctx.lines.find((l) => l.id === targetLineId)!;
      if (line.stationIds.length < 3) return err(`「${lineName(targetLineId)}」至少需要 3 座站点才能闭合为环线`);
      return {
        kind: 'ops',
        ops: [{ type: 'close_line_loop', lineId: targetLineId }],
        summary: `将「${lineName(targetLineId)}」首尾相连闭合为环线`
      };
    }

    case 'branch': {
      // branch [线名] from 分叉站 新站1 新站2 ...
      let lineId: string;
      let afterFromTokens: Token[];
      let anchorTok: Token | undefined;
      if (rest[0]?.value?.toLowerCase() === 'from') {
        if (!ctx.currentLineId) return err('没有当前选中线路，请用：branch 1号线 from 分叉站 新站1 新站2 …');
        lineId = ctx.currentLineId;
        anchorTok = rest[1];
        afterFromTokens = rest.slice(2);
      } else {
        const lineR = resolveLine(rest[0]);
        if ('error' in lineR) return err(lineR.error);
        if (rest[1]?.value?.toLowerCase() !== 'from') {
          return err('用法：branch 1号线 from 分叉站 新站1 新站2 …');
        }
        lineId = lineR.id;
        anchorTok = rest[2];
        afterFromTokens = rest.slice(3);
      }
      const stR = resolveStation(anchorTok);
      if ('error' in stR) return err(stR.error);
      const line = ctx.lines.find((l) => l.id === lineId)!;
      if (!line.stationIds.includes(stR.id)) {
        return err(`站点「${stationName(stR.id)}」不在「${lineName(lineId)}」上，无法从该站分叉`);
      }
      const namesR = collectNames(afterFromTokens, '支线站名');
      if ('error' in namesR) return err(namesR.error);
      return {
        kind: 'ops',
        ops: [
          {
            type: 'create_branch_line',
            lineId,
            branchFromStationId: stR.id,
            newStationNames: namesR.names
          }
        ],
        summary: `从「${lineName(lineId)} · ${stationName(stR.id)}」分出 ${namesR.names.length} 站支线`
      };
    }

    case 'merge': {
      // merge 源站 [into] 目标站
      const srcR = resolveStation(rest[0]);
      if ('error' in srcR) return err(srcR.error);
      const secondIdx = rest[1]?.value?.toLowerCase() === 'into' ? 2 : 1;
      const dstR = resolveStation(rest[secondIdx]);
      if ('error' in dstR) return err(dstR.error);
      if (srcR.id === dstR.id) return err('不能将同一个站点与自身合并');
      return {
        kind: 'ops',
        ops: [{ type: 'merge_stations', sourceStationId: srcR.id, targetStationId: dstR.id }],
        summary: `合并「${stationName(srcR.id)}」入「${stationName(dstR.id)}」形成换乘站`
      };
    }

    case 'swap': {
      // swap [线名] 站A 站B
      let lineId: string;
      let tokA: Token | undefined;
      let tokB: Token | undefined;
      if (rest.length === 2) {
        if (!ctx.currentLineId) return err('用法：swap 线名 站A 站B（或选中线路后 swap 站A 站B）');
        lineId = ctx.currentLineId;
        tokA = rest[0];
        tokB = rest[1];
      } else {
        const lineR = resolveLine(rest[0]);
        if ('error' in lineR) return err(lineR.error);
        lineId = lineR.id;
        const offset = rest[1]?.value?.toLowerCase() === 'between' ? 2 : 1;
        tokA = rest[offset];
        tokB = rest[offset + 1];
      }
      const aR = resolveStation(tokA);
      if ('error' in aR) return err(aR.error);
      const bR = resolveStation(tokB);
      if ('error' in bR) return err(bR.error);
      return {
        kind: 'effect',
        effect: { type: 'swap_parallel', lineId, startStationId: aR.id, endStationId: bR.id },
        summary: `已对调「${stationName(aR.id)}-${stationName(bR.id)}」共线走廊的并行顺序`
      };
    }

    case 'connect': {
      if (!ctx.currentLineId) return err('没有当前线路，请先 create line 或 select 线名');
      return buildConnect(ctx.currentLineId, rest, ctx, resolveStation, lineName, stationName);
    }

    case 'extend': {
      let lineId: string;
      let posTok: Token | undefined;
      let nameTokens: Token[];
      const firstVal = rest[0]?.value?.toLowerCase();
      if ((firstVal === 'start' || firstVal === 'end') && ctx.currentLineId) {
        lineId = ctx.currentLineId;
        posTok = rest[0];
        nameTokens = rest.slice(1);
      } else {
        const lineR = resolveLine(rest[0]);
        if ('error' in lineR) return err(lineR.error);
        lineId = lineR.id;
        posTok = rest[1];
        nameTokens = rest.slice(2);
      }
      const pos = posTok?.value?.toLowerCase();
      if (pos !== 'start' && pos !== 'end') return err('用法：extend 线名 start|end 新站1 新站2 …');
      const line = ctx.lines.find((l) => l.id === lineId)!;
      if (line.stationIds.length < 2) return err('extend 需要线路至少已有 2 个站点');
      const namesR = collectNames(nameTokens, '新站名');
      if ('error' in namesR) return err(namesR.error);
      const op: AIOperation = { type: 'create_station_at_line_end', lineId, position: pos, names: namesR.names };
      return {
        kind: 'ops',
        ops: [op],
        summary: `「${lineName(lineId)}」${pos === 'start' ? '起点' : '终点'}延伸 ${namesR.names.length} 个新站`
      };
    }

    case 'attach': {
      const lineR = resolveLine(rest[0]);
      if ('error' in lineR) return err(lineR.error);
      const pos = rest[1]?.value?.toLowerCase();
      if (pos !== 'start' && pos !== 'end') return err('用法：attach 线名 start|end 已有站');
      const stR = resolveStation(rest[2]);
      if ('error' in stR) return err(stR.error);
      const op: AIOperation = { type: 'attach_station_to_line', lineId: lineR.id, stationId: stR.id, position: pos };
      return {
        kind: 'ops',
        ops: [op],
        summary: `把「${stationName(stR.id)}」接到「${lineName(lineR.id)}」${pos === 'start' ? '起点' : '终点'}`
      };
    }

    case 'recolor': {
      const lineR = resolveLine(rest[0]);
      if ('error' in lineR) return err(lineR.error);
      const colorR = parseColorToken(rest[1]);
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
      return err('用法：rename line 线名 新名  或  rename station 站名 新名');
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
      return err('用法：delete line 线名  或  delete station 站名');
    }

    case 'select': {
      const lineR = resolveLine(rest[0]);
      if ('error' in lineR) return err(lineR.error);
      return {
        kind: 'action',
        action: { type: 'select_line', lineId: lineR.id },
        undoable: false,
        summary: `当前线路：「${lineName(lineR.id)}」`
      };
    }

    case 'station': {
      const nameR = requireName(rest[0], '站名');
      if ('error' in nameR) return err(nameR.error);
      const kw = rest[1]?.value?.toLowerCase();
      if (kw === 'at') {
        const coords = rest[2] && !rest[2].quoted ? parseCoords(rest[2].value) : null;
        if (!coords) return err('用法：station 站名 at x,y（如 station 西单 at 800,450）');
        return {
          kind: 'effect',
          effect: { type: 'add_station', name: nameR.name, x: coords.x, y: coords.y },
          summary: `建独立站「${nameR.name}」@(${coords.x},${coords.y})`
        };
      }
      const offset = parseRelativeOffset(rest.slice(1));
      if ('error' in offset) return err(offset.error);
      const anchorR = resolveStation(offset.anchorToken);
      if ('error' in anchorR) return err(anchorR.error);
      const anchor = ctx.stations.find((s) => s.id === anchorR.id)!;
      const x = anchor.x + offset.dx;
      const y = anchor.y + offset.dy;
      return {
        kind: 'effect',
        effect: { type: 'add_station', name: nameR.name, x, y },
        summary: `建独立站「${nameR.name}」（相对「${stationName(anchorR.id)}」）`
      };
    }

    case 'insert': {
      const lineR = resolveLine(rest[0]);
      if ('error' in lineR) return err(lineR.error);
      if (rest[1]?.value?.toLowerCase() !== 'between') return err('用法：insert 线名 between 站A 站B 新站1 …');
      const aR = resolveStation(rest[2]);
      if ('error' in aR) return err(aR.error);
      const bR = resolveStation(rest[3]);
      if ('error' in bR) return err(bR.error);
      const namesR = collectNames(rest.slice(4), '新站名');
      if ('error' in namesR) return err(namesR.error);
      const op: AIOperation = {
        type: 'create_station_between',
        lineId: lineR.id,
        afterStationId: aR.id,
        beforeStationId: bR.id,
        names: namesR.names
      };
      return {
        kind: 'ops',
        ops: [op],
        summary: `在「${lineName(lineR.id)}」「${stationName(aR.id)}」「${stationName(bR.id)}」间插 ${namesR.names.length} 站`
      };
    }

    case 'waypoint': {
      if (rest[0]?.value?.toLowerCase() === 'clear') {
        const lineR = resolveLine(rest[1]);
        if ('error' in lineR) return err(lineR.error);
        if (rest[2]?.value?.toLowerCase() !== 'between') return err('用法：waypoint clear 线名 between 站A 站B');
        const aR = resolveStation(rest[3]);
        if ('error' in aR) return err(aR.error);
        const bR = resolveStation(rest[4]);
        if ('error' in bR) return err(bR.error);
        return {
          kind: 'effect',
          effect: { type: 'clear_waypoints', lineId: lineR.id, startStationId: aR.id, endStationId: bR.id },
          summary: `清空「${stationName(aR.id)}-${stationName(bR.id)}」途经点`
        };
      }
      const lineR = resolveLine(rest[0]);
      if ('error' in lineR) return err(lineR.error);
      if (rest[1]?.value?.toLowerCase() !== 'between') return err('用法：waypoint 线名 between 站A 站B at x,y [at x,y …]');
      const aR = resolveStation(rest[2]);
      if ('error' in aR) return err(aR.error);
      const bR = resolveStation(rest[3]);
      if ('error' in bR) return err(bR.error);
      const points = parseWaypoints(rest.slice(4));
      if ('error' in points) return err(points.error);
      return {
        kind: 'effect',
        effect: {
          type: 'set_waypoints',
          lineId: lineR.id,
          startStationId: aR.id,
          endStationId: bR.id,
          points: points.points
        },
        summary: `「${stationName(aR.id)}-${stationName(bR.id)}」设 ${points.points.length} 个途经点`
      };
    }

    case 'waypoints': {
      const mode = rest[0]?.value?.toLowerCase();
      if (mode === 'hide' || mode === 'off') {
        return {
          kind: 'ops',
          ops: [{ type: 'configure_map', hideWaypoints: true }],
          summary: '已开启「默认隐藏途经点控制柄」'
        };
      }
      if (mode === 'show' || mode === 'on') {
        return {
          kind: 'ops',
          ops: [{ type: 'configure_map', hideWaypoints: false }],
          summary: '已恢复显示途经点控制柄'
        };
      }
      return err('用法：waypoints hide | show');
    }

    case 'city':
    case 'basemap': {
      const rawArg = (rest[0]?.value || '').trim().toLowerCase();
      const mapped = LIGHT_CITY_ARCH_ALIASES[rawArg] || LIGHT_CITY_ARCH_ALIASES[rest[0]?.value || ''];
      if (!mapped) {
        return err('用法：city river(大江) | confluence(交汇) | bay(海湾) | ring(环城) | delta(水乡) | lake(湖山) | shuffle(换城) | plain(纯画布)');
      }
      if (mapped === 'plain') {
        return { kind: 'action', action: { type: 'set_basemap_plain' }, undoable: true, summary: '已切换为纯画布模式' };
      }
      return {
        kind: 'ops',
        ops: [{ type: 'configure_map', lightCityArchetype: mapped }],
        summary: mapped === 'shuffle' ? '已刷新轻城市随机种子' : `已切换轻城市地貌：${mapped}`
      };
    }

    case 'preset': {
      const rawArg = (rest[0]?.value || '').trim().toLowerCase();
      const style = PRESET_ALIASES[rawArg] || PRESET_ALIASES[rest[0]?.value || ''];
      if (!style) return err('用法：preset modern(现代) | classic(经典) | bold(粗体) | mtr(管道)');
      return {
        kind: 'ops',
        ops: [{ type: 'configure_map', cityStyle: style }],
        summary: `视觉风格切换为：${style}`
      };
    }

    case 'zoom': {
      const a = rest[0]?.value?.toLowerCase();
      if (a === 'in') return { kind: 'action', action: { type: 'zoom_in' }, undoable: false, summary: '放大一档' };
      if (a === 'out') return { kind: 'action', action: { type: 'zoom_out' }, undoable: false, summary: '缩小一档' };
      const v = Number(rest[0]?.value);
      if (!Number.isFinite(v) || v <= 0) return err('用法：zoom 1.5 | zoom in | zoom out');
      return { kind: 'action', action: { type: 'zoom', value: Math.max(0.1, Math.min(5, v)) }, undoable: false, summary: `缩放到 ${v}×` };
    }

    case 'fit':
      return { kind: 'action', action: { type: 'fit' }, undoable: false, summary: '适配全图' };
    case 'reset':
      return { kind: 'action', action: { type: 'reset' }, undoable: false, summary: '复位视图' };

    case 'center': {
      const stR = resolveStation(rest[0]);
      if ('error' in stR) return err(stR.error);
      return {
        kind: 'action',
        action: { type: 'center', stationId: stR.id },
        undoable: false,
        summary: `居中到「${stationName(stR.id)}」`
      };
    }

    case 'style': {
      const v = rest[0]?.value?.toLowerCase();
      if (v === 'classic') return { kind: 'action', action: { type: 'set_style', mapStyle: 'classic-badge' }, undoable: true, summary: '地图样式：经典圆标' };
      if (v === 'dot') return { kind: 'action', action: { type: 'set_style', mapStyle: 'dot-label' }, undoable: true, summary: '地图样式：专业线网' };
      return err('用法：style classic | dot');
    }

    case 'theme': {
      const v = rest[0]?.value?.toLowerCase();
      if (v === 'light' || v === 'dark') {
        return {
          kind: 'action',
          action: { type: 'set_theme', canvasTheme: v },
          undoable: true,
          summary: `画布主题：${v === 'dark' ? '深色' : '浅色'}`
        };
      }
      return err('用法：theme light | dark');
    }

    case 'corner': {
      const v = Number(rest[0]?.value);
      if (!Number.isFinite(v) || v < 0 || v > 40) return err('用法：corner 0-40（0=直角）');
      return {
        kind: 'action',
        action: { type: 'set_corner', cornerRadius: Math.round(v) },
        undoable: true,
        summary: v === 0 ? '线路转角：直角' : `线路圆角半径：${Math.round(v)}`
      };
    }

    case 'undo':
      return { kind: 'action', action: { type: 'undo' }, undoable: false, summary: '撤销' };
    case 'redo':
      return { kind: 'action', action: { type: 'redo' }, undoable: false, summary: '重做' };
    case 'save':
      return { kind: 'action', action: { type: 'save' }, undoable: false, summary: '保存地图' };
    case 'new':
      return { kind: 'action', action: { type: 'new' }, undoable: false, summary: '新建空白方案' };

    case 'help': {
      const topic = rest[0] ? (rest[0].quoted ? rest[0].value : rest[0].value.toLowerCase()) : undefined;
      return { kind: 'guide', topic };
    }

    default: {
      const aiCandidate = looksLikeNaturalLanguage(trimmed) || rest.length >= 2 ? trimmed : undefined;
      return err(
        aiCandidate
          ? `未识别命令「${verb}」——若是自然语言规划，可点右侧交给 AI，或以 ai / ? 开头`
          : `未知命令「${verb}」。输入 help 查看快捷语法，或以 ai 开头调用 AI 规划`,
        aiCandidate
      );
    }
  }
}

function parseOneShotLineCreation(name: string, color: string, tail: Token[]): ResolvedCommand {
  let direction: 'east_west' | 'north_south' | 'nw_se' | 'sw_ne' | undefined;
  let stationTokens = tail;
  const lastVal = tail[tail.length - 1]?.value?.toLowerCase();
  if (
    !tail[tail.length - 1]?.quoted &&
    (lastVal === 'east_west' || lastVal === 'north_south' || lastVal === 'nw_se' || lastVal === 'sw_ne')
  ) {
    direction = lastVal;
    stationTokens = tail.slice(0, -1);
  }
  if (stationTokens.length < 2) {
    return err('一行建线至少需要 2 个站名，如：line 1号线 red 西站 市民中心 人民广场 东站');
  }
  const namesR = collectNames(stationTokens, '站名');
  if ('error' in namesR) return err(namesR.error);
  return {
    kind: 'ops',
    ops: [
      {
        type: 'create_new_line_with_stations',
        name,
        color,
        stationNames: namesR.names,
        ...(direction ? { direction } : {})
      }
    ],
    summary: `新建「${name}」（${namesR.names.length} 站）`
  };
}

function parseLoopCreation(args: Token[]): ResolvedCommand {
  const nameR = requireName(args[0], '环线名');
  if ('error' in nameR) return err('用法：loop 4号线 purple 站1 站2 站3 站4 …（至少 3 站）');
  const colorR = parseColorToken(args[1]);
  if ('error' in colorR) return err(colorR.error);
  const stationTokens = args.slice(2);
  if (stationTokens.length < 3) {
    return err('新建环线至少需要 3 个站名，如：loop 4号线 purple 金融城 会展中心 体育馆 北站');
  }
  const namesR = collectNames(stationTokens, '环线站名');
  if ('error' in namesR) return err(namesR.error);
  return {
    kind: 'ops',
    ops: [
      {
        type: 'create_loop_line',
        name: nameR.name,
        color: colorR.color,
        stationNames: namesR.names
      }
    ],
    summary: `新建环线「${nameR.name}」（${namesR.names.length} 站闭环）`
  };
}

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
  const line = ctx.lines.find((l) => l.id === lineId)!;
  if (line.stationIds.length > 0) {
    const ends = [line.stationIds[0], line.stationIds[line.stationIds.length - 1]];
    if (!ends.includes(ids[0])) {
      return err(
        `「${lineName(lineId)}」非空，connect 的第一个站必须是它的端点（${ends.map(stationName).map((s) => `「${s}」`).join(' 或 ')}）`
      );
    }
  }
  return {
    kind: 'effect',
    effect: { type: 'connect', lineId, stationIds: ids },
    summary: `「${lineName(lineId)}」连接 ${ids.length} 个站`
  };
}

function collectNames(tokens: Token[], label: string): { names: string[] } | { error: string } {
  if (tokens.length === 0) return { error: `缺少${label}` };
  const names: string[] = [];
  for (const t of tokens) {
    if (t.isRef) return { error: `${label}请填写名称而非 @id` };
    if (!checkName(t.value)) return { error: `${label}「${t.value}」无效（非空、≤32 字）` };
    names.push(t.value.trim());
  }
  return { names };
}

function parseRelativeOffset(tokens: Token[]): { dx: number; dy: number; anchorToken: Token } | { error: string } {
  let dx = 0;
  let dy = 0;
  let i = 0;
  let consumedPair = false;
  while (i < tokens.length && tokens[i].value.toLowerCase() !== 'from') {
    const dir = DIRECTIONS[tokens[i].value.toLowerCase()];
    if (!dir) return { error: 'station 用法：station 站名 at x,y  或  station 站名 left/right/up/down 距离 … from 锚站' };
    const dist = Number(tokens[i + 1]?.value);
    if (!Number.isFinite(dist)) return { error: `方向 ${tokens[i].value} 后需要一个距离数字` };
    dx += dir.dx * dist;
    dy += dir.dy * dist;
    consumedPair = true;
    i += 2;
  }
  if (!consumedPair) return { error: 'station 相对放置需至少一组「方向 距离」' };
  if (tokens[i]?.value?.toLowerCase() !== 'from') return { error: '相对放置需以 from 锚站 结尾' };
  const anchorToken = tokens[i + 1];
  if (!anchorToken) return { error: '缺少锚站，用法 … from 锚站' };
  return { dx, dy, anchorToken };
}

function parseWaypoints(tokens: Token[]): { points: { x: number; y: number }[] } | { error: string } {
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

// ── 上下文感知自动补全引擎 ─────────────────────────────────────────────
export interface CommandCompletionItem {
  label: string;
  insertText: string;
  replaceStart: number;
  hint?: string;
  swatch?: string;
}

function formatTokenInsert(name: string): string {
  return /\s/.test(name) ? `"${name}" ` : `${name} `;
}

export function getCommandCompletions(input: string, ctx: CommandContext): CommandCompletionItem[] {
  if (!input || input.startsWith('?') || input.startsWith('？')) return [];

  // 只针对最后一个分号之后的当前子句做上下文补全
  let clauseStart = 0;
  for (let i = input.length - 1; i >= 0; i -= 1) {
    if (input[i] === ';' || input[i] === '；') {
      clauseStart = i + 1;
      break;
    }
  }
  const clause = input.slice(clauseStart);
  const leadingSpaces = clause.length - clause.trimStart().length;
  const trimmedStart = clause.trimStart();
  if (!trimmedStart) return [];

  const trailingSpace = /\s$/.test(clause);
  const tokens = tokenize(clause);
  if (tokens.length === 0) return [];

  const verb = tokens[0].value.toLowerCase();
  if (verb === 'ai' || verb === 'ask') return [];

  // 正在输入第 1 个词（动作动词）
  if (tokens.length === 1 && !trailingSpace) {
    const prefix = verb;
    return COMMAND_VERBS.filter((v) => v.startsWith(prefix) && v !== prefix)
      .slice(0, 8)
      .map((v) => ({
        label: v,
        insertText: `${v} `,
        replaceStart: clauseStart + leadingSpaces,
        hint: VERB_HINTS[v]
      }));
  }

  const argIndex = trailingSpace ? tokens.length - 1 : tokens.length - 2;
  const activeTok = trailingSpace ? null : tokens[tokens.length - 1];
  const prefix = (activeTok?.value || '').toLowerCase();
  const replaceStart = activeTok ? clauseStart + activeTok.start : input.length;

  const matchLines = (): CommandCompletionItem[] =>
    ctx.lines
      .filter((l) => !prefix || l.name.toLowerCase().includes(prefix))
      .slice(0, 7)
      .map((l) => ({
        label: l.name,
        insertText: formatTokenInsert(l.name),
        replaceStart,
        swatch: l.color,
        hint: `${l.stationIds.length}站`
      }));

  const matchStations = (): CommandCompletionItem[] =>
    ctx.stations
      .filter((s) => !prefix || s.name.toLowerCase().includes(prefix))
      .slice(0, 8)
      .map((s) => ({
        label: s.name,
        insertText: formatTokenInsert(s.name),
        replaceStart
      }));

  const matchColors = (): CommandCompletionItem[] =>
    Object.entries(NAMED_COLORS)
      .filter(([name]) => !prefix || name.startsWith(prefix))
      .map(([name, hex]) => ({
        label: name,
        insertText: `${name} `,
        replaceStart,
        swatch: hex
      }));

  const matchKeywords = (items: Array<{ word: string; hint?: string }>): CommandCompletionItem[] =>
    items
      .filter((it) => !prefix || it.word.startsWith(prefix))
      .filter((it) => it.word !== prefix)
      .map((it) => ({
        label: it.word,
        insertText: `${it.word} `,
        replaceStart,
        hint: it.hint
      }));

  // 按动词与参数槽位精准派发候选
  if (verb === 'select' || verb === 'close') {
    if (argIndex === 0) return matchLines();
  } else if (verb === 'recolor') {
    if (argIndex === 0) return matchLines();
    if (argIndex === 1) return matchColors();
  } else if (verb === 'loop') {
    if (argIndex === 1) return matchColors();
    if (argIndex >= 2) return matchStations();
  } else if (verb === 'line') {
    if (argIndex === 0) return matchLines();
    if (argIndex === 1) {
      return [
        ...matchKeywords([{ word: 'connect', hint: '连接已有站' }]),
        ...matchColors().slice(0, 6)
      ];
    }
    if (argIndex >= 2) return matchStations();
  } else if (verb === 'create') {
    if (argIndex === 0) {
      return matchKeywords([
        { word: 'line', hint: '新建干线' },
        { word: 'loop', hint: '新建环线' }
      ]);
    }
    if (argIndex === 2) return matchColors();
    if (argIndex >= 3) return matchStations();
  } else if (verb === 'extend' || verb === 'attach') {
    if (argIndex === 0) return matchLines();
    if (argIndex === 1) {
      return matchKeywords([
        { word: 'end', hint: '终点向外' },
        { word: 'start', hint: '起点向外' }
      ]);
    }
    if (verb === 'attach' && argIndex === 2) return matchStations();
  } else if (verb === 'branch') {
    if (argIndex === 0) {
      return [...matchKeywords([{ word: 'from', hint: '从当前线分叉' }]), ...matchLines()];
    }
    const prevWord = tokens[argIndex]?.value?.toLowerCase();
    if (prevWord === 'from') return matchStations();
    if (argIndex === 1 && tokens[1]?.value?.toLowerCase() !== 'from') {
      return matchKeywords([{ word: 'from', hint: '指定分叉站' }]);
    }
  } else if (verb === 'connect' || verb === 'merge' || verb === 'center') {
    return matchStations();
  } else if (verb === 'insert') {
    if (argIndex === 0) return matchLines();
    if (argIndex === 1) return matchKeywords([{ word: 'between', hint: '两站之间' }]);
    if (argIndex === 2 || argIndex === 3) return matchStations();
  } else if (verb === 'swap') {
    if (argIndex === 0) return matchLines();
    if (argIndex === 1 || argIndex === 2) return matchStations();
  } else if (verb === 'delete' || verb === 'rename') {
    if (argIndex === 0) {
      return matchKeywords([
        { word: 'line', hint: '操作线路' },
        { word: 'station', hint: '操作站点' }
      ]);
    }
    if (argIndex === 1) {
      const targetKind = tokens[1]?.value?.toLowerCase();
      if (targetKind === 'line') return matchLines();
      if (targetKind === 'station') return matchStations();
    }
  } else if (verb === 'city' || verb === 'basemap') {
    if (argIndex === 0) {
      return matchKeywords([
        { word: 'river', hint: '穿城大江' },
        { word: 'confluence', hint: '两江交汇' },
        { word: 'bay', hint: '湾区海港' },
        { word: 'ring', hint: '平原环城' },
        { word: 'delta', hint: '河网水乡' },
        { word: 'lake', hint: '湖山新城' },
        { word: 'shuffle', hint: '随机换城' },
        { word: 'plain', hint: '纯画布' }
      ]);
    }
  } else if (verb === 'preset') {
    if (argIndex === 0) {
      return matchKeywords([
        { word: 'modern', hint: '现代风格' },
        { word: 'classic', hint: '经典圆环' },
        { word: 'bold', hint: '粗体换乘' },
        { word: 'mtr', hint: '港铁管道' }
      ]);
    }
  } else if (verb === 'waypoints') {
    if (argIndex === 0) {
      return matchKeywords([
        { word: 'hide', hint: '默认隐藏控制柄' },
        { word: 'show', hint: '常显控制柄' }
      ]);
    }
  } else if (verb === 'theme') {
    if (argIndex === 0) {
      return matchKeywords([
        { word: 'light', hint: '浅色画布' },
        { word: 'dark', hint: '深色画布' }
      ]);
    }
  }

  return [];
}
