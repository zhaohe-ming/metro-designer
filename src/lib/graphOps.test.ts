import {
  connectStationsOnLine,
  deleteStationFromGraph,
  deriveLineTopology,
  insertStationOnSection,
  MapGraph,
  mergeStationsIntoInterchange,
  removeStationFromLine,
  reorderLineStations
} from './graphOps';
import { Line, Section, Station } from '../types';

// ── 测试夹具构造器 ─────────────────────────────────────────────────────────
const station = (id: string, x = 0, y = 0, extra: Partial<Station> = {}): Station => ({
  id,
  name: id.toUpperCase(),
  x,
  y,
  ...extra
});

const section = (
  id: string,
  lineId: string,
  startStationId: string,
  endStationId: string,
  extra: Partial<Section> = {}
): Section => ({ id, lineId, startStationId, endStationId, ...extra });

// 按站序生成一条直线线路 + 对应的相邻区间。
function linearLine(lineId: string, stationIds: string[]): { line: Line; sections: Section[] } {
  const sections: Section[] = [];
  const sectionIds: string[] = [];
  for (let i = 0; i < stationIds.length - 1; i += 1) {
    const sid = `${lineId}_sec${i}`;
    sectionIds.push(sid);
    sections.push(section(sid, lineId, stationIds[i], stationIds[i + 1]));
  }
  return { line: { id: lineId, name: lineId, color: '#1890ff', stationIds: [...stationIds], sectionIds }, sections };
}

const idSet = (s: Section) => new Set([s.startStationId, s.endStationId]);

