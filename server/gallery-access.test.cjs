const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveGalleryAdmins } = require('./lib/galleryAccess');
const { snapshot, artwork } = require('./lib/galleryDomain');

test('reviewed server configuration grants only the approved account', () => {
  assert.deepEqual([...resolveGalleryAdmins(undefined)], ['3855166698@qq.com']);
});
test('environment override replaces rather than expands the configured accounts', () => {
  assert.deepEqual([...resolveGalleryAdmins(' ADMIN@EXAMPLE.TEST, admin@example.test ')], ['admin@example.test']);
});
test('explicitly empty environment override disables all moderation accounts', () => {
  assert.equal(resolveGalleryAdmins('').size, 0);
});

test('gallery snapshot preserves curved waypoint radius/mode, >20 waypoints, diagonal station labels, and custom line labelPosition', () => {
  const manyWaypoints = Array.from({ length: 25 }, (_, i) => ({
    x: 10 + i * 8,
    y: 20 + (i % 2) * 12,
    ...(i === 3 ? { radius: 24, mode: 'arc' } : { radius: 14, mode: 'corner' })
  }));
  const clean = snapshot(
    {
      lines: [
        {
          id: 'L1',
          name: '1号线',
          color: '#2563eb',
          stationIds: ['S1', 'S2'],
          sectionIds: ['E1'],
          labelPosition: { x: -45, y: 18 }
        }
      ],
      stations: [
        { id: 'S1', name: '起点', x: 0, y: 0, labelPosition: 'top-left' },
        { id: 'S2', name: '终点', x: 240, y: 0, labelPosition: 'bottom-right' }
      ],
      sections: [
        {
          id: 'E1',
          lineId: 'L1',
          startStationId: 'S1',
          endStationId: 'S2',
          waypoints: manyWaypoints
        }
      ],
      mapSettings: { cornerRadius: 16 }
    },
    false
  );

  assert.equal(clean.sections[0].waypoints.length, 25);
  assert.equal(clean.sections[0].waypoints[3].radius, 24);
  assert.equal(clean.sections[0].waypoints[3].mode, 'arc');
  assert.equal(clean.stations[0].labelPosition, 'top-left');
  assert.deepEqual(clean.lines[0].labelPosition, { x: -45, y: 18 });

  const art = artwork({ title: '弯道测试', snapshot: clean }, 'data:image/png;base64,AA==', '© 高德地图');
  assert.match(art.svg, /<path d="M /);
  assert.match(art.svg, /© 高德地图/);
});
