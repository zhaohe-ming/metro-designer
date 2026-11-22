import { LabelDensity } from '../types';

/** Both live Konva updates and the settled React render use this size rule. */
export function plainCanvasElementScale(density: LabelDensity, viewportScale: number): number {
  return density === 'paper' ? 1 : Math.max(0.7, Math.min(1.4, 1 / Math.max(viewportScale, 0.0001)));
}

export function liveElementScaleRatio(density: LabelDensity, viewportScale: number, renderedElementScale: number): number {
  return plainCanvasElementScale(density, viewportScale) / renderedElementScale;
}
