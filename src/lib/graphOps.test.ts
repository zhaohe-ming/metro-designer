import { deleteStationFromGraph, MapGraph } from './graphOps';
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
