import {
  buildLightCitySvgLayer,
  generateLightCity,
  getLightCityPalette,
  getLightCityPreviewViewBox,
  getLightCityWorldBounds,
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

  test('London real-world detailed template generates multi-tier street network and survives normalizeMapSettings without truncation', () => {
    const londonZh = generateLightCity({ archetype: 'london', seed: 1001, language: 'zh-CN' });
    const londonEn = generateLightCity({ archetype: 'london', seed: 1001, language: 'en-US' });

    expect(londonZh.archetype).toBe('london');
    expect(londonZh.features.length).toBeGreaterThan(700);

    const expressCount = londonZh.features.filter((f) => f.type === 'road' && f.kind === 'express').length;
    const arterialCount = londonZh.features.filter((f) => f.type === 'road' && f.kind === 'arterial').length;
    const streetCount = londonZh.features.filter((f) => f.type === 'road' && f.kind === 'street').length;
    const urbanCount = londonZh.features.filter((f) => f.type === 'zone' && f.kind === 'urban').length;
    expect(urbanCount).toBe(0);
    expect(expressCount).toBeGreaterThan(50);
    expect(arterialCount).toBeGreaterThan(150);
    expect(streetCount).toBeGreaterThan(250);

    const londonSvg = buildLightCitySvgLayer(londonZh, false);
    expect(londonSvg).toContain('linearGradient');
    expect(londonSvg).toContain('mask="url(#lc_fade_mask_');

    const normalized = normalizeMapSettings({
      ...DEFAULT_MAP_SETTINGS,
      baseMap: { mode: 'light-city', lightCity: londonZh }
    });
    expect(normalized.baseMap.lightCity?.archetype).toBe('london');
    expect(normalized.baseMap.lightCity?.features.length).toBe(londonZh.features.length);
    expect(
      normalized.baseMap.lightCity?.features.filter((f) => f.type === 'road' && f.kind === 'street').length
    ).toBe(streetCount);

    const zhTexts = londonZh.features.filter((f) => f.type === 'label').map((f: any) => f.text);
    const enTexts = londonEn.features.filter((f) => f.type === 'label').map((f: any) => f.text);
    expect(zhTexts.some((t) => t.includes('威斯敏斯特') || t.includes('金丝雀'))).toBe(true);
    expect(enTexts.some((t) => t.includes('WESTMINSTER') || t.includes('CANARY'))).toBe(true);
  });

  test('Tokyo, Paris, New York, and Shanghai real-world templates generate rich geometry, edge feathering, and zero vertex truncation', () => {
    const cases: Array<{
      id: 'tokyo' | 'paris' | 'newyork' | 'shanghai';
      zhKey: string;
      enKey: string;
    }> = [
      { id: 'tokyo', zhKey: '新宿', enKey: 'SHINJUKU' },
      { id: 'paris', zhKey: '塞纳河', enKey: 'LA SEINE' },
      { id: 'newyork', zhKey: '曼哈顿', enKey: 'MANHATTAN' },
      { id: 'shanghai', zhKey: '陆家嘴', enKey: 'LUJIAZUI' }
    ];

    for (const c of cases) {
      const cityZh = generateLightCity({ archetype: c.id, seed: 2026, language: 'zh-CN' });
      const cityEn = generateLightCity({ archetype: c.id, seed: 2026, language: 'en-US' });

      expect(cityZh.archetype).toBe(c.id);
      expect(cityZh.features.length).toBeGreaterThan(500);
      expect(cityZh.features.filter((f) => f.type === 'zone' && f.kind === 'urban')).toHaveLength(0);
      expect(cityZh.features.filter((f) => f.type === 'zone' && f.kind === 'park').length).toBeGreaterThan(25);
      expect(cityZh.features.filter((f) => f.type === 'zone' && f.kind === 'island').length).toBeGreaterThanOrEqual(2);
      expect(cityZh.features.filter((f) => f.type === 'road' && f.kind === 'express').length).toBeGreaterThan(20);
      expect(cityZh.features.filter((f) => f.type === 'road' && f.kind === 'arterial').length).toBeGreaterThan(80);
      expect(cityZh.features.filter((f) => f.type === 'road' && f.kind === 'street').length).toBeGreaterThan(250);

      const svg = buildLightCitySvgLayer(cityZh, false);
      expect(svg).toContain('linearGradient');
      expect(svg).toContain('mask="url(#lc_fade_mask_');

      const normalized = normalizeMapSettings({
        ...DEFAULT_MAP_SETTINGS,
        baseMap: { mode: 'light-city', lightCity: cityZh }
      });
      expect(normalized.baseMap.lightCity?.archetype).toBe(c.id);
      expect(normalized.baseMap.lightCity?.features.length).toBe(cityZh.features.length);

      // Every polygon and polyline must survive normalizeMapSettings without hitting the 400-vertex slice cap
      cityZh.features.forEach((orig, idx) => {
        const normFeat = normalized.baseMap.lightCity?.features[idx];
        if (orig.type !== 'label' && normFeat && normFeat.type !== 'label') {
          expect(normFeat.points.length).toBe(orig.points.length);
        }
      });

      const zhLabels = cityZh.features.filter((f) => f.type === 'label').map((f: any) => f.text);
      const enLabels = cityEn.features.filter((f) => f.type === 'label').map((f: any) => f.text);
      expect(zhLabels.some((t) => t.includes(c.zhKey))).toBe(true);
      expect(enLabels.some((t) => t.includes(c.enKey))).toBe(true);
    }
  });

  test('Greater Shanghai city-wide macro template covers full metropolitan span without fine street clutter', () => {
    const shWide = generateLightCity({ archetype: 'shanghai_wide', seed: 2026, language: 'zh-CN' });
    const bounds = getLightCityWorldBounds(shWide);
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThan(3600);
    expect(bounds!.height).toBeGreaterThan(3000);

    // Macro template keeps expressways + primary corridors and omits fine street clutter
    expect(shWide.features.filter((f) => f.type === 'road' && f.kind === 'street')).toHaveLength(0);
    expect(shWide.features.filter((f) => f.type === 'road' && f.kind === 'express').length).toBeGreaterThan(50);
    expect(shWide.features.filter((f) => f.type === 'road' && f.kind === 'arterial').length).toBeGreaterThan(100);
    expect(shWide.features.filter((f) => f.type === 'zone' && f.kind === 'island').length).toBeGreaterThanOrEqual(4);

    const labels = shWide.features.filter((f) => f.type === 'label').map((f: any) => f.text);
    expect(labels.some((t) => t.includes('滴水湖'))).toBe(true);
    expect(labels.some((t) => t.includes('浦东国际机场'))).toBe(true);
    expect(labels.some((t) => t.includes('虹桥'))).toBe(true);
    expect(labels.some((t) => t.includes('嘉定'))).toBe(true);
    expect(labels.some((t) => t.includes('松江'))).toBe(true);

    const vb = getLightCityPreviewViewBox(shWide);
    expect(vb.split(' ').map(Number)[2]).toBeGreaterThan(3000);

    const normalized = normalizeMapSettings({
      ...DEFAULT_MAP_SETTINGS,
      baseMap: { mode: 'light-city', lightCity: shWide }
    });
    expect(normalized.baseMap.lightCity?.archetype).toBe('shanghai_wide');
    expect(normalized.baseMap.lightCity?.features.length).toBe(shWide.features.length);
    shWide.features.forEach((orig, idx) => {
      const normFeat = normalized.baseMap.lightCity?.features[idx];
      if (orig.type !== 'label' && normFeat && normFeat.type !== 'label') {
        expect(normFeat.points.length).toBe(orig.points.length);
      }
    });
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
