import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { Stage, Layer, Circle, Text, Group, Line, Rect } from 'react-konva';
import { Input, Button, message, ColorPicker, Select, Dropdown, Tooltip } from 'antd';
import {
  DownOutlined,
  SelectOutlined,
  EnvironmentOutlined,
  NodeIndexOutlined,
  LineOutlined,
  DragOutlined
} from '@ant-design/icons';
import { MapSettings, Station, Line as LineType, Section, Waypoint, LINE_COLORS } from '../types';
import { getCityStylePreset } from '../stylePresets';
import { getAmapConfig, loadAmap } from '../amapLoader';
import { createId } from '../utils/id';
import DraggableModal from './DraggableModal';

const STATION_RADIUS = 18;
const DEFAULT_CANVAS_BACKGROUND_COLOR = '#fafbfc';
const GUIDE_THRESHOLD_DEG = 10;
const SNAP_THRESHOLD_DEG = 2;
const SNAP_ANGLES = [0, 45, 90, 135];
const MAX_WAYPOINTS_PER_SECTION = 6;
const SECTION_HIT_STROKE_WIDTH = 22;
const CANVAS_THEME_PALETTES = {
  light: {
    background: '#fbfdff',
    lineGuide: '#94a3b8',
    activeGuide: '#2563eb',
    drawingLine: '#2563eb',
    stationStroke: '#ffffff',
    inactiveStationFill: '#10b981',
    stationText: '#ffffff',
    labelText: '#0f172a',
    labelShadow: 'rgba(255,255,255,0.92)',
    dotShadow: 'rgba(15,23,42,0.2)',
    waypointFill: '#ffffff',
    waypointStroke: '#2563eb',
    waypointShadow: 'rgba(37,99,235,0.24)',
    lineShadowOpacity: 0.28,
    menuSurface: '#ffffff',
    menuText: '#1f2937',
    menuMuted: '#94a3b8',
    menuShadow: '0 8px 24px rgba(15,23,42,0.12)'
  },
  dark: {
    background: '#07111f',
    lineGuide: '#475569',
    activeGuide: '#93c5fd',
    drawingLine: '#93c5fd',
    stationStroke: '#07111f',
    inactiveStationFill: '#0f766e',
    stationText: '#ffffff',
    labelText: '#f8fafc',
    labelShadow: 'rgba(2,6,23,0.95)',
    dotShadow: 'rgba(147,197,253,0.34)',
    waypointFill: '#07111f',
    waypointStroke: '#93c5fd',
    waypointShadow: 'rgba(147,197,253,0.36)',
    lineShadowOpacity: 0.56,
    menuSurface: '#0f172a',
    menuText: '#e5eefc',
    menuMuted: '#94a3b8',
    menuShadow: '0 12px 28px rgba(0,0,0,0.34)'
  }
} as const;

const getDefaultCanvasBackground = (theme: MapSettings['canvasTheme']) =>
  CANVAS_THEME_PALETTES[theme].background;

const DEFAULT_AMAP_SETTINGS = {
  center: [116.397428, 39.90923] as [number, number],
  zoom: 11,
  style: 'normal' as const
};

type CanvasTool = 'select' | 'station' | 'line' | 'section' | 'pan';

interface CanvasProps {
  currentLineId: string | null;
  lines: LineType[];
  sections: Section[];
  stations: Station[];
  mapSettings: MapSettings;
  language?: 'zh-CN' | 'en-US';
  onAddStation: (station: Station) => void;
  onUpdateStation: (station: Station) => void;
  onAddStationToLine: (
    stationId: string,
    options?: { mode?: 'default' | 'connect' | 'only'; connectToStationId?: string }
  ) => void;
  onRenameStation: (stationId: string, name: string) => void;
  onDeleteSection: (sectionId: string) => void;
  onReorderStations: (lineId: string, stationIds: string[]) => void;
  onDeleteStation: (stationId: string) => void;
  onUpdateStations?: (stations: Station[]) => void;
  onUpdateSection?: (sectionId: string, patch: Partial<Section>) => void;
  onMapSettingsChange?: (settings: MapSettings) => void;
  onStageReady?: (stage: any) => void;
  onBeginInteraction?: () => void;
}

