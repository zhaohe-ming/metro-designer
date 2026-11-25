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

function sizeMatches(view: Viewport | null, target: Viewport) {
  return !!view && Math.abs(view.width - target.width) <= 2 && Math.abs(view.height - target.height) <= 2;
}

// 允许高德内部墨卡托像素取整与 HiDPI 亚像素尺寸误差，同时足以拦截未切换前的旧城市视野。
function matches(view: Viewport | null, target: Viewport) {
  return sizeMatches(view, target) && view!.style === target.style &&
    Math.abs(view!.center[0] - target.center[0]) <= 0.0005 &&
    Math.abs(view!.center[1] - target.center[1]) <= 0.0005 &&
    Math.abs(view!.zoom - target.zoom) <= 0.05;
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
  const { key } = getAmapConfig();
  const sceneKey = JSON.stringify([documentKey, viewport.style, width, height]);
  const latest = useRef({ ...options, sceneKey });
  useLayoutEffect(() => { latest.current = { ...options, sceneKey }; });
  const mapRef = useRef<any>(null);
  const initialized = useRef(false);
  const appliedStyle = useRef<string>(viewport.style);
  const completed = useRef<Viewport | null>(null);
  const echoed = useRef<PendingViewport | null>(null);
  const pending = useRef<PendingViewport | null>(null);
  const frame = useRef<number | null>(null);
  const settleFrame = useRef<number | null>(null);
  const interactionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<{ readyKey: string | null; error: string }>({ readyKey: null, error: '' });
  const [renderTick, setRenderTick] = useState(0);

  const clearTimers = useCallback(() => {
    if (settleFrame.current !== null) {
      cancelAnimationFrame(settleFrame.current);
      settleFrame.current = null;
    }
    if (loadTimer.current !== null) {
      clearTimeout(loadTimer.current);
      loadTimer.current = null;
    }
  }, []);

  const scheduleRender = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => { frame.current = null; setRenderTick(tick => tick + 1); });
  }, []);

  const commitReady = useCallback((requestKey: string, settledView: Viewport) => {
    completed.current = settledView;
    pending.current = null;
    clearTimers();
    latest.current.onInteractionChange(false);
    // 就绪状态和投影刷新在同一次提交中生效，首次可见帧只使用目标视野的投影。
    setState({ readyKey: requestKey, error: '' });
    setRenderTick(tick => tick + 1);
  }, [clearTimers]);

  const reveal = useCallback(() => {
    const request = pending.current;
    const map = mapRef.current;
    if (!request || !map || request.key !== latest.current.sceneKey || !latest.current.enabled) return false;
    const current = readViewport(map, appliedStyle.current);
    if (!matches(completed.current, request) || !matches(current, request)) return false;
    commitReady(request.key, current!);
    return true;
  }, [commitReady]);

  // 高德 JS API 2.0 的 `complete` 事件在同一个 AMap.Map 实例生命周期内只会在首次初始化时触发一次；
  // 后续切换存档调用 setZoomAndCenter / setMapStyle 或容器 resize 不会再次触发 `complete`。
  // 因此实例完成首次初始化后，在下一动画帧确认底图尺寸和投影已就位即可安全解锁新场景（兼容高德对超界 zoom/经纬度的限幅）。
  const scheduleInitializedSettle = useCallback((target: PendingViewport) => {
    if (!initialized.current) return;
    if (settleFrame.current !== null) cancelAnimationFrame(settleFrame.current);
    settleFrame.current = requestAnimationFrame(() => {
      settleFrame.current = null;
      const map = mapRef.current;
      if (!initialized.current || !map || pending.current !== target ||
        target.key !== latest.current.sceneKey || !latest.current.enabled) return;
      const current = readViewport(map, appliedStyle.current);
      if (!sizeMatches(current, target) || current!.style !== target.style) return;
      commitReady(target.key, current!);
    });
  }, [commitReady]);

  const applyViewport = useCallback(() => {
    const map = mapRef.current;
    const input = latest.current;
    if (!map || !input.enabled || input.documentLoading) return;
    const target: PendingViewport = { ...input.viewport, width: input.width, height: input.height, key: input.sceneKey };
    const current = readViewport(map, appliedStyle.current);
    const needsMove = !current || Math.abs(current.center[0] - target.center[0]) > 0.0005 ||
      Math.abs(current.center[1] - target.center[1]) > 0.0005 || Math.abs(current.zoom - target.zoom) > 0.05;
    const needsStyle = appliedStyle.current !== target.style;
    const needsResize = !sizeMatches(current, target);
    // 普通拖动结束后的状态回写或同视野切换存档，不重新加载底图，也不打断交互。
    if (!pending.current && !needsMove && !needsStyle && !needsResize && matches(current, target) &&
      (initialized.current || matches(completed.current, target) ||
        (echoed.current?.key === target.key && matches(echoed.current, target)))) {
      clearTimers();
      setState(previous => previous.readyKey === target.key && !previous.error ? previous : { readyKey: target.key, error: '' });
      scheduleRender();
      return;
    }
    pending.current = target;
    setState({ readyKey: null, error: '' });
    clearTimers();
    // 超时只显示错误，不按固定延时放出错误坐标；迟到的 complete 仍可正常恢复。
    loadTimer.current = setTimeout(() => {
      if (pending.current === target) setState({ readyKey: null, error: '底图加载较慢，请检查网络连接，加载完成后会自动显示线网。' });
    }, 20_000);
    if (needsStyle) {
      completed.current = null;
      appliedStyle.current = target.style;
      map.setMapStyle?.(`amap://styles/${target.style}`);
    }
    if (needsResize) {
      map.resize?.();
    }
    // 打开存档直接跳到目标视野；日常手动拖动、缩放仍由 SDK 保持平滑。
    if (needsMove) map.setZoomAndCenter?.(target.zoom, target.center, true, 0);
    if (!reveal() && initialized.current) {
      scheduleInitializedSettle(target);
    }
  }, [clearTimers, reveal, scheduleInitializedSettle, scheduleRender]);

  useEffect(() => {
    if (!enabled) {
      clearTimers();
      setState({ readyKey: null, error: '' });
      return;
    }
    if (!key) {
      clearTimers();
      setState({ readyKey: null, error: '地理底图初始化配置无效' });
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
      initialized.current = false;
      appliedStyle.current = desired.style;
      completed.current = null;
      const live = () => !disposed && mapRef.current === map;
      const handleComplete = () => {
        if (!live()) return;
        const wasInitialized = initialized.current;
        initialized.current = true;
        const view = readViewport(map, appliedStyle.current);
        completed.current = view;
        if (reveal()) {
          scheduleRender();
          return;
        }
        // 若首次初始化期间用户切换了目标存档，或高德对初始缩放做了限幅，立即同步到最新目标视野。
        if (!wasInitialized && pending.current && view) {
          const req = pending.current;
          if (appliedStyle.current !== req.style) {
            appliedStyle.current = req.style;
            map.setMapStyle?.(`amap://styles/${req.style}`);
          }
          if (!matches(view, req)) {
            map.setZoomAndCenter?.(req.zoom, req.center, true, 0);
          }
          if (!reveal()) scheduleInitializedSettle(req);
        }
        scheduleRender();
      };
      const handleResize = () => {
        if (!live()) return;
        if (pending.current && initialized.current) {
          const view = readViewport(map, appliedStyle.current);
          if (matches(view, pending.current)) {
            commitReady(pending.current.key, view!);
            return;
          }
          scheduleInitializedSettle(pending.current);
        }
        scheduleRender();
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
        } else if (pending.current && initialized.current) {
          scheduleInitializedSettle(pending.current);
        }
        scheduleRender();
        if (interactionTimer.current !== null) clearTimeout(interactionTimer.current);
        interactionTimer.current = setTimeout(() => {
          interactionTimer.current = null;
          if (live()) { latest.current.onInteractionChange(false); scheduleRender(); }
        }, 120);
      };
      const events: Array<[string, () => void]> = [['complete', handleComplete], ['resize', handleResize],
        ['movestart', handleStart], ['zoomstart', handleStart], ['mapmove', scheduleRender], ['zoomchange', scheduleRender],
        ['moveend', handleEnd], ['zoomend', handleEnd]];
      events.forEach(([event, handler]) => map.on(event, handler));
      disposeMap = () => {
        events.forEach(([event, handler]) => map.off?.(event, handler));
        map.destroy?.();
        if (mapRef.current === map) mapRef.current = null;
        initialized.current = false;
      };
      applyViewport();
    }).catch(error => {
      if (!disposed) setState({ readyKey: null, error: error?.message || '地理底图加载失败' });
    });
    return () => {
      disposed = true;
      disposeMap?.();
      pending.current = null; completed.current = null; echoed.current = null; initialized.current = false;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      if (interactionTimer.current !== null) clearTimeout(interactionTimer.current);
      interactionTimer.current = null;
      clearTimers();
      latest.current.onInteractionChange(false);
    };
  }, [enabled, key, containerRef, applyViewport, clearTimers, commitReady, reveal, scheduleInitializedSettle, scheduleRender]);

  useLayoutEffect(() => { applyViewport(); }, [applyViewport, enabled, sceneKey, options.documentLoading,
    viewport.zoom, longitude, latitude]);

  return { mapRef, ready: enabled && state.readyKey === sceneKey, error: state.error, renderTick };
}
