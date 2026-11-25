import {
  buildSectionRenderGeometry,
  computeDirectedParallelOffset,
  computeNetworkParallelLayout,
  findWaypointInsertIndex,
  moveLineInParallelOrder,
  offsetPolylinePoints
} from './offsetPath';
import { buildMetroSvg } from './exportSvg';
import { DEFAULT_MAP_SETTINGS } from '../types';

describe('computeDirectedParallelOffset', () => {
  it('fixes opposite-direction overlap: A->B and B->A receive opposite world-space shifts', () => {
    const d1 = computeDirectedParallelOffset('s1', 's2', 0, 2, 8);
    const d2 = computeDirectedParallelOffset('s2', 's1', 1, 2, 8);

    const line1Shifted = offsetPolylinePoints([{ x: 0, y: 0 }, { x: 100, y: 0 }], d1);
    const line2Shifted = offsetPolylinePoints([{ x: 100, y: 0 }, { x: 0, y: 0 }], d2);

    expect(line1Shifted[0].y).toBeCloseTo(-4, 5);
    expect(line1Shifted[1].y).toBeCloseTo(-4, 5);
    expect(line2Shifted[0].y).toBeCloseTo(4, 5);
    expect(line2Shifted[1].y).toBeCloseTo(4, 5);
  });
});

describe('offsetPolylinePoints & concentric corner rounding', () => {
  it('computes exact miter bisector at 90-degree bends and concentric inner/outer radii', () => {
    const base = [
      { x: 0, y: 0 },
      { x: 100, y: 0, radius: 20 },
      { x: 100, y: 100 }
    ];

    const inner = offsetPolylinePoints(base, 4, 0);
    const outer = offsetPolylinePoints(base, -4, 0);

    expect(inner[1].x).toBeCloseTo(96, 5);
    expect(inner[1].y).toBeCloseTo(4, 5);
    expect(inner[1].radius).toBeCloseTo(16, 5);

    expect(outer[1].x).toBeCloseTo(104, 5);
    expect(outer[1].y).toBeCloseTo(-4, 5);
    expect(outer[1].radius).toBeCloseTo(24, 5);

    const innerGeom = buildSectionRenderGeometry(base, 4, 0);
    const outerGeom = buildSectionRenderGeometry(base, -4, 0);
    expect(innerGeom.renderPoints.length).toBeGreaterThan(4);
    expect(outerGeom.renderPoints.length).toBeGreaterThan(4);
  });
});

describe('findWaypointInsertIndex', () => {
  it('inserts into the exact sub-segment clicked regardless of start/end station order or U-turns', () => {
    const start = { x: 200, y: 0 };
    const waypoints = [
      { x: 120, y: 60 },
      { x: 60, y: 60 }
    ];
    const end = { x: 0, y: 0 };

    expect(findWaypointInsertIndex(start, waypoints, end, { x: 30, y: 31 }).insertIndex).toBe(2);
    expect(findWaypointInsertIndex(start, waypoints, end, { x: 90, y: 58 }).insertIndex).toBe(1);
    expect(findWaypointInsertIndex(start, waypoints, end, { x: 160, y: 29 }).insertIndex).toBe(0);
  });
});

