import { createGuestDraft, hasGuestSession, setGuestSession } from './guestDraft';

test('demo is a connected editable graph with exactly two transfers', () => {
  const draft = createGuestDraft();
  expect(draft.lines).toHaveLength(3);
  expect(draft.stations).toHaveLength(12);
  const stationIds = new Set(draft.stations.map(s => s.id));
  draft.lines.forEach(line => {
    expect(line.stationIds.every(id => stationIds.has(id))).toBe(true);
    expect(line.sectionIds).toHaveLength(line.stationIds.length - 1);
    line.sectionIds.forEach((id, index) => {
      expect(draft.sections.find(section => section.id === id)).toMatchObject({
        lineId: line.id, startStationId: line.stationIds[index], endStationId: line.stationIds[index + 1]
      });
    });
  });
  expect(draft.stations.filter(station => draft.lines.filter(line => line.stationIds.includes(station.id)).length > 1)).toHaveLength(2);
});

test('restart creates a separate empty document with independent settings', () => {
  const demo = createGuestDraft();
  const blank = createGuestDraft(true);
  expect(blank.id).not.toBe(demo.id);
  expect(blank.lines).toEqual([]);
  expect(blank.stations).toEqual([]);
  blank.mapSettings.dotLabelStyle.fontSize = 99;
  expect(demo.mapSettings.dotLabelStyle.fontSize).not.toBe(99);
});

test('guest marker stays separate from the authentication token and last cloud map', () => {
  localStorage.setItem('metro_token', 'existing-session');
  localStorage.setItem('metro_last_map_id', 'existing-map');
  setGuestSession(true);
  expect(hasGuestSession()).toBe(true);
  setGuestSession(false);
  expect(hasGuestSession()).toBe(false);
  expect(localStorage.getItem('metro_token')).toBe('existing-session');
  expect(localStorage.getItem('metro_last_map_id')).toBe('existing-map');
  localStorage.clear();
});
