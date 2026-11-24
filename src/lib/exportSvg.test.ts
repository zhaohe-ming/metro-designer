import { buildMetroSvg } from './exportSvg';
import { DEFAULT_MAP_SETTINGS } from '../types';

describe('buildMetroSvg', () => {
  it('exports valid standalone SVG with parallel tracks, custom arcs, and escaped station labels', () => {
    const svg = buildMetroSvg({
      lines: [
        { id: 'l1', name: '1号线', color: '#e11d48', stationIds: ['s1', 's2'], sectionIds: ['sec1'] },
        { id: 'l2', name: '2号线', color: '#2563eb', stationIds: ['s2', 's1'], sectionIds: ['sec2'] }
      ],
      stations: [
        { id: 's1', name: '人民广场 & 枢纽', x: 100, y: 100 },
        { id: 's2', name: '陆家嘴', x: 300, y: 100 }
      ],
      sections: [
        { id: 'sec1', lineId: 'l1', startStationId: 's1', endStationId: 's2', waypoints: [{ x: 200, y: 60, mode: 'arc' }] },
        { id: 'sec2', lineId: 'l2', startStationId: 's2', endStationId: 's1' }
      ],
      mapSettings: DEFAULT_MAP_SETTINGS
    });

    expect(svg.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('人民广场 &amp; 枢纽');
    expect(svg).toContain('#e11d48');
    expect(svg).toContain('#2563eb');
  });
});
