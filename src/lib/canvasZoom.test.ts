import {
  AMAP_REFERENCE_ZOOM,
  computeAmapVisualScales,
  estimateSingleLineTextWidth,
  liveElementScaleRatio,
  plainCanvasElementScale
} from './canvasZoom';

test.each(['adaptive', 'key'] as const)('%s label size agrees during zoom and after settling', density => {
  const fontSize = 13;
  for (const before of [0.2, 0.5, 0.7, 0.9, 1, 1.3, 2, 4]) {
    const rendered = plainCanvasElementScale(density, before);
    for (const current of [0.1, 0.4, 0.6, 0.8, 1, 1.2, 1.5, 3, 5]) {
      const livePixels = fontSize * rendered * liveElementScaleRatio(density, current, rendered) * current;
      const settledPixels = fontSize * plainCanvasElementScale(density, current) * current;
      expect(livePixels).toBeCloseTo(settledPixels, 10);
    }
  }
});

test('paper elements always follow the viewport with no compensating size change', () => {
  for (const current of [0.1, 0.5, 1, 2, 5]) {
    expect(plainCanvasElementScale('paper', current)).toBe(1);
    expect(liveElementScaleRatio('paper', current, 1)).toBe(1);
  }
});

test('screen-readable labels stay constant across the wide readable range and continuous at the clamps', () => {
  for (const current of [0.55, 0.8, 1, 1.2, 1.6, 1.8]) {
    expect(plainCanvasElementScale('adaptive', current) * current).toBeCloseTo(1, 10);
  }
  for (const boundary of [1 / 1.85, 1 / 0.55]) {
    const left = plainCanvasElementScale('adaptive', boundary - 0.00001) * (boundary - 0.00001);
    const right = plainCanvasElementScale('adaptive', boundary + 0.00001) * (boundary + 0.00001);
    expect(Math.abs(left - right)).toBeLessThan(0.00003);
  }
});

test('AMap visual scales are stateless, deterministic, and shrink dots/pills cleanly at city-wide zoom', () => {
  for (const density of ['paper', 'adaptive', 'key'] as const) {
    const ref = computeAmapVisualScales(density, AMAP_REFERENCE_ZOOM);
    expect(ref.dotScale).toBeCloseTo(1, 6);
    expect(ref.strokeScale).toBeCloseTo(1, 6);
    expect(ref.labelScale).toBeCloseTo(1, 6);
    expect(ref.pillScale).toBeCloseTo(1, 6);

    const macro = computeAmapVisualScales(density, 9.8);
    const closeUp = computeAmapVisualScales(density, 13.5);
    expect(macro.dotScale).toBeLessThan(macro.labelScale);
    expect(macro.dotScale).toBeLessThan(0.7);
    expect(macro.pillScale).toBeLessThan(0.85);
    expect(macro.allowTier1OverlapCull).toBe(true);
    expect(closeUp.allowTier1OverlapCull).toBe(false);
    expect(closeUp.dotScale).toBeGreaterThan(ref.dotScale);
    // Repeated calls with same zoom always produce identical scales regardless of prior zoom history
    expect(computeAmapVisualScales(density, 9.8)).toEqual(macro);
  }
});

test('single-line text width estimation distinguishes CJK and ASCII without underestimating mixed names', () => {
  expect(estimateSingleLineTextWidth('天津站南广场', 13)).toBeGreaterThan(6 * 13);
  expect(estimateSingleLineTextWidth('S1津滨快线', 12)).toBeGreaterThan(estimateSingleLineTextWidth('津滨快线', 12));
});
