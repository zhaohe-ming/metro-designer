import {
  buildLightCitySvgLayer,
  generateLightCity,
  getLightCityPalette,
  LIGHT_CITY_ARCHETYPES,
  sampleRoundedRoadPolyline,
  sampleSmoothClosedPolygon,
  sampleSmoothOpenSpline,
  snapTerrainDrawPoint
} from './lightCity';
import { buildMetroSvg } from './exportSvg';
import { DEFAULT_MAP_SETTINGS, normalizeMapSettings } from '../types';

describe('Light City generator, normalization & SVG export', () => {
  test('all 6 procedural archetypes generate deterministic multi-layer features', () => {
    for (const meta of LIGHT_CITY_ARCHETYPES) {
      const a = generateLightCity({ archetype: meta.id, seed: 202611 });
      const b = generateLightCity({ archetype: meta.id, seed: 202611 });
      expect(a).toEqual(b);

      if (meta.id === 'custom') {
        expect(a.features).toHaveLength(0);
      } else {
        expect(a.features.length).toBeGreaterThanOrEqual(6);
        expect(a.features.some((f) => f.type === 'zone')).toBe(true);
        expect(a.features.some((f) => f.type === 'river' || f.type === 'waterArea')).toBe(true);
        expect(a.features.some((f) => f.type === 'road')).toBe(true);
        expect(a.features.some((f) => f.type === 'label')).toBe(true);
      }
    }
  });

  test('spline, smooth polygon, and rounded road samplers emit finite coordinates', () => {
    const spline = sampleSmoothOpenSpline([
      { x: 0, y: 0 },
      { x: 100, y: 80 },
      { x: 240, y: -30 }
    ]);
    expect(spline.length).toBeGreaterThan(6);
    expect(spline.every(Number.isFinite)).toBe(true);

    const poly = sampleSmoothClosedPolygon([
      { x: 0, y: 0 },
      { x: 120, y: 0 },
      { x: 120, y: 120 },
      { x: 0, y: 120 }
    ]);
    expect(poly.length).toBeGreaterThan(16);
    expect(poly.every(Number.isFinite)).toBe(true);

    const road = sampleRoundedRoadPolyline(
      [
        { x: 0, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 200 }
      ],
      false,
      36
    );
    expect(road.length).toBeGreaterThan(6);
    expect(road.every(Number.isFinite)).toBe(true);
  });

  test('normalizeMapSettings preserves light-city mode, layer toggles, and hideWaypoints', () => {
    const generated = generateLightCity({ archetype: 'bay', seed: 4242 });
    const normalized = normalizeMapSettings({
      ...DEFAULT_MAP_SETTINGS,
      hideWaypoints: true,
      baseMap: {
        mode: 'light-city',
        lightCity: {
          ...generated,
          opacity: 0.75,
          layerVisibility: { zones: true, water: true, roads: false, labels: true }
        }
      }
    });

    expect(normalized.hideWaypoints).toBe(true);
    expect(normalized.baseMap.mode).toBe('light-city');
    expect(normalized.baseMap.lightCity?.archetype).toBe('bay');
    expect(normalized.baseMap.lightCity?.opacity).toBe(0.75);
    expect(normalized.baseMap.lightCity?.layerVisibility.roads).toBe(false);
    expect(normalized.baseMap.lightCity?.features.length).toBe(generated.features.length);
  });

  test('buildMetroSvg embeds light-city vector basemap behind metro lines', () => {
    const lc = generateLightCity({ archetype: 'river', seed: 8888 });
    const svgLayer = buildLightCitySvgLayer(lc, false);
    expect(svgLayer).toContain('id="light-city-basemap"');

    const fullSvg = buildMetroSvg({
      lines: [{ id: 'l1', name: '1号线', color: '#e11d48', stationIds: ['s1', 's2'], sectionIds: ['sec1'] }],
      stations: [
        { id: 's1', name: '西站', x: 520, y: 460 },
        { id: 's2', name: '东站', x: 960, y: 460 }
      ],
      sections: [{ id: 'sec1', lineId: 'l1', startStationId: 's1', endStationId: 's2' }],
      mapSettings: normalizeMapSettings({
        ...DEFAULT_MAP_SETTINGS,
        baseMap: { mode: 'light-city', lightCity: lc }
      })
    });

    expect(fullSvg).toContain('#f6f7f9');
    expect(fullSvg).toContain('id="light-city-basemap"');
    expect(fullSvg).toContain('西站');
  });

  test('two-pass SVG water union places all waterBank paths before waterFill paths so junctions have no internal seams', () => {
    const pal = getLightCityPalette(false);
    const lc = {
      theme: 'paper-grey' as const,
      archetype: 'custom' as const,
      seed: 1,
      opacity: 1,
      layerVisibility: { zones: true, water: true, roads: true, labels: true },
      features: [
        {
          id: 'r1',
          type: 'river' as const,
          width: 60,
          points: [
            { x: 100, y: 200 },
            { x: 500, y: 200 }
          ]
        },
        {
          id: 'r2',
          type: 'river' as const,
          width: 48,
          points: [
            { x: 300, y: 200 },
            { x: 460, y: 360 }
          ]
        }
      ]
    };
    const svg = buildLightCitySvgLayer(lc, false);
    const lastBankIdx = svg.lastIndexOf(`stroke="${pal.waterBank}"`);
    const firstFillIdx = svg.indexOf(`stroke="${pal.waterFill}"`);
    expect(lastBankIdx).toBeGreaterThan(-1);
    expect(firstFillIdx).toBeGreaterThan(lastBankIdx);
  });

  test('snapTerrainDrawPoint snaps second river to first river vertex and smooth centerline, and respects Alt bypass', () => {
    const lc = {
      theme: 'paper-grey' as const,
      archetype: 'custom' as const,
      seed: 1,
      opacity: 1,
      layerVisibility: { zones: true, water: true, roads: true, labels: true },
      features: [
        {
          id: 'r1',
          type: 'river' as const,
          width: 64,
          points: [
            { x: 200, y: 300 },
            { x: 400, y: 300 },
            { x: 600, y: 300 }
          ]
        }
      ]
    };

    // 1. 靠近第一条河流的历史控制顶点 (400, 300)
    const vSnap = snapTerrainDrawPoint({
      rawPoint: { x: 408, y: 294 },
      lightCity: lc,
      tool: 'river',
      viewportScale: 1
    });
    expect(vSnap.snapped).toBe(true);
    expect(vSnap.kind).toBe('vertex');
    expect(vSnap.x).toBe(400);
    expect(vSnap.y).toBe(300);

    // 2. 靠近第一条河流的河道中心段 (300, 300) 但不靠近顶点 -> 吸附到中心线实现无缝分汊
    const cSnap = snapTerrainDrawPoint({
      rawPoint: { x: 305, y: 309 },
      lightCity: lc,
      tool: 'river',
      viewportScale: 1
    });
    expect(cSnap.snapped).toBe(true);
    expect(cSnap.kind).toBe('centerline');
    expect(Math.abs(cSnap.x - 305)).toBeLessThanOrEqual(1);
    expect(cSnap.y).toBe(300);

    // 3. 按住 Alt 键临时解除磁吸
    const freePt = snapTerrainDrawPoint({
      rawPoint: { x: 408, y: 294 },
      lightCity: lc,
      tool: 'river',
      viewportScale: 1,
      altKey: true
    });
    expect(freePt.snapped).toBe(false);
    expect(freePt.x).toBe(408);
    expect(freePt.y).toBe(294);
  });
});
