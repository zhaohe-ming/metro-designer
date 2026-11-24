import { DEFAULT_MAP_SETTINGS } from '../types';
import {
  METRO_PROJECT_FORMAT,
  parseMetroProjectJson,
  sanitizeProjectFilename,
  serializeMetroProject
} from './projectFile';

describe('projectFile serialization & compatibility', () => {
  test('round-trips .metro project data including viewport and currentLineId', () => {
    const raw = serializeMetroProject({
      name: '天津线网规划.metro',
      lines: [{ id: 'l1', name: '1号线', color: '#e11d48', stationIds: ['s1', 's2'], sectionIds: ['sec1'] }],
      stations: [
        { id: 's1', name: '刘园', x: 100, y: 120 },
        { id: 's2', name: '西站', x: 220, y: 120 }
      ],
      sections: [{ id: 'sec1', lineId: 'l1', startStationId: 's1', endStationId: 's2' }],
      mapSettings: { ...DEFAULT_MAP_SETTINGS, cornerRadius: 16 },
      currentLineId: 'l1',
      viewport: { scale: 1.25, x: -40, y: 30 }
    });

    const parsed = parseMetroProjectJson(raw, 'fallback.metro');
    expect(parsed.format).toBe(METRO_PROJECT_FORMAT);
    expect(parsed.name).toBe('天津线网规划');
    expect(parsed.lines).toHaveLength(1);
    expect(parsed.stations).toHaveLength(2);
    expect(parsed.mapSettings.cornerRadius).toBe(16);
    expect(parsed.viewport).toEqual({ scale: 1.25, x: -40, y: 30 });
  });

  test('compatibly parses legacy guest draft backup JSON', () => {
    const legacyJson = JSON.stringify({
      version: 1,
      id: 'draft_1',
      updatedAt: 1700000000000,
      name: '',
      lines: [],
      stations: [{ id: 'st1', name: '人民广场', x: 50, y: 80 }],
      sections: [],
      mapSettings: DEFAULT_MAP_SETTINGS
    });
    const parsed = parseMetroProjectJson(legacyJson, '上海备份.json');
    expect(parsed.name).toBe('上海备份');
    expect(parsed.stations[0].name).toBe('人民广场');
  });

  test('sanitizes unsafe Windows filename characters and rejects invalid JSON', () => {
    expect(sanitizeProjectFilename('1号线: 东段/西段?.metro')).toBe('1号线_ 东段_西段_');
    expect(() => parseMetroProjectJson('{bad json')).toThrow(/有效/);
    expect(() => parseMetroProjectJson('{"hello":1}')).toThrow(/线路与站点/);
  });
});