describe('deleteStationFromGraph', () => {
  it('删中间站时用一条新区间缝合前后邻站，线路保持连通', () => {
    const { line, sections } = linearLine('L1', ['s1', 's2', 's3']);
    const graph: MapGraph = { lines: [line], stations: ['s1', 's2', 's3'].map((id) => station(id)), sections };

    const next = deleteStationFromGraph('s2', graph);

    expect(next.stations.map((s) => s.id)).toEqual(['s1', 's3']);
    const l = next.lines[0];
    expect(l.stationIds).toEqual(['s1', 's3']);
    expect(l.sectionIds).toHaveLength(1);
    expect(next.sections).toHaveLength(1); // 旧两段移除、缝合段加入
    expect(idSet(next.sections[0])).toEqual(new Set(['s1', 's3']));
  });

  it('删首端点站：不缝合，只移除站点和它那一条区间', () => {
    const { line, sections } = linearLine('L1', ['s1', 's2', 's3']);
    const graph: MapGraph = { lines: [line], stations: ['s1', 's2', 's3'].map((id) => station(id)), sections };

    const next = deleteStationFromGraph('s1', graph);

    expect(next.lines[0].stationIds).toEqual(['s2', 's3']);
    expect(next.sections).toHaveLength(1);
    expect(idSet(next.sections[0])).toEqual(new Set(['s2', 's3']));
  });

  it('删末端点站：不缝合', () => {
    const { line, sections } = linearLine('L1', ['s1', 's2', 's3']);
    const graph: MapGraph = { lines: [line], stations: ['s1', 's2', 's3'].map((id) => station(id)), sections };

    const next = deleteStationFromGraph('s3', graph);

    expect(next.lines[0].stationIds).toEqual(['s1', 's2']);
    expect(next.sections).toHaveLength(1);
    expect(idSet(next.sections[0])).toEqual(new Set(['s1', 's2']));
  });

  it('两站线路删掉一站 → 剩 1 站 0 区间', () => {
    const { line, sections } = linearLine('L1', ['s1', 's2']);
    const graph: MapGraph = { lines: [line], stations: ['s1', 's2'].map((id) => station(id)), sections };

    const next = deleteStationFromGraph('s2', graph);

    expect(next.lines[0].stationIds).toEqual(['s1']);
    expect(next.lines[0].sectionIds).toEqual([]);
    expect(next.sections).toEqual([]);
  });

  it('换乘站：每条经过它的线路都各自缝合', () => {
    const a = linearLine('LA', ['s1', 'x', 's2']);
    const b = linearLine('LB', ['s3', 'x', 's4']);
    const graph: MapGraph = {
      lines: [a.line, b.line],
      stations: ['s1', 's2', 's3', 's4', 'x'].map((id) => station(id)),
      sections: [...a.sections, ...b.sections]
    };

    const next = deleteStationFromGraph('x', graph);

    expect(next.stations.find((s) => s.id === 'x')).toBeUndefined();
    const la = next.lines.find((l) => l.id === 'LA')!;
    const lb = next.lines.find((l) => l.id === 'LB')!;
    expect(la.stationIds).toEqual(['s1', 's2']);
    expect(lb.stationIds).toEqual(['s3', 's4']);
    expect(la.sectionIds).toHaveLength(1);
    expect(lb.sectionIds).toHaveLength(1);
    expect(next.sections).toHaveLength(2); // 两条缝合段，原四段全部移除
  });

  it('删一个不在任何线路上的孤立站点：只移除站点，区间/线路不变', () => {
    const { line, sections } = linearLine('L1', ['s1', 's2']);
    const graph: MapGraph = {
      lines: [line],
      stations: ['s1', 's2', 'orphan'].map((id) => station(id)),
      sections
    };

    const next = deleteStationFromGraph('orphan', graph);

    expect(next.stations.map((s) => s.id).sort()).toEqual(['s1', 's2']);
    expect(next.sections).toEqual(sections);
    expect(next.lines[0]).toEqual(line);
  });

  it('缝合段按 prev → next 顺序拼接两段途经点', () => {
    const s12 = section('sec12', 'L1', 's1', 's2', { waypoints: [{ x: 10, y: 0 }] });
    const s23 = section('sec23', 'L1', 's2', 's3', { waypoints: [{ x: 20, y: 0 }] });
    const line: Line = { id: 'L1', name: 'L1', color: '#1890ff', stationIds: ['s1', 's2', 's3'], sectionIds: ['sec12', 'sec23'] };
    const graph: MapGraph = { lines: [line], stations: ['s1', 's2', 's3'].map((id) => station(id)), sections: [s12, s23] };

    const next = deleteStationFromGraph('s2', graph);

    expect(next.sections).toHaveLength(1);
    expect(next.sections[0].waypoints).toEqual([{ x: 10, y: 0 }, { x: 20, y: 0 }]);
  });

  it('某段以 end→start 反向存储时，途经点会被正确反转对齐到 prev → next 方向', () => {
    // sec12 反向存储为 s2 → s1
    const s12 = section('sec12', 'L1', 's2', 's1', { waypoints: [{ x: 10, y: 1 }, { x: 11, y: 2 }] });
    const s23 = section('sec23', 'L1', 's2', 's3', { waypoints: [{ x: 20, y: 0 }] });
    const line: Line = { id: 'L1', name: 'L1', color: '#1890ff', stationIds: ['s1', 's2', 's3'], sectionIds: ['sec12', 'sec23'] };
    const graph: MapGraph = { lines: [line], stations: ['s1', 's2', 's3'].map((id) => station(id)), sections: [s12, s23] };

    const next = deleteStationFromGraph('s2', graph);
    const bridge = next.sections[0];

    expect(bridge.startStationId).toBe('s1');
    expect(bridge.endStationId).toBe('s3');
    // s1→s2 段需反转：[{11,2},{10,1}]，再接 s2→s3 段 [{20,0}]
    expect(bridge.waypoints).toEqual([{ x: 11, y: 2 }, { x: 10, y: 1 }, { x: 20, y: 0 }]);
  });

  it('在更长线路的中部删站时保持区间顺序', () => {
    const { line, sections } = linearLine('L1', ['s1', 's2', 's3', 's4', 's5']);
    const graph: MapGraph = { lines: [line], stations: ['s1', 's2', 's3', 's4', 's5'].map((id) => station(id)), sections };

    const next = deleteStationFromGraph('s3', graph);
    const l = next.lines[0];

    expect(l.stationIds).toEqual(['s1', 's2', 's4', 's5']);
    expect(l.sectionIds).toHaveLength(3);
    expect(l.sectionIds[0]).toBe('L1_sec0'); // s1-s2 原样
    expect(l.sectionIds[2]).toBe('L1_sec3'); // s4-s5 原样
    const mid = next.sections.find((s) => s.id === l.sectionIds[1])!;
    expect(idSet(mid)).toEqual(new Set(['s2', 's4'])); // 中间是缝合段
  });

  it('不修改入参（纯函数）', () => {
    const { line, sections } = linearLine('L1', ['s1', 's2', 's3']);
    const graph: MapGraph = { lines: [line], stations: ['s1', 's2', 's3'].map((id) => station(id)), sections };
    const snapshot = JSON.stringify(graph);

    deleteStationFromGraph('s2', graph);

    expect(JSON.stringify(graph)).toEqual(snapshot);
  });
});