const Canvas: React.FC<CanvasProps> = ({
  currentLineId,
  lines,
  sections,
  stations,
  mapSettings,
  language = 'zh-CN',
  onAddStation,
  onUpdateStation,
  onAddStationToLine,
  onRenameStation,
  onDeleteSection,
  onReorderStations,
  onDeleteStation,
  onUpdateStations,
  onUpdateSection,
  onMapSettingsChange,
  onStageReady,
  onBeginInteraction
}) => {
  const text = language === 'en-US'
    ? {
        tools: {
          select: 'Select',
          station: 'Station',
          line: 'Connect',
          section: 'Section',
          pan: 'Pan'
        },
        hints: {
          select: 'Select mode: click stations for details, right-click stations or sections to edit.',
          station: 'Station mode: click blank canvas to add stations.',
          lineIdle: 'Connect mode: click a start station, then click an end station to build line order.',
          lineDrawing: (name: string) => `Connecting from ${name}. Click an end station to finish, Esc to cancel.`,
          section: 'Section mode: click existing section lines to add or manage waypoints.',
          pan: 'Pan mode: drag blank canvas to move the view, mouse wheel to zoom.'
        },
        zoomIn: 'Zoom in',
        zoomOut: 'Zoom out',
        fitView: 'Fit view',
        resetView: 'Reset view',
        zoom: 'Zoom'
      }
    : {
        tools: {
          select: '选择',
          station: '站点',
          line: '连线',
          section: '区间',
          pan: '移动'
        },
        hints: {
          select: '选择模式：点击站点查看信息，右键编辑站点或区间。',
          station: '站点模式：点击空白画布添加站点。',
          lineIdle: '连线模式：先点击起点站，再点击终点站建立线路顺序。',
          lineDrawing: (name: string) => `连线中：从 ${name} 出发，点击终点站完成连接，Esc 取消。`,
          section: '区间模式：点击已有区间线条，添加或管理途经点。',
          pan: '移动模式：拖拽空白画布调整视图，滚轮缩放。'
        },
        zoomIn: '放大',
        zoomOut: '缩小',
        fitView: '适应视图',
        resetView: '重置视图',
        zoom: '缩放'
      };
  // 记录鼠标按下位置
  const [mouseDownPosition, setMouseDownPosition] = useState<{ x: number; y: number } | null>(null);
  const [canvasBackgroundColor, setCanvasBackgroundColor] = useState<string>(() =>
    getDefaultCanvasBackground(mapSettings.canvasTheme)
  );
  const [canvasBackgroundImage, setCanvasBackgroundImage] = useState<string | null>(null);
  const [canvasContextMenu, setCanvasContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
  }>({
    visible: false,
    x: 0,
    y: 0
  });
  const [canvasColorModal, setCanvasColorModal] = useState<{
    visible: boolean;
    currentColor: string;
    showPicker: boolean;
  }>({
    visible: false,
    currentColor: getDefaultCanvasBackground(mapSettings.canvasTheme),
    showPicker: false
  });
  // 右键点击标志
  const lastIsRightClickRef = useRef(false);
  // 区间右键菜单相关状态
  const [sectionContextMenu, setSectionContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    sectionKey: string | null;
    waypointIndex: number | null;
    waypointOnly: boolean;
  }>({
    visible: false,
    x: 0,
    y: 0,
    sectionKey: null,
    waypointIndex: null,
    waypointOnly: false
  });
  const [adding, setAdding] = useState(false);
  const [newStation, setNewStation] = useState<{ x: number; y: number; lng?: number; lat?: number } | null>(null);
  const [stationName, setStationName] = useState('');
  const [activeTool, setActiveTool] = useState<CanvasTool>('station');
  
  // 绘制模式相关状态
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [isSectionMode, setIsSectionMode] = useState(false); // 区间绘制模式
  const [selectedSection, setSelectedSection] = useState<{ sectionId: string; lineId: string; startStation: Station; endStation: Station } | null>(null);
  const [addingWaypoint, setAddingWaypoint] = useState(false);

  // 从 sections 中读取某区间的途经点
  const getSectionWaypoints = (sectionId: string): Waypoint[] =>
    sections.find(section => section.id === sectionId)?.waypoints || [];

  // 写回某区间的途经点（保存前快照交给上层 onBeginInteraction 决定）
  const writeSectionWaypoints = (sectionId: string, nextWaypoints: Waypoint[]) => {
    if (!onUpdateSection) return;
    const patch: Partial<Section> = { waypoints: nextWaypoints.length ? nextWaypoints : undefined };
    onUpdateSection(sectionId, patch);
  };
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawingLine, setDrawingLine] = useState<{ startStation: Station | null; points: number[] }>({
    startStation: null,
    points: []
  });
  const [drawingStartPoint, setDrawingStartPoint] = useState<{ x: number; y: number } | null>(null);
  const setCanvasTool = (tool: CanvasTool) => {
    setActiveTool(tool);
    setIsDrawingMode(tool === 'line');
    if (tool !== 'line') {
      setDrawingLine({ startStation: null, points: [] });
      setIsDrawing(false);
    }
    if (tool !== 'section') {
      setIsSectionMode(false);
      setSelectedSection(null);
      setAddingWaypoint(false);
    } else {
      setIsSectionMode(true);
    }
  };
  
  // 缩放相关状态
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [lastPointerPosition, setLastPointerPosition] = useState({ x: 0, y: 0 });
  
  // 线段点击相关状态
  const [lineSegmentClick, setLineSegmentClick] = useState<{
    lineId: string;
    startStation: Station;
    endStation: Station;
    clickPosition: { x: number; y: number };
  } | null>(null);
  
  // 站点右键菜单相关状态
  const [stationContextMenu, setStationContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    station: Station | null;
  }>({
    visible: false,
    x: 0,
    y: 0,
    station: null
  });
  const [showConnectAction, setShowConnectAction] = useState(false);
  const [connectModal, setConnectModal] = useState<{ visible: boolean; station: Station | null }>({
    visible: false,
    station: null
  });
  const [selectedConnectStationId, setSelectedConnectStationId] = useState<string | undefined>(undefined);
  const [renameStationModal, setRenameStationModal] = useState<{ visible: boolean; station: Station | null; name: string }>({
    visible: false,
    station: null,
    name: ''
  });
  const [stationInfoModal, setStationInfoModal] = useState<{ visible: boolean; station: Station | null; note: string }>({
    visible: false,
    station: null,
    note: ''
  });
  const [activeCalibrationGuides, setActiveCalibrationGuides] = useState<number[][]>([]);
  
  const containerRef = useRef<HTMLDivElement | null>(null);
  const amapContainerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<any>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 960, height: 640 });
  const amapRef = useRef<any>(null);
  const amapOverlayFrameRef = useRef<number | null>(null);
  const amapInteractionEndTimerRef = useRef<number | null>(null);
  const lastPointerPositionRef = useRef({ x: 0, y: 0 });
  const latestMapSettingsRef = useRef(mapSettings);
  const previousBaseMapModeRef = useRef(mapSettings.baseMap.mode);
  const [amapReady, setAmapReady] = useState(false);
  const [amapError, setAmapError] = useState('');
  const [mapRenderTick, setMapRenderTick] = useState(0);
  const [isMapInteracting, setIsMapInteracting] = useState(false);
  const isAmapMode = mapSettings.baseMap.mode === 'amap';
  const amapEnv = getAmapConfig();

  useEffect(() => {
    latestMapSettingsRef.current = mapSettings;
  }, [mapSettings]);

  useEffect(() => {
    if (onStageReady && stageRef.current) {
      onStageReady(stageRef.current);
    }
  }, [onStageReady]);

  // 监听ESC键取消绘制和全局点击关闭右键菜单
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isDrawing) {
          cancelDrawing();
        } else if (isDrawingMode) {
          setIsDrawingMode(false);
          setActiveTool('select');
        }
        // ESC键也关闭右键菜单
        closeStationContextMenu();
      }
    };

    const handleGlobalClick = (e: MouseEvent) => {
      // 如果点击的不是右键菜单内的元素，则关闭菜单
      const target = e.target as HTMLElement;
      if (!target.closest('.station-context-menu')) {
        closeStationContextMenu();
      }
      if (!target.closest('.canvas-context-menu')) {
        setCanvasContextMenu(prev => ({ ...prev, visible: false }));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('click', handleGlobalClick);
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('click', handleGlobalClick);
    };
  }, [isDrawing, isDrawingMode]);

  useEffect(() => {
    return () => {
      if (canvasBackgroundImage) {
        URL.revokeObjectURL(canvasBackgroundImage);
      }
    };
  }, [canvasBackgroundImage]);

  useEffect(() => {
    setCanvasBackgroundColor(getDefaultCanvasBackground(mapSettings.canvasTheme));
  }, [mapSettings.canvasTheme]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const syncStageSize = () => {
      const nextWidth = Math.max(320, Math.floor(element.clientWidth));
      const nextHeight = Math.max(320, Math.floor(element.clientHeight));
      setStageSize((prev) =>
        prev.width === nextWidth && prev.height === nextHeight
          ? prev
          : { width: nextWidth, height: nextHeight }
      );
    };

    syncStageSize();

    const observer = new ResizeObserver(() => {
      syncStageSize();
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isAmapMode) {
      if (amapInteractionEndTimerRef.current !== null) {
        window.clearTimeout(amapInteractionEndTimerRef.current);
        amapInteractionEndTimerRef.current = null;
      }
      if (amapRef.current) {
        amapRef.current.destroy?.();
        amapRef.current = null;
      }
      setIsMapInteracting(false);
      setAmapReady(false);
      setAmapError('');
      return;
    }

    if (!amapEnv.key || !amapEnv.securityCode) {
      setAmapError('请先配置 REACT_APP_AMAP_KEY 和 REACT_APP_AMAP_SECURITY_CODE');
      setAmapReady(false);
      return;
    }

    let disposed = false;
    loadAmap()
      .then((AMap) => {
        if (disposed || !amapContainerRef.current) return;
        if (!amapRef.current) {
          const scheduleOverlayRender = () => {
            if (amapOverlayFrameRef.current !== null) return;
            amapOverlayFrameRef.current = window.requestAnimationFrame(() => {
              amapOverlayFrameRef.current = null;
              setMapRenderTick(tick => tick + 1);
            });
          };
          const amapOptions = mapSettings.baseMap.amap || {
            center: [116.397428, 39.90923] as [number, number],
            zoom: 11,
            style: 'normal' as const
          };
          const map = new AMap.Map(amapContainerRef.current, {
            center: amapOptions.center,
            zoom: amapOptions.zoom,
            viewMode: '2D',
            mapStyle: `amap://styles/${amapOptions.style}`,
            resizeEnable: true
          });
          amapRef.current = map;
          const syncSettings = () => {
            const center = map.getCenter();
            const zoom = map.getZoom();
            const latestSettings = latestMapSettingsRef.current;
            onMapSettingsChange?.({
              ...latestSettings,
              baseMap: {
                mode: 'amap',
                amap: {
                  ...(latestSettings.baseMap.amap || DEFAULT_AMAP_SETTINGS),
                  center: [center.lng, center.lat],
                  zoom
                }
              }
            });
          };
          const startMapInteraction = () => {
            if (amapInteractionEndTimerRef.current !== null) {
              window.clearTimeout(amapInteractionEndTimerRef.current);
              amapInteractionEndTimerRef.current = null;
            }
            setIsMapInteracting(true);
            scheduleOverlayRender();
          };
          const finishMapInteraction = () => {
            syncSettings();
            scheduleOverlayRender();
            if (amapInteractionEndTimerRef.current !== null) {
              window.clearTimeout(amapInteractionEndTimerRef.current);
            }
            amapInteractionEndTimerRef.current = window.setTimeout(() => {
              amapInteractionEndTimerRef.current = null;
              setIsMapInteracting(false);
              scheduleOverlayRender();
            }, 120);
          };
          map.on('movestart', startMapInteraction);
          map.on('zoomstart', startMapInteraction);
          map.on('mapmove', scheduleOverlayRender);
          map.on('zoomchange', scheduleOverlayRender);
          map.on('moveend', finishMapInteraction);
          map.on('zoomend', finishMapInteraction);
        }
        setAmapReady(true);
        setAmapError('');
        setMapRenderTick(tick => tick + 1);
      })
      .catch(error => {
        if (!disposed) {
          setAmapError(error?.message || '高德地图加载失败');
          setAmapReady(false);
        }
      });

    return () => {
      disposed = true;
      if (amapOverlayFrameRef.current !== null) {
        window.cancelAnimationFrame(amapOverlayFrameRef.current);
        amapOverlayFrameRef.current = null;
      }
      if (amapInteractionEndTimerRef.current !== null) {
        window.clearTimeout(amapInteractionEndTimerRef.current);
        amapInteractionEndTimerRef.current = null;
      }
    };
  }, [isAmapMode, amapEnv.key, amapEnv.securityCode]);

  useEffect(() => {
    const map = amapRef.current;
    const amapOptions = mapSettings.baseMap.amap;
    if (!isAmapMode || !map || !amapOptions) return;
    map.setMapStyle?.(`amap://styles/${amapOptions.style}`);
    const currentCenter = map.getCenter?.();
    const currentZoom = map.getZoom?.();
    const shouldMove =
      !currentCenter ||
      Math.abs(currentCenter.lng - amapOptions.center[0]) > 0.000001 ||
      Math.abs(currentCenter.lat - amapOptions.center[1]) > 0.000001 ||
      Math.abs((currentZoom || amapOptions.zoom) - amapOptions.zoom) > 0.01;
    if (shouldMove) {
      map.setZoomAndCenter?.(amapOptions.zoom, amapOptions.center);
    }
    setMapRenderTick(tick => tick + 1);
  }, [
    isAmapMode,
    mapSettings.baseMap.amap?.style,
    mapSettings.baseMap.amap?.zoom,
    mapSettings.baseMap.amap?.center?.[0],
    mapSettings.baseMap.amap?.center?.[1]
  ]);

  // 站点像素坐标缓存：AMap 模式下根据经纬度投影，否则用 station.x/y。
  // 依赖 mapRenderTick 是为了在 AMap pan/zoom 后强制重算（amapRef.current 不会触发 React 重渲染）。
  const stationDisplayPoints = useMemo(() => {
    const map = amapRef.current;
    return stations.reduce<Record<string, { x: number; y: number }>>((result, station) => {
      if (isAmapMode && amapReady && map && typeof station.lng === 'number' && typeof station.lat === 'number') {
        const pixel = map.lngLatToContainer?.([station.lng, station.lat]);
        if (pixel) {
          result[station.id] = { x: pixel.x, y: pixel.y };
          return result;
        }
      }
      result[station.id] = { x: station.x, y: station.y };
      return result;
    }, {});
  }, [stations, isAmapMode, amapReady, mapRenderTick]);

  const getDisplayPoint = (station: Station) => stationDisplayPoints[station.id] || { x: station.x, y: station.y };

  const getWaypointDisplayPoint = (point: Waypoint) => {
    void mapRenderTick;
    const map = amapRef.current;
    if (isAmapMode && amapReady && map && typeof point.lng === 'number' && typeof point.lat === 'number') {
      const pixel = map.lngLatToContainer?.([point.lng, point.lat]);
      if (pixel) {
        return { x: pixel.x, y: pixel.y };
      }
    }
    return { x: point.x, y: point.y };
  };

  const getPointerWorldPosition = (stage: any, pointer: { x: number; y: number }) => {
    if (isAmapMode) return { x: pointer.x, y: pointer.y };
    return {
      x: (pointer.x - stage.x()) / stage.scaleX(),
      y: (pointer.y - stage.y()) / stage.scaleY()
    };
  };

  const getLngLatFromContainerPoint = (point: { x: number; y: number }) => {
    const map = amapRef.current;
    const AMap = (window as any).AMap;
    if (!isAmapMode || !amapReady || !map || !AMap?.Pixel) return null;
    const lngLat = map.containerToLngLat?.(new AMap.Pixel(point.x, point.y));
    if (!lngLat) return null;
    return { lng: lngLat.lng, lat: lngLat.lat };
  };

  const projectLngLatToContainerPoint = (lng?: number, lat?: number) => {
    const map = amapRef.current;
    if (!map || typeof lng !== 'number' || typeof lat !== 'number') return null;
    const pixel = map.lngLatToContainer?.([lng, lat]);
    return pixel ? { x: pixel.x, y: pixel.y } : null;
  };

  useLayoutEffect(() => {
    const previousMode = previousBaseMapModeRef.current;
    if (previousMode === 'amap' && !isAmapMode && amapRef.current) {
      const frozenStations = stations.map(station => {
        const point = projectLngLatToContainerPoint(station.lng, station.lat);
        return point ? { ...station, ...point } : station;
      });

      onUpdateStations?.(frozenStations);
      if (onUpdateSection) {
        sections.forEach(section => {
          if (!section.waypoints?.length) return;
          const nextWaypoints = section.waypoints.map(point => {
            const projected = projectLngLatToContainerPoint(point.lng, point.lat);
            return projected ? { ...point, ...projected } : point;
          });
          onUpdateSection(section.id, { waypoints: nextWaypoints });
        });
      }
      setScale(1);
      setPosition({ x: 0, y: 0 });
      setIsMapInteracting(false);
      setSelectedSection(null);
      setAddingWaypoint(false);
      setActiveCalibrationGuides([]);
      setSectionContextMenu({ visible: false, x: 0, y: 0, sectionKey: null, waypointIndex: null, waypointOnly: false });
      setCanvasContextMenu({ visible: false, x: 0, y: 0 });
    }
    previousBaseMapModeRef.current = mapSettings.baseMap.mode;
  }, [isAmapMode, mapSettings.baseMap.mode, onUpdateStations, onUpdateSection, sections, stations]);

  // 处理鼠标滚轮缩放
  const handleWheel = (e: any) => {
    e.evt.preventDefault();
    if (isAmapMode && amapRef.current) {
      const currentZoom = amapRef.current.getZoom?.() || mapSettings.baseMap.amap?.zoom || 11;
      const nextZoom = e.evt.deltaY > 0 ? currentZoom - 0.35 : currentZoom + 0.35;
      amapRef.current.setZoom?.(Math.max(3, Math.min(20, nextZoom)));
      return;
    }
    
    const stage = e.target.getStage();
    const oldScale = stage.scaleX();
    const pointer = stage.getPointerPosition();
    
    const mousePointTo = {
      x: (pointer.x - stage.x()) / oldScale,
      y: (pointer.y - stage.y()) / oldScale,
    };

    const newScale = e.evt.deltaY > 0 ? oldScale * 0.9 : oldScale * 1.1;
    
    // 限制缩放范围
    const clampedScale = Math.max(0.1, Math.min(5, newScale));
    
    setScale(clampedScale);
    setPosition({
      x: pointer.x - mousePointTo.x * clampedScale,
      y: pointer.y - mousePointTo.y * clampedScale,
    });
  };

  // 处理拖拽开始
  const handleMouseDown = (e: any) => {
    // 关闭右键菜单
    closeStationContextMenu();
    setCanvasContextMenu(prev => ({ ...prev, visible: false }));
    if (e.target === e.target.getStage()) {
      const pos = e.target.getPointerPosition();
      setIsDragging(activeTool === 'pan');
      lastPointerPositionRef.current = pos;
      if (!isAmapMode) {
        setLastPointerPosition(pos);
      }
      setMouseDownPosition(pos);
    }
  };

  // 处理拖拽移动
  const handleMouseMove = (e: any) => {
    if (isDragging && activeTool === 'pan') {
      const stage = e.target.getStage();
      const pointer = stage.getPointerPosition();
      if (isAmapMode && amapRef.current) {
        const lastPointer = lastPointerPositionRef.current;
        amapRef.current.panBy?.(pointer.x - lastPointer.x, pointer.y - lastPointer.y);
        lastPointerPositionRef.current = pointer;
        return;
      }
      
      setPosition({
        x: position.x + (pointer.x - lastPointerPosition.x),
        y: position.y + (pointer.y - lastPointerPosition.y),
      });
      
      setLastPointerPosition(pointer);
    }
    
    // 原有的绘制模式鼠标移动逻辑
    if (isDrawing && drawingLine.startStation && drawingStartPoint) {
      const stage = e.target.getStage();
      const pointer = stage.getPointerPosition();
      
      // 转换为世界坐标
      const worldPos = {
        ...getPointerWorldPosition(stage, pointer)
      };
      
      setDrawingLine(prev => ({
        ...prev,
        points: [
          drawingStartPoint.x,
          drawingStartPoint.y,
          worldPos.x,
          worldPos.y
        ]
      }));
    }
  };

  // 处理拖拽结束
  // 处理拖拽结束，判断是否为单击
  const handleMouseUp = (e?: any) => {
    let isClick = false;
    if (mouseDownPosition && e && e.target && e.target.getStage) {
      const pointer = e.target.getStage().getPointerPosition();
      if (pointer) {
        const dx = Math.abs(pointer.x - mouseDownPosition.x);
        const dy = Math.abs(pointer.y - mouseDownPosition.y);
        if (dx < 3 && dy < 3) {
          isClick = true;
        }
      }
    }
    setIsDragging(false);
    setMouseDownPosition(null);
    // 只有真正单击才弹窗
    if (isClick && e && e.evt && e.evt.button === 0 && !isSectionMode) {
      handleStageClick(e);
    }
  };

  // 重置视图
  const resetView = () => {
    if (isAmapMode && amapRef.current) {
      const amapOptions = mapSettings.baseMap.amap || DEFAULT_AMAP_SETTINGS;
      amapRef.current.setZoomAndCenter?.(amapOptions.zoom, amapOptions.center);
      return;
    }
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  // 放大
  const zoomIn = () => {
    if (isAmapMode && amapRef.current) {
      amapRef.current.setZoom?.(Math.min(20, (amapRef.current.getZoom?.() || 11) + 1));
      return;
    }
    setScale(prev => Math.min(5, prev * 1.2));
  };

  // 缩小
  const zoomOut = () => {
    if (isAmapMode && amapRef.current) {
      amapRef.current.setZoom?.(Math.max(3, (amapRef.current.getZoom?.() || 11) - 1));
      return;
    }
    setScale(prev => Math.max(0.1, prev / 1.2));
  };

  // 直接跳到某个缩放百分比（仅在纯画布模式下用 —— AMap 自己有标准 zoom 级别，
  // 把"100%"硬塞过去会很别扭，HUD 里 AMap 模式时直接禁用预设下拉）
  const setZoomPercent = (percent: number) => {
    const next = Math.max(0.1, Math.min(5, percent / 100));
    setScale(next);
  };

  // 适应视图
  const fitView = () => {
    if (stations.length === 0) return;
    if (isAmapMode && amapRef.current) {
      const lngLatStations = stations.filter(station => typeof station.lng === 'number' && typeof station.lat === 'number');
      if (lngLatStations.length) {
        const AMap = (window as any).AMap;
        const bounds = new AMap.Bounds(
          [Math.min(...lngLatStations.map(station => station.lng!)), Math.min(...lngLatStations.map(station => station.lat!))],
          [Math.max(...lngLatStations.map(station => station.lng!)), Math.max(...lngLatStations.map(station => station.lat!))]
        );
        amapRef.current.setBounds?.(bounds, false, [80, 80, 80, 80]);
      }
      return;
    }
    
    const minX = Math.min(...stations.map(s => s.x));
    const minY = Math.min(...stations.map(s => s.y));
    const maxX = Math.max(...stations.map(s => s.x));
    const maxY = Math.max(...stations.map(s => s.y));
    
    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const stageWidth = stageSize.width;
    const stageHeight = stageSize.height;
    
    const scaleX = (stageWidth - 100) / contentWidth;
    const scaleY = (stageHeight - 100) / contentHeight;
    const newScale = Math.min(scaleX, scaleY, 2);
    
    setScale(newScale);
    setPosition({
      x: (stageWidth - contentWidth * newScale) / 2 - minX * newScale,
      y: (stageHeight - contentHeight * newScale) / 2 - minY * newScale
    });
  };

  // 画布点击，弹窗输入站名
  const handleStageClick = (e: any) => {
    // 关闭右键菜单
    closeStationContextMenu();
    if (isSectionMode) {
      return;
    }
    
    if (isDrawingMode) {
      handleDrawingModeClick(e);
    } else if (activeTool === 'station') {
      // 检查是否点击了空白区域
    if (e.target === e.target.getStage()) {
        const stage = e.target.getStage();
        const pointer = stage.getPointerPosition();
        
        // 转换为世界坐标
        const worldPos = {
          ...getPointerWorldPosition(stage, pointer),
          ...(getLngLatFromContainerPoint(pointer) || {})
        };
        
        setNewStation(worldPos);
      setAdding(true);
      }
    }
  };

  // 绘制模式下的点击处理
  const handleDrawingModeClick = (e: any) => {
    const stage = e.target.getStage();
    const pointer = stage.getPointerPosition();
    
    // 转换为世界坐标
    const worldPos = {
      ...getPointerWorldPosition(stage, pointer)
    };
    
    // 检查是否点击了站点
    const clickedStation = stations.find(station => {
      const stationPoint = getDisplayPoint(station);
      const distance = Math.sqrt(
        Math.pow(stationPoint.x - worldPos.x, 2) + Math.pow(stationPoint.y - worldPos.y, 2)
      );
      return distance <= 20;
    });
    
    if (clickedStation) {
      if (!drawingLine.startStation) {
        const startPoint = getDisplayPoint(clickedStation);
        // 开始绘制
        setDrawingLine({
          startStation: clickedStation,
          points: [startPoint.x, startPoint.y]
        });
        setDrawingStartPoint(startPoint);
        setIsDrawing(true);
      } else if (drawingLine.startStation.id !== clickedStation.id) {
        // 完成绘制
        completeDrawing(clickedStation);
      }
    }
  };

  // 完成绘制
  const completeDrawing = (endStation: Station) => {
    if (!currentLineId || !drawingLine.startStation) {
      message.warning('请先选择一条线路');
      cancelDrawing();
      return;
    }

    // 获取当前线路
    const currentLine = lines.find(l => l.id === currentLineId);
    if (!currentLine) {
      message.error('线路不存在');
      cancelDrawing();
      return;
    }

    // 构建完整的路径点
    const endPoint = getDisplayPoint(endStation);
    const allPoints = [...drawingLine.points, endPoint.x, endPoint.y];
    
    // 根据路径点确定站点顺序
    const pathStations = getStationsAlongPath(allPoints);
    
    // 更新线路的站点顺序
    onReorderStations(currentLineId, pathStations.map(s => s.id));
    
    message.success(`已更新线路"${currentLine.name}"的站点顺序`);
    onAddStationToLine(endStation.id, {
      mode: 'connect',
      connectToStationId: drawingLine.startStation.id
    });
    cancelDrawing();
  };

  // 取消绘制
  const cancelDrawing = () => {
    setDrawingLine({ startStation: null, points: [] });
    setIsDrawing(false);
  };

  // 根据路径点确定站点顺序
  const getStationsAlongPath = (pathPoints: number[]): Station[] => {
    const pathStations: Station[] = [];
    const usedStationIds = new Set<string>();

    // 添加起始站点
    if (drawingLine.startStation) {
      pathStations.push(drawingLine.startStation);
      usedStationIds.add(drawingLine.startStation.id);
    }

    // 沿着路径查找站点
    for (let i = 0; i < pathPoints.length - 1; i += 2) {
      const x = pathPoints[i];
      const y = pathPoints[i + 1];
      
      // 查找距离当前路径点最近的站点
      let nearestStation: Station | null = null;
      let minDistance = Infinity;
      
      for (const station of stations) {
        if (!usedStationIds.has(station.id)) {
          const stationPoint = getDisplayPoint(station);
          const distance = Math.sqrt(
            Math.pow(stationPoint.x - x, 2) + Math.pow(stationPoint.y - y, 2)
          );
          if (distance < minDistance && distance <= 60) { // 60 = 20 * 3 (站点半径的3倍)
            minDistance = distance;
            nearestStation = station;
          }
        }
      }

      if (nearestStation) {
        pathStations.push(nearestStation);
        usedStationIds.add(nearestStation.id);
      }
    }

    return pathStations;
  };



  // 确认添加站点
  const handleAddStation = () => {
    if (newStation && stationName.trim()) {
      const newStationData: Station = {
        id: createId(),
        name: stationName.trim(),
        x: newStation.x,
        y: newStation.y,
        lng: newStation.lng,
        lat: newStation.lat
      };

      onAddStation(newStationData);

      // 如果是在线段上添加站点，需要更新线路的站点顺序
      if (lineSegmentClick) {
        const { lineId, startStation, endStation } = lineSegmentClick;
        const currentLine = lines.find(l => l.id === lineId);
        
        if (currentLine) {
          const startIndex = currentLine.stationIds.indexOf(startStation.id);
          const endIndex = currentLine.stationIds.indexOf(endStation.id);
          
          if (startIndex !== -1 && endIndex !== -1) {
            const newStationIds = [...currentLine.stationIds];
            const insertIndex = startIndex < endIndex ? startIndex + 1 : endIndex + 1;
            newStationIds.splice(insertIndex, 0, newStationData.id);
            onReorderStations(lineId, newStationIds);
          }
        }
        setLineSegmentClick(null); // 清除线段点击状态
      }

      setAdding(false);
      setNewStation(null);
      setStationName('');
    }
  };

  // 拖动站点（含自动吸附）
  const handleDragMove = (id: string, pos: { x: number; y: number }) => {
    const updatedStation = stations.find(s => s.id === id);
    if (updatedStation) {
      if (isAmapMode) {
        const lngLat = getLngLatFromContainerPoint(pos);
        onUpdateStation({
          ...updatedStation,
          x: pos.x,
          y: pos.y,
          ...(lngLat || {})
        });
        return;
      }
      const connectedStationIds = sections
        .filter(sec => sec.startStationId === id || sec.endStationId === id)
        .map(sec => (sec.startStationId === id ? sec.endStationId : sec.startStationId));
      const connectedStations = connectedStationIds
        .map(stationId => stations.find(s => s.id === stationId))
        .filter(Boolean) as Station[];

      let snappedX = pos.x;
      let snappedY = pos.y;
      const guides: number[][] = [];
      let bestSnapDiff = Number.POSITIVE_INFINITY;

      connectedStations.forEach(st => {
        const guide = buildAxisGuide(st.x, st.y, pos.x, pos.y);
        if (guide) {
          guides.push(guide);
        }
        const snap = getDirectionalSnap(st.x, st.y, pos.x, pos.y, SNAP_THRESHOLD_DEG);
        if (snap && snap.diff < bestSnapDiff) {
          bestSnapDiff = snap.diff;
          snappedX = snap.x;
          snappedY = snap.y;
        }
      });

      setActiveCalibrationGuides(guides);
      onUpdateStation({
        ...updatedStation,
        x: snappedX,
        y: snappedY
      });
    }
  };

  // 处理站点点击
  const handleStationClick = (station: Station, e?: any) => {
    if (lastIsRightClickRef.current) {
      lastIsRightClickRef.current = false;
      return;
    }
    if (e?.evt && e.evt.button !== 0) {
      return;
    }
    if (isDrawingMode) {
      if (e) handleDrawingModeClick(e);
      return;
    }
    setStationInfoModal({
      visible: true,
      station,
      note: station.note || ''
    });
  };

  // 处理站点右键点击
  const handleStationRightClick = (e: any, station: Station) => {
    e.evt.preventDefault();
    lastIsRightClickRef.current = true;
    setShowConnectAction(false);
    
    const stage = e.target.getStage();
    if (stage) {
      const pointer = stage.getPointerPosition();
      if (pointer) {
        setStationContextMenu({
          visible: true,
          x: pointer.x,
          y: pointer.y,
          station
        });
      }
    }
  };

  // 关闭站点右键菜单
  const closeStationContextMenu = () => {
    setShowConnectAction(false);
    setStationContextMenu({
      visible: false,
      x: 0,
      y: 0,
      station: null
    });
  };

  // 删除站点
  const handleDeleteStation = () => {
    if (stationContextMenu.station) {
      onDeleteStation(stationContextMenu.station.id);
      closeStationContextMenu();
    }
  };

  const handleOpenRenameStation = () => {
    if (!stationContextMenu.station) return;
    setRenameStationModal({
      visible: true,
      station: stationContextMenu.station,
      name: stationContextMenu.station.name
    });
    closeStationContextMenu();
  };

  const handleConfirmRenameStation = () => {
    if (!renameStationModal.station) return;
    onRenameStation(renameStationModal.station.id, renameStationModal.name);
    setRenameStationModal({ visible: false, station: null, name: '' });
  };

  const handleSaveStationNote = () => {
    if (!stationInfoModal.station) return;
    onUpdateStation({
      ...stationInfoModal.station,
      note: stationInfoModal.note
    });
    setStationInfoModal(prev => ({ ...prev, station: { ...prev.station!, note: prev.note } }));
    message.success('站点附加标注已更新');
  };

  const getCurrentLineStationOptions = (excludeStationId?: string) => {
    if (!currentLineId) return [];
    const currentLine = lines.find(l => l.id === currentLineId);
    if (!currentLine) return [];
    return currentLine.stationIds
      .map(id => stations.find(s => s.id === id))
      .filter(Boolean)
      .filter(s => (excludeStationId ? s!.id !== excludeStationId : true))
      .map(s => ({ label: s!.name, value: s!.id }));
  };

  const handleOpenConnectModal = () => {
    if (!currentLineId) {
      message.warning('请先选择一条线路');
      return;
    }
    const currentStation = stationContextMenu.station;
    if (!currentStation) return;
    const options = getCurrentLineStationOptions(currentStation.id);
    if (!options.length) {
      message.warning('当前线路暂无可连接站点');
      return;
    }
    setConnectModal({ visible: true, station: currentStation });
    setSelectedConnectStationId(options[0].value);
    closeStationContextMenu();
  };

  const handleConfirmConnectToStation = () => {
    if (!connectModal.station || !selectedConnectStationId) {
      message.warning('请选择要连接的站点');
      return;
    }
    onAddStationToLine(connectModal.station.id, {
      mode: 'connect',
      connectToStationId: selectedConnectStationId
    });
    setConnectModal({ visible: false, station: null });
    setSelectedConnectStationId(undefined);
  };

  const getAngleToAxis = (x1: number, y1: number, x2: number, y2: number) => {
    const angle = Math.abs(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI);
    const horizontal = Math.min(angle, Math.abs(180 - angle));
    const vertical = Math.abs(90 - angle);
    return { horizontal, vertical };
  };

  const getDirectionalSnap = (x1: number, y1: number, x2: number, y2: number, threshold: number) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx === 0 && dy === 0) return null;

    const rawAngle = Math.atan2(dy, dx) * 180 / Math.PI;
    const normalizedAngle = ((rawAngle % 180) + 180) % 180;
    const best = SNAP_ANGLES
      .map(angle => {
        const diff = Math.min(Math.abs(normalizedAngle - angle), 180 - Math.abs(normalizedAngle - angle));
        return { angle, diff };
      })
      .sort((a, b) => a.diff - b.diff)[0];

    if (!best || best.diff > threshold) return null;

    const radians = best.angle * Math.PI / 180;
    const ux = Math.cos(radians);
    const uy = Math.sin(radians);
    const projectedLength = dx * ux + dy * uy;
    return {
      x: x1 + ux * projectedLength,
      y: y1 + uy * projectedLength,
      diff: best.diff
    };
  };

  const buildAxisGuide = (x1: number, y1: number, x2: number, y2: number): number[] | null => {
    const snapped = getDirectionalSnap(x1, y1, x2, y2, GUIDE_THRESHOLD_DEG);
    return snapped ? [x1, y1, snapped.x, snapped.y] : null;
  };

  const updateWaypoint = (sectionId: string, waypointIndex: number, x: number, y: number, withGuide = false) => {
    const section = sections.find(sec => sec.id === sectionId);
    if (!section) return;
    const startStation = stations.find(s => s.id === section.startStationId);
    const endStation = stations.find(s => s.id === section.endStationId);
    if (!startStation || !endStation) return;

    const current = section.waypoints || [];
    if (!current[waypointIndex]) return;
    const next = [...current];

    const prevPoint = waypointIndex === 0 ? getDisplayPoint(startStation) : getWaypointDisplayPoint(next[waypointIndex - 1]);
    const nextPoint = waypointIndex === next.length - 1 ? getDisplayPoint(endStation) : getWaypointDisplayPoint(next[waypointIndex + 1]);

    let snappedX = x;
    let snappedY = y;
    const guideLines: number[][] = [];

    const prevGuide = buildAxisGuide(prevPoint.x, prevPoint.y, x, y);
    const nextGuide = buildAxisGuide(x, y, nextPoint.x, nextPoint.y);

    if (prevGuide) guideLines.push(prevGuide);
    if (nextGuide) guideLines.push([x, y, nextGuide[2], nextGuide[3]]);

    const snapCandidates = [
      getDirectionalSnap(prevPoint.x, prevPoint.y, x, y, SNAP_THRESHOLD_DEG),
      getDirectionalSnap(nextPoint.x, nextPoint.y, x, y, SNAP_THRESHOLD_DEG)
    ].filter(Boolean) as Array<{ x: number; y: number; diff: number }>;
    const bestSnap = snapCandidates.sort((a, b) => a.diff - b.diff)[0];
    if (bestSnap) {
      snappedX = bestSnap.x;
      snappedY = bestSnap.y;
    }

    next[waypointIndex] = {
      ...next[waypointIndex],
      x: snappedX,
      y: snappedY,
      ...(getLngLatFromContainerPoint({ x: snappedX, y: snappedY }) || {})
    };
    writeSectionWaypoints(sectionId, next);

    if (withGuide) {
      setActiveCalibrationGuides(guideLines.map(g => [g[0], g[1], g[2], g[3]]));
    }
  };

  const hideWaypoint = (sectionId: string, waypointIndex: number) => {
    onBeginInteraction?.();
    const current = getSectionWaypoints(sectionId);
    writeSectionWaypoints(
      sectionId,
      current.map((point, index) => (index === waypointIndex ? { ...point, hidden: true } : point))
    );
  };

  const showWaypoint = (sectionId: string, waypointIndex: number) => {
    onBeginInteraction?.();
    const current = getSectionWaypoints(sectionId);
    writeSectionWaypoints(
      sectionId,
      current.map((point, index) => (index === waypointIndex ? { ...point, hidden: false } : point))
    );
  };

  const deleteWaypoint = (sectionId: string, waypointIndex: number) => {
    onBeginInteraction?.();
    const current = getSectionWaypoints(sectionId);
    writeSectionWaypoints(
      sectionId,
      current.filter((_, index) => index !== waypointIndex)
    );
  };

  const handleCanvasContextMenu = (e: any) => {
    e.evt.preventDefault();
    const stage = e.target.getStage();
    if (!stage || e.target !== stage) {
      return;
    }
    const pointer = stage.getPointerPosition();
    closeStationContextMenu();
    setSectionContextMenu(prev => ({ ...prev, visible: false, waypointOnly: false }));
    setCanvasContextMenu({
      visible: true,
      x: pointer?.x || 0,
      y: pointer?.y || 0
    });
  };

  const openCanvasColorModal = () => {
    setCanvasContextMenu(prev => ({ ...prev, visible: false }));
    setCanvasColorModal({
      visible: true,
      currentColor: canvasBackgroundColor,
      showPicker: false
    });
  };

  const handleCanvasColorPickerChange = (color: any) => {
    const hex = color?.toHexString ? color.toHexString() : color;
    setCanvasColorModal(prev => ({ ...prev, currentColor: hex, showPicker: false }));
  };

  const handleConfirmCanvasColor = () => {
    setCanvasBackgroundColor(canvasColorModal.currentColor || getDefaultCanvasBackground(mapSettings.canvasTheme));
    setCanvasColorModal({ visible: false, currentColor: canvasColorModal.currentColor, showPicker: false });
  };

  const handleClearBackgroundImage = () => {
    setCanvasContextMenu(prev => ({ ...prev, visible: false }));
    if (canvasBackgroundImage) {
      URL.revokeObjectURL(canvasBackgroundImage);
      setCanvasBackgroundImage(null);
      message.success('已清除背景图片');
    }
  };

  const handleResetCanvasColor = () => {
    setCanvasContextMenu(prev => ({ ...prev, visible: false }));
    setCanvasBackgroundColor(getDefaultCanvasBackground(mapSettings.canvasTheme));
    message.success('已恢复默认画布颜色');
  };

  const triggerImageImport = () => {
    setCanvasContextMenu(prev => ({ ...prev, visible: false }));
    imageInputRef.current?.click();
  };

  const handleImportImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      message.warning('请选择图片文件');
      e.target.value = '';
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    if (canvasBackgroundImage) {
      URL.revokeObjectURL(canvasBackgroundImage);
    }
    setCanvasBackgroundImage(objectUrl);
    message.success('背景图片导入成功');
    e.target.value = '';
  };

  // 处理线段点击，在线段上添加站点
  const handleLineSegmentClick = (lineId: string, startStation: Station, endStation: Station, clickPosition: { x: number; y: number }) => {
    if (isDrawingMode) return; // 绘制模式下不处理线段点击

    // 计算新站点在线段上的位置（投影到线段上）
    const startPoint = getDisplayPoint(startStation);
    const endPoint = getDisplayPoint(endStation);
    const dx = endPoint.x - startPoint.x;
    const dy = endPoint.y - startPoint.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    
    if (length === 0) return;
    
    // 计算点击位置到起点的向量
    const vx = clickPosition.x - startPoint.x;
    const vy = clickPosition.y - startPoint.y;
    
    // 计算投影比例
    const projection = (vx * dx + vy * dy) / (dx * dx + dy * dy);
    const clampedProjection = Math.max(0, Math.min(1, projection));
    
    // 计算新站点的位置
    const projectedPoint = {
      x: startPoint.x + clampedProjection * dx,
      y: startPoint.y + clampedProjection * dy
    };
    const newStationPosition = {
      ...projectedPoint,
      ...(getLngLatFromContainerPoint(projectedPoint) || {})
    };

    setLineSegmentClick({
      lineId,
      startStation,
      endStation,
      clickPosition: newStationPosition
    });

    setNewStation(newStationPosition);
    setStationName('');
    setAdding(true);
  };

  const stylePreset = getCityStylePreset(mapSettings);
  // 每个站点出现在多少条线路里（≥2 即换乘站）。O(stations × lines)，量大时这个缓存意义明显。
  const stationLineCounts = useMemo(() => {
    return stations.reduce<Record<string, number>>((result, station) => {
      result[station.id] = lines.filter(line => line.stationIds.includes(station.id)).length;
      return result;
    }, {});
  }, [stations, lines]);

  // 渲染线路连接线（网状结构）
  const renderLines = () => {
    const segments = sections
      .map(section => {
        const line = lines.find(l => l.id === section.lineId);
        const start = stations.find(s => s.id === section.startStationId);
        const end = stations.find(s => s.id === section.endStationId);
        if (!line || !start || !end) return null;
        return {
          section,
          line,
          start,
          end,
          waypoints: section.waypoints || [],
          normalizedKey: [section.startStationId, section.endStationId].sort().join('_')
        };
      })
      .filter(Boolean) as Array<{
      section: Section;
      line: LineType;
      start: Station;
      end: Station;
      waypoints: Waypoint[];
      normalizedKey: string;
    }>;

    const countMap = new Map<string, number>();
    segments.forEach(seg => countMap.set(seg.normalizedKey, (countMap.get(seg.normalizedKey) || 0) + 1));
    const indexMap = new Map<string, number>();

    const result: JSX.Element[] = [];
    segments.forEach(seg => {
      const total = countMap.get(seg.normalizedKey) || 1;
      const currentIndex = indexMap.get(seg.normalizedKey) || 0;
      indexMap.set(seg.normalizedKey, currentIndex + 1);
      const startPoint = getDisplayPoint(seg.start);
      const endPoint = getDisplayPoint(seg.end);

      const waypointPoints = seg.waypoints.map(point => getWaypointDisplayPoint(point));
      const rawPoints = [startPoint.x, startPoint.y, ...waypointPoints.flatMap(p => [p.x, p.y]), endPoint.x, endPoint.y];
      const dx = endPoint.x - startPoint.x;
      const dy = endPoint.y - startPoint.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const normal = { x: -dy / len, y: dx / len };
      const offset = (currentIndex - (total - 1) / 2) * 8;

      const shiftedPoints: number[] = [];
      for (let i = 0; i < rawPoints.length; i += 2) {
        shiftedPoints.push(rawPoints[i] + normal.x * offset, rawPoints[i + 1] + normal.y * offset);
      }

      const handleSectionLineClick = (e: any) => {
        if (lastIsRightClickRef.current) {
          lastIsRightClickRef.current = false;
          return;
        }
        if (!e.evt || e.evt.button !== 0) return;
        const stage = e.target.getStage();
        if (isSectionMode) {
          setSelectedSection({
            sectionId: seg.section.id,
            lineId: seg.line.id,
            startStation: seg.start,
            endStation: seg.end
          });
        } else if (stage) {
          const pointer = stage.getPointerPosition();
          if (pointer) {
            const worldPos = getPointerWorldPosition(stage, pointer);
            handleLineSegmentClick(seg.line.id, seg.start, seg.end, worldPos);
          }
        }
      };

      const handleSectionLineContextMenu = (e: any) => {
        e.evt.preventDefault();
        lastIsRightClickRef.current = true;
        const stage = e.target.getStage();
        if (!stage) return;
        const pointer = stage.getPointerPosition();
        setSectionContextMenu({
          visible: true,
          x: pointer?.x || 0,
          y: pointer?.y || 0,
          sectionKey: seg.section.id,
          waypointIndex: null,
          waypointOnly: false
        });
      };

      result.push(
        <Line
          key={`${seg.section.id}_${currentIndex}_hit`}
          points={shiftedPoints}
          stroke="rgba(0,0,0,0.001)"
          strokeWidth={Math.max(SECTION_HIT_STROKE_WIDTH, stylePreset.lineWidth + 12)}
          hitStrokeWidth={Math.max(SECTION_HIT_STROKE_WIDTH, stylePreset.lineWidth + 12)}
          lineCap="round"
          lineJoin="round"
          tension={0}
          onClick={handleSectionLineClick}
          onContextMenu={handleSectionLineContextMenu}
        />,
        <Line
          key={`${seg.section.id}_${currentIndex}`}
          points={shiftedPoints}
          stroke={seg.line.color}
          strokeWidth={stylePreset.lineWidth}
          lineCap="round"
          lineJoin="round"
          shadowColor={seg.line.color}
          shadowBlur={isMapInteracting && isAmapMode ? 0 : stylePreset.lineShadowBlur}
          shadowOpacity={isMapInteracting && isAmapMode ? 0 : Math.max(canvasPalette.lineShadowOpacity, stylePreset.lineShadowOpacity)}
          tension={0}
          onClick={handleSectionLineClick}
          onContextMenu={handleSectionLineContextMenu}
        />
      );

      // 校准虚线：显示接近水平/竖直的段
      for (let i = 0; i < shiftedPoints.length - 2; i += 2) {
        const guide = buildAxisGuide(
          shiftedPoints[i],
          shiftedPoints[i + 1],
          shiftedPoints[i + 2],
          shiftedPoints[i + 3]
        );
        if (guide) {
          result.push(
            <Line
              key={`guide_${seg.section.id}_${currentIndex}_${i}`}
              points={guide}
              stroke={canvasPalette.lineGuide}
              strokeWidth={1}
              dash={[6, 6]}
              opacity={0.8}
            />
          );
        }
      }
    });
    return result;
  };

  // 生成直线连接  // 生成直线连接
  const generateStraightLine = (lineStations: Station[]): number[] => {
    if (lineStations.length < 2) return [];

    const points: number[] = [];
    
    // 直接连接相邻站点
    for (let i = 0; i < lineStations.length; i++) {
      points.push(lineStations[i].x, lineStations[i].y);
    }
    
    return points;
  };

  // 获取站点是否在当前线路中
  const isStationInCurrentLine = (stationId: string) => {
    if (!currentLineId) return false;
    const currentLine = lines.find(l => l.id === currentLineId);
    return currentLine?.stationIds.includes(stationId) || false;
  };

  const isDotLabelStyle = mapSettings.mapStyle === 'dot-label';
  const isDarkCanvas = mapSettings.canvasTheme === 'dark';
  const canvasPalette = CANVAS_THEME_PALETTES[mapSettings.canvasTheme];
  const dotLabelStyle = mapSettings.dotLabelStyle;
  const amapStyle = mapSettings.baseMap.amap?.style || 'normal';
  const isLightAmapRender = isAmapMode && isMapInteracting;
  const isMutedAmapStyle = isAmapMode && (amapStyle === 'dark' || amapStyle === 'grey');
  const isFreshAmapStyle = isAmapMode && amapStyle === 'fresh';
  const readableLabelText = isMutedAmapStyle ? '#ffffff' : isFreshAmapStyle ? '#0f172a' : dotLabelStyle.color || canvasPalette.labelText;
  const readableLabelShadow = isMutedAmapStyle ? 'rgba(0, 0, 0, 0.92)' : 'rgba(255, 255, 255, 0.98)';

  type LabelRect = { x: number; y: number; width: number; height: number };

  const rectsOverlap = (a: LabelRect, b: LabelRect) =>
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

  const distanceToSegment = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(px - x1, py - y1);
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  };

  const getStationColor = (stationId: string) => {
    const currentLine = currentLineId ? lines.find(line => line.id === currentLineId) : null;
    if (currentLine?.stationIds.includes(stationId)) return currentLine.color;
    return lines.find(line => line.stationIds.includes(stationId))?.color || '#64748b';
  };

  // 站名标注布局：O(stations × candidates × stations) 量级，必须缓存。
  // 依赖经过精挑：stationDisplayPoints 已捕获 mapRenderTick / AMap 状态等隐式输入。
  const labelPlacements = useMemo(() => {
    if (isLightAmapRender) return {} as Record<string, LabelRect>;
    const pointOf = (station: Station) => stationDisplayPoints[station.id] || { x: station.x, y: station.y };
    const waypointPointOf = (point: Waypoint) => {
      const map = amapRef.current;
      if (isAmapMode && amapReady && map && typeof point.lng === 'number' && typeof point.lat === 'number') {
        const pixel = map.lngLatToContainer?.([point.lng, point.lat]);
        if (pixel) return { x: pixel.x, y: pixel.y };
      }
      return { x: point.x, y: point.y };
    };
    const occupied: LabelRect[] = [];
    const lineSegments = sections
      .map(section => {
        const start = stations.find(station => station.id === section.startStationId);
        const end = stations.find(station => station.id === section.endStationId);
        if (!start || !end) return [];
        const points = [pointOf(start), ...((section.waypoints || []).map(waypointPointOf)), pointOf(end)];
        const segments: Array<[number, number, number, number]> = [];
        for (let i = 0; i < points.length - 1; i += 1) {
          segments.push([points[i].x, points[i].y, points[i + 1].x, points[i + 1].y]);
        }
        return segments;
      })
      .flat();

    return stations.reduce<Record<string, LabelRect>>((result, station) => {
      if (station.labelPosition === 'hidden') return result;
      const stationPoint = pointOf(station);
      const labelWidth = Math.max(44, station.name.length * dotLabelStyle.fontSize);
      const labelHeight = Math.max(22, dotLabelStyle.fontSize + 10);
      const gap = 12;
      const candidates = [
        { key: 'right', x: stationPoint.x + gap, y: stationPoint.y - labelHeight / 2 },
        { key: 'left', x: stationPoint.x - labelWidth - gap, y: stationPoint.y - labelHeight / 2 },
        { key: 'top', x: stationPoint.x - labelWidth / 2, y: stationPoint.y - labelHeight - gap },
        { key: 'bottom', x: stationPoint.x - labelWidth / 2, y: stationPoint.y + gap },
        { key: 'top-right', x: stationPoint.x + gap, y: stationPoint.y - labelHeight - gap },
        { key: 'bottom-right', x: stationPoint.x + gap, y: stationPoint.y + gap },
        { key: 'top-left', x: stationPoint.x - labelWidth - gap, y: stationPoint.y - labelHeight - gap },
        { key: 'bottom-left', x: stationPoint.x - labelWidth - gap, y: stationPoint.y + gap }
      ].filter(candidate => station.labelPosition === 'auto' || !station.labelPosition || candidate.key === station.labelPosition);

      const best = candidates
        .map(candidate => {
          const rect = { x: candidate.x, y: candidate.y, width: labelWidth, height: labelHeight };
          let score = 0;
          occupied.forEach(other => {
            if (rectsOverlap(rect, other)) score += 100;
          });
          stations.forEach(other => {
            const otherPoint = pointOf(other);
            if (other.id !== station.id && rectsOverlap(rect, { x: otherPoint.x - 8, y: otherPoint.y - 8, width: 16, height: 16 })) {
              score += 60;
            }
          });
          if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > stageSize.width || rect.y + rect.height > stageSize.height) {
            score += 40;
          }
          const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
          lineSegments.forEach(([x1, y1, x2, y2]) => {
            if (distanceToSegment(center.x, center.y, x1, y1, x2, y2) < 16) score += 18;
          });
          if (candidate.key === 'right') score -= 6;
          if (candidate.key === 'left') score -= 3;
          return { rect, score };
        })
        .sort((a, b) => a.score - b.score)[0];

      if (best) {
        occupied.push(best.rect);
        result[station.id] = best.rect;
      }
      return result;
    }, {});
  }, [
    isLightAmapRender,
    sections,
    stations,
    dotLabelStyle.fontSize,
    stageSize.width,
    stageSize.height,
    stationDisplayPoints,
    isAmapMode,
    amapReady,
    mapRenderTick
  ]);

  // 线路名标签布局：依赖 labelPlacements + stationDisplayPoints，跟着它们重算就够了
  const lineNamePlacements = useMemo(() => {
    if (isLightAmapRender || !mapSettings.showLineNameLabels || lines.length === 0) return [];
    const pointOf = (station: Station) => stationDisplayPoints[station.id] || { x: station.x, y: station.y };
    const occupied: LabelRect[] = [
      ...Object.values(labelPlacements),
      ...stations.map(station => {
        const point = pointOf(station);
        return {
          x: point.x - stylePreset.interchangeRadius - 8,
          y: point.y - stylePreset.interchangeRadius - 8,
          width: (stylePreset.interchangeRadius + 8) * 2,
          height: (stylePreset.interchangeRadius + 8) * 2
        };
      })
    ];

    const placements: Array<{
      key: string;
      line: LineType;
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];

    lines.forEach(line => {
      const orderedStations = line.stationIds
        .map(id => stations.find(station => station.id === id))
        .filter(Boolean) as Station[];
      if (orderedStations.length < 2) return;

      const labelWidth = Math.max(52, line.name.length * stylePreset.lineLabelFontSize + stylePreset.lineLabelPaddingX * 2);
      const labelHeight = stylePreset.lineLabelFontSize + stylePreset.lineLabelPaddingY * 2 + 2;
      const terminalPairs = [
        { terminal: orderedStations[0], neighbor: orderedStations[1], preference: 0 },
        {
          terminal: orderedStations[orderedStations.length - 1],
          neighbor: orderedStations[orderedStations.length - 2],
          preference: 4
        }
      ];

      const best = terminalPairs
        .flatMap(({ terminal, neighbor, preference }) => {
          if (!terminal || !neighbor) return [];
          const terminalPoint = pointOf(terminal);
          const neighborPoint = pointOf(neighbor);
          const dx = terminalPoint.x - neighborPoint.x;
          const dy = terminalPoint.y - neighborPoint.y;
          const len = Math.hypot(dx, dy) || 1;
          const outward = { x: dx / len, y: dy / len };
          const normal = { x: -outward.y, y: outward.x };
          const baseDistance = Math.max(24, stylePreset.interchangeRadius + 14);
          return [0, labelHeight + 8, -(labelHeight + 8), labelHeight * 2 + 16, -(labelHeight * 2 + 16)].map(
            (sideOffset, index) => {
              const centerX = terminalPoint.x + outward.x * (baseDistance + labelWidth / 2) + normal.x * sideOffset;
              const centerY = terminalPoint.y + outward.y * (baseDistance + labelHeight / 2) + normal.y * sideOffset;
              return {
                rect: {
                  x: centerX - labelWidth / 2,
                  y: centerY - labelHeight / 2,
                  width: labelWidth,
                  height: labelHeight
                },
                score: preference + index * 2
              };
            }
          );
        })
        .map(candidate => {
          let score = candidate.score;
          occupied.forEach(other => {
            if (rectsOverlap(candidate.rect, other)) score += 90;
          });
          if (
            candidate.rect.x < 0 ||
            candidate.rect.y < 0 ||
            candidate.rect.x + candidate.rect.width > stageSize.width ||
            candidate.rect.y + candidate.rect.height > stageSize.height
          ) {
            score += 35;
          }
          return { rect: candidate.rect, score };
        })
        .sort((a, b) => a.score - b.score)[0];

      if (best) {
        occupied.push(best.rect);
        placements.push({
          key: line.id,
          line,
          ...best.rect
        });
      }
    });

    return placements;
  }, [
    isLightAmapRender,
    mapSettings.showLineNameLabels,
    lines,
    labelPlacements,
    stations,
    stylePreset,
    stageSize.width,
    stageSize.height,
    stationDisplayPoints
  ]);

  return (
    <div
      ref={containerRef}
      className={`metro-canvas-surface ${isDarkCanvas ? 'is-canvas-dark' : ''}`}
      style={{
        width: '100%',
        height: '100%',
        '--metro-canvas-bg': canvasBackgroundColor,
        backgroundColor: canvasBackgroundColor,
        // 用户导入了自定义画布背景图 → 用那张图；
        // 否则 undefined（不写 'none'），让 CSS 里的 drafting-paper 点状网格能生效
        backgroundImage:
          !isAmapMode && canvasBackgroundImage ? `url(${canvasBackgroundImage})` : undefined,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat'
      } as React.CSSProperties}
    >
      {isAmapMode && (
        <div
          ref={amapContainerRef}
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 0,
            background: isDarkCanvas ? '#07111f' : '#eef6ff'
          }}
        />
      )}
      {isAmapMode && amapError && (
        <div
          style={{
            position: 'absolute',
            top: 86,
            left: 18,
            zIndex: 1002,
            maxWidth: 420,
            padding: '10px 12px',
            borderRadius: 8,
            background: '#fff7ed',
            border: '1px solid #fed7aa',
            color: '#9a3412',
            fontSize: 13,
            boxShadow: '0 10px 28px rgba(15,23,42,0.12)'
          }}
        >
          {amapError}
        </div>
      )}
      <div className="metro-canvas-tools">
        <div className="metro-tool-group" role="toolbar" aria-label="Canvas tools">
          {/* 工具组：5 个按钮 = icon + label。
              激活态在 label 前显式插一个小蓝点，比单靠背景色更直观；
              hint 不再常驻一行长文案，改成每个按钮 hover 时的 Tooltip */}
          {[
            { key: 'select' as CanvasTool, label: text.tools.select, icon: <SelectOutlined />, hint: text.hints.select },
            { key: 'station' as CanvasTool, label: text.tools.station, icon: <EnvironmentOutlined />, hint: text.hints.station },
            {
              key: 'line' as CanvasTool,
              label: text.tools.line,
              icon: <NodeIndexOutlined />,
              hint:
                drawingLine.startStation
                  ? text.hints.lineDrawing(drawingLine.startStation.name)
                  : text.hints.lineIdle
            },
            { key: 'section' as CanvasTool, label: text.tools.section, icon: <LineOutlined />, hint: text.hints.section },
            { key: 'pan' as CanvasTool, label: text.tools.pan, icon: <DragOutlined />, hint: text.hints.pan }
          ].map((tool) => {
            const active = activeTool === tool.key;
            return (
              <Tooltip key={tool.key} title={tool.hint} placement="bottom" mouseEnterDelay={0.2}>
                <button
                  type="button"
                  className={`metro-tool-button ${active ? 'is-active' : ''}`}
                  onClick={() => setCanvasTool(tool.key)}
                  aria-pressed={active}
                >
                  {active ? <span className="metro-tool-button__dot" aria-hidden="true" /> : null}
                  <span className="metro-tool-button__icon">{tool.icon}</span>
                  <span className="metro-tool-button__label">{tool.label}</span>
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
      {isSectionMode && selectedSection && (
        <DraggableModal
          title={`添加途经点（${selectedSection.startStation.name} → ${selectedSection.endStation.name}）`}
          open={!addingWaypoint}
          onOk={() => {
            if (getSectionWaypoints(selectedSection.sectionId).length >= MAX_WAYPOINTS_PER_SECTION) {
              message.warning(`最多只能添加${MAX_WAYPOINTS_PER_SECTION}个途经点`);
              return;
            }
            setAddingWaypoint(true);
          }}
          onCancel={() => {
            setSelectedSection(null);
            setAddingWaypoint(false);
          }}
          okText="添加途经点"
          cancelText="完成"
        >
          <div style={{ marginBottom: 12, color: '#666', fontSize: 14 }}>
            点击“添加途经点”后，在区间内点击画布添加途经点，最多{MAX_WAYPOINTS_PER_SECTION}个，途经点仅用于折线显示
          </div>
          <div>
            已添加途经点数：{getSectionWaypoints(selectedSection.sectionId).length}
          </div>
          {/* 列出已添加途经点并可删除 */}
          {(() => {
            const sectionKey = selectedSection.sectionId;
            const points = getSectionWaypoints(sectionKey);
            if (points.length === 0) return null;
            return (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontWeight: 'bold', marginBottom: 6 }}>途经点管理：</div>
                {points.map((pt, idx) => (
                  <div key={idx} style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ marginRight: 8 }}>途经点{idx + 1} ({pt.x.toFixed(0)}, {pt.y.toFixed(0)})</span>
                    <Button
                      type="text"
                      danger
                      size="small"
                      icon={<span style={{fontWeight:'bold',color:'#ff4d4f'}}>🗑️</span>}
                      onClick={() => {
                        onBeginInteraction?.();
                        const newArr = [...points];
                        newArr.splice(idx, 1);
                        writeSectionWaypoints(sectionKey, newArr);
                      }}
                    >删除</Button>
                  </div>
                ))}
              </div>
            );
          })()}
        </DraggableModal>
      )}
      {/* 画布 HUD：底部右侧一条胶囊，整合"缩放 +/-"、"当前缩放（带预设下拉）"、"适应视图 / 重置"。
          替换了原本分布在右上 + 右下的两个独立控件，视觉上更整合，也腾出右上角空间 */}
      <div className="metro-canvas-hud">
        <Tooltip title={text.zoomOut}>
          <button type="button" className="metro-canvas-hud__btn" onClick={zoomOut} aria-label={text.zoomOut}>−</button>
        </Tooltip>
        {!isAmapMode ? (
          <Dropdown
            placement="top"
            trigger={['click']}
            menu={{
              items: [50, 75, 100, 125, 150, 200].map(percent => ({
                key: String(percent),
                label: `${percent}%`,
                onClick: () => setZoomPercent(percent)
              }))
            }}
          >
            <button type="button" className="metro-canvas-hud__value">
              {Math.round(scale * 100)}% <DownOutlined style={{ fontSize: 9 }} />
            </button>
          </Dropdown>
        ) : (
          <span className="metro-canvas-hud__value metro-canvas-hud__value--static">
            {text.zoom} {Math.round((amapRef.current?.getZoom?.() || mapSettings.baseMap.amap?.zoom || 11) * 10) / 10}
          </span>
        )}
        <Tooltip title={text.zoomIn}>
          <button type="button" className="metro-canvas-hud__btn" onClick={zoomIn} aria-label={text.zoomIn}>+</button>
        </Tooltip>
        <span className="metro-canvas-hud__divider" />
        <Tooltip title={text.fitView}>
          <button type="button" className="metro-canvas-hud__btn" onClick={fitView} aria-label={text.fitView}>□</button>
        </Tooltip>
        <Tooltip title={text.resetView}>
          <button type="button" className="metro-canvas-hud__btn" onClick={resetView} aria-label={text.resetView}>⌂</button>
        </Tooltip>
      </div>

      <Stage
        ref={stageRef}
        width={stageSize.width}
        height={stageSize.height}
        scaleX={isAmapMode ? 1 : scale}
        scaleY={isAmapMode ? 1 : scale}
        x={isAmapMode ? 0 : position.x}
        y={isAmapMode ? 0 : position.y}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={e => {
          // 拖拽结束（handleMouseUp 内部已经按 click 距离阈值决定要不要触发 handleStageClick）
          handleMouseUp(e);
        }}
        onContextMenu={handleCanvasContextMenu}
        onWheel={handleWheel}
        onClick={e => {
          if (sectionContextMenu.visible) {
            // 区间右键菜单弹出时不响应途经点添加
            return;
          }
          if (isSectionMode && selectedSection && addingWaypoint) {
            // 保持原有途经点添加逻辑
            const stage = e.target.getStage();
            if (stage) {
              const pointer = stage.getPointerPosition();
              if (pointer) {
                const worldPos = {
                  ...getPointerWorldPosition(stage, pointer),
                  ...(getLngLatFromContainerPoint(pointer) || {})
                };
                const sectionKey = selectedSection.sectionId;
                const currentWaypoints = getSectionWaypoints(sectionKey);
                if (currentWaypoints.length >= MAX_WAYPOINTS_PER_SECTION) {
                  message.warning(`最多只能添加${MAX_WAYPOINTS_PER_SECTION}个途经点`);
                  setAddingWaypoint(false);
                  setSelectedSection(null);
                  return;
                }
                onBeginInteraction?.();
                const nextWaypoints = [...currentWaypoints, worldPos];
                writeSectionWaypoints(sectionKey, nextWaypoints);
                setAddingWaypoint(false);
                if (nextWaypoints.length >= MAX_WAYPOINTS_PER_SECTION) {
                  setSelectedSection(null);
                  message.success(`已达到最多${MAX_WAYPOINTS_PER_SECTION}个途经点`);
                } else {
                  message.success('已添加途经点');
                }
                return;
              }
            }
            return;
          }
          // 画布单击不再处理添加站点弹窗，交由 onMouseUp 统一处理
        }}
        style={{ cursor: activeTool === 'pan' ? 'grab' : isDrawingMode || activeTool === 'station' ? 'crosshair' : 'default' }}
      >
        <Layer>
          <Rect
            x={-10000}
            y={-10000}
            width={20000}
            height={20000}
            fill={isAmapMode ? 'rgba(0,0,0,0)' : canvasBackgroundColor}
            listening={false}
          />
          {/* 渲染线路连接线 */}
          {renderLines()}
          {lineNamePlacements.map(label => (
            <Group key={`line_label_${label.key}`} x={label.x} y={label.y} listening={false}>
              <Rect
                width={label.width}
                height={label.height}
                cornerRadius={label.height / 2}
                fill={isMutedAmapStyle ? 'rgba(255,255,255,0.94)' : stylePreset.lineLabelFill}
                stroke={label.line.color}
                strokeWidth={isAmapMode ? Math.max(2.5, stylePreset.lineLabelStrokeWidth) : stylePreset.lineLabelStrokeWidth}
                shadowColor={label.line.color}
                shadowBlur={isAmapMode ? 8 : 4}
                shadowOpacity={isAmapMode ? 0.22 : 0.16}
              />
              <Text
                text={label.line.name}
                width={label.width}
                height={label.height}
                align="center"
                verticalAlign="middle"
                fontSize={stylePreset.lineLabelFontSize}
                fontStyle={`${stylePreset.lineLabelFontWeight}`}
                fill={isMutedAmapStyle ? '#0f172a' : stylePreset.lineLabelText}
              />
            </Group>
          ))}
          {activeCalibrationGuides.map((guide, idx) => (
            <Line
              key={`active_guide_${idx}`}
              points={guide}
              stroke={canvasPalette.activeGuide}
              strokeWidth={1}
              dash={[6, 6]}
              opacity={0.9}
            />
          ))}
          {sections.map(section => {
            const points = section.waypoints || [];
            const visiblePoints = points
              .map((pt, idx) => ({ pt, idx }))
              .filter(({ pt }) => !pt.hidden);
            if (!visiblePoints.length) return null;
            return visiblePoints.map(({ pt, idx }) => {
              const waypointPoint = getWaypointDisplayPoint(pt);
              return (
                <Circle
                  key={`wp_${section.id}_${idx}`}
                  x={waypointPoint.x}
                  y={waypointPoint.y}
                  radius={6}
                  fill={canvasPalette.waypointFill}
                  stroke={canvasPalette.waypointStroke}
                  strokeWidth={2}
                  shadowColor={canvasPalette.waypointShadow}
                  shadowBlur={isLightAmapRender ? 0 : 5}
                  draggable
                  onDragStart={() => {
                    onBeginInteraction?.();
                  }}
                  onDragMove={e => {
                    updateWaypoint(section.id, idx, e.target.x(), e.target.y(), true);
                  }}
                  onDragEnd={() => {
                    setActiveCalibrationGuides([]);
                  }}
                  onContextMenu={e => {
                    e.evt.preventDefault();
                    lastIsRightClickRef.current = true;
                    const stage = e.target.getStage();
                    if (!stage) return;
                    const pointer = stage.getPointerPosition();
                    setSectionContextMenu({
                      visible: true,
                      x: pointer?.x || 0,
                      y: pointer?.y || 0,
                      sectionKey: section.id,
                      waypointIndex: idx,
                      waypointOnly: true
                    });
                  }}
                />
              );
            });
          })}
          
          {/* 渲染正在绘制的线 */}
          {isDrawing && drawingLine.points.length >= 4 && (
            <Line
              points={drawingLine.points}
              stroke={canvasPalette.drawingLine}
              strokeWidth={3}
              lineCap="round"
              lineJoin="round"
              dash={[5, 5]}
              tension={0}
            />
          )}
          
          {/* 渲染站点 */}
          {stations.map(station => {
            const stationColor = getStationColor(station.id);
            const labelRect = labelPlacements[station.id];
            const isInterchangeStation = (stationLineCounts[station.id] || 0) > 1;
            const stationPoint = getDisplayPoint(station);
            return (
              <Group
                key={station.id}
                x={stationPoint.x}
                y={stationPoint.y}
                draggable={activeTool === 'select' || activeTool === 'station'}
                onDragStart={() => onBeginInteraction?.()}
                onDragMove={e =>
                  handleDragMove(station.id, { x: e.target.x(), y: e.target.y() })
                }
                onDragEnd={() => setActiveCalibrationGuides([])}
                onClick={(e) => handleStationClick(station, e)}
                onContextMenu={(e) => handleStationRightClick(e, station)}
                style={{ cursor: isDrawingMode ? 'crosshair' : 'pointer' }}
              >
                {isDotLabelStyle ? (
                  <>
                    {isInterchangeStation ? (
                      <>
                        <Circle
                          radius={stylePreset.interchangeRadius}
                          fill={canvasPalette.stationStroke}
                          stroke={stationColor}
                          strokeWidth={stylePreset.interchangeStrokeWidth}
                          shadowColor={canvasPalette.dotShadow}
                          shadowBlur={isLightAmapRender ? 0 : 6}
                        />
                        <Circle
                          radius={stylePreset.interchangeInnerRadius}
                          fill={stationColor}
                          stroke={mapSettings.cityStyle === 'mtr' ? canvasPalette.stationStroke : stationColor}
                          strokeWidth={mapSettings.cityStyle === 'mtr' ? 2 : 1}
                        />
                      </>
                    ) : (
                      <Circle
                        radius={stylePreset.normalStationRadius}
                        fill={stationColor}
                        stroke={canvasPalette.stationStroke}
                        strokeWidth={stylePreset.normalStationStrokeWidth}
                        shadowColor={canvasPalette.dotShadow}
                        shadowBlur={isLightAmapRender ? 0 : 4}
                      />
                    )}
                    {labelRect ? (
                      <Group x={labelRect.x - stationPoint.x} y={labelRect.y - stationPoint.y} listening={false}>
                        <Text
                          text={station.name}
                          width={labelRect.width}
                          height={labelRect.height}
                          fontSize={dotLabelStyle.fontSize}
                          fontStyle={`${dotLabelStyle.fontWeight}`}
                          fill={readableLabelText}
                          align="center"
                          verticalAlign="middle"
                          shadowColor={isAmapMode ? readableLabelShadow : canvasPalette.labelShadow}
                          shadowBlur={isAmapMode ? 5 : isDarkCanvas ? 5 : 2}
                          shadowOpacity={1}
                        />
                      </Group>
                    ) : null}
                  </>
                ) : (
                  <>
                    <Circle
                      radius={isInterchangeStation ? 24 : 20}
                      fill={isStationInCurrentLine(station.id) ? stationColor : canvasPalette.inactiveStationFill}
                      stroke={canvasPalette.stationStroke}
                      strokeWidth={isInterchangeStation ? 4 : 2}
                      shadowColor={isDarkCanvas ? 'rgba(147,197,253,0.35)' : 'rgba(15,23,42,0.28)'}
                      shadowBlur={isLightAmapRender ? 0 : isDarkCanvas ? 7 : 4}
                      shadowOffset={{ x: 2, y: 2 }}
                    />
                    {!isLightAmapRender ? (
                      <Text
                        text={station.name}
                        fontSize={12}
                        fill={canvasPalette.stationText}
                        align="center"
                        verticalAlign="middle"
                        width={40}
                        height={40}
                        offsetX={20}
                        offsetY={20}
                        shadowColor={isAmapMode ? 'rgba(2,6,23,0.95)' : isDarkCanvas ? 'rgba(2,6,23,0.8)' : 'rgba(15,23,42,0.42)'}
                        shadowBlur={isAmapMode ? 5 : isDarkCanvas ? 3 : 2}
                        shadowOffset={{ x: 1, y: 1 }}
                      />
                    ) : null}
                  </>
                )}
              </Group>
            );
          })}
        </Layer>
      </Stage>
      
      {/* 添加站点的模态框 */}
      <DraggableModal
        title={lineSegmentClick ? "在线段上添加站点" : "添加站点"}
        open={adding}
        onOk={handleAddStation}
        onCancel={() => {
          setAdding(false);
          setNewStation(null);
          setStationName('');
          setLineSegmentClick(null);
        }}
        okText="添加"
        cancelText="取消"
      >
        {lineSegmentClick && (
          <div style={{ marginBottom: 16, color: '#666', fontSize: 14 }}>
            将在 <strong>{lineSegmentClick.startStation.name}</strong> 和 <strong>{lineSegmentClick.endStation.name}</strong> 之间添加新站点
          </div>
        )}
        <Input
          placeholder={lineSegmentClick ? "请输入新站点名称" : "请输入站点名称"}
          value={stationName}
          onChange={e => setStationName(e.target.value)}
          onPressEnter={handleAddStation}
          maxLength={10}
        />
      </DraggableModal>
      <DraggableModal
        title="更改画布颜色"
        open={canvasColorModal.visible}
        onOk={handleConfirmCanvasColor}
        onCancel={() =>
          setCanvasColorModal(prev => ({
            ...prev,
            visible: false,
            currentColor: canvasBackgroundColor,
            showPicker: false
          }))
        }
        okText="确认"
        cancelText="取消"
      >
        <div style={{ marginBottom: 16 }}>
          <Text>选择新的颜色：</Text>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {LINE_COLORS.map(color => (
            <div
              key={color}
              style={{
                width: 32,
                height: 32,
                borderRadius: '50%',
                backgroundColor: color,
                border: color === canvasColorModal.currentColor ? '3px solid #1890ff' : '2px solid #d9d9d9',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
              onClick={() => setCanvasColorModal(prev => ({ ...prev, currentColor: color }))}
            >
              {color === canvasColorModal.currentColor && (
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: 'bold' }}>✓</Text>
              )}
            </div>
          ))}
        </div>
        <div style={{ marginTop: 16 }}>
          <Button type="dashed" block onClick={() => setCanvasColorModal(prev => ({ ...prev, showPicker: true }))}>
            更多颜色
          </Button>
        </div>
        {canvasColorModal.showPicker && (
          <div style={{ marginTop: 16, textAlign: 'center' }}>
            <ColorPicker
              value={canvasColorModal.currentColor || getDefaultCanvasBackground(mapSettings.canvasTheme)}
              onChange={handleCanvasColorPickerChange}
              showText
            />
          </div>
        )}
      </DraggableModal>
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        onChange={handleImportImage}
        style={{ display: 'none' }}
      />
      <DraggableModal
        title="与其他站点进行连接"
        open={connectModal.visible}
        onOk={handleConfirmConnectToStation}
        onCancel={() => {
          setConnectModal({ visible: false, station: null });
          setSelectedConnectStationId(undefined);
        }}
        okText="确认连接"
        cancelText="取消"
      >
        <div style={{ marginBottom: 12, color: '#666' }}>
          当前站点：<strong>{connectModal.station?.name || '-'}</strong>
        </div>
        <div style={{ marginBottom: 8 }}>选择当前线路中的连接站点：</div>
        <Select
          style={{ width: '100%' }}
          options={getCurrentLineStationOptions(connectModal.station?.id)}
          value={selectedConnectStationId}
          onChange={setSelectedConnectStationId}
          placeholder="请选择一个站点"
        />
      </DraggableModal>
      <DraggableModal
        title="修改站点名称"
        open={renameStationModal.visible}
        onOk={handleConfirmRenameStation}
        onCancel={() => setRenameStationModal({ visible: false, station: null, name: '' })}
        okText="保存"
        cancelText="取消"
      >
        <Input
          value={renameStationModal.name}
          onChange={(e) => setRenameStationModal(prev => ({ ...prev, name: e.target.value }))}
          placeholder="请输入站点名称"
          maxLength={20}
        />
      </DraggableModal>
      <DraggableModal
        title="站点信息"
        open={stationInfoModal.visible}
        onCancel={() => setStationInfoModal({ visible: false, station: null, note: '' })}
        footer={null}
      >
        {stationInfoModal.station && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div><strong>名称：</strong>{stationInfoModal.station.name}</div>
            <div>
              <strong>经过线路：</strong>
              {lines.filter(line => line.stationIds.includes(stationInfoModal.station!.id)).map(line => line.name).join('、') || '无'}
            </div>
            <div>
              <strong>是否换乘站：</strong>
              {lines.filter(line => line.stationIds.includes(stationInfoModal.station!.id)).length > 1 ? '是' : '否'}
            </div>
            <div>
              <div style={{ marginBottom: 6 }}><strong>附加标注：</strong></div>
              <Input.TextArea
                value={stationInfoModal.note}
                onChange={(e) => setStationInfoModal(prev => ({ ...prev, note: e.target.value }))}
                placeholder="如：机场、高铁站、交通枢纽等"
                rows={3}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button type="primary" onClick={handleSaveStationNote}>保存标注</Button>
            </div>
          </div>
        )}
      </DraggableModal>
      {canvasContextMenu.visible && (
        <div
          className="canvas-context-menu"
          onMouseDown={e => e.stopPropagation()}
          style={{
            position: 'absolute',
            top: canvasContextMenu.y,
            left: canvasContextMenu.x,
            zIndex: 1002,
            background: '#fff',
            padding: '8px 12px',
            borderRadius: '6px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            fontSize: '12px',
            color: '#333',
            display: 'flex',
            flexDirection: 'column',
            gap: 8
          }}
        >
          <Button size="small" onClick={openCanvasColorModal}>
            更改画布颜色
          </Button>
          <Button size="small" onClick={triggerImageImport}>
            导入图片
          </Button>
          <Button size="small" onClick={handleClearBackgroundImage} disabled={!canvasBackgroundImage}>
            清除背景图片
          </Button>
          <Button size="small" onClick={handleResetCanvasColor}>
            恢复默认画布颜色
          </Button>
        </div>
      )}
       {/* 区间右键菜单 */}
       {sectionContextMenu.visible && sectionContextMenu.sectionKey ? (() => {
         const sectionKey = sectionContextMenu.sectionKey!;
         const pointIndex = sectionContextMenu.waypointIndex;
         const sectionWaypoints = getSectionWaypoints(sectionKey);
         const currentPoint = pointIndex === null ? null : sectionWaypoints[pointIndex];
         const closeSectionMenu = () => {
           setSectionContextMenu({ ...sectionContextMenu, visible: false, waypointOnly: false });
           setSelectedSection(null);
           setAddingWaypoint(false);
         };

         return (
           <div
             className="section-context-menu"
             onMouseDown={e => e.stopPropagation()}
             style={{
               position: 'absolute',
               top: sectionContextMenu.y,
               left: sectionContextMenu.x,
               zIndex: 1000,
               minWidth: 140,
               background: canvasPalette.menuSurface,
               padding: '8px 10px',
               borderRadius: '8px',
               boxShadow: canvasPalette.menuShadow,
               fontSize: '12px',
               color: canvasPalette.menuText,
               display: 'flex',
               flexDirection: 'column',
               gap: 8,
             }}
           >
             {sectionContextMenu.waypointOnly && currentPoint ? (
               <>
                 <div style={{ fontWeight: 700 }}>途经点管理</div>
                 <Button
                   size="small"
                   onClick={() => {
                     hideWaypoint(sectionKey, pointIndex!);
                     closeSectionMenu();
                   }}
                 >
                   隐藏途经点
                 </Button>
                 <Button
                   size="small"
                   danger
                   onClick={() => {
                     deleteWaypoint(sectionKey, pointIndex!);
                     closeSectionMenu();
                   }}
                 >
                   删除途经点
                 </Button>
                 <Button size="small" onClick={closeSectionMenu}>取消</Button>
               </>
             ) : (
               <>
                 <div style={{ fontWeight: 700 }}>区间途经点管理</div>
                 {sectionWaypoints.length > 0 ? (
                   sectionWaypoints.map((pt, idx) => (
                     <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 6, alignItems: 'center' }}>
                       <span style={{ color: canvasPalette.menuText }}>途经点 {idx + 1}</span>
                       <Button
                         size="small"
                         onClick={() => {
                           if (pt.hidden) {
                             showWaypoint(sectionKey, idx);
                           } else {
                             hideWaypoint(sectionKey, idx);
                           }
                           closeSectionMenu();
                         }}
                       >
                         {pt.hidden ? '显示' : '隐藏'}
                       </Button>
                       <Button
                         size="small"
                         danger
                         onClick={() => {
                           deleteWaypoint(sectionKey, idx);
                           closeSectionMenu();
                         }}
                       >
                         删除
                       </Button>
                     </div>
                   ))
                 ) : (
                   <div style={{ color: canvasPalette.menuMuted }}>暂无途经点</div>
                 )}
                 <Button
                   size="small"
                   danger
                   onClick={() => {
                     onDeleteSection(sectionKey);
                     closeSectionMenu();
                   }}
                 >
                   删除当前区间
                 </Button>
                 <Button size="small" onClick={closeSectionMenu}>取消</Button>
               </>
             )}
           </div>
         );
       })() : null}

       {/* 站点右键菜单 */}
       {stationContextMenu.visible && (
         <div
            className="station-context-menu"
           style={{
             position: 'absolute',
             top: stationContextMenu.y,
             left: stationContextMenu.x,
             zIndex: 1000,
             background: '#fff',
             padding: '8px 12px',
             borderRadius: '6px',
             boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
             fontSize: '12px',
             color: '#333',
             display: 'flex',
             flexDirection: 'column',
             gap: 8,
           }}
          >
            <div style={{ fontWeight: 'bold' }}>站点: {stationContextMenu.station?.name}</div>
            <div
              onMouseEnter={() => setShowConnectAction(true)}
              onMouseLeave={() => setShowConnectAction(false)}
              style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <Button
                size="small"
                onClick={() => {
                  onAddStationToLine(stationContextMenu.station!.id, { mode: 'default' });
                  closeStationContextMenu();
                }}
                disabled={!currentLineId}
              >
                {showConnectAction ? '添加到当前线路（建立默认连接）' : '添加到当前线路'}
              </Button>
              {showConnectAction && (
                <Button
                  size="small"
                  type="dashed"
                  onClick={handleOpenConnectModal}
                  disabled={!currentLineId || getCurrentLineStationOptions(stationContextMenu.station?.id).length === 0}
                >
                  与其他站点进行连接
                </Button>
              )}
              {showConnectAction && (
                <Button
                  size="small"
                  onClick={() => {
                    onAddStationToLine(stationContextMenu.station!.id, { mode: 'only' });
                    closeStationContextMenu();
                  }}
                  disabled={!currentLineId}
                >
                  仅添加站点
                </Button>
              )}
            </div>
            <Button size="small" onClick={handleOpenRenameStation}>
              修改站点名称
            </Button>
            <Button
              size="small"
              onClick={handleDeleteStation}
              danger
           >
             删除站点
           </Button>
           <Button
             size="small"
             onClick={closeStationContextMenu}
           >
             取消
           </Button>
         </div>
       )}
    </div>
  );
};

export default Canvas; 