describe('Corridor parallel continuity, custom ordering & express skip-stop avoidance', () => {
  test('multi-station shared corridor (including 90-degree turn & random UUIDs & reversed section) keeps each line on the exact same side without crossing', () => {
    const stations = {
      A: { x: 100, y: 300 }, // id: st_900
      B: { x: 220, y: 300 }, // id: st_102
      C: { x: 340, y: 300 }, // id: st_550
      D: { x: 340, y: 460 }  // id: st_007 (在 C 站向南 90° 拐弯)
    };

    const lineOrderMap = new Map<string, number>([
      ['l1', 0],
      ['l2', 1]
    ]);

    const sections = [
      { id: 's1_ab', lineId: 'l1', startStationId: 'st_900', endStationId: 'st_102', points: [stations.A, stations.B] },
      { id: 's1_bc', lineId: 'l1', startStationId: 'st_102', endStationId: 'st_550', points: [stations.B, stations.C] },
      { id: 's1_cd', lineId: 'l1', startStationId: 'st_550', endStationId: 'st_007', points: [stations.C, stations.D] },
      { id: 's2_ba', lineId: 'l2', startStationId: 'st_102', endStationId: 'st_900', points: [stations.B, stations.A] },
      { id: 's2_bc', lineId: 'l2', startStationId: 'st_102', endStationId: 'st_550', points: [stations.B, stations.C] },
      { id: 's2_dc', lineId: 'l2', startStationId: 'st_007', endStationId: 'st_550', points: [stations.D, stations.C] }
    ];

    const layout = computeNetworkParallelLayout({
      sections,
      lineOrderMap,
      gap: 9
    });

    const g1AB = buildSectionRenderGeometry([stations.A, stations.B], layout.bySectionId.get('s1_ab')!.directedOffset, 0);
    const g2BA = buildSectionRenderGeometry([stations.B, stations.A], layout.bySectionId.get('s2_ba')!.directedOffset, 0);
    const g1BC = buildSectionRenderGeometry([stations.B, stations.C], layout.bySectionId.get('s1_bc')!.directedOffset, 0);
    const g2BC = buildSectionRenderGeometry([stations.B, stations.C], layout.bySectionId.get('s2_bc')!.directedOffset, 0);

    expect(g1AB.shiftedPoints[0].y).toBeCloseTo(295.5, 3);
    expect(g1BC.shiftedPoints[0].y).toBeCloseTo(295.5, 3);
    expect(g2BA.shiftedPoints[0].y).toBeCloseTo(304.5, 3);
    expect(g2BC.shiftedPoints[0].y).toBeCloseTo(304.5, 3);

    const g1CD = buildSectionRenderGeometry([stations.C, stations.D], layout.bySectionId.get('s1_cd')!.directedOffset, 0);
    const g2DC = buildSectionRenderGeometry([stations.D, stations.C], layout.bySectionId.get('s2_dc')!.directedOffset, 0);
    expect(g1CD.shiftedPoints[0].x).toBeCloseTo(344.5, 3);
    expect(g2DC.shiftedPoints[0].x).toBeCloseTo(335.5, 3);

    expect(layout.bySectionId.get('s1_ab')!.corridorSectionIds).toHaveLength(6);
  });

  test('express line spanning multiple local sections (A -> D over A-B-C-D) triggers 2-slot parallel avoidance without affecting perpendicular crossing lines', () => {
    const A = { x: 100, y: 200 };
    const B = { x: 200, y: 200 };
    const C = { x: 300, y: 200 };
    const D = { x: 400, y: 200 };

    const lineOrderMap = new Map<string, number>([
      ['express', 0],
      ['local', 1],
      ['cross', 2]
    ]);

    const sections = [
      { id: 'exp_ad', lineId: 'express', startStationId: 'A', endStationId: 'D', points: [A, D] },
      { id: 'loc_ab', lineId: 'local', startStationId: 'A', endStationId: 'B', points: [A, B] },
      { id: 'loc_bc', lineId: 'local', startStationId: 'B', endStationId: 'C', points: [B, C] },
      { id: 'loc_cd', lineId: 'local', startStationId: 'C', endStationId: 'D', points: [C, D] },
      {
        id: 'crs_ns',
        lineId: 'cross',
        startStationId: 'N',
        endStationId: 'S',
        points: [
          { x: 250, y: 80 },
          { x: 250, y: 320 }
        ]
      }
    ];

    const layout = computeNetworkParallelLayout({
      sections,
      lineOrderMap,
      gap: 9,
      stationLineCounts: { A: 2, B: 1, C: 1, D: 2, N: 1, S: 1 }
    });

    const expMeta = layout.bySectionId.get('exp_ad')!;
    const locAB = layout.bySectionId.get('loc_ab')!;
    const locBC = layout.bySectionId.get('loc_bc')!;
    const locCD = layout.bySectionId.get('loc_cd')!;
    const crossMeta = layout.bySectionId.get('crs_ns')!;

    expect(expMeta.totalSlots).toBe(2);
    expect(locAB.totalSlots).toBe(2);
    expect(locBC.totalSlots).toBe(2);
    expect(locCD.totalSlots).toBe(2);

    expect(expMeta.directedOffset).toBeCloseTo(-4.5, 3);
    expect(locAB.directedOffset).toBeCloseTo(4.5, 3);
    expect(locBC.directedOffset).toBeCloseTo(4.5, 3);
    expect(locCD.directedOffset).toBeCloseTo(4.5, 3);

    expect(crossMeta.totalSlots).toBe(1);
    expect(crossMeta.directedOffset).toBe(0);

    expect(layout.stationTrackNudges.get('A')).toBeUndefined();
    expect(layout.stationTrackNudges.get('D')).toBeUndefined();
    expect(layout.stationTrackNudges.get('B')?.dy).toBeCloseTo(4.5, 3);
    expect(layout.stationTrackNudges.get('C')?.dy).toBeCloseTo(4.5, 3);
  });

  test('user parallelOrder swaps top/bottom or left/right order cleanly and integrates with SVG export', () => {
    const swapped = moveLineInParallelOrder(['l1', 'l2'], 'l1', 'swap');
    expect(swapped).toEqual(['l2', 'l1']);

    const svg = buildMetroSvg({
      lines: [
        { id: 'l1', name: '1号线', color: '#ef4444', stationIds: ['A', 'B', 'C'], sectionIds: ['s_ab', 's_bc'] },
        { id: 'r1', name: '快线', color: '#2563eb', stationIds: ['A', 'C'], sectionIds: ['s_ac'] }
      ],
      stations: [
        { id: 'A', name: '起点', x: 100, y: 200 },
        { id: 'B', name: '中间站', x: 220, y: 200 },
        { id: 'C', name: '终点', x: 340, y: 200 }
      ],
      sections: [
        { id: 's_ab', lineId: 'l1', startStationId: 'A', endStationId: 'B', parallelOrder: ['r1', 'l1'] },
        { id: 's_bc', lineId: 'l1', startStationId: 'B', endStationId: 'C', parallelOrder: ['r1', 'l1'] },
        { id: 's_ac', lineId: 'r1', startStationId: 'A', endStationId: 'C', parallelOrder: ['r1', 'l1'] }
      ],
      mapSettings: DEFAULT_MAP_SETTINGS
    });

    expect(svg).toContain('M 100 195.6 L 340 195.6');
    expect(svg).toContain('M 100 204.4 L 220 204.4');
    expect(svg).toContain('cy="204.4"');
  });
});
