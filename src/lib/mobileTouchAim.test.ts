import {
  computeTouchAimScreenPoint,
  reorderIdsByDrag,
  shouldActivateTouchAim,
  TOUCH_AIM_OFFSET_Y
} from './mobileTouchAim';

describe('mobileTouchAim helpers', () => {
  it('offsets touch crosshair 52px above finger and clamps inside stage bounds', () => {
    expect(computeTouchAimScreenPoint({ x: 180, y: 300 }, { width: 390, height: 700 })).toEqual({
      x: 180,
      y: 300 - TOUCH_AIM_OFFSET_Y
    });
    // Near top edge: clamps to y = 14 instead of going negative
    expect(computeTouchAimScreenPoint({ x: 4, y: 30 }, { width: 390, height: 700 })).toEqual({
      x: 12,
      y: 14
    });
    // Near right/bottom edge: clamps inside stage
    expect(computeTouchAimScreenPoint({ x: 388, y: 745 }, { width: 390, height: 700 })).toEqual({
      x: 378,
      y: 686
    });
  });

  it('activates touch aiming only after finger moves past threshold', () => {
    expect(shouldActivateTouchAim({ x: 100, y: 200 }, { x: 103, y: 203 })).toBe(false);
    expect(shouldActivateTouchAim({ x: 100, y: 200 }, { x: 106, y: 200 })).toBe(true);
    expect(shouldActivateTouchAim({ x: 100, y: 200 }, { x: 100, y: 192 })).toBe(true);
  });

  it('reorders line or station IDs deterministically without mutating input', () => {
    const base = ['l1', 'l2', 'l3', 'l4'];
    expect(reorderIdsByDrag(base, 'l1', 'l3')).toEqual(['l2', 'l3', 'l1', 'l4']);
    expect(reorderIdsByDrag(base, 'l4', 'l1')).toEqual(['l4', 'l1', 'l2', 'l3']);
    expect(reorderIdsByDrag(base, 'l2', 'l2')).toEqual(['l1', 'l2', 'l3', 'l4']);
    expect(base).toEqual(['l1', 'l2', 'l3', 'l4']);
  });
});
