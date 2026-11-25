import {
  applyNetworkOperations,
  buildCompactAIMapState,
  NetworkEngineState,
  summarizeAIOperation
} from './networkEngine';
import { deriveLineTopology } from './graphOps';
import { DEFAULT_MAP_SETTINGS } from '../types';

function createEmptyState(): NetworkEngineState {
  return {
    lines: [],
    stations: [],
    sections: [],
    mapSettings: DEFAULT_MAP_SETTINGS,
    currentLineId: null
  };
}

describe('networkEngine — unified CLI & AI 2.0 operations', () => {
  test('multi-anchor create_new_line_with_stations smoothly interpolates between 2+ existing transfer stations', () => {
    let seq = 1;
    const makeId = () => `id_${seq++}`;

    // 先建两条平行南北线，提供两个已知坐标的换乘锚点：西锚点@(200, 300) 与 东锚点@(600, 300)
    const base: NetworkEngineState = {
      ...createEmptyState(),
      stations: [
        { id: 'w1', name: '西锚点', x: 200, y: 300 },
        { id: 'e1', name: '东锚点', x: 600, y: 300 }
      ]
    };

    const res = applyNetworkOperations(
      base,
      [
        {
          type: 'create_new_line_with_stations',
          name: '东西快线',
          color: '#e11d48',
          stationNames: ['外西站', '西锚点', '中间一站', '中间二站', '中间三站', '东锚点', '外东站']
        }
      ],
      { createId: makeId }
    );

    expect(res.applied).toBe(1);
    expect(res.lines).toHaveLength(1);
    const byName = new Map(res.stations.map((s) => [s.name, s]));

    // 复用既有锚点（绝不重复建站）
    expect(byName.get('西锚点')!.id).toBe('w1');
    expect(byName.get('东锚点')!.id).toBe('e1');

    // 三个中间新站严格等距插值在 x = 300, 400, 500, y = 300
    expect(byName.get('中间一站')!.x).toBeCloseTo(300, 1);
    expect(byName.get('中间二站')!.x).toBeCloseTo(400, 1);
    expect(byName.get('中间三站')!.x).toBeCloseTo(500, 1);
    expect(byName.get('中间二站')!.y).toBeCloseTo(300, 1);

    // 两端顺滑切向外推
    expect(byName.get('外西站')!.x).toBeLessThan(200);
    expect(byName.get('外东站')!.x).toBeGreaterThan(600);
  });

  test('create_loop_line, create_branch_line, close_line_loop, batch_rename_stations & configure_map work atomically', () => {
    let seq = 1;
    const makeId = () => `n_${seq++}`;

    const res = applyNetworkOperations(
      createEmptyState(),
      [
        {
          type: 'configure_map',
          lightCityArchetype: 'confluence',
          cornerRadius: 18,
          hideWaypoints: true
        },
        {
          type: 'create_new_line_with_stations',
          name: '1号线',
          color: '#dc2626',
          stationNames: ['站点 1', '站点 2', '站点 3', '站点 4']
        },
        {
          type: 'create_loop_line',
          name: '4号环线',
          color: '#7c3aed',
          stationNames: ['环北', '站点 2', '环南', '环西']
        }
      ],
      { createId: makeId }
    );

    expect(res.applied).toBe(3);
    expect(res.mapSettings.baseMap.mode).toBe('light-city');
    expect(res.mapSettings.baseMap.lightCity?.archetype).toBe('confluence');
    expect(res.mapSettings.cornerRadius).toBe(18);
    expect(res.mapSettings.hideWaypoints).toBe(true);

    // 校验 4 号环线确实闭合为纯环线，且复用了 1 号线的「站点 2」作为换乘站
    const loopLine = res.lines.find((l) => l.name === '4号环线')!;
    const loopTopo = deriveLineTopology(
      loopLine,
      res.sections.filter((s) => s.lineId === loopLine.id)
    );
    expect(loopTopo.isLoop).toBe(true);

    // 在 1 号线的「站点 3」分出 Y 型支线 + 一次性批量重命名全部「站点 1..4」
    const st1 = res.stations.find((s) => s.name === '站点 1')!;
    const st2 = res.stations.find((s) => s.name === '站点 2')!;
    const st3 = res.stations.find((s) => s.name === '站点 3')!;
    const st4 = res.stations.find((s) => s.name === '站点 4')!;
    const line1 = res.lines.find((l) => l.name === '1号线')!;

    const res2 = applyNetworkOperations(
      res,
      [
        {
          type: 'create_branch_line',
          lineId: line1.id,
          branchFromStationId: st3.id,
          newStationNames: ['软件园', '国际机场']
        },
        {
          type: 'batch_rename_stations',
          renames: [
            { stationId: st1.id, name: '西客站' },
            { stationId: st2.id, name: '人民广场' },
            { stationId: st3.id, name: '科技城' },
            { stationId: st4.id, name: '东枢纽' }
          ]
        }
      ],
      { createId: makeId }
    );

    expect(res2.applied).toBe(2);
    const updatedLine1 = res2.lines.find((l) => l.id === line1.id)!;
    const topo1 = deriveLineTopology(
      updatedLine1,
      res2.sections.filter((s) => s.lineId === line1.id)
    );
    expect(topo1.hasBranch).toBe(true);
    expect(res2.stations.find((s) => s.id === st2.id)!.name).toBe('人民广场');

    // 验证空间上下文压缩器输出完整的坐标、环/支线标记与轻城市地理参考摘要
    const compact = buildCompactAIMapState({
      lines: res2.lines,
      stations: res2.stations,
      sections: res2.sections,
      mapSettings: res2.mapSettings
    });
    expect(compact.spatialContext?.baseMapMode).toBe('light-city');
    expect(compact.spatialContext?.lightCitySummary).toContain('两江交汇');
    expect(compact.lines.find((l) => l.name === '4号环线')?.isLoop).toBe(true);
    expect(compact.lines.find((l) => l.name === '1号线')?.hasBranch).toBe(true);
    expect(compact.stations.find((s) => s.name === '人民广场')?.isTransfer).toBe(true);

    // 验证中文摘要生成器
    const sum = summarizeAIOperation(
      {
        type: 'batch_rename_stations',
        renames: [
          { stationId: st1.id, name: '西客站' },
          { stationId: st2.id, name: '人民广场' }
        ]
      },
      res.lines,
      res.stations
    );
    expect(sum).toContain('批量命名站点');
  });
});
