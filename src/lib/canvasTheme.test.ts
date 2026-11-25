import {
  computeRelativeLuminance,
  resolveLineBadgeColors,
  resolveReadableStationLabelColor
} from './canvasTheme';

describe('canvasTheme contrast helpers', () => {
  it('switches default dark station label color (#0f172a) to light text on dark canvas', () => {
    expect(resolveReadableStationLabelColor('#0f172a', true)).toBe('#f8fafc');
    expect(resolveReadableStationLabelColor('#111827', true)).toBe('#f8fafc');
    expect(resolveReadableStationLabelColor(undefined, true)).toBe('#f8fafc');
  });

  it('preserves bright user-customized station label colors on dark canvas', () => {
    expect(resolveReadableStationLabelColor('#fbbf24', true)).toBe('#fbbf24');
    expect(resolveReadableStationLabelColor('#93c5fd', true)).toBe('#93c5fd');
    expect(resolveReadableStationLabelColor('#ffffff', true)).toBe('#ffffff');
  });

  it('prevents near-white station labels from disappearing on light canvas', () => {
    expect(resolveReadableStationLabelColor('#ffffff', false)).toBe('#0f172a');
    expect(resolveReadableStationLabelColor('#f8fafc', false)).toBe('#0f172a');
    expect(resolveReadableStationLabelColor('#1e293b', false)).toBe('#1e293b');
  });

  it('computes relative luminance for 3-digit, 6-digit hex, and rgb strings', () => {
    expect(computeRelativeLuminance('#000')).toBeCloseTo(0, 4);
    expect(computeRelativeLuminance('#ffffff')).toBeCloseTo(1, 4);
    expect(computeRelativeLuminance('rgb(15, 23, 42)')).toBeLessThan(0.05);
  });

  it('adapts line name badge fill and text for dark surfaces', () => {
    expect(resolveLineBadgeColors('#ffffff', '#0f172a', false)).toEqual({
      fill: '#ffffff',
      text: '#0f172a'
    });
    expect(resolveLineBadgeColors('#ffffff', '#0f172a', true)).toEqual({
      fill: '#0f172a',
      text: '#f8fafc'
    });
  });
});
