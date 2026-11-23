import { RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getAmapConfig, loadAmap } from '../amapLoader';
import { AmapBaseMapSettings } from '../types';

type Viewport = { center: [number, number]; zoom: number; style: string; width: number; height: number };
type PendingViewport = Viewport & { key: string };

function readViewport(map: any, style: string): Viewport | null {
  const center = map.getCenter?.();
  const size = map.getSize?.();
  const zoom = Number(map.getZoom?.());
  const width = Number(size?.width ?? size?.getWidth?.());
  const height = Number(size?.height ?? size?.getHeight?.());
  if (![center?.lng, center?.lat, zoom, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { center: [center.lng, center.lat], zoom, style, width, height };
}

function matches(view: Viewport | null, target: Viewport) {
  return !!view && view.style === target.style && Math.abs(view.center[0] - target.center[0]) <= 0.000001 &&
    Math.abs(view.center[1] - target.center[1]) <= 0.000001 && Math.abs(view.zoom - target.zoom) <= 0.01 &&
    Math.abs(view.width - target.width) <= 1 && Math.abs(view.height - target.height) <= 1;
}

interface Options {
  enabled: boolean;
  documentKey: string;
  documentLoading: boolean;
  containerRef: RefObject<HTMLDivElement>;
  viewport: AmapBaseMapSettings;
  width: number;
  height: number;
  onViewportChange: (center: [number, number], zoom: number) => void;
  onInteractionChange: (interacting: boolean) => void;
}

export function useAmapViewport(options: Options) {
  const { enabled, containerRef, viewport, documentKey, width, height } = options;
  const [longitude, latitude] = viewport.center;
  const { key, securityCode } = getAmapConfig();
  const sceneKey = JSON.stringify([documentKey, viewport.style, width, height]);
  const latest = useRef({ ...options, sceneKey });
  useLayoutEffect(() => { latest.current = { ...options, sceneKey }; });
  const mapRef = useRef<any>(null);
  const appliedStyle = useRef<string>(viewport.style);
  const completed = useRef<Viewport | null>(null);
  const echoed = useRef<PendingViewport | null>(null);
  const pending = useRef<PendingViewport | null>(null);
  const frame = useRef<number | null>(null);
  const interactionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<{ readyKey: string | null; error: string }>({ readyKey: null, error: '' });
  const [renderTick, setRenderTick] = useState(0);

  const scheduleRender = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => { frame.current = null; setRenderTick(tick => tick + 1); });
  }, []);

  const reveal = useCallback(() => {
    const request = pending.current;
    const map = mapRef.current;
    if (!request || !map || request.key !== latest.current.sceneKey || !latest.current.enabled ||
      !matches(completed.current, request) || !matches(readViewport(map, appliedStyle.current), request)) return;
    pending.current = null;
    if (loadTimer.current !== null) clearTimeout(loadTimer.current);
    loadTimer.current = null;
    latest.current.onInteractionChange(false);
    // 就绪状态和投影刷新在同一次提交中生效，首次可见帧只使用目标视野的投影。
    setState({ readyKey: request.key, error: '' });
    setRenderTick(tick => tick + 1);
  }, []);

  const applyViewport = useCallback(() => {
    const map = mapRef.current;
    const input = latest.current;
    if (!map || !input.enabled || input.documentLoading) return;
    const target: PendingViewport = { ...input.viewport, width: input.width, height: input.height, key: input.sceneKey };
    const current = readViewport(map, appliedStyle.current);
    const needsMove = !current || Math.abs(current.center[0] - target.center[0]) > 0.000001 ||
      Math.abs(current.center[1] - target.center[1]) > 0.000001 || Math.abs(current.zoom - target.zoom) > 0.01;
    const needsStyle = appliedStyle.current !== target.style;
    // 普通拖动结束后的状态回写，不重新加载底图，也不打断交互。
    if (!pending.current && !needsMove && !needsStyle && matches(current, target) &&
      (matches(completed.current, target) || (echoed.current?.key === target.key && matches(echoed.current, target)))) {
      setState(previous => previous.readyKey === target.key && !previous.error ? previous : { readyKey: target.key, error: '' });
      scheduleRender();
      return;
    }
    pending.current = target;
    setState({ readyKey: null, error: '' });
    if (loadTimer.current !== null) clearTimeout(loadTimer.current);
    // 超时只显示错误，不按固定延时放出错误坐标；迟到的 complete 仍可正常恢复。
    loadTimer.current = setTimeout(() => {
      if (pending.current === target) setState({ readyKey: null, error: '底图加载较慢，请检查网络连接，加载完成后会自动显示线网。' });
    }, 20_000);
    if (needsStyle) {
      completed.current = null;
      appliedStyle.current = target.style;
      map.setMapStyle?.(`amap://styles/${target.style}`);
    }
    // 打开存档直接跳到目标视野；日常手动拖动、缩放仍由 SDK 保持平滑。
    if (needsMove) map.setZoomAndCenter?.(target.zoom, target.center, true, 0);
    reveal();
  }, [reveal, scheduleRender]);

  useEffect(() => {
    if (!enabled) {
      setState({ readyKey: null, error: '' });
      return;
    }
    if (!key || !securityCode) {
      setState({ readyKey: null, error: '请先配置 REACT_APP_AMAP_KEY 和 REACT_APP_AMAP_SECURITY_CODE' });
      return;
    }
    let disposed = false;
    let disposeMap: (() => void) | undefined;
    loadAmap().then(AMap => {
      if (disposed || !containerRef.current) return;
      const desired = latest.current.viewport;
      const map = new AMap.Map(containerRef.current, { center: desired.center, zoom: desired.zoom,
        viewMode: '2D', mapStyle: `amap://styles/${desired.style}`, resizeEnable: true });
      mapRef.current = map;
      appliedStyle.current = desired.style;
      completed.current = null;
      const live = () => !disposed && mapRef.current === map;
      const handleComplete = () => {
        if (!live()) return;
        completed.current = readViewport(map, appliedStyle.current);
        reveal(); scheduleRender();
      };
      const handleStart = () => {
        if (!live()) return;
        if (interactionTimer.current !== null) clearTimeout(interactionTimer.current);
        if (!pending.current) latest.current.onInteractionChange(true);
        scheduleRender();
      };
      const handleEnd = () => {
        if (!live()) return;
        const view = readViewport(map, appliedStyle.current);
        // 存档加载中的程序化移动不回写设置，避免旧地图事件覆盖新存档的目标视野。
        if (view && !pending.current && !latest.current.documentLoading) {
          echoed.current = { ...view, key: latest.current.sceneKey };
          latest.current.onViewportChange(view.center, view.zoom);
        }
        scheduleRender();
        if (interactionTimer.current !== null) clearTimeout(interactionTimer.current);
        interactionTimer.current = setTimeout(() => {
          if (live()) { latest.current.onInteractionChange(false); scheduleRender(); }
        }, 120);
      };
      const events: Array<[string, () => void]> = [['complete', handleComplete], ['resize', scheduleRender],
        ['movestart', handleStart], ['zoomstart', handleStart], ['mapmove', scheduleRender], ['zoomchange', scheduleRender],
        ['moveend', handleEnd], ['zoomend', handleEnd]];
      events.forEach(([event, handler]) => map.on(event, handler));
      disposeMap = () => {
        events.forEach(([event, handler]) => map.off?.(event, handler));
        map.destroy?.();
        if (mapRef.current === map) mapRef.current = null;
      };
      applyViewport();
    }).catch(error => {
      if (!disposed) setState({ readyKey: null, error: error?.message || '高德地图加载失败' });
    });
    return () => {
      disposed = true;
      disposeMap?.();
      pending.current = null; completed.current = null; echoed.current = null;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      if (interactionTimer.current !== null) clearTimeout(interactionTimer.current);
      if (loadTimer.current !== null) clearTimeout(loadTimer.current);
      latest.current.onInteractionChange(false);
    };
  }, [enabled, key, securityCode, containerRef, applyViewport, reveal, scheduleRender]);

  useLayoutEffect(() => { applyViewport(); }, [applyViewport, enabled, sceneKey, options.documentLoading,
    viewport.zoom, longitude, latitude]);

  return { mapRef, ready: enabled && state.readyKey === sceneKey, error: state.error, renderTick };
}
