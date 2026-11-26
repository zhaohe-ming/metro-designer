import { DEFAULT_MAP_SETTINGS } from '../types';
import { insertStationOnSection, MapGraph, reconcileGraph } from '../lib/graphOps';
import { parseMetroProjectJson, serializeMetroProject } from '../lib/projectFile';
import { calibrateMetersPerUnitBetweenPoints, computeNetworkMileageSummary, haversineMeters } from './distance';
import { solveServiceKinematics } from './kinematics';
import {
  buildOrderedLineSteps,
  createAllSubCorridorPatternsForLine,
  createLineAllStopPattern,
  createLineExpressPattern,
  decomposeLineIntoSubCorridors,
  reconcileProOps
} from './reconcile';
import { buildCorridorDiagramModel, buildServiceDiagramSvg } from './corridorDiagram';
import {
  buildMareyDiagramModel,
  buildMareyDiagramSvg,
  computeLiveTrainSnapshots,
  recommendOptimalPhaseOffset,
  solveNetworkTimetable
} from './timetable';
import { createEmptyProOpsDocument, normalizeProOpsDocument, ProOpsDocument, ProServicePattern } from './types';

function createFourStationLinearGraph(): MapGraph {
  // 4 座间距各 1500m（60 单位 × 25 m/单位 = 1500m）的车站：A - B - C - D
  return reconcileGraph({
    stations: [
      { id: 's_a', name: '西园', x: 0, y: 0 },
      { id: 's_b', name: '春晓', x: 60, y: 0 },
      { id: 's_c', name: '大学城', x: 120, y: 0 },
      { id: 's_d', name: '东岸', x: 180, y: 0 }
    ],
    sections: [
      { id: 'sec_ab', lineId: 'L1', startStationId: 's_a', endStationId: 's_b' },
      { id: 'sec_bc', lineId: 'L1', startStationId: 's_b', endStationId: 's_c' },
      { id: 'sec_cd', lineId: 'L1', startStationId: 's_c', endStationId: 's_d' }
    ],
    lines: [
      {
        id: 'L1',
        name: '1号线',
        color: '#2563eb',
        stationIds: ['s_a', 's_b', 's_c', 's_d'],
        sectionIds: ['sec_ab', 'sec_bc', 'sec_cd']
      }
    ]
  });
}

