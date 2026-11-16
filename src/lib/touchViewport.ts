export type TouchPoint = { id: number; x: number; y: number };
export type CanvasViewport = { x: number; y: number; scale: number };

const distance = (a: TouchPoint, b: TouchPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: TouchPoint, b: TouchPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// 手势跨 touchstart/move/end 持续存在；第二根手指离开后，剩余手指只导航，直到全部离屏。
export class TouchViewportGesture {
  private previous: TouchPoint[] = [];
  private origin: TouchPoint | null = null;
  private consumed = false;
  private multiTouch = false;
  private moved = false;

  start(points: TouchPoint[]) {
    if (!this.previous.length) {
      this.origin = points[0] || null;
      this.consumed = false;
      this.multiTouch = false;
      this.moved = false;
    }
    if (points.length > 1) {
      this.multiTouch = true;
      this.consumed = true;
    }
    this.previous = points;
  }

  consume() { this.consumed = true; }
  get canLongPress() { return this.previous.length === 1 && !this.consumed && !this.moved; }
  get isNavigating() { return this.multiTouch; }

  move(points: TouchPoint[], view: CanvasViewport, panSingle: boolean): CanvasViewport | null {
    const previous = this.previous;
    this.previous = points;
    if (points.length > 1) { this.multiTouch = true; this.consumed = true; }
    if (this.origin && points[0] && distance(this.origin, points[0]) > 8) this.moved = true;
    if (points.length >= 2 && previous.length >= 2) {
      // 按 identifier 配对，避免触点数组顺序改变时镜头跳动。
      const a = points.find(p => p.id === previous[0].id);
      const b = points.find(p => p.id === previous[1].id);
      const oldDistance = distance(previous[0], previous[1]);
      if (!a || !b || oldDistance < 1) return null;
      const oldCenter = midpoint(previous[0], previous[1]);
      const center = midpoint(a, b);
      const scale = Math.max(0.1, Math.min(5, view.scale * distance(a, b) / oldDistance));
      return {
        scale,
        x: center.x - (oldCenter.x - view.x) * scale / view.scale,
        y: center.y - (oldCenter.y - view.y) * scale / view.scale
      };
    }
    if (points.length === 1 && previous.length === 1 && (panSingle || this.multiTouch)) {
      return { ...view, x: view.x + points[0].x - previous[0].x, y: view.y + points[0].y - previous[0].y };
    }
    return null;
  }

  end(remaining: TouchPoint[]) {
    const tap = !remaining.length && !this.consumed && !this.moved && this.previous.length === 1;
    this.previous = remaining;
    if (!remaining.length) { this.origin = null; this.multiTouch = false; }
    return tap;
  }

  cancel() { this.previous = []; this.origin = null; this.consumed = true; }
}
