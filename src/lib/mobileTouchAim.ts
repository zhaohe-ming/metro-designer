// 移动端触屏精准瞄准（防手指遮挡偏移准星）与 Pointer 排序纯计算工具

export const TOUCH_AIM_OFFSET_Y = 52;
export const TOUCH_AIM_ACTIVATE_PX = 6;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * 计算手指在屏幕按住移动时的偏移准星屏幕坐标：
 * 默认向指腹正上方偏移 52px，完全避开拇指/食指遮挡，并限制在画布安全边界内。
 */
export function computeTouchAimScreenPoint(
  finger: ScreenPoint,
  stageSize: { width: number; height: number },
  offsetY = TOUCH_AIM_OFFSET_Y
): ScreenPoint {
  const safeMaxX = Math.max(12, stageSize.width - 12);
  const safeMaxY = Math.max(14, stageSize.height - 14);
  return {
    x: clamp(finger.x, 12, safeMaxX),
    y: clamp(finger.y - offsetY, 14, safeMaxY)
  };
}

export function shouldActivateTouchAim(
  origin: ScreenPoint,
  current: ScreenPoint,
  thresholdPx = TOUCH_AIM_ACTIVATE_PX
): boolean {
  return Math.hypot(current.x - origin.x, current.y - origin.y) >= thresholdPx;
}

/**
 * 统一用于桌面拖放与移动端 Pointer 拖拽的顺序重排计算（无副作用）
 */
export function reorderIdsByDrag(ids: readonly string[], draggedId: string, targetId: string): string[] {
  if (!draggedId || !targetId || draggedId === targetId) {
    return [...ids];
  }
  const fromIdx = ids.indexOf(draggedId);
  const toIdx = ids.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1) {
    return [...ids];
  }
  const next = [...ids];
  next.splice(fromIdx, 1);
  next.splice(toIdx, 0, draggedId);
  return next;
}

export function triggerLightHaptic(durationMs = 8): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(durationMs);
    }
  } catch {
    /* ignore unsupported environments */
  }
}
