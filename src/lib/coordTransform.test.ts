import {
  gcj02ToWgs84,
  migrateLegacyGcj02MapToWgs84,
  wgs84ToGcj02
} from './coordTransform';
import { DEFAULT_MAP_SETTINGS } from '../types';

describe('coordTransform (GCJ-02 <-> WGS-84)', () => {
  test('roundtrips Beijing Tiananmen coordinates within sub-meter precision', () => {
    const wgs: [number, number] = [116.391276, 39.907335];
    const gcj = wgs84ToGcj02(wgs[0], wgs[1]);
    // GCJ-02 in Beijing shifts ~500m east and ~140m north
    expect(Math.abs(gcj[0] - wgs[0])).toBeGreaterThan(0.004);
    expect(Math.abs(gcj[1] - wgs[1])).toBeGreaterThan(0.001);

    const restored = gcj02ToWgs84(gcj[0], gcj[1]);
    expect(Math.abs(restored[0] - wgs[0])).toBeLessThan(0.000005);
    expect(Math.abs(restored[1] - wgs[1])).toBeLessThan(0.000005);
  });

  test('leaves overseas coordinates untouched', () => {
    const london: [number, number] = [-0.127758, 51.507351];
    expect(gcj02ToWgs84(london[0], london[1])).toEqual(london);
  });

  test('migrates legacy amap GCJ-02 map once and marks coordSystem=wgs84 (idempotent)', () => {
    const legacySettings = {
      ...DEFAULT_MAP_SETTINGS,
      baseMap: {
        mode: 'amap' as const,
        amap: {
          center: [116.397428, 39.90923] as [number, number],
          zoom: 12,
          style: 'normal' as const
        }
      }
    };
    const first = migrateLegacyGcj02MapToWgs84({
      stations: [{ id: 's1', name: '天安门', x: 0, y: 0, lng: 116.397428, lat: 39.90923 }],
      sections: [],
      mapSettings: legacySettings
    });
    expect(first.migrated).toBe(true);
    expect(first.mapSettings.baseMap.amap?.coordSystem).toBe('wgs84');
    expect(first.stations[0].lng).toBeCloseTo(116.3912, 3);

    // Calling again on already-migrated data must NOT double-shift
    const second = migrateLegacyGcj02MapToWgs84({
      stations: first.stations,
      sections: first.sections,
      mapSettings: first.mapSettings
    });
    expect(second.migrated).toBe(false);
    expect(second.stations[0].lng).toBe(first.stations[0].lng);
  });
});