describe('Pro Operations Mode Phase 1 Engine & Isolation', () => {
  test('continuous velocity envelope solver keeps speed across skipped stations without false stop/start penalty', () => {
    const graph = createFourStationLinearGraph();
    const doc = createEmptyProOpsDocument();
    doc.lineSpecs.L1 = {
      rollingStock: '4D',
      carCapacity: 1200,
      maxSpeedKmh: 120,
      accelMps2: 1.0,
      decelMps2: 1.0,
      turnbackSec: 150
    };

    const local = createLineAllStopPattern(graph, 'L1')!;
    const express = createLineExpressPattern(graph, 'L1')!;
    // 强制大站快车：A停 -> B越 -> C越 -> D停
    express.routeSteps = express.routeSteps.map((s, idx, arr) => ({
      ...s,
      stopAtEnd: idx === arr.length - 1
    }));

    doc.servicePatterns = [local, express];
    const { proOps, validations } = reconcileProOps(graph, doc);

    const localKin = solveServiceKinematics(graph, proOps, proOps.servicePatterns[0], validations[local.id], false);
    const expressKin = solveServiceKinematics(graph, proOps, proOps.servicePatterns[1], validations[express.id], false);

    // 慢车 3 段独立起停 (3 * 78.33s = 235s) + 2 个中间站各 30s 停站 = 295s
    expect(localKin.pureRunSec).toBeCloseTo(235.0, 0);
    expect(localKin.oneWayTravelSec).toBeCloseTo(295.0, 0);

    // 快车连续越过 B、C 不减速至 0：以 120km/h 高速直接通过 B、C，总用时约 168.3s（比慢车纯运行 235s 还快 66.7s！）
    expect(expressKin.visits[1].isStop).toBe(false);
    expect(expressKin.visits[1].passSpeedKmh).toBeCloseTo(120, 0);
    expect(expressKin.visits[2].isStop).toBe(false);
    expect(expressKin.visits[2].passSpeedKmh).toBeCloseTo(120, 0);
    expect(expressKin.oneWayTravelSec).toBeCloseTo(168.3, 0);
    expect(expressKin.oneWayTravelSec).toBeLessThan(localKin.pureRunSec - 60);
  });

  test('piecewise speed restriction smoothly brakes before restricted middle section', () => {
    const graph = createFourStationLinearGraph();
    const doc = createEmptyProOpsDocument();
    doc.lineSpecs.L1 = {
      rollingStock: '4D',
      carCapacity: 1200,
      maxSpeedKmh: 120,
      accelMps2: 1.0,
      decelMps2: 1.0,
      turnbackSec: 150
    };
    // 中间区间 B-C 限速 60 km/h
    doc.sectionOverrides.sec_bc = { speedLimitKmh: 60 };

    const express = createLineAllStopPattern(graph, 'L1')!;
    express.routeSteps = express.routeSteps.map((s, idx, arr) => ({
      ...s,
      stopAtEnd: idx === arr.length - 1
    }));
    doc.servicePatterns = [express];

    const { proOps, validations } = reconcileProOps(graph, doc);
    const kin = solveServiceKinematics(graph, proOps, proOps.servicePatterns[0], validations[express.id], false);

    // 进入限速区间 B 站时的通过速度已被后向制动包络压制在 <= 60 km/h
    expect(kin.visits[1].passSpeedKmh).toBeLessThanOrEqual(60.1);
    expect(kin.visits[2].passSpeedKmh).toBeLessThanOrEqual(60.1);
    expect(kin.segments[0].peakSpeedKmh).toBeGreaterThan(95);
  });

  test('per-visit stopAtEnd handles 6-shaped / loop repeated station visits independently', () => {
    // 6 字线：A -> B -> C -> D -> B -> A（B 站经过两次：第一次越站，第二次停靠）
    const graph = reconcileGraph({
      stations: [
        { id: 's_a', name: '西门', x: 0, y: 0 },
        { id: 's_b', name: '枢纽站', x: 50, y: 0 },
        { id: 's_c', name: '北环', x: 100, y: -40 },
        { id: 's_d', name: '南环', x: 100, y: 40 }
      ],
      sections: [
        { id: 'sec_ab', lineId: 'L6', startStationId: 's_a', endStationId: 's_b' },
        { id: 'sec_bc', lineId: 'L6', startStationId: 's_b', endStationId: 's_c' },
        { id: 'sec_cd', lineId: 'L6', startStationId: 's_c', endStationId: 's_d' },
        { id: 'sec_db', lineId: 'L6', startStationId: 's_d', endStationId: 's_b' }
      ],
      lines: [
        {
          id: 'L6',
          name: '6号线',
          color: '#7c3aed',
          stationIds: ['s_a', 's_b', 's_c', 's_d'],
          sectionIds: ['sec_ab', 'sec_bc', 'sec_cd', 'sec_db']
        }
      ]
    });

    const pattern: ProServicePattern = {
      id: 'pat_6',
      name: '6字环快线',
      code: '环快',
      color: '#7c3aed',
      category: 'express',
      stopAtStart: true,
      headwaySec: 300,
      bidirectional: false,
      routeSteps: [
        { kind: 'section', sectionId: 'sec_ab', lineId: 'L6', fromStationId: 's_a', toStationId: 's_b', stopAtEnd: false },
        { kind: 'section', sectionId: 'sec_bc', lineId: 'L6', fromStationId: 's_b', toStationId: 's_c', stopAtEnd: true },
        { kind: 'section', sectionId: 'sec_cd', lineId: 'L6', fromStationId: 's_c', toStationId: 's_d', stopAtEnd: false },
        { kind: 'section', sectionId: 'sec_db', lineId: 'L6', fromStationId: 's_d', toStationId: 's_b', stopAtEnd: true },
        { kind: 'section', sectionId: 'sec_ab', lineId: 'L6', fromStationId: 's_b', toStationId: 's_a', stopAtEnd: true }
      ]
    };

    const doc = createEmptyProOpsDocument();
    doc.servicePatterns = [pattern];

    const { proOps, validations } = reconcileProOps(graph, doc);
    expect(validations.pat_6.status).toBe('valid');

    const kin = solveServiceKinematics(graph, proOps, proOps.servicePatterns[0], validations.pat_6, false);
    // visits[1] 是第一次经过 s_b（越站），visits[4] 是第二次经过 s_b（停靠）
    expect(kin.visits[1].stationId).toBe('s_b');
    expect(kin.visits[1].isStop).toBe(false);
    expect(kin.visits[1].passSpeedKmh).toBeGreaterThan(40);

    expect(kin.visits[4].stationId).toBe('s_b');
    expect(kin.visits[4].isStop).toBe(true);
    expect(kin.visits[4].dwellSec).toBeGreaterThan(0);
  });

  test('shared interchange station is NOT treated as track-connected without explicit ProTrackConnection', () => {
    const graph = reconcileGraph({
      stations: [
        { id: 's1', name: '起点1', x: 0, y: 0 },
        { id: 's_hub', name: '人民广场', x: 60, y: 0 },
        { id: 's2', name: '终点2', x: 120, y: 0 }
      ],
      sections: [
        { id: 'sec_1', lineId: 'L1', startStationId: 's1', endStationId: 's_hub' },
        { id: 'sec_2', lineId: 'L2', startStationId: 's_hub', endStationId: 's2' }
      ],
      lines: [
        { id: 'L1', name: '1号线', color: '#2563eb', stationIds: ['s1', 's_hub'], sectionIds: ['sec_1'] },
        { id: 'L2', name: '2号线', color: '#10b981', stationIds: ['s_hub', 's2'], sectionIds: ['sec_2'] }
      ]
    });

    // 未配置跨线道岔直接拼接两线区间 -> 必须判定为 broken
    const illegalThrough: ProServicePattern = {
      id: 'pat_illegal',
      name: '未授权跨线',
      code: '跨线',
      color: '#7c3aed',
      category: 'through',
      stopAtStart: true,
      headwaySec: 300,
      bidirectional: true,
      routeSteps: [
        { kind: 'section', sectionId: 'sec_1', lineId: 'L1', fromStationId: 's1', toStationId: 's_hub', stopAtEnd: true },
        { kind: 'section', sectionId: 'sec_2', lineId: 'L2', fromStationId: 's_hub', toStationId: 's2', stopAtEnd: true }
      ]
    };

    const doc = createEmptyProOpsDocument();
    doc.servicePatterns = [illegalThrough];
    const badCheck = reconcileProOps(graph, doc);
    expect(badCheck.validations.pat_illegal.status).toBe('broken');
    expect(badCheck.validations.pat_illegal.issues.some((i) => i.code === 'discontinuity')).toBe(true);

    // 显式添加同站跨线道岔并接入交路 -> 变为 valid
    doc.trackConnections = [
      {
        id: 'conn_hub',
        name: '人民广场 1-2道岔',
        kind: 'same_station_junction',
        fromLineId: 'L1',
        fromStationId: 's_hub',
        toLineId: 'L2',
        toStationId: 's_hub',
        distanceMeters: 180,
        speedLimitKmh: 45,
        bidirectional: true
      }
    ];
    doc.servicePatterns = [
      {
        ...illegalThrough,
        id: 'pat_legal',
        routeSteps: [
          { kind: 'section', sectionId: 'sec_1', lineId: 'L1', fromStationId: 's1', toStationId: 's_hub', stopAtEnd: true },
          { kind: 'connection', connectionId: 'conn_hub', fromLineId: 'L1', fromStationId: 's_hub', toLineId: 'L2', toStationId: 's_hub', stopAtEnd: true },
          { kind: 'section', sectionId: 'sec_2', lineId: 'L2', fromStationId: 's_hub', toStationId: 's2', stopAtEnd: true }
        ]
      }
    ];

    const goodCheck = reconcileProOps(graph, doc);
    expect(goodCheck.validations.pat_legal.status).toBe('valid');
    const kin = solveServiceKinematics(graph, goodCheck.proOps, goodCheck.proOps.servicePatterns[0], goodCheck.validations.pat_legal, false);
    expect(kin.status).toBe('valid');
    // 同站道岔不会产生重复乘客站名列，总访问站数仍为 3 座（起点1 -> 人民广场 -> 终点2）
    expect(kin.visits).toHaveLength(3);
    expect(kin.visits[1].switchedToLineName).toBe('2号线');
  });

  test('reconcileProOps heals deterministic interval split and degrades to broken without deleting on loop ambiguity', () => {
    const baseGraph = createFourStationLinearGraph();
    const local = createLineAllStopPattern(baseGraph, 'L1')!;
    const express = createLineExpressPattern(baseGraph, 'L1')!;
    express.routeSteps = express.routeSteps.map((s, idx, arr) => ({ ...s, stopAtEnd: idx === arr.length - 1 }));

    const doc: ProOpsDocument = {
      ...createEmptyProOpsDocument(),
      servicePatterns: [local, express]
    };

    // 1) 在 sec_bc 之间插入新站 s_mid -> 确定性裂变自愈
    const splitGraph = insertStationOnSection(baseGraph, {
      sectionId: 'sec_bc',
      station: { id: 's_mid', name: '科技园', x: 90, y: 0 }
    });
    const healed = reconcileProOps(splitGraph, doc);
    expect(healed.validations[local.id].status).toBe('valid');
    expect(healed.validations[local.id].healedSplitCount).toBe(1);
    expect(healed.proOps.servicePatterns[0].routeSteps).toHaveLength(4);
    // 普通车对新插中间站默认停靠，快车默认越站
    expect(healed.proOps.servicePatterns[0].routeSteps[1].stopAtEnd).toBe(true);
    expect(healed.proOps.servicePatterns[1].routeSteps[1].stopAtEnd).toBe(false);

    // 2) 环线删掉某段区间时：绝不反向绕环盲猜，也绝不静默删除交路，而是保留并标为 broken
    const loopGraph = reconcileGraph({
      stations: [
        { id: 'a', name: 'A站', x: 0, y: 0 },
        { id: 'b', name: 'B站', x: 50, y: 0 },
        { id: 'c', name: 'C站', x: 50, y: 50 },
        { id: 'd', name: 'D站', x: 0, y: 50 }
      ],
      sections: [
        { id: 'ab', lineId: 'LP', startStationId: 'a', endStationId: 'b' },
        { id: 'bc', lineId: 'LP', startStationId: 'b', endStationId: 'c' },
        { id: 'cd', lineId: 'LP', startStationId: 'c', endStationId: 'd' },
        { id: 'da', lineId: 'LP', startStationId: 'd', endStationId: 'a' }
      ],
      lines: [{ id: 'LP', name: '环线', color: '#e11d48', stationIds: ['a', 'b', 'c', 'd'], sectionIds: ['ab', 'bc', 'cd', 'da'] }]
    });
    const loopPattern = createLineAllStopPattern(loopGraph, 'LP')!;
    const loopDoc: ProOpsDocument = {
      ...createEmptyProOpsDocument(),
      servicePatterns: [loopPattern]
    };

    // 用户在普通模式删掉了 ab 区间（环断开）
    const brokenLoopGraph = reconcileGraph({
      ...loopGraph,
      sections: loopGraph.sections.filter((s) => s.id !== 'ab')
    });
    const brokenCheck = reconcileProOps(brokenLoopGraph, loopDoc);
    expect(brokenCheck.proOps.servicePatterns).toHaveLength(1);
    expect(brokenCheck.validations[loopPattern.id].status).toBe('broken');
    expect(brokenCheck.validations[loopPattern.id].issues[0].message).toContain('A站 → B站');
  });

  test('.metro project serializer omits empty proOps and round-trips active proOps cleanly alongside 1D SVG export', () => {
    const graph = createFourStationLinearGraph();
    const plainJson = serializeMetroProject({
      name: '纯净线网',
      lines: graph.lines,
      stations: graph.stations,
      sections: graph.sections,
      mapSettings: DEFAULT_MAP_SETTINGS
    });
    expect(plainJson.includes('"proOps"')).toBe(false);

    const doc = createEmptyProOpsDocument();
    const local = createLineAllStopPattern(graph, 'L1')!;
    const express = createLineExpressPattern(graph, 'L1')!;
    doc.servicePatterns = [local, express];

    const withProJson = serializeMetroProject({
      name: '含运营线网',
      lines: graph.lines,
      stations: graph.stations,
      sections: graph.sections,
      mapSettings: DEFAULT_MAP_SETTINGS,
      proOps: doc
    });
    const parsed = parseMetroProjectJson(withProJson);
    expect(parsed.proOps?.servicePatterns).toHaveLength(2);

    const { proOps, validations } = reconcileProOps(graph, parsed.proOps!);
    const kinMap = Object.fromEntries(
      proOps.servicePatterns.map((p) => [
        p.id,
        solveServiceKinematics(graph, proOps, p, validations[p.id], false)
      ])
    );
    const diagram = buildCorridorDiagramModel({
      graph,
      proOps,
      validations,
      kinematicsMap: kinMap,
      isGeoMode: false,
      axisMode: 'line',
      targetLineId: 'L1'
    });
    expect(diagram.columns).toHaveLength(4);
    expect(diagram.rows).toHaveLength(2);

    const svg = buildServiceDiagramSvg(diagram, 'dark');
    expect(svg.startsWith('<?xml')).toBe(true);
    expect(svg).toContain('1号线');
    expect(svg).toContain('大站快车');

    expect(calibrateMetersPerUnitBetweenPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 2500)).toBe(25);
    expect(haversineMeters(116.39, 39.9, 116.4, 39.9)).toBeGreaterThan(800);
  });

  test('line corridor covers main trunk, Y-branches, multiple disconnected segments, loops, and zero parked scale', () => {
    // 同一条 1 号线同时包含：
    // - 分量1（主线 A-B-C + 支线 B-E-F）
    // - 分量2（独立东段 X-Y-Z）
    // - 孤立未连线站 U
    const complexGraph: MapGraph = {
      stations: [
        { id: 'A', name: '西园', x: 0, y: 0 },
        { id: 'B', name: '科技园', x: 40, y: 0 },
        { id: 'C', name: '东岸', x: 80, y: 0 },
        { id: 'E', name: '空港北', x: 40, y: -40 },
        { id: 'F', name: '航站楼', x: 80, y: -40 },
        { id: 'X', name: '沙河', x: 200, y: 0 },
        { id: 'Y', name: '高教园', x: 240, y: 0 },
        { id: 'Z', name: '新城东', x: 280, y: 0 },
        { id: 'U', name: '远期预留站', x: 340, y: 0 }
      ],
      sections: [
        { id: 's_ab', lineId: 'L1', startStationId: 'A', endStationId: 'B' },
        { id: 's_bc', lineId: 'L1', startStationId: 'B', endStationId: 'C' },
        { id: 's_be', lineId: 'L1', startStationId: 'B', endStationId: 'E' },
        { id: 's_ef', lineId: 'L1', startStationId: 'E', endStationId: 'F' },
        { id: 's_xy', lineId: 'L1', startStationId: 'X', endStationId: 'Y' },
        { id: 's_yz', lineId: 'L1', startStationId: 'Y', endStationId: 'Z' }
      ],
      lines: [
        {
          id: 'L1',
          name: '1号线',
          color: '#2563eb',
          stationIds: ['A', 'B', 'C', 'E', 'F', 'X', 'Y', 'Z', 'U'],
          sectionIds: ['s_ab', 's_bc', 's_be', 's_ef', 's_xy', 's_yz']
        }
      ]
    };

    const subs = decomposeLineIntoSubCorridors(complexGraph, 'L1');
    // 包含：分量1主线、分量1支线、分量2独立区段、孤立站，共 4 个子走廊
    expect(subs.length).toBe(4);

    // 一键生成全线普通车自动覆盖主线、主支贯通与独立东段
    const allPatterns = createAllSubCorridorPatternsForLine(complexGraph, 'L1');
    expect(allPatterns.length).toBe(3);

    const doc = createEmptyProOpsDocument();
    doc.servicePatterns = allPatterns;
    const { proOps, validations } = reconcileProOps(complexGraph, doc);
    const kinMap = Object.fromEntries(
      proOps.servicePatterns.map((p) => [
        p.id,
        solveServiceKinematics(complexGraph, proOps, p, validations[p.id], false)
      ])
    );

    const model = buildCorridorDiagramModel({
      graph: complexGraph,
      proOps,
      validations,
      kinematicsMap: kinMap,
      isGeoMode: false,
      axisMode: 'line',
      targetLineId: 'L1'
    });

    // 全部 9 座唯一站点 100% 出现在走廊列中，无任何遗漏
    const uniqueColStations = new Set(model.columns.map((c) => c.stationId));
    expect(uniqueColStations.size).toBe(9);

    // 最长链 A-B-E-F(4站)被识别为主线（不点亮支线 C），而主支贯通 A-B-C 跨主干与支线两段色带（不点亮 E、F！）
    const mainTrunkRow = model.rows.find((r) => r.pattern.name.includes('主线'))!;
    const throughBranchRow = model.rows.find((r) => r.pattern.name.includes('主支贯通'))!;
    expect(mainTrunkRow).toBeDefined();
    expect(throughBranchRow).toBeDefined();
    expect(throughBranchRow.spans.length).toBe(2);
    const colC = model.columns.find((c) => c.stationId === 'C')!;
    const colE = model.columns.find((c) => c.stationId === 'E')!;
    const colF = model.columns.find((c) => c.stationId === 'F')!;
    expect(mainTrunkRow.cells[colC.colIndex].kind).toBe('none');
    expect(throughBranchRow.cells[colC.colIndex].kind).toBe('terminus');
    expect(throughBranchRow.cells[colE.colIndex].kind).toBe('none');
    expect(throughBranchRow.cells[colF.colIndex].kind).toBe('none');

    // 环线任意中间站始发（如从 C 出发 C -> D -> A -> B -> C）在闭合环走廊上精确映射为两段环绕色带
    const loopGraph = reconcileGraph({
      stations: [
        { id: 'a', name: 'A', x: 0, y: 0 },
        { id: 'b', name: 'B', x: 40, y: 0 },
        { id: 'c', name: 'C', x: 40, y: 40 },
        { id: 'd', name: 'D', x: 0, y: 40 }
      ],
      sections: [
        { id: 'ab', lineId: 'LP', startStationId: 'a', endStationId: 'b' },
        { id: 'bc', lineId: 'LP', startStationId: 'b', endStationId: 'c' },
        { id: 'cd', lineId: 'LP', startStationId: 'c', endStationId: 'd' },
        { id: 'da', lineId: 'LP', startStationId: 'd', endStationId: 'a' }
      ],
      lines: [{ id: 'LP', name: '环线', color: '#e11d48', stationIds: ['a', 'b', 'c', 'd'], sectionIds: ['ab', 'bc', 'cd', 'da'] }]
    });
    const midLoopSteps = buildOrderedLineSteps(loopGraph, 'LP', { startStationId: 'c', endStationId: 'c' });
    expect(midLoopSteps).toHaveLength(4);

    // 比例尺临时删空挂 0 时保持合法 0 值，不强制弹回 25 或 0.2
    const zeroNorm = normalizeProOpsDocument({ scaleConfig: { metersPerUnit: 0 } })!;
    expect(zeroNorm.scaleConfig.metersPerUnit).toBe(0);
    const zeroMileage = computeNetworkMileageSummary(complexGraph, zeroNorm, false);
    expect(zeroMileage.totalLineKm).toBe(0);
  });

  test('Phase 2 Marey timetable detects catch-up conflicts, auto-resolves via passing track hold, optimizes offset & interpolates live trains', () => {
    // 5 站干线（总长 6km，每段 1.5km）：S0 - S1 - S2 - S3 - S4
    const graph = reconcileGraph({
      stations: [
        { id: 'S0', name: '始发站', x: 0, y: 0 },
        { id: 'S1', name: '一站', x: 60, y: 0 },
        { id: 'S2', name: '中枢站', x: 120, y: 0 },
        { id: 'S3', name: '三站', x: 180, y: 0 },
        { id: 'S4', name: '终到站', x: 240, y: 0 }
      ],
      sections: [
        { id: 'e0', lineId: 'L1', startStationId: 'S0', endStationId: 'S1' },
        { id: 'e1', lineId: 'L1', startStationId: 'S1', endStationId: 'S2' },
        { id: 'e2', lineId: 'L1', startStationId: 'S2', endStationId: 'S3' },
        { id: 'e3', lineId: 'L1', startStationId: 'S3', endStationId: 'S4' }
      ],
      lines: [
        {
          id: 'L1',
          name: '1号线',
          color: '#2563eb',
          stationIds: ['S0', 'S1', 'S2', 'S3', 'S4'],
          sectionIds: ['e0', 'e1', 'e2', 'e3']
        }
      ]
    });

    const doc = createEmptyProOpsDocument();
    doc.lineSpecs.L1 = {
      rollingStock: '4D',
      carCapacity: 1200,
      maxSpeedKmh: 140,
      accelMps2: 1.0,
      decelMps2: 1.0,
      turnbackSec: 150,
      minHeadwaySec: 120
    };

    const local = createLineAllStopPattern(graph, 'L1')!;
    local.headwaySec = 600; // 每 10 分钟一班
    local.firstDepartureOffsetSec = 0;
    local.autoOvertake = true;
    local.bidirectional = false;

    const express = createLineAllStopPattern(graph, 'L1')!;
    express.id = 'pat_exp';
    express.name = '1号线直达快车';
    express.code = '快车';
    express.color = '#ea580c';
    express.category = 'express';
    express.headwaySec = 600;
    // 快车仅比慢车晚 120s 发车，中途全越站，必在后半程追上并超越慢车！
    express.firstDepartureOffsetSec = 120;
    express.autoOvertake = false;
    express.bidirectional = false;
    express.routeSteps = express.routeSteps.map((s, idx, arr) => ({
      ...s,
      stopAtEnd: idx === arr.length - 1
    }));

    doc.servicePatterns = [local, express];

    // 1) 未设越行站时：快车追上慢车，产生追踪冲突且给出建议设越行站的车站
    const state1 = reconcileProOps(graph, doc);
    const kinMap1 = Object.fromEntries(
      state1.proOps.servicePatterns.map((p) => [
        p.id,
        solveServiceKinematics(graph, state1.proOps, p, state1.validations[p.id], false)
      ])
    );
    const ttConflict = solveNetworkTimetable({
      graph,
      proOps: state1.proOps,
      validations: state1.validations,
      kinematicsMap: kinMap1,
      isGeoMode: false
    });
    expect(ttConflict.conflicts.length).toBeGreaterThan(0);
    expect(ttConflict.conflicts[0].suggestedPassingStationId).toBeDefined();
    expect(ttConflict.peakSectionTph).toBeCloseTo(12, 1);

    // 2) 智能错峰优化：即便不加越行线，在 10 分钟车隔下调整快车相位也能实现零冲突错峰
    const opt = recommendOptimalPhaseOffset({
      graph,
      proOps: state1.proOps,
      validations: state1.validations,
      kinematicsMap: kinMap1,
      targetPatternId: express.id,
      isGeoMode: false
    });
    expect(opt.conflictCount).toBe(0);

    // 3) 保持 120s 紧跟发车，但在中枢站 S2（及 S1）开启越行配线 -> 自动延长慢车停站待避，冲突清零！
    doc.stationProfiles.S1 = { hasPassingTrack: true };
    doc.stationProfiles.S2 = { hasPassingTrack: true };
    const state2 = reconcileProOps(graph, doc);
    const kinMap2 = Object.fromEntries(
      state2.proOps.servicePatterns.map((p) => [
        p.id,
        solveServiceKinematics(graph, state2.proOps, p, state2.validations[p.id], false)
      ])
    );
    const ttResolved = solveNetworkTimetable({
      graph,
      proOps: state2.proOps,
      validations: state2.validations,
      kinematicsMap: kinMap2,
      isGeoMode: false
    });
    expect(ttResolved.overtakes.length).toBeGreaterThan(0);
    expect(ttResolved.conflicts.length).toBe(0);

    // 4) 生成 Marey 斜线运行图模型、SVG 导出与实时列车位置快照（含 yielding 待避状态）
    const marey = buildMareyDiagramModel({
      graph,
      proOps: state2.proOps,
      timetable: ttResolved,
      isGeoMode: false,
      targetLineId: 'L1',
      directionFilter: 'both'
    });
    expect(marey.threads.length).toBeGreaterThan(4);
    expect(marey.markers.some((m) => m.kind === 'overtake')).toBe(true);

    const mareySvg = buildMareyDiagramSvg(marey, { theme: 'dark', zoomX: 1.5, playheadSec: ttResolved.overtakes[0].timeSec });
    expect(mareySvg.startsWith('<?xml')).toBe(true);
    expect(mareySvg).toContain('Marey Train Diagram');

    const snapsAtOvertake = computeLiveTrainSnapshots(ttResolved.trains, ttResolved.overtakes[0].timeSec);
    expect(snapsAtOvertake.length).toBeGreaterThanOrEqual(2);
    expect(snapsAtOvertake.some((s) => s.status === 'yielding' || s.status === 'dwelling')).toBe(true);
  });
});
