import { DEFAULT_MAP_SETTINGS, normalizeMapSettings, normalizeSections, normalizeVideoExportConfig } from './index';

describe('normalizeSections', () => {
  it('非数组输入返回空数组', () => {
    expect(normalizeSections(undefined)).toEqual([]);
    expect(normalizeSections(null)).toEqual([]);
    expect(normalizeSections({})).toEqual([]);
  });

  it('丢弃缺少必填 id 字段的区间', () => {
    const input = [
      { id: 's1', lineId: 'L1', startStationId: 'a', endStationId: 'b' }, // 合法
      { id: 's2', lineId: 'L1', startStationId: 'a' }, // 缺 endStationId
      { lineId: 'L1', startStationId: 'a', endStationId: 'b' } // 缺 id
    ];
    const out = normalizeSections(input);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('s1');
  });

  it('把 id 强转为字符串', () => {
    const out = normalizeSections([{ id: 123, lineId: 456, startStationId: 7, endStationId: 8 }]);
    expect(out[0]).toMatchObject({ id: '123', lineId: '456', startStationId: '7', endStationId: '8' });
  });

  it('过滤非法途经点，保留合法途经点', () => {
    const out = normalizeSections([
      {
        id: 's1',
        lineId: 'L1',
        startStationId: 'a',
        endStationId: 'b',
        waypoints: [
          { x: 1, y: 2 }, // 合法
          { x: 'bad', y: 2 }, // 非法 → 丢
          { y: 5 }, // 缺 x → 丢
          { x: 3, y: 4, lng: 116, lat: 39, hidden: true } // 合法 + 可选字段
        ]
      }
    ]);
    expect(out[0].waypoints).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4, lng: 116, lat: 39, hidden: true }
    ]);
  });

  it('途经点全部非法时不写 waypoints 字段', () => {
    const out = normalizeSections([
      { id: 's1', lineId: 'L1', startStationId: 'a', endStationId: 'b', waypoints: [{ x: 'x', y: 'y' }] }
    ]);
    expect(out[0].waypoints).toBeUndefined();
  });
});

describe('视频配置保存', () => {
  const videoExport = {
    segments: [{ id: 'step-1', lineId: 'L1', startStationId: 'a', endStationId: 'b', openDate: '2020-01-01' }],
    title: '城市轨道线网历程', subtitle: '1969 - 2026', titleDurationSec: 2.5
  };

  it('保存和重新加载会保留区间、标题与时长，且不共享可变对象', () => {
    const stored = JSON.parse(JSON.stringify(normalizeMapSettings({ videoExport, labelDensity: 'key' })));
    const loaded = normalizeMapSettings(stored);
    expect(loaded.videoExport).toEqual(videoExport);
    expect(loaded.labelDensity).toBe('key');
    expect(loaded.videoExport!.segments[0]).not.toBe(videoExport.segments[0]);
  });

  it('未完成的配置也能保存，重复行 id 修复后可以分别编辑', () => {
    const draft = normalizeVideoExportConfig({
      segments: [null, { id: 'same', lineId: 'L1' }, { id: 'same', openDate: '2020-01-01' }],
      title: 42, subtitle: '草稿', titleDurationSec: 100
    })!;
    expect(draft.segments).toHaveLength(2);
    expect(new Set(draft.segments.map(segment => segment.id)).size).toBe(2);
    expect(draft.segments[0]).toMatchObject({ lineId: 'L1', startStationId: '', endStationId: '', openDate: '' });
    expect(draft.title).toBe('');
    expect(draft.titleDurationSec).toBe(8);
  });

  it('前后端的设置归一化保持一致，云端不会丢失标签密度或视频草稿', () => {
    const backend = require('../../server/lib/mapSettings');
    const fixtures = [undefined, null, {},
      { labelDensity: 'adaptive', videoExport },
      {
        labelDensity: 'adaptive',
        videoExport: {
          ...videoExport,
          segments: [{ ...videoExport.segments[0], phaseLabel: '一期' }],
          aspectRatio: '9:16',
          resolution: '1080p',
          fps: 60,
          speedMultiplier: 1.5,
          cameraMode: 'overview',
          unopenedStyle: 'hidden',
          dateMode: 'sequence',
          showYearBadge: true,
          showLineLegend: false
        }
      },
      { labelDensity: 'key', videoExport: { segments: [{ id: 'x' }, { id: 'x' }], titleDurationSec: -2 } },
      { labelDensity: 'unknown', videoExport: 'invalid', cornerRadius: 100 },
      { videoExport: { segments: [null, [], 9, { openDate: 23 }], title: 'x'.repeat(100), titleDurationSec: NaN } }
    ];
    fixtures.forEach(settings => {
      expect(backend.normalizeMapSettings(settings)).toEqual(normalizeMapSettings(settings as any));
    });
  });
});

describe('normalizeMapSettings', () => {
  it('空输入返回默认值，但 mapStyle 回退到 classic-badge（保护老存档观感）', () => {
    // 故意的分叉：DEFAULT_MAP_SETTINGS.mapStyle = 'dot-label' 只给"新建项目"用；
    // normalize 对缺字段的老数据回退 classic-badge，不改变老地图的既有观感。
    const expected = { ...DEFAULT_MAP_SETTINGS, mapStyle: 'classic-badge' };
    expect(normalizeMapSettings(undefined)).toEqual(expected);
    expect(normalizeMapSettings(null)).toEqual(expected);
  });

  it('新建项目的默认 mapStyle 是 dot-label（专业线网）', () => {
    expect(DEFAULT_MAP_SETTINGS.mapStyle).toBe('dot-label');
    // 显式保存过 dot-label 的存档经 normalize 后保持不变
    expect(normalizeMapSettings({ mapStyle: 'dot-label' }).mapStyle).toBe('dot-label');
  });

  it('把超范围的字号收紧到允许区间', () => {
    expect(normalizeMapSettings({ dotLabelStyle: { fontSize: 999, fontWeight: 700, color: '#000000' } }).dotLabelStyle.fontSize).toBe(24);
    expect(normalizeMapSettings({ dotLabelStyle: { fontSize: 1, fontWeight: 700, color: '#000000' } }).dotLabelStyle.fontSize).toBe(10);
  });

  it('非法颜色回退到默认色', () => {
    expect(normalizeMapSettings({ dotLabelStyle: { fontSize: 13, fontWeight: 700, color: 'red' } }).dotLabelStyle.color).toBe(
      DEFAULT_MAP_SETTINGS.dotLabelStyle.color
    );
  });

  it('未知 cityStyle 归一到 standard', () => {
    expect(normalizeMapSettings({ cityStyle: 'tokyo' as any }).cityStyle).toBe('standard');
    expect(normalizeMapSettings({ cityStyle: 'mtr' }).cityStyle).toBe('mtr');
  });

  it('高德 zoom 收紧到 3..20', () => {
    expect(normalizeMapSettings({ baseMap: { mode: 'amap', amap: { center: [120, 30], zoom: 99, style: 'normal' } } }).baseMap.amap!.zoom).toBe(20);
    expect(normalizeMapSettings({ baseMap: { mode: 'amap', amap: { center: [120, 30], zoom: 0, style: 'normal' } } }).baseMap.amap!.zoom).toBe(3);
  });

  it('非法 labelDensity 归一到 paper', () => {
    expect(normalizeMapSettings({ labelDensity: 'nonsense' as any }).labelDensity).toBe('paper');
    expect(normalizeMapSettings({ labelDensity: 'key' }).labelDensity).toBe('key');
  });
});
