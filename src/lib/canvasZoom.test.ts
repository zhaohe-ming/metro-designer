import { liveElementScaleRatio, plainCanvasElementScale } from './canvasZoom';

test.each(['adaptive', 'key'] as const)('%s label size agrees during zoom and after settling', density => {
  const fontSize = 13;
  for (const before of [0.2, 0.7, 0.9, 1, 1.3, 2, 4]) {
    const rendered = plainCanvasElementScale(density, before);
    for (const current of [0.1, 0.6, 0.8, 1, 1.2, 1.5, 3, 5]) {
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

test('screen-readable labels stay constant in the readable range and continuous at the clamps', () => {
  for (const current of [0.8, 1, 1.2, 1.4]) {
    expect(plainCanvasElementScale('adaptive', current) * current).toBeCloseTo(1, 10);
  }
  for (const boundary of [1 / 1.4, 1 / 0.7]) {
    const left = plainCanvasElementScale('adaptive', boundary - 0.00001) * (boundary - 0.00001);
    const right = plainCanvasElementScale('adaptive', boundary + 0.00001) * (boundary + 0.00001);
    expect(Math.abs(left - right)).toBeLessThan(0.00003);
  }
});