describe('core topology transactions (connect / loop / branch / insert / removeFromLine / merge)', () => {
  it('connectStationsOnLine preserves existing stations and detects loop closure', () => {
    const { line, sections } = linearLine('L1', ['s1', 's2', 's3']);
    const stations = ['s1', 's2', 's3', 's4'].map((id, i) => station(id, i * 50, 0));
    const g0: MapGraph = { lines: [line], stations, sections };

    // 从首站 s1 向另一端 s4 延伸：s4 排到队首且原 s1,s2,s3 绝不丢失
    const step1 = connectStationsOnLine(g0, { lineId: 'L1', fromStationId: 's1', toStationId: 's4' });
    expect(step1.closedLoop).toBe(false);
    expect(step1.graph.lines[0].stationIds).toEqual(['s4', 's1', 's2', 's3']);

    // 再从 s3 连回 s4 闭合为环线
    const step2 = connectStationsOnLine(step1.graph, { lineId: 'L1', fromStationId: 's3', toStationId: 's4' });
    expect(step2.closedLoop).toBe(true);
    const meta = deriveLineTopology(step2.graph.lines[0], step2.graph.sections);
    expect(meta.isLoop).toBe(true);
    expect(meta.terminalStationIds).toEqual([]);
  });

  it('supports Y-branch lines without losing any branch stations', () => {
    const { line, sections } = linearLine('L1', ['s1', 's2', 's3']);
    const stations = ['s1', 's2', 's3', 'b1', 'b2'].map((id) => station(id));
    let g: MapGraph = { lines: [line], stations, sections };
    g = connectStationsOnLine(g, { lineId: 'L1', fromStationId: 's2', toStationId: 'b1' }).graph;
    g = connectStationsOnLine(g, { lineId: 'L1', fromStationId: 'b1', toStationId: 'b2' }).graph;

    const meta = deriveLineTopology(g.lines[0], g.sections);
    expect(meta.hasBranch).toBe(true);
    expect(new Set(g.lines[0].stationIds)).toEqual(new Set(['s1', 's2', 's3', 'b1', 'b2']));
    expect(new Set(meta.terminalStationIds)).toEqual(new Set(['s1', 's3', 'b2']));
  });

  it('insertStationOnSection splits section and partitions waypoints accurately', () => {
    const sec = section('sec1', 'L1', 's1', 's2', {
      waypoints: [{ x: 40, y: 20 }, { x: 160, y: 20 }]
    });
    const l1: Line = { id: 'L1', name: '1号线', color: '#f00', stationIds: ['s1', 's2'], sectionIds: ['sec1'] };
    const g0: MapGraph = {
      lines: [l1],
      stations: [station('s1', 0, 0), station('s2', 200, 0)],
      sections: [sec]
    };

    const g1 = insertStationOnSection(g0, {
      sectionId: 'sec1',
      station: station('s_mid', 100, 20)
    });

    expect(g1.lines[0].stationIds).toEqual(['s1', 's_mid', 's2']);
    expect(g1.sections).toHaveLength(2);
    const first = g1.sections.find((s) => s.startStationId === 's1')!;
    const second = g1.sections.find((s) => s.endStationId === 's2')!;
    expect(first.waypoints).toEqual([{ x: 40, y: 20 }]);
    expect(second.waypoints).toEqual([{ x: 160, y: 20 }]);
  });

  it('removeStationFromLine stitches middle station instead of breaking line in half', () => {
    const { line, sections } = linearLine('L1', ['s1', 's2', 's3']);
    const g0: MapGraph = { lines: [line], stations: ['s1', 's2', 's3'].map((id) => station(id)), sections };
    const g1 = removeStationFromLine(g0, 'L1', 's2');

    expect(g1.lines[0].stationIds).toEqual(['s1', 's3']);
    expect(g1.sections).toHaveLength(1);
    expect(idSet(g1.sections[0])).toEqual(new Set(['s1', 's3']));
    // 站点实体本身仍保留在画布中（只是移出该线路）
    expect(g1.stations).toHaveLength(3);
  });

  it('reorderLineStations rebuilds sections to match new station order', () => {
    const { line, sections } = linearLine('L1', ['s1', 's2', 's3']);
    const g0: MapGraph = { lines: [line], stations: ['s1', 's2', 's3'].map((id) => station(id)), sections };
    const g1 = reorderLineStations(g0, 'L1', ['s1', 's3', 's2']);
    expect(g1.lines[0].stationIds).toEqual(['s1', 's3', 's2']);
    expect(g1.sections.map((s) => `${s.startStationId}->${s.endStationId}`)).toEqual(['s1->s3', 's3->s2']);
  });

  it('mergeStationsIntoInterchange merges two stations cleanly into a transfer hub', () => {
    const a = linearLine('L1', ['s1', 'hubA', 's2']);
    const b = linearLine('L2', ['s3', 'hubB', 's4']);
    const g0: MapGraph = {
      lines: [a.line, b.line],
      stations: ['s1', 'hubA', 's2', 's3', 'hubB', 's4'].map((id) => station(id)),
      sections: [...a.sections, ...b.sections]
    };
    const g1 = mergeStationsIntoInterchange(g0, 'hubB', 'hubA');
    expect(g1.stations.some((s) => s.id === 'hubB')).toBe(false);
    expect(g1.lines.find((l) => l.id === 'L2')!.stationIds).toEqual(['s3', 'hubA', 's4']);
  });
});
