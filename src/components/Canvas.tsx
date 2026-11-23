import {
  AMAP_REFERENCE_ZOOM,
  computeAmapVisualScales,
  computePlainVisualScales,
  estimateSingleLineTextWidth,
  liveElementScaleRatio,
  plainCanvasElementScale
} from '../lib/canvasZoom';
import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import Konva from 'konva';
import { Stage, Layer, Circle, Text, Group, Line, Rect, Arc, Path } from 'react-konva';
import { Input, Button, message, ColorPicker, Select, Dropdown, Tooltip, Spin } from 'antd';
import {
  BgColorsOutlined,
  DeleteOutlined,
  DownOutlined,
  DragOutlined,
  EditOutlined,
  EnvironmentOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  LineOutlined,
  NodeIndexOutlined,
  PictureOutlined,
  PlusCircleOutlined,
  ReloadOutlined,
  SelectOutlined,
  TranslationOutlined
} from '@ant-design/icons';
import { api } from '../api';
import { MapSettings, Station, Line as LineType, Section, Waypoint, LINE_COLORS } from '../types';
import { getCityStylePreset } from '../stylePresets';
import { planInterchange, buildCurvedArrowPath } from '../lib/interchange';
import { roundLineFlat } from '../lib/roundedPath';
import { SpatialBoxGrid } from '../lib/spatialGrid';
import { AppAction } from '../lib/commandParser';
import { useAmapViewport } from '../lib/useAmapViewport';
import { createId } from '../utils/id';
import DraggableModal from './DraggableModal';
import CanvasStartPrompt from './CanvasStartPrompt';
import { TouchViewportGesture, TouchPoint } from '../lib/touchViewport';
import { useElasticToolbar } from '../lib/useElasticToolbar';
import MobileViewControls from './MobileViewControls';

// 性能诊断开关。用户在 DevTools Console 输入：
//   localStorage.setItem('metro_perf', '1'); location.reload();
// 之后所有 perfMark 会打到 console，方便定位 "9 秒点击" 那种延迟到底卡在哪一段。
// 关掉：localStorage.removeItem('metro_perf'); location.reload();
const __perfEnabled = (() => {
  try {
    return typeof window !== 'undefined' && window.localStorage?.getItem('metro_perf') === '1';
  } catch {
    return false;
  }
})();
const perfMark = (label: string, startTime: number) => {
  if (!__perfEnabled) return;
  const ms = performance.now() - startTime;
  if (ms > 0.5) {
    // 只打 >0.5ms 的避免 console 被 noise 淹没
    console.log(`[metro-perf] ${label}: ${ms.toFixed(2)}ms`);
  }
};
// 用 useRef 持久化"上次渲染时刻"，每次 render 算出 render 间隔
const __perfMarkRender = (componentName: string, prevRef: { current: number }) => {
  if (!__perfEnabled) return;
  const now = performance.now();
  const since = now - prevRef.current;
  prevRef.current = now;
  if (since > 0 && since < 2000) {
    console.log(`[metro-perf] ${componentName} render +${since.toFixed(0)}ms since last`);
  }
};

const STATION_RADIUS = 18;
const DEFAULT_CANVAS_BACKGROUND_COLOR = '#fafbfc';
const GUIDE_THRESHOLD_DEG = 10;
const SNAP_THRESHOLD_DEG = 2;
const SNAP_ANGLES = [0, 45, 90, 135];
const MAX_WAYPOINTS_PER_SECTION = 6;
const SECTION_HIT_STROKE_WIDTH = 22;
// 纯画布缩放：定档梯子（CAD 式"一格一档"）。scale = ZOOM_MIN * ZOOM_STEP_FACTOR^n。
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 5;
const ZOOM_STEP_FACTOR = 1.15;        // 每档 ±15%
// 同一次物理滚动常触发一串 wheel 事件（高分辨率/平滑滚轮尤甚）。
// 用这个时间锁把事件洪流合并成"每 45ms 最多走一档"，既挡洪流又不拖慢正常滚动。
const WHEEL_STEP_LOCK_MS = 45;

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
const CANVAS_THEME_PALETTES = {
  light: {
    background: '#ffffff',
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
const CANVAS_TOOL_ORDER: CanvasTool[] = ['select', 'station', 'line', 'section', 'pan'];

interface CanvasProps {
  readOnly?: boolean;
  currentLineId: string | null;
  lines: LineType[];
  sections: Section[];
  stations: Station[];
  mapSettings: MapSettings;
  documentKey?: string;
  isDocumentLoading?: boolean;
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
  onCreateLine?: () => void;
  onStartWithAmap?: () => void;
  // 命令行视图通道：App 执行器把视图类命令（zoom/fit/reset/center）通过这个 prop 下发，
  // Canvas 在 effect 里执行（Canvas 才持有 scale/position/amapRef）。seq 保证重复命令也能再触发。
  viewCommand?: { seq: number; action: AppAction } | null;
  mobileViewControlsHost?: HTMLDivElement | null;
  isGuest?: boolean;
  onRequireAuth?: () => void;
  initialViewport?: { scale: number; x: number; y: number };
  fitOnMount?: boolean;
  onViewportChange?: (viewport: { scale: number; x: number; y: number }) => void;
}

const Canvas: React.FC<CanvasProps> = ({
  readOnly = false,
  currentLineId,
  lines,
  sections,
  stations,
  mapSettings,
  documentKey = 'draft', isDocumentLoading = false,
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
  onBeginInteraction,
  onCreateLine,
  onStartWithAmap,
  viewCommand,
  mobileViewControlsHost, initialViewport, fitOnMount, onViewportChange, isGuest, onRequireAuth
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
  const touchGestureRef = useRef(new TouchViewportGesture());
  const touchTapAllowedRef = useRef(false);
  const longPressTimerRef = useRef<number | null>(null);
  const [isCompact, setIsCompact] = useState(() => window.matchMedia('(max-width: 768px), (max-width: 1024px) and (max-height: 500px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 768px), (max-width: 1024px) and (max-height: 500px)');
    const update = () => setIsCompact(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!isCompact && !window.matchMedia('(pointer: coarse)').matches) return;
    const previous = Konva.hitOnDragEnabled;
    Konva.hitOnDragEnabled = true;
    return () => { Konva.hitOnDragEnabled = previous; };
  }, [isCompact]);
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
  // 默认工具：桌面端"站点"（最常用），移动端"移动"（先让人能拖图，再让他想加站点）。
  // 仅 mount 时检测一次，之后用户切换 tool 由 setCanvasTool 接管。
  const [activeTool, setActiveTool] = useState<CanvasTool>(() => {
    if (readOnly) return 'pan';
    if (typeof window !== 'undefined' && window.matchMedia?.('(max-width: 768px), (max-width: 1024px) and (max-height: 500px)').matches) {
      return 'pan';
    }
    return 'station';
  });
  
  // 绘制模式相关状态
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [isSectionMode, setIsSectionMode] = useState(false); // 区间绘制模式
  const [selectedSection, setSelectedSection] = useState<{ sectionId: string; lineId: string; startStation: Station; endStation: Station } | null>(null);
  const [addingWaypoint, setAddingWaypoint] = useState(false);

  // O(1) 主键与邻接索引表：消除大线网下 O(sections × stations) 的重复 .find / .filter
  const lineById = useMemo(() => {
    const map = new Map<string, LineType>();
    lines.forEach((line) => map.set(line.id, line));
    return map;
  }, [lines]);

  const stationById = useMemo(() => {
    const map = new Map<string, Station>();
    stations.forEach((station) => map.set(station.id, station));
    return map;
  }, [stations]);

  const sectionById = useMemo(() => {
    const map = new Map<string, Section>();
    sections.forEach((section) => map.set(section.id, section));
    return map;
  }, [sections]);

  const stationToSections = useMemo(() => {
    const map = new Map<string, Section[]>();
    sections.forEach((section) => {
      const a = map.get(section.startStationId);
      if (a) a.push(section);
      else map.set(section.startStationId, [section]);
      if (section.endStationId !== section.startStationId) {
        const b = map.get(section.endStationId);
        if (b) b.push(section);
        else map.set(section.endStationId, [section]);
      }
    });
    return map;
  }, [sections]);

  const currentLineStationIdSet = useMemo(() => {
    const current = currentLineId ? lineById.get(currentLineId) : undefined;
    return new Set<string>(current?.stationIds || []);
  }, [lineById, currentLineId]);

  // 从 sections 中读取某区间的途经点
  const getSectionWaypoints = (sectionId: string): Waypoint[] =>
    sectionById.get(sectionId)?.waypoints || [];

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
  const drawingPointsRef = useRef<number[]>([]);
  const dragStationDraftRef = useRef<{ id: string; x: number; y: number; lng?: number; lat?: number } | null>(null);
  const dragWaypointDraftRef = useRef<{ sectionId: string; waypoints: Waypoint[] } | null>(null);
  const sectionParallelMetaRef = useRef<Map<string, { total: number; index: number }>>(new Map());
  const parallelGapRef = useRef(8);
  const [drawingStartPoint, setDrawingStartPoint] = useState<{ x: number; y: number } | null>(null);
  const setCanvasTool = (tool: CanvasTool) => {
    setActiveTool(tool);
    setIsDrawingMode(tool === 'line');
    if (tool !== 'line') {
      drawingPointsRef.current = [];
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
  
  // 桌面端与移动端统一启用物理弹簧浮岛滑块与按住拖拽扫选（只读预览态停用手势）
  const toolGroupRef = useElasticToolbar(CANVAS_TOOL_ORDER.indexOf(activeTool), CANVAS_TOOL_ORDER.length, !readOnly,
    index => setCanvasTool(CANVAS_TOOL_ORDER[index]));
  const [scale, setScale] = useState(initialViewport?.scale || 1);
  const [position, setPosition] = useState({ x: initialViewport?.x || 0, y: initialViewport?.y || 0 });
  useEffect(() => { onViewportChange?.({ scale, ...position }); }, [scale, position, onViewportChange]);
  const [isDragging, setIsDragging] = useState(false);
  // 历史遗留：以前用 useState 存上一次指针位置，每次 mousemove 触发一次额外的
  // setState；现在只读写 lastPointerPositionRef，省掉这一层重渲染。
  // 留这一行注释提醒不要再引入"lastPointerPosition state"。

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
  // 站名翻译按钮的 loading 标志（独立于 modal state，避免每次输入都触发重渲）
  const [translatingStation, setTranslatingStation] = useState(false);

  const handleTranslateStationName = async () => {
    if (isGuest) { onRequireAuth?.(); return; }
    const raw = renameStationModal.name.trim();
    if (!raw) {
      message.warning('请先输入要翻译的站名');
      return;
    }
    setTranslatingStation(true);
    try {
      const { english } = await api.translateStation(raw);
      setRenameStationModal(prev => ({ ...prev, name: english }));
      message.success(`已翻译：${english}`);
    } catch (e: any) {
      message.error(e?.message || '翻译失败，请稍后再试');
    } finally {
      setTranslatingStation(false);
    }
  };
  const [stationInfoModal, setStationInfoModal] = useState<{ visible: boolean; station: Station | null; note: string }>({
    visible: false,
    station: null,
    note: ''
  });
  const [activeCalibrationGuides, setActiveCalibrationGuides] = useState<number[][]>([]);
  
  const containerRef = useRef<HTMLDivElement | null>(null);
  const amapContainerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<any>(null);
  const syncZoomElementSizesRef = useRef<(viewportScale: number) => void>(() => {});
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 960, height: 640 });
  // 纯画布交互（拖动 / 滚轮缩放）也走"高频交互"通道，让 skipHeavyLayout 生效。
  // wheel 事件没有明确的"结束"信号，靠这个 timer 在最后一次 wheel 后 150ms 落回。
  const canvasInteractionEndTimerRef = useRef<number | null>(null);
  // 滚轮缩放的时间锁：上一档发生的时刻（performance.now）
  const wheelStepLockRef = useRef(0);
  // Perf 诊断：记录每次 Canvas 函数体跑的时间间隔（=渲染频率）
  const __perfRenderRef = useRef(performance.now());
  __perfMarkRender('Canvas', __perfRenderRef);
  // 给点击 → modal 弹出这条链路一个起点 ref，让 useEffect 在 modal 真正 open 时打 totals
  const __perfClickStartRef = useRef<number | null>(null);
  // 上一次 state 指纹，每次 render 跟当前对比，打出"是哪个 state 变了"
  const __perfStateFpRef = useRef<string>('');
  const lastPointerPositionRef = useRef({ x: 0, y: 0 });
  const latestMapSettingsRef = useRef(mapSettings);
  const previousBaseMapModeRef = useRef(mapSettings.baseMap.mode);
  const [isMapInteracting, setIsMapInteracting] = useState(false);
  // 拖站点 / 拖途经点中：跟 isMapInteracting 一起作为"高频交互"标志，
  // 屏蔽 O(n²) 的 label layout 和 line name 计算，让拖拽帧率不卡
  const [isDraggingNode, setIsDraggingNode] = useState(false);
  const isAmapMode = mapSettings.baseMap.mode === 'amap';

  useLayoutEffect(() => {
    latestMapSettingsRef.current = mapSettings;
  }, [mapSettings]);

  const { mapRef: amapRef, ready: amapReady, error: amapError, renderTick: mapRenderTick } = useAmapViewport({
    enabled: isAmapMode, containerRef: amapContainerRef, documentKey, documentLoading: isDocumentLoading,
    viewport: mapSettings.baseMap.amap || DEFAULT_AMAP_SETTINGS, width: stageSize.width, height: stageSize.height,
    onInteractionChange: setIsMapInteracting,
    onViewportChange: (center, zoom) => {
      const latest = latestMapSettingsRef.current;
      onMapSettingsChange?.({ ...latest, baseMap: { mode: 'amap',
        amap: { ...(latest.baseMap.amap || DEFAULT_AMAP_SETTINGS), center, zoom } } });
    }
  });
  const canvasSceneReady = !isDocumentLoading && (!isAmapMode || amapReady);

  useEffect(() => {
    if (onStageReady && stageRef.current) {
      onStageReady(stageRef.current);
    }
  }, [onStageReady]);

  // 监听 ESC 键取消绘制、单键快捷切换工具，以及全局点击关闭右键菜单
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (readOnly) return;
      if (e.key === 'Escape') {
        if (isDrawing) {
          cancelDrawing();
        } else if (isDrawingMode) {
          setIsDrawingMode(false);
          setActiveTool('select');
        }
        closeStationContextMenu();
        setSectionContextMenu(prev => ({ ...prev, visible: false }));
        setCanvasContextMenu(prev => ({ ...prev, visible: false }));
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      }
      if (document.querySelector('.ant-modal-wrap:not([style*="display: none"])')) return;

      const key = e.key.toLowerCase();
      if (key === 'v') setCanvasTool('select');
      else if (key === 's') setCanvasTool('station');
      else if (key === 'l') setCanvasTool('line');
      else if (key === 'w') setCanvasTool('section');
      else if (key === 'h') setCanvasTool('pan');
    };

    const handleGlobalClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.station-context-menu')) {
        closeStationContextMenu();
      }
      if (!target.closest('.section-context-menu')) {
        setSectionContextMenu(prev => ({ ...prev, visible: false }));
      }
      if (!target.closest('.canvas-context-menu')) {
        setCanvasContextMenu(prev => ({ ...prev, visible: false }));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handleGlobalClick);
    
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handleGlobalClick);
    };
  }, [isDrawing, isDrawingMode, readOnly]);

  // 卸载时清理 canvas interaction timer，避免 React 警告 / 内存泄漏
  useEffect(() => {
    return () => {
      if (canvasInteractionEndTimerRef.current !== null) {
        window.clearTimeout(canvasInteractionEndTimerRef.current);
        canvasInteractionEndTimerRef.current = null;
      }
      if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    };
  }, []);

  // Perf 诊断：从 mousedown 起算，到 "添加站点" modal 真正 mount 为止，整段总耗时。
  // 这条 effect 在 adding 翻 true 时触发，正好是 React commit 完成、modal 进入 DOM 那一刻。
  useEffect(() => {
    if (!__perfEnabled) return;
    if (adding && __perfClickStartRef.current !== null) {
      const total = performance.now() - __perfClickStartRef.current;
      console.log(`[metro-perf] click → add-station modal opened: ${total.toFixed(2)}ms (stations=${stations.length}, sections=${sections.length}, lines=${lines.length})`);
      __perfClickStartRef.current = null;
    }
  }, [adding, stations.length, sections.length, lines.length]);

  // Stage transform 的"状态 → 命令"同步：
  // 拖动 / 缩放交互期间我们直接对 stageRef 做 imperative 写（stage.position / stage.scale），
  // 绕开整套 React reconcile + react-konva diff。这里这个 layout effect 只负责"非交互期"的
  // 状态变更（programmatic reset、fit-all 等）落到 stage 上。
  // 交互中 isMapInteracting 为 true，effect 直接 bail，避免覆盖刚刚 imperative 写入的值。
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    if (isAmapMode) {
      // AMap 模式：stage 永远 (0,0,1)，底图变换由 AMap 处理
      stage.scale({ x: 1, y: 1 });
      stage.position({ x: 0, y: 0 });
      stage.batchDraw();
      return;
    }
    if (isMapInteracting) return;
    stage.scale({ x: scale, y: scale });
    stage.position(position);
    stage.batchDraw();
  }, [scale, position, isAmapMode, isMapInteracting]);

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

  // 站点像素坐标缓存：AMap 模式下根据经纬度投影，否则用 station.x/y。
  // 依赖 mapRenderTick 是为了在 AMap pan/zoom 后强制重算（amapRef.current 不会触发 React 重渲染）。
  const stationDisplayPoints = useMemo(() => {
    if (!canvasSceneReady) return {} as Record<string, { x: number; y: number }>;
    const map = amapRef.current;
    return stations.reduce<Record<string, { x: number; y: number }>>((result, station) => {
      if (isAmapMode && amapReady && map && typeof station.lng === 'number' && typeof station.lat === 'number') {
        const pixel = map.lngLatToContainer?.([station.lng, station.lat]);
        if (pixel && Number.isFinite(pixel.x) && Number.isFinite(pixel.y)) {
          result[station.id] = { x: pixel.x, y: pixel.y };
          return result;
        }
      }
      result[station.id] = { x: station.x, y: station.y };
      return result;
    }, {});
  }, [stations, isAmapMode, amapReady, mapRenderTick, canvasSceneReady, stageSize.width, stageSize.height]);

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
  // 纯画布交互的统一开关：mousedown / wheel 进入，mouseup / wheel idle 退出。
  // 翻 isMapInteracting 把 labelPlacements + lineNamePlacements 切到缓存路径，
  // 是大线网拖动卡顿的根因修复。
  const startCanvasInteraction = () => {
    if (canvasInteractionEndTimerRef.current !== null) {
      window.clearTimeout(canvasInteractionEndTimerRef.current);
      canvasInteractionEndTimerRef.current = null;
    }
    setIsMapInteracting(true);
  };
  const scheduleCanvasInteractionEnd = (delayMs: number = 150) => {
    if (canvasInteractionEndTimerRef.current !== null) {
      window.clearTimeout(canvasInteractionEndTimerRef.current);
    }
    canvasInteractionEndTimerRef.current = window.setTimeout(() => {
      canvasInteractionEndTimerRef.current = null;
      // 落停：把手势期间 imperative 写入 stage 的最终 scale/position 同步回 React state。
      // 必须 *先* setState、*再* 翻 isMapInteracting=false —— 否则 useLayoutEffect 在
      // isMapInteracting 翻假时会用旧 state 把 stage 变换写回去，导致缩放/平移被弹回
      // （和 handleMouseUp 880-883 注释同一个坑）。React18 在 timeout 里自动批处理这几个 setState。
      const stage = stageRef.current;
      if (stage && !isAmapMode) {
        const pos = stage.position();
        const sx = stage.scaleX();
        setScale(prev => (Math.abs(sx - prev) > 0.0001 ? sx : prev));
        setPosition(prev =>
          Math.abs(pos.x - prev.x) > 0.5 || Math.abs(pos.y - prev.y) > 0.5 ? { x: pos.x, y: pos.y } : prev
        );
      }
      setIsMapInteracting(false);
    }, delayMs);
  };

  const handleWheel = (e: any) => {
    e.evt.preventDefault();
    if (isAmapMode && amapRef.current) {
      const currentZoom = amapRef.current.getZoom?.() || mapSettings.baseMap.amap?.zoom || 11;
      const nextZoom = e.evt.deltaY > 0 ? currentZoom - 0.35 : currentZoom + 0.35;
      amapRef.current.setZoom?.(Math.max(3, Math.min(20, nextZoom)));
      return;
    }

    // 纯画布滚轮缩放：进入"交互中"通道，最后一次 wheel 后 150ms 落回静止
    startCanvasInteraction();
    scheduleCanvasInteractionEnd(150);

    // 时间锁：把一次物理滚动的事件洪流合并成"每 WHEEL_STEP_LOCK_MS 最多一档"
    const now = performance.now();
    if (now - wheelStepLockRef.current < WHEEL_STEP_LOCK_MS) return;
    wheelStepLockRef.current = now;

    const stage = e.target.getStage();
    const oldScale = stage.scaleX();
    const pointer = stage.getPointerPosition();

    const mousePointTo = {
      x: (pointer.x - stage.x()) / oldScale,
      y: (pointer.y - stage.y()) / oldScale,
    };

    // 定档缩放：把当前缩放吸附到梯子（scale = ZOOM_MIN * ZOOM_STEP_FACTOR^n），再走一档。
    // deltaY>0（向下滚）= 缩小 = -1 档。
    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const currentStep = Math.round(Math.log(oldScale / ZOOM_MIN) / Math.log(ZOOM_STEP_FACTOR));
    const steppedScale = ZOOM_MIN * Math.pow(ZOOM_STEP_FACTOR, currentStep + direction);
    const clampedScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, steppedScale));
    if (clampedScale === oldScale) return; // 已到顶/底，无变化
    const newPos = {
      x: pointer.x - mousePointTo.x * clampedScale,
      y: pointer.y - mousePointTo.y * clampedScale
    };

    // 纯 imperative 写 stage（视觉立即响应），手势期间不 setState —— 避免每格滚轮触发
    // 整个 Canvas 全树重渲染（这是缩放比拖动更卡的根因）。最终 scale/position 由
    // scheduleCanvasInteractionEnd 的落停回调统一提交一次，与 pan 路径行为一致。
    stage.scale({ x: clampedScale, y: clampedScale });
    stage.position(newPos);
    syncZoomElementSizesRef.current(clampedScale);
    stage.batchDraw();
  };

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };

  const readTouchPoints = (e: any): TouchPoint[] => {
    const stage = stageRef.current;
    if (!stage) return [];
    const rect = stage.container().getBoundingClientRect();
    return Array.from(e.evt.touches as TouchList).map(t => ({
      id: t.identifier,
      x: (t.clientX - rect.left) * stage.width() / rect.width,
      y: (t.clientY - rect.top) * stage.height() / rect.height
    }));
  };

  const handleTouchStart = (e: any) => {
    e.evt.preventDefault();
    const points = readTouchPoints(e);
    const gesture = touchGestureRef.current;
    gesture.start(points);
    touchTapAllowedRef.current = false;
    lastIsRightClickRef.current = false;
    clearLongPress();
    closeStationContextMenu();
    setSectionContextMenu(prev => ({ ...prev, visible: false }));
    setCanvasContextMenu(prev => ({ ...prev, visible: false }));
    if (points.length > 1) {
      // 第二指接管导航，结束 Konva 可能已开始的单指节点拖拽。
      stageRef.current?.find('.touch-edit-node').forEach((node: any) => node.stopDrag());
      setIsDraggingNode(false);
      setActiveCalibrationGuides([]);
      setIsDragging(false);
      startCanvasInteraction();
      return;
    }
    if (activeTool === 'pan') startCanvasInteraction();
    if (points.length !== 1) return;
    const point = points[0];
    const stationNode = e.target.findAncestor('.touch-station', true);
    const station = stationNode ? stations.find(s => s.id === stationNode.id()) : null;
    const sectionId = e.target.getAttr('sectionId');
    const waypointIndex = e.target.getAttr('waypointIndex');
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      if (readOnly) return;
      if (!gesture.canLongPress || isDrawingMode || addingWaypoint) return;
      gesture.consume();
      stationNode?.stopDrag();
      if (station) {
        setShowConnectAction(true);
        setStationContextMenu({ visible: true, station, ...point });
      } else if (sectionId) {
        setSectionContextMenu({ visible: true, sectionKey: sectionId, waypointIndex: waypointIndex ?? null,
          waypointOnly: waypointIndex !== undefined, ...point });
      } else if (e.target === stageRef.current) {
        setCanvasContextMenu({ visible: true, ...point });
      }
    }, 550);
  };

  const handleTouchMove = (e: any) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const points = readTouchPoints(e);
    const gesture = touchGestureRef.current;
    if (points.length > 1 && !gesture.isNavigating) {
      stage.find('.touch-edit-node').forEach((node: any) => node.stopDrag());
    }
    const next = gesture.move(points, isAmapMode ? { x: 0, y: 0, scale: 1 }
      : { ...stage.position(), scale: stage.scaleX() }, activeTool === 'pan');
    if (!gesture.canLongPress) clearLongPress();
    if (!next) return;
    startCanvasInteraction();
    if (isAmapMode && amapRef.current) {
      const map = amapRef.current;
      const center = points.length > 1
        ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 } : null;
      const anchor = center ? getLngLatFromContainerPoint({
        x: (center.x - next.x) / next.scale, y: (center.y - next.y) / next.scale
      }) : null;
      if (next.scale !== 1) {
        const zoom = Math.max(3, Math.min(20, map.getZoom() + Math.log2(next.scale)));
        map.setZoom(zoom, true, 0);
      }
      const pixel = anchor ? map.lngLatToContainer([anchor.lng, anchor.lat]) : null;
      if (center && pixel) map.panBy?.(center.x - pixel.x, center.y - pixel.y, 0);
      else map.panBy?.(next.x, next.y, 0);
      return;
    }
    stage.scale({ x: next.scale, y: next.scale });
    stage.position({ x: next.x, y: next.y });
    syncZoomElementSizesRef.current(next.scale);
    stage.batchDraw();
  };

  const handleTouchEnd = (e: any) => {
    e.evt.preventDefault();
    clearLongPress();
    const remaining = readTouchPoints(e);
    touchTapAllowedRef.current = touchGestureRef.current.end(remaining);
    if (remaining.length) return;
    setIsDragging(false);
    scheduleCanvasInteractionEnd(120);
    // 站点/区间由自己的 onTap 处理；空白画布在此处理添加站点。
    if (touchTapAllowedRef.current && e.target === stageRef.current && !addingWaypoint) handleStageClick(e);
  };

  const handleTouchCancel = () => {
    clearLongPress();
    touchGestureRef.current.cancel();
    touchTapAllowedRef.current = false;
    stageRef.current?.find('.touch-edit-node').forEach((node: any) => node.stopDrag());
    setIsDragging(false);
    setIsDraggingNode(false);
    setActiveCalibrationGuides([]);
    scheduleCanvasInteractionEnd(0);
  };

  // 处理拖拽开始
  const handleMouseDown = (e: any) => {
    const __t0 = performance.now();
    __perfClickStartRef.current = __t0;
    // 关闭右键菜单
    closeStationContextMenu();
    setCanvasContextMenu(prev => ({ ...prev, visible: false }));
    if (e.target === e.target.getStage()) {
      const pos = e.target.getPointerPosition();
      const willPan = activeTool === 'pan';
      setIsDragging(willPan);
      lastPointerPositionRef.current = pos;
      setMouseDownPosition(pos);
      // 纯画布 pan：进入"交互中"通道，labelPlacements 切换到缓存路径
      if (willPan && !isAmapMode) {
        startCanvasInteraction();
      }
    }
    perfMark('handleMouseDown sync body', __t0);
  };

  // 处理拖拽移动
  const handleMouseMove = (e: any) => {
    if (isDragging && activeTool === 'pan') {
      const stage = e.target.getStage();
      const pointer = stage.getPointerPosition();
      const last = lastPointerPositionRef.current;
      const dx = pointer.x - last.x;
      const dy = pointer.y - last.y;
      lastPointerPositionRef.current = pointer;

      if (isAmapMode && amapRef.current) {
        amapRef.current.panBy?.(dx, dy);
        return;
      }

      // 纯画布：直接写 stage.position()，不走 React state，不触发 reconcile。
      // Konva 的 batchDraw 内部已经把多次写聚合成单帧一次重绘。
      const current = stage.position();
      stage.position({ x: current.x + dx, y: current.y + dy });
      stage.batchDraw();
    }

  // 原有的绘制模式鼠标移动逻辑：优先直接命令式更新顶层预览层 Line，避免每次鼠标移动重渲整张几千节点的画布
    if (isDrawing && drawingLine.startStation && drawingStartPoint) {
      const stage = e.target.getStage();
      const pointer = stage.getPointerPosition();

      // 转换为世界坐标
      const worldPos = {
        ...getPointerWorldPosition(stage, pointer)
      };

      const nextPts = [
        drawingStartPoint.x,
        drawingStartPoint.y,
        worldPos.x,
        worldPos.y
      ];
      drawingPointsRef.current = nextPts;
      const previewNode = stage?.findOne?.('#metro-drawing-preview');
      if (previewNode) {
        previewNode.points(nextPts);
        previewNode.visible(true);
        previewNode.getLayer?.()?.batchDraw?.();
      } else {
        setDrawingLine(prev => ({ ...prev, points: nextPts }));
      }
    }
  };

  // 处理拖拽结束
  // 处理拖拽结束，判断是否为单击
  const handleMouseUp = (e?: any) => {
    const __t0 = performance.now();
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
    // 把 stage 的最终位置同步回 React state；之后等 120ms 才退出"交互中"，
    // 避免松手瞬间立刻跑 label 重布局造成"松手卡一下"。
    // 注意 setState 必须在 scheduleCanvasInteractionEnd 之前发出 —— 等 isMapInteracting
    // 翻 false 时 useLayoutEffect 会跑，那时 state 已经是新值，effect 写回 stage 是 no-op。
    if (!isAmapMode && stageRef.current) {
      const stage = stageRef.current;
      const pos = stage.position();
      const sx = stage.scaleX();
      // 只在确实变了才 setState，省一次 reconcile
      if (Math.abs(pos.x - position.x) > 0.5 || Math.abs(pos.y - position.y) > 0.5) {
        setPosition({ x: pos.x, y: pos.y });
      }
      if (Math.abs(sx - scale) > 0.001) {
        setScale(sx);
      }
      scheduleCanvasInteractionEnd(120);
    }
    // 只有真正单击才弹窗。鼠标事件用 button===0 区分左键；触屏事件 evt.button === undefined，
    // 那就用 evt 类型判断（TouchEvent 没有 button 字段，只要不是右键就放行）。
    const isLeftMouseOrTouch =
      e && e.evt && (e.evt.button === 0 || e.evt.button === undefined);
    if (isClick && isLeftMouseOrTouch && !isSectionMode) {
      handleStageClick(e);
    }
    perfMark('handleMouseUp sync body (inc stageClick if any)', __t0);
  };

  const applyCanvasViewport = (nextScale: number, nextPosition: { x: number; y: number }) => {
    const stage = stageRef.current;
    if (stage) {
      stage.scale({ x: nextScale, y: nextScale });
      stage.position(nextPosition);
      syncZoomElementSizesRef.current(nextScale);
      stage.batchDraw();
    }
    setScale(nextScale);
    setPosition(nextPosition);
    scheduleCanvasInteractionEnd(0);
  };

  // 重置视图
  const resetView = () => {
    if (isAmapMode && amapRef.current) {
      const amapOptions = mapSettings.baseMap.amap || DEFAULT_AMAP_SETTINGS;
      amapRef.current.setZoomAndCenter?.(amapOptions.zoom, amapOptions.center);
      return;
    }
    applyCanvasViewport(1, { x: 0, y: 0 });
  };

  const setCanvasZoom = (requested: number) => {
    const stage = stageRef.current;
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, requested));
    if (!stage) { setScale(next); return; }
    const old = stage.scaleX();
    const center = { x: stage.width() / 2, y: stage.height() / 2 };
    const pos = stage.position();
    applyCanvasViewport(next, { x: center.x - (center.x - pos.x) * next / old,
      y: center.y - (center.y - pos.y) * next / old });
  };

  // 放大
  const zoomIn = () => {
    if (isAmapMode && amapRef.current) {
      amapRef.current.setZoom?.(Math.min(20, (amapRef.current.getZoom?.() || 11) + 1));
      return;
    }
    setCanvasZoom((stageRef.current?.scaleX() || scale) * 1.2);
  };

  // 缩小
  const zoomOut = () => {
    if (isAmapMode && amapRef.current) {
      amapRef.current.setZoom?.(Math.max(3, (amapRef.current.getZoom?.() || 11) - 1));
      return;
    }
    setCanvasZoom((stageRef.current?.scaleX() || scale) / 1.2);
  };

  // 直接跳到某个缩放百分比（仅在纯画布模式下用 —— AMap 自己有标准 zoom 级别，
  // 把"100%"硬塞过去会很别扭，HUD 里 AMap 模式时直接禁用预设下拉）
  const setZoomPercent = (percent: number) => {
    const next = Math.max(0.1, Math.min(5, percent / 100));
    setCanvasZoom(next);
  };

  // 适应视图：自动打开小地图时封顶 1.0（保持 100% 标准设计比例不暴涨到 200%），手动点击“适应视图”温和封顶 1.15
  const fitView = (extraPadding = 0, maxZoomCap = 1.15) => {
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
    
    const paddingX = isCompact ? 64 : 50;
    const paddingTop = (isCompact ? 132 : 50) + extraPadding;
    const paddingBottom = (isCompact ? 156 : 50) + extraPadding / 2;
    const scaleX = Math.max(40, stageWidth - paddingX * 2) / Math.max(contentWidth, 1);
    const scaleY = Math.max(40, stageHeight - paddingTop - paddingBottom) / Math.max(contentHeight, 1);
    const newScale = Math.max(ZOOM_MIN, Math.min(scaleX, scaleY, maxZoomCap));
    
    applyCanvasViewport(newScale, {
      x: (stageWidth - contentWidth * newScale) / 2 - minX * newScale,
      y: paddingTop + (stageHeight - paddingTop - paddingBottom - contentHeight * newScale) / 2 - minY * newScale
    });
  };

  const initialFitRef = useRef(fitOnMount);
  const lastFittedDocKeyRef = useRef<string | null>(fitOnMount ? null : documentKey);
  const initialFitViewRef = useRef(fitView);
  initialFitViewRef.current = fitView;
  useEffect(() => {
    if (fitOnMount && documentKey !== lastFittedDocKeyRef.current) {
      initialFitRef.current = true;
    }
  }, [documentKey, fitOnMount]);
  useEffect(() => {
    if (initialFitRef.current && !isDocumentLoading && stageSize.width > 0 && stageSize.height > 0 &&
      Math.abs(stageSize.width - (containerRef.current?.clientWidth || stageSize.width)) < 2) {
      initialFitRef.current = false;
      lastFittedDocKeyRef.current = documentKey;
      if (!isAmapMode && stations.length > 0) {
        initialFitViewRef.current(72, 1);
      }
    }
  }, [documentKey, isAmapMode, isDocumentLoading, stageSize.width, stageSize.height, stations.length]);

  // 居中到某站（命令 center）。纯画布按当前缩放把站点移到视口中心；高德走 setCenter。
  const centerOnStation = (stationId: string) => {
    const st = stations.find(s => s.id === stationId);
    if (!st) return;
    if (isAmapMode && amapRef.current) {
      if (typeof st.lng === 'number' && typeof st.lat === 'number') {
        amapRef.current.setCenter?.([st.lng, st.lat]);
      }
      return;
    }
    const p = getDisplayPoint(st);
    setPosition({ x: stageSize.width / 2 - p.x * scale, y: stageSize.height / 2 - p.y * scale });
  };

  // 命令行视图通道（latest-ref 模式）：分发器每次渲染重建、闭包捕获当前的视图函数，
  // 这样 effect 只需依赖 viewCommand，无需把一堆函数塞进 deps（也避免 exhaustive-deps 噪音）。
  const viewDispatchRef = useRef<(a: AppAction) => void>(() => {});
  viewDispatchRef.current = (a: AppAction) => {
    switch (a.type) {
      case 'zoom': setZoomPercent(a.value * 100); break;
      case 'zoom_in': zoomIn(); break;
      case 'zoom_out': zoomOut(); break;
      case 'fit': fitView(); break;
      case 'reset': resetView(); break;
      case 'center': centerOnStation(a.stationId); break;
      default: break;
    }
  };
  useEffect(() => {
    if (viewCommand) viewDispatchRef.current(viewCommand.action);
  }, [viewCommand]);

  // 画布点击，弹窗输入站名
  const handleStageClick = (e: any) => {
    const __t0 = performance.now();
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
    perfMark('handleStageClick sync body', __t0);
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
        const initPts = [startPoint.x, startPoint.y];
        drawingPointsRef.current = initPts;
        // 开始绘制
        setDrawingLine({
          startStation: clickedStation,
          points: initPts
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
    const currentLine = lineById.get(currentLineId);
    if (!currentLine) {
      message.error('线路不存在');
      cancelDrawing();
      return;
    }

    // 构建完整的路径点
    const endPoint = getDisplayPoint(endStation);
    const activePts = drawingPointsRef.current.length >= 2 ? drawingPointsRef.current : drawingLine.points;
    const allPoints = [...activePts, endPoint.x, endPoint.y];
    
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
    drawingPointsRef.current = [];
    const previewNode = stageRef.current?.findOne?.('#metro-drawing-preview');
    if (previewNode) {
      previewNode.points([]);
      previewNode.visible(false);
      previewNode.getLayer?.()?.batchDraw?.();
    }
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

  // 命令式更新某条区间在线网画布上的 Konva Line 坐标（拖拽站点/途经点期间 60fps 零 React 重渲染）
  const updateSectionKonvaLineImperative = (
    section: Section,
    overrideStation?: { id: string; x: number; y: number },
    overrideWaypoints?: Waypoint[]
  ) => {
    const stage = stageRef.current;
    if (!stage?.findOne) return;
    const start = stationById.get(section.startStationId);
    const end = stationById.get(section.endStationId);
    if (!start || !end) return;
    const startPt = overrideStation && overrideStation.id === start.id
      ? { x: overrideStation.x, y: overrideStation.y }
      : getDisplayPoint(start);
    const endPt = overrideStation && overrideStation.id === end.id
      ? { x: overrideStation.x, y: overrideStation.y }
      : getDisplayPoint(end);
    const wps = overrideWaypoints !== undefined ? overrideWaypoints : (section.waypoints || []);
    const wpPts = wps.map((point) => getWaypointDisplayPoint(point));
    const rawPoints = [startPt.x, startPt.y, ...wpPts.flatMap((p) => [p.x, p.y]), endPt.x, endPt.y];
    const dx = endPt.x - startPt.x;
    const dy = endPt.y - startPt.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const normal = { x: -dy / len, y: dx / len };
    const meta = sectionParallelMetaRef.current.get(section.id) || { total: 1, index: 0 };
    const offset = (meta.index - (meta.total - 1) / 2) * parallelGapRef.current;
    const shiftedPoints: number[] = [];
    for (let i = 0; i < rawPoints.length; i += 2) {
      shiftedPoints.push(rawPoints[i] + normal.x * offset, rawPoints[i + 1] + normal.y * offset);
    }
    const radius = Math.max(0, mapSettings.cornerRadius || 0);
    const renderPoints = radius > 0 ? roundLineFlat(shiftedPoints, radius) : shiftedPoints;
    const visNode = stage.findOne(`#sec_vis_${section.id}`);
    const hitNode = stage.findOne(`#sec_hit_${section.id}`);
    visNode?.points?.(renderPoints);
    hitNode?.points?.(shiftedPoints);
  };

  // 命令式更新顶层辅助层上的校准虚线（最多 4 条），避免拖拽中 setActiveCalibrationGuides 引发重渲
  const updateImperativeGuides = (guides: number[][]) => {
    const stage = stageRef.current;
    if (!stage?.findOne) {
      setActiveCalibrationGuides(guides);
      return;
    }
    let layer: any = null;
    for (let i = 0; i < 4; i += 1) {
      const node = stage.findOne(`#imperative_guide_${i}`);
      if (!node) continue;
      layer = layer || node.getLayer?.();
      if (guides[i]) {
        node.points(guides[i]);
        node.visible(true);
      } else {
        node.points([]);
        node.visible(false);
      }
    }
    layer?.batchDraw?.();
  };

  // 拖动站点（含自动吸附；拖拽过程纯命令式更新 Konva，松手才提交一次 React 状态）
  const handleDragMove = (id: string, pos: { x: number; y: number }, groupNode?: any) => {
    if (touchGestureRef.current.isNavigating) return;
    const updatedStation = stationById.get(id);
    if (!updatedStation) return;

    if (isAmapMode) {
      const lngLat = getLngLatFromContainerPoint(pos);
      dragStationDraftRef.current = { id, x: pos.x, y: pos.y, ...(lngLat || {}) };
      const incident = stationToSections.get(id) || [];
      if (stageRef.current?.findOne) {
        incident.forEach((sec) => updateSectionKonvaLineImperative(sec, { id, x: pos.x, y: pos.y }));
        groupNode?.getLayer?.()?.batchDraw?.();
      } else {
        onUpdateStation({ ...updatedStation, x: pos.x, y: pos.y, ...(lngLat || {}) });
      }
      return;
    }

    const incidentSections = stationToSections.get(id) || [];
    const connectedStations: Station[] = [];
    incidentSections.forEach((sec) => {
      const neighborId = sec.startStationId === id ? sec.endStationId : sec.startStationId;
      const neighbor = stationById.get(neighborId);
      if (neighbor) connectedStations.push(neighbor);
    });

    let snappedX = pos.x;
    let snappedY = pos.y;
    const guides: number[][] = [];
    let bestSnapDiff = Number.POSITIVE_INFINITY;

    connectedStations.forEach((st) => {
      const guide = buildAxisGuide(st.x, st.y, pos.x, pos.y);
      if (guide) guides.push(guide);
      const snap = getDirectionalSnap(st.x, st.y, pos.x, pos.y, SNAP_THRESHOLD_DEG);
      if (snap && snap.diff < bestSnapDiff) {
        bestSnapDiff = snap.diff;
        snappedX = snap.x;
        snappedY = snap.y;
      }
    });

    dragStationDraftRef.current = { id, x: snappedX, y: snappedY };
    if (groupNode?.position) {
      groupNode.position({ x: snappedX, y: snappedY });
    }
    updateImperativeGuides(guides);
    if (stageRef.current?.findOne) {
      incidentSections.forEach((sec) => updateSectionKonvaLineImperative(sec, { id, x: snappedX, y: snappedY }));
      groupNode?.getLayer?.()?.batchDraw?.();
    } else {
      onUpdateStation({ ...updatedStation, x: snappedX, y: snappedY });
    }
  };

  const commitStationDrag = () => {
    updateImperativeGuides([]);
    setActiveCalibrationGuides([]);
    setIsDraggingNode(false);
    const draft = dragStationDraftRef.current;
    dragStationDraftRef.current = null;
    if (!draft) return;
    const base = stationById.get(draft.id);
    if (!base) return;
    onUpdateStation({
      ...base,
      x: draft.x,
      y: draft.y,
      ...(draft.lng !== undefined && draft.lat !== undefined ? { lng: draft.lng, lat: draft.lat } : {})
    });
  };

  // 处理站点点击
  const handleStationClick = (station: Station, e?: any) => {
    if (readOnly) {setStationInfoModal({visible:true,station,note:station.note||''});return;}
    if (lastIsRightClickRef.current) {
      lastIsRightClickRef.current = false;
      return;
    }
    if (e?.evt && e.evt.button !== undefined && e.evt.button !== 0) {
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
    if (readOnly) { e?.evt?.preventDefault?.(); return; }
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

  const handleStationTap = (station: Station, e: any) => {
    if (readOnly) {if(touchTapAllowedRef.current)handleStationClick(station,e);return;}
    if (!touchTapAllowedRef.current || addingWaypoint) return;
    if (isDrawingMode) { handleDrawingModeClick(e); return; }
    if (activeTool === 'pan') return;
    const pointer = e.target.getStage()?.getPointerPosition();
    if (pointer) {
      setShowConnectAction(true);
      setStationContextMenu({ visible: true, station, x: pointer.x, y: pointer.y });
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
    const currentLine = lineById.get(currentLineId);
    if (!currentLine) return [];
    return currentLine.stationIds
      .map(id => stationById.get(id))
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

  const updateWaypoint = (sectionId: string, waypointIndex: number, x: number, y: number, withGuide = false, circleNode?: any) => {
    const section = sectionById.get(sectionId);
    if (!section) return;
    const startStation = stationById.get(section.startStationId);
    const endStation = stationById.get(section.endStationId);
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

    if (circleNode && stageRef.current?.findOne) {
      if (!isAmapMode) circleNode.position?.({ x: snappedX, y: snappedY });
      dragWaypointDraftRef.current = { sectionId, waypoints: next };
      if (withGuide) updateImperativeGuides(guideLines.map(g => [g[0], g[1], g[2], g[3]]));
      updateSectionKonvaLineImperative(section, undefined, next);
      circleNode.getLayer?.()?.batchDraw?.();
      return;
    }

    writeSectionWaypoints(sectionId, next);
    if (withGuide) {
      setActiveCalibrationGuides(guideLines.map(g => [g[0], g[1], g[2], g[3]]));
    }
  };

  const commitWaypointDrag = () => {
    updateImperativeGuides([]);
    setActiveCalibrationGuides([]);
    setIsDraggingNode(false);
    const draft = dragWaypointDraftRef.current;
    dragWaypointDraftRef.current = null;
    if (draft) {
      writeSectionWaypoints(draft.sectionId, draft.waypoints);
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
    if (readOnly) { e?.evt?.preventDefault?.(); return; }
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
  // 线路圆角半径（世界坐标）：0 = 直角。只圆途经点拐角（section 内部点），站点端点保持尖角。
  const lineCornerRadius = Math.max(0, mapSettings.cornerRadius || 0);
  // 一次遍历建 station -> Line[] 的索引；后面 stationLineCounts / tier1 / getStationColor 全部走 O(1) 查表，
  // 不再每个站重复扫一遍 lines.filter / lines.find。大线网下 O(stations × lines) 是大头之一
  const stationToLines = useMemo(() => {
    const map = new Map<string, LineType[]>();
    lines.forEach(line => {
      line.stationIds.forEach(id => {
        const arr = map.get(id);
        if (arr) arr.push(line);
        else map.set(id, [line]);
      });
    });
    return map;
  }, [lines]);

  // 每个站点出现在多少条线路里（≥2 即换乘站）。靠 stationToLines O(1) 查
  const stationLineCounts = useMemo(() => {
    return stations.reduce<Record<string, number>>((result, station) => {
      result[station.id] = stationToLines.get(station.id)?.length || 0;
      return result;
    }, {});
  }, [stations, stationToLines]);

  // Tier 1 = 必须显示站名 = 换乘站（≥2 线）+ 每条线的首末站。
  // 环线情况：如果 line.stationIds 首 === 末，会自动通过 Set 去重为一个。
  const tier1StationIds = useMemo(() => {
    const set = new Set<string>();
    Object.entries(stationLineCounts).forEach(([id, count]) => {
      if (count >= 2) set.add(id);
    });
    lines.forEach(line => {
      if (line.stationIds.length === 0) return;
      set.add(line.stationIds[0]);
      set.add(line.stationIds[line.stationIds.length - 1]);
    });
    return set;
  }, [stationLineCounts, lines]);

  // 站点标签密度：3 档，决定 fontSize / radius / lineWidth 怎么随缩放变化 + T2 显示策略
  const labelDensity = mapSettings.labelDensity;

  // 计算"图纸缩放系数"——用于乘以 fontSize / dot radius / lineWidth / 线路名标签等所有"图纸元素"。
  // - paper:    plain 模式靠 Konva 自然缩放，返回 1；
  //             amap 模式用 1.5^(zoom - 11) 做"半比例图纸缩放"：
  //               * 纯 2^delta（跟 AMap 线性 1:1）在 zoom 14 已经是 8×，标签会炸；
  //               * 1.5^delta 让 zoom 11→13 视觉上 1×→2.25× 比较明显，再用 clamp 锁住上限；
  //               * 上限 2.5 / 下限 0.5：保证最大不致遮屏，最小不致看不见
  // - adaptive: 反向 damped 缩放，让屏幕显示接近恒定大小（plain canvas 缩远时不至于完全看不见）
  // - key:      跟 adaptive 同样的尺寸策略，差异只在于 labelPlacements 把 T2 全部丢掉
  // 统一无状态视觉缩放模型：
  // - 高德模式：严格按当前地理 zoom 与固定参考层级（AMAP_REFERENCE_ZOOM = 11.8）计算分层系数，
  //   彻底废除会话期随机锚点，保证任意顺序打开地图或刷新页面后站点、站名、胶囊大小 100% 一致；
  // - 纯画布模式：与 Konva Stage 实时手势共享 plainCanvasElementScale，滚轮落停零跳变。
  const visualScales = useMemo(() => {
    if (isAmapMode) {
      const liveZoom = amapReady ? amapRef.current?.getZoom?.() : undefined;
      const zoom =
        typeof liveZoom === 'number' && Number.isFinite(liveZoom)
          ? liveZoom
          : mapSettings.baseMap.amap?.zoom || AMAP_REFERENCE_ZOOM;
      return computeAmapVisualScales(labelDensity, zoom);
    }
    return computePlainVisualScales(labelDensity, scale);
  }, [labelDensity, isAmapMode, amapReady, scale, mapRenderTick, mapSettings.baseMap.amap?.zoom]);

  const { dotScale, strokeScale, labelScale, pillScale, allowTier1OverlapCull } = visualScales;
  const effectiveScale = labelScale;

  // 手势直接写 Stage 时，同帧补偿站点/文字与线路宽度，避免松手后才改变字号。
  // 仅遍历现有 Konva 节点，不触发整张线网的 React 更新或标签避让计算。
  useLayoutEffect(() => {
    const synchronize = (viewportScale: number) => {
      const stage = stageRef.current;
      if (!stage) return;
      const ratio = isAmapMode ? 1 : liveElementScaleRatio(labelDensity, viewportScale, dotScale);
      const elementStrokeScale = isAmapMode ? strokeScale : plainCanvasElementScale(labelDensity, viewportScale);
      stage.find('.zoom-sized-element').forEach((node: any) => node.scale({ x: ratio, y: ratio }));
      stage.find('.zoom-sized-stroke').forEach((node: any) => node.strokeWidth(stylePreset.lineWidth * elementStrokeScale));
    };
    syncZoomElementSizesRef.current = synchronize;
    synchronize(stageRef.current?.scaleX() || scale);
  });

  // 按元素语义分别乘上 strokeScale / dotScale / labelScale / pillScale：
  // 缩远看全城时圆点与线宽显著收窄不糊成毛虫，站名保持可读下限并自动避让，首末站胶囊保持克制比例。
  const scaledLineWidth = stylePreset.lineWidth * strokeScale;
  const scaledParallelGap = Math.max(3.5, 8 * strokeScale);
  parallelGapRef.current = scaledParallelGap;
  const scaledNormalStationRadius = stylePreset.normalStationRadius * dotScale;
  const scaledNormalStationStrokeWidth = stylePreset.normalStationStrokeWidth * dotScale;
  const scaledInterchangeRadius = stylePreset.interchangeRadius * dotScale;
  const scaledInterchangeInnerRadius = stylePreset.interchangeInnerRadius * dotScale;
  const scaledInterchangeStrokeWidth = stylePreset.interchangeStrokeWidth * dotScale;
  const scaledWaypointRadius = Math.max(3.5, 6 * dotScale);
  const scaledWaypointStrokeWidth = Math.max(1.25, 2 * dotScale);
  const scaledFontSize = mapSettings.dotLabelStyle.fontSize * labelScale;
  // 线路名 pill 标签（终端“1 号线”色块）走独立的 pillScale，缩远或放大都不会喧宾夺主
  const scaledLineLabelFontSize = stylePreset.lineLabelFontSize * pillScale;
  const scaledLineLabelStrokeWidth = stylePreset.lineLabelStrokeWidth * pillScale;
  const scaledLineLabelPaddingX = stylePreset.lineLabelPaddingX * pillScale;
  const scaledLineLabelPaddingY = stylePreset.lineLabelPaddingY * pillScale;
  const scaledStationLabelGap = Math.max(6, scaledNormalStationRadius + 6 * labelScale);
  const scaledStationLabelMinWidth = 36 * labelScale;
  const scaledStationLabelMinHeight = 20 * labelScale;
  const scaledStationCollisionRadius = Math.max(5, scaledNormalStationRadius + 3 * dotScale);
  const scaledLineCollisionDistance = Math.max(10, scaledLineWidth + 10 * labelScale);
  const scaledLineLabelMinWidth = 48 * pillScale;
  const scaledLineLabelTerminalGap = 12 * pillScale;
  const scaledLineLabelMinDistance = 20 * pillScale;
  const scaledLineLabelSideGap = 7 * pillScale;
  const scaledClassicStationRadius = 20 * dotScale;
  const scaledClassicInterchangeRadius = 24 * dotScale;
  const scaledClassicStationStrokeWidth = 2 * dotScale;
  const scaledClassicInterchangeStrokeWidth = 4 * dotScale;
  const scaledClassicStationTextSize = 12 * labelScale;
  const scaledClassicStationTextBox = 40 * dotScale;

  const isLargeGraph = stations.length > 200 || sections.length > 200;

  // 预计算并缓存所有区间的平行偏移与圆角几何，仅在拓扑/投影/圆角变化时重算，并用 O(1) Map 替代 .find
  const preparedLineSegments = useMemo(() => {
    if (!canvasSceneReady) {
      sectionParallelMetaRef.current = new Map();
      return [];
    }
    const rawList: Array<{
      section: Section;
      line: LineType;
      start: Station;
      end: Station;
      waypoints: Waypoint[];
      normalizedKey: string;
    }> = [];
    for (let i = 0; i < sections.length; i += 1) {
      const section = sections[i];
      const line = lineById.get(section.lineId);
      const start = stationById.get(section.startStationId);
      const end = stationById.get(section.endStationId);
      if (!line || !start || !end) continue;
      const a = section.startStationId;
      const b = section.endStationId;
      rawList.push({
        section,
        line,
        start,
        end,
        waypoints: section.waypoints || [],
        normalizedKey: a < b ? `${a}_${b}` : `${b}_${a}`
      });
    }

    const countMap = new Map<string, number>();
    rawList.forEach((seg) => countMap.set(seg.normalizedKey, (countMap.get(seg.normalizedKey) || 0) + 1));
    const indexMap = new Map<string, number>();
    const metaMap = new Map<string, { total: number; index: number }>();

    const map = amapRef.current;
    const projectWp = (point: Waypoint) => {
      if (isAmapMode && amapReady && map && typeof point.lng === 'number' && typeof point.lat === 'number') {
        const pixel = map.lngLatToContainer?.([point.lng, point.lat]);
        if (pixel) return { x: pixel.x, y: pixel.y };
      }
      return { x: point.x, y: point.y };
    };

    const prepared = rawList.map((seg) => {
      const total = countMap.get(seg.normalizedKey) || 1;
      const currentIndex = indexMap.get(seg.normalizedKey) || 0;
      indexMap.set(seg.normalizedKey, currentIndex + 1);
      metaMap.set(seg.section.id, { total, index: currentIndex });

      const startPoint = stationDisplayPoints[seg.start.id] || { x: seg.start.x, y: seg.start.y };
      const endPoint = stationDisplayPoints[seg.end.id] || { x: seg.end.x, y: seg.end.y };
      const rawPoints: number[] = [startPoint.x, startPoint.y];
      for (let w = 0; w < seg.waypoints.length; w += 1) {
        const p = projectWp(seg.waypoints[w]);
        rawPoints.push(p.x, p.y);
      }
      rawPoints.push(endPoint.x, endPoint.y);

      const dx = endPoint.x - startPoint.x;
      const dy = endPoint.y - startPoint.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const normalX = -dy / len;
      const normalY = dx / len;
      const offset = (currentIndex - (total - 1) / 2) * scaledParallelGap;

      const shiftedPoints: number[] = new Array(rawPoints.length);
      for (let i = 0; i < rawPoints.length; i += 2) {
        shiftedPoints[i] = rawPoints[i] + normalX * offset;
        shiftedPoints[i + 1] = rawPoints[i + 1] + normalY * offset;
      }
      const renderPoints =
        lineCornerRadius > 0 ? roundLineFlat(shiftedPoints, lineCornerRadius) : shiftedPoints;

      return {
        ...seg,
        currentIndex,
        shiftedPoints,
        renderPoints
      };
    });

    sectionParallelMetaRef.current = metaMap;
    return prepared;
  }, [
    canvasSceneReady,
    sections,
    lineById,
    stationById,
    stationDisplayPoints,
    isAmapMode,
    amapReady,
    mapRenderTick,
    lineCornerRadius,
    scaledParallelGap
  ]);

  // 渲染线路连接线（网状结构）
  const renderLines = (suppressShadow: boolean) => {
    const result: JSX.Element[] = [];
    const showAllGuides = !suppressShadow && sections.length <= 80;

    preparedLineSegments.forEach((seg) => {
      const { currentIndex, shiftedPoints, renderPoints } = seg;

      const handleSectionLineClick = (e: any) => {
        if (readOnly) { e?.evt?.preventDefault?.(); return; }
        if (lastIsRightClickRef.current) {
          lastIsRightClickRef.current = false;
          return;
        }
        if (!e.evt || (e.evt.button !== undefined && e.evt.button !== 0)) return;
        if (e.evt.touches !== undefined && !touchTapAllowedRef.current) return;
        if (activeTool === 'pan' || addingWaypoint) return;
        if (isCompact && activeTool === 'select') {
          const pointer = e.target.getStage()?.getPointerPosition();
          setSectionContextMenu({ visible: true, x: pointer?.x || 0, y: pointer?.y || 0,
            sectionKey: seg.section.id, waypointIndex: null, waypointOnly: false });
          return;
        }
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
        if (readOnly) { e?.evt?.preventDefault?.(); return; }
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
          id={`sec_hit_${seg.section.id}`}
          points={shiftedPoints}
          stroke="rgba(0,0,0,0.001)"
          strokeWidth={Math.max(SECTION_HIT_STROKE_WIDTH, stylePreset.lineWidth + 12)}
          hitStrokeWidth={Math.max(SECTION_HIT_STROKE_WIDTH, stylePreset.lineWidth + 12)}
          lineCap="round"
          lineJoin="round"
          perfectDrawEnabled={false}
          tension={0}
          sectionId={seg.section.id}
          onTap={handleSectionLineClick}
          onClick={handleSectionLineClick}
          onContextMenu={handleSectionLineContextMenu}
        />,
        <Line
          key={`${seg.section.id}_${currentIndex}`}
          id={`sec_vis_${seg.section.id}`}
          name="zoom-sized-stroke"
          points={renderPoints}
          stroke={seg.line.color}
          strokeWidth={scaledLineWidth}
          lineCap="round"
          lineJoin="round"
          perfectDrawEnabled={false}
          shadowColor={seg.line.color}
          shadowBlur={suppressShadow ? 0 : stylePreset.lineShadowBlur}
          shadowOpacity={suppressShadow ? 0 : Math.max(canvasPalette.lineShadowOpacity, stylePreset.lineShadowOpacity)}
          tension={0}
          sectionId={seg.section.id}
          onTap={handleSectionLineClick}
          onClick={handleSectionLineClick}
          onContextMenu={handleSectionLineContextMenu}
        />
      );

      // 校准虚线：大线网仅对当前激活编辑线路展示静态校准虚线，避免成百上千条辅助虚线翻倍占用绘制预算
      if (!isLightRender && (showAllGuides || seg.line.id === currentLineId)) {
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
                listening={false}
                perfectDrawEnabled={false}
              />
            );
          }
        }
      }
    });
    return result;
  };

  // 生成直线连接
  const generateStraightLine = (lineStations: Station[]): number[] => {
    if (lineStations.length < 2) return [];

    const points: number[] = [];
    for (let i = 0; i < lineStations.length; i++) {
      points.push(lineStations[i].x, lineStations[i].y);
    }
    return points;
  };

  // 获取站点是否在当前线路中（O(1) Set 查表）
  const isStationInCurrentLine = (stationId: string) => currentLineStationIdSet.has(stationId);

  const isDotLabelStyle = mapSettings.mapStyle === 'dot-label';
  const isDarkCanvas = mapSettings.canvasTheme === 'dark';
  const canvasPalette = CANVAS_THEME_PALETTES[mapSettings.canvasTheme];
  const dotLabelStyle = mapSettings.dotLabelStyle;
  const amapStyle = mapSettings.baseMap.amap?.style || 'normal';
  const isLightAmapRender = isAmapMode && isMapInteracting;
  // Perf 诊断：state 指纹。每次 render 跟上次比，**只在变化时**打出来。
  // 列在这里的字段是 Canvas 里所有"会随交互/动画变化"的高频 state，看哪个无端在变就抓哪个。
  if (__perfEnabled) {
    const fp = [
      `adding=${adding}`,
      `newStation=${!!newStation}`,
      `mouseDownPos=${!!mouseDownPosition}`,
      `isDragging=${isDragging}`,
      `isDraggingNode=${isDraggingNode}`,
      `isMapInteracting=${isMapInteracting}`,
      `mapRenderTick=${mapRenderTick}`,
      `activeTool=${activeTool}`,
      `scale=${scale.toFixed(3)}`,
      `pos=${position.x.toFixed(0)},${position.y.toFixed(0)}`,
      `stageSize=${stageSize.width}x${stageSize.height}`,
      `lines=${lines.length}/stations=${stations.length}/sections=${sections.length}`,
      `showConnect=${showConnectAction}`,
      `ctxMenu=${stationContextMenu.visible ? 'S' : ''}${canvasContextMenu.visible ? 'C' : ''}${sectionContextMenu.visible ? 'X' : ''}`,
      `selSection=${!!selectedSection}`,
      `addingWp=${addingWaypoint}`,
      `calibGuides=${activeCalibrationGuides.length}`,
      `amapReady=${amapReady}`
    ].join('|');
    if (fp !== __perfStateFpRef.current) {
      // diff 一下哪些片段变了，输出会更精炼
      const prevParts = __perfStateFpRef.current.split('|');
      const curParts = fp.split('|');
      const changed = curParts.filter((p, i) => p !== prevParts[i]);
      console.log(`[metro-perf] state changed: ${changed.join(', ') || '(none — pure prop change?)'}`);
      __perfStateFpRef.current = fp;
    }
  }
  // AMap 模式拖动 / 缩放时，AMap 自己已经在底图层绘制，Konva 这一层走"轻量渲染"
  // ——把 labels / shadows / 装饰文字全砍掉，是 AMap 模式拖动顺滑的根本原因。
  // 纯画布模式之前没有这个开关，所以拖动时 Konva 还要绘制 100+ 个 Text + shadow，
  // 站点越多越卡。把同一个机制扩展到画布交互期间一并应用。
  const isLightCanvasRender = !isAmapMode && isMapInteracting;
  const isLightRender = isLightAmapRender || isLightCanvasRender;
  // 拖拽 / AMap 交互期间跳过 O(n²) 的 label / lineName 重排，复用上一次的缓存结果。
  // 视觉上：拖动站点时旁边的标签会暂时"凝固"在旧位置，松开后立即重新布局——
  // 60Hz 拖拽时省下大量算法成本，是大线网卡顿的主要来源
  const skipHeavyLayout = isMapInteracting || isDraggingNode;
  const isMutedAmapStyle = isAmapMode && (amapStyle === 'dark' || amapStyle === 'grey');
  const isFreshAmapStyle = isAmapMode && amapStyle === 'fresh';
  const readableLabelText = isMutedAmapStyle ? '#ffffff' : isFreshAmapStyle ? '#0f172a' : dotLabelStyle.color || canvasPalette.labelText;
  const readableLabelShadow = isMutedAmapStyle ? 'rgba(0, 0, 0, 0.92)' : 'rgba(255, 255, 255, 0.98)';

  // O(1) 查询：currentLine 一次查表；非当前线就取这个站第一条经过线的色；都没有给默认灰
  const currentLine = currentLineId ? (lineById.get(currentLineId) || null) : null;
  const suppressShadows = isLightRender || isLargeGraph;
  const getStationColor = (stationId: string) => {
    const passing = stationToLines.get(stationId);
    if (currentLine && passing?.some(l => l.id === currentLine.id)) return currentLine.color;
    return passing?.[0]?.color || '#64748b';
  };

  // 站名标注布局：用 2D 空间网格哈希索引将 O(stations² + stations×segments) 降至近似 O(stations)，
  // 评分结果与原版全量碰撞算法严格等价，千站规模下耗时从数百毫秒降至数毫秒。
  const labelPlacementsCacheRef = useRef<Record<string, LabelRect>>({});
  const labelPlacements = useMemo(() => {
    if (!canvasSceneReady) { labelPlacementsCacheRef.current = {}; return {}; }
    const __t0 = performance.now();
    if (isLightAmapRender) return {} as Record<string, LabelRect>;
    if (skipHeavyLayout) return labelPlacementsCacheRef.current;

    const pointOf = (station: Station) => stationDisplayPoints[station.id] || { x: station.x, y: station.y };
    const waypointPointOf = (point: Waypoint) => {
      const map = amapRef.current;
      if (isAmapMode && amapReady && map && typeof point.lng === 'number' && typeof point.lat === 'number') {
        const pixel = map.lngLatToContainer?.([point.lng, point.lat]);
        if (pixel) return { x: pixel.x, y: pixel.y };
      }
      return { x: point.x, y: point.y };
    };

    const gridCellSize = Math.max(64, Math.round(128 * effectiveScale));
    const occupiedGrid = new SpatialBoxGrid<LabelRect>(gridCellSize);

    type StationCollisionBox = LabelRect & { stationId: string };
    const stationGrid = new SpatialBoxGrid<StationCollisionBox>(gridCellSize);
    for (let i = 0; i < stations.length; i += 1) {
      const st = stations[i];
      const pt = pointOf(st);
      stationGrid.insert({
        stationId: st.id,
        x: pt.x - scaledStationCollisionRadius,
        y: pt.y - scaledStationCollisionRadius,
        width: scaledStationCollisionRadius * 2,
        height: scaledStationCollisionRadius * 2
      });
    }

    type SegmentCollisionBox = LabelRect & { x1: number; y1: number; x2: number; y2: number };
    const segmentGrid = new SpatialBoxGrid<SegmentCollisionBox>(gridCellSize);
    const pad = scaledLineCollisionDistance;
    for (let s = 0; s < sections.length; s += 1) {
      const section = sections[s];
      const start = stationById.get(section.startStationId);
      const end = stationById.get(section.endStationId);
      if (!start || !end) continue;
      const wps = section.waypoints;
      let prev = pointOf(start);
      if (wps && wps.length > 0) {
        for (let w = 0; w < wps.length; w += 1) {
          const cur = waypointPointOf(wps[w]);
          const minX = Math.min(prev.x, cur.x) - pad;
          const minY = Math.min(prev.y, cur.y) - pad;
          segmentGrid.insert({
            x: minX,
            y: minY,
            width: Math.abs(cur.x - prev.x) + pad * 2,
            height: Math.abs(cur.y - prev.y) + pad * 2,
            x1: prev.x, y1: prev.y, x2: cur.x, y2: cur.y
          });
          prev = cur;
        }
      }
      const last = pointOf(end);
      segmentGrid.insert({
        x: Math.min(prev.x, last.x) - pad,
        y: Math.min(prev.y, last.y) - pad,
        width: Math.abs(last.x - prev.x) + pad * 2,
        height: Math.abs(last.y - prev.y) + pad * 2,
        x1: prev.x, y1: prev.y, x2: last.x, y2: last.y
      });
    }

    // 按重要性精细排序：Tier 1（换乘 + 首末站）优先于普通站；同为 Tier 1 时，多线换乘大枢纽优先于双线换乘与单线终点站
    const sortedStations = [...stations].sort((a, b) => {
      const aT1 = tier1StationIds.has(a.id) ? 0 : 1;
      const bT1 = tier1StationIds.has(b.id) ? 0 : 1;
      if (aT1 !== bT1) return aT1 - bT1;
      return (stationLineCounts[b.id] || 0) - (stationLineCounts[a.id] || 0);
    });

    const computed = sortedStations.reduce<Record<string, LabelRect>>((result, station) => {
      if (station.labelPosition === 'hidden') return result;
      const isT1 = tier1StationIds.has(station.id);
      if (labelDensity === 'key' && !isT1) return result;
      const hasPinnedPosition = Boolean(station.labelPosition && station.labelPosition !== 'auto');

      const stationPoint = pointOf(station);
      const labelWidth = Math.max(
        scaledStationLabelMinWidth,
        Math.ceil(estimateSingleLineTextWidth(station.name, scaledFontSize) + 8 * labelScale)
      );
      const labelHeight = Math.max(scaledStationLabelMinHeight, Math.ceil(scaledFontSize + 8 * labelScale));
      const gap = ((stationLineCounts[station.id] || 0) > 1 ? scaledInterchangeRadius : scaledNormalStationRadius) + 5 * labelScale;
      const candidates = [
        { key: 'right', x: stationPoint.x + gap, y: stationPoint.y - labelHeight / 2 },
        { key: 'left', x: stationPoint.x - labelWidth - gap, y: stationPoint.y - labelHeight / 2 },
        { key: 'top', x: stationPoint.x - labelWidth / 2, y: stationPoint.y - labelHeight - gap },
        { key: 'bottom', x: stationPoint.x - labelWidth / 2, y: stationPoint.y + gap },
        { key: 'top-right', x: stationPoint.x + gap, y: stationPoint.y - labelHeight - gap },
        { key: 'bottom-right', x: stationPoint.x + gap, y: stationPoint.y + gap },
        { key: 'top-left', x: stationPoint.x - labelWidth - gap, y: stationPoint.y - labelHeight - gap },
        { key: 'bottom-left', x: stationPoint.x - labelWidth - gap, y: stationPoint.y + gap }
      ].filter(candidate => !hasPinnedPosition || candidate.key === station.labelPosition);

      let best: { rect: LabelRect; score: number; hasLabelOverlap: boolean } | null = null;
      for (let c = 0; c < candidates.length; c += 1) {
        const candidate = candidates[c];
        const rect: LabelRect = { x: candidate.x, y: candidate.y, width: labelWidth, height: labelHeight };
        let score = 0;
        let hasLabelOverlap = false;
        occupiedGrid.forEachInBox(rect, (other) => {
          if (rectsOverlap(rect, other)) {
            score += 120;
            hasLabelOverlap = true;
          }
        });
        stationGrid.forEachInBox(rect, (other) => {
          if (other.stationId !== station.id && rectsOverlap(rect, other)) score += 60;
        });
        if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > stageSize.width || rect.y + rect.height > stageSize.height) {
          score += 40;
        }
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const nearSegments = segmentGrid.queryPoint(cx, cy);
        for (let k = 0; k < nearSegments.length; k += 1) {
          const seg = nearSegments[k];
          if (distanceToSegment(cx, cy, seg.x1, seg.y1, seg.x2, seg.y2) < scaledLineCollisionDistance) {
            score += 18;
          }
        }
        if (candidate.key === 'right') score -= 6;
        if (candidate.key === 'left') score -= 3;
        if (!best || score < best.score) {
          best = { rect, score, hasLabelOverlap };
        }
      }

      if (!best) return result;
      // 普通站在发生硬重叠或严重压盖圆点时隐藏；缩远密集视野下若 T1 的全部 8 个候选位仍与更高优先级站名硬叠字，也自动避让隐藏（手动固定位置除外）
      if (!hasPinnedPosition) {
        if (!isT1 && (best.hasLabelOverlap || best.score >= 100)) return result;
        if (isT1 && allowTier1OverlapCull && best.hasLabelOverlap) return result;
      }

      occupiedGrid.insert(best.rect);
      result[station.id] = best.rect;
      return result;
    }, {});
    labelPlacementsCacheRef.current = computed;
    perfMark(`labelPlacements computed (stations=${stations.length}, sections=${sections.length})`, __t0);
    return computed;
  }, [
    canvasSceneReady,
    isLightAmapRender,
    skipHeavyLayout,
    sections,
    stations,
    stationById,
    scaledFontSize,
    labelScale,
    effectiveScale,
    scaledNormalStationRadius,
    scaledInterchangeRadius,
    scaledStationLabelMinWidth,
    scaledStationLabelMinHeight,
    scaledStationCollisionRadius,
    scaledLineCollisionDistance,
    stageSize.width,
    stageSize.height,
    stationDisplayPoints,
    isAmapMode,
    amapReady,
    mapRenderTick,
    tier1StationIds,
    stationLineCounts,
    allowTier1OverlapCull,
    labelDensity
  ]);

  // 线路名标签布局：同样接入空间网格索引与 stationById O(1) 查表
  const lineNamePlacementsCacheRef = useRef<Array<{ key: string; line: LineType; x: number; y: number; width: number; height: number }>>([]);
  const lineNamePlacements = useMemo(() => {
    if (!canvasSceneReady) { lineNamePlacementsCacheRef.current = []; return []; }
    const __t0 = performance.now();
    if (isLightAmapRender || !mapSettings.showLineNameLabels || lines.length === 0) return [];
    if (skipHeavyLayout) return lineNamePlacementsCacheRef.current;

    const pointOf = (station: Station) => stationDisplayPoints[station.id] || { x: station.x, y: station.y };
    const occupiedGrid = new SpatialBoxGrid<LabelRect>(Math.max(64, Math.round(128 * effectiveScale)));
    const labelValues = Object.values(labelPlacements);
    for (let i = 0; i < labelValues.length; i += 1) occupiedGrid.insert(labelValues[i]);
    for (let i = 0; i < stations.length; i += 1) {
      const point = pointOf(stations[i]);
      occupiedGrid.insert({
        x: point.x - scaledInterchangeRadius - scaledStationCollisionRadius,
        y: point.y - scaledInterchangeRadius - scaledStationCollisionRadius,
        width: (scaledInterchangeRadius + scaledStationCollisionRadius) * 2,
        height: (scaledInterchangeRadius + scaledStationCollisionRadius) * 2
      });
    }

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
        .map(id => stationById.get(id))
        .filter(Boolean) as Station[];
      if (orderedStations.length < 2) return;

      const labelWidth = Math.max(
        scaledLineLabelMinWidth,
        Math.ceil(estimateSingleLineTextWidth(line.name, scaledLineLabelFontSize) + scaledLineLabelPaddingX * 2)
      );
      const labelHeight = scaledLineLabelFontSize + scaledLineLabelPaddingY * 2 + 2;
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
          const baseDistance = Math.max(scaledLineLabelMinDistance, scaledInterchangeRadius + scaledLineLabelTerminalGap);
          return [
            0,
            labelHeight + scaledLineLabelSideGap,
            -(labelHeight + scaledLineLabelSideGap),
            labelHeight * 2 + scaledLineLabelSideGap * 2,
            -(labelHeight * 2 + scaledLineLabelSideGap * 2)
          ].map(
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
          occupiedGrid.forEachInBox(candidate.rect, (other) => {
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
        occupiedGrid.insert(best.rect);
        placements.push({
          key: line.id,
          line,
          ...best.rect
        });
      }
    });

    lineNamePlacementsCacheRef.current = placements;
    perfMark(`lineNamePlacements computed (lines=${lines.length})`, __t0);
    return placements;
  }, [
    canvasSceneReady,
    isLightAmapRender,
    skipHeavyLayout,
    mapSettings.showLineNameLabels,
    lines,
    labelPlacements,
    stations,
    stationById,
    effectiveScale,
    stylePreset,
    scaledInterchangeRadius,
    scaledStationCollisionRadius,
    scaledLineLabelMinWidth,
    scaledLineLabelTerminalGap,
    scaledLineLabelMinDistance,
    scaledLineLabelSideGap,
    scaledLineLabelFontSize,
    scaledLineLabelPaddingX,
    scaledLineLabelPaddingY,
    stageSize.width,
    stageSize.height,
    stationDisplayPoints
  ]);

  const handleWaypointPlacement = (e: any) => {
    if (e.evt?.touches !== undefined && !touchTapAllowedRef.current) return;
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

  };

  return (
    <div
      ref={containerRef}
      onTouchCancel={handleTouchCancel}
      className={`metro-canvas-surface ${isDarkCanvas ? 'is-canvas-dark' : ''}`}
      data-map-mode={mapSettings.baseMap.mode}
      aria-busy={!canvasSceneReady}
      style={{
        width: '100%',
        height: '100%',
        '--metro-canvas-bg': canvasBackgroundColor,
        backgroundColor: canvasBackgroundColor,
        // 用户导入了自定义画布背景图 → 用那张图并设置 cover/no-repeat；
        // 否则保持 undefined，避免内联 cover/no-repeat 把 CSS 里的 24×24 制图点阵拉成单点导致失效
        backgroundImage:
          !isAmapMode && canvasBackgroundImage ? `url(${canvasBackgroundImage})` : undefined,
        backgroundSize: !isAmapMode && canvasBackgroundImage ? 'cover' : undefined,
        backgroundPosition: !isAmapMode && canvasBackgroundImage ? 'center' : undefined,
        backgroundRepeat: !isAmapMode && canvasBackgroundImage ? 'no-repeat' : undefined
      } as React.CSSProperties}
    >
      {lines.length === 0 && stations.length === 0 && sections.length === 0 && !isAmapMode && !canvasBackgroundImage && onCreateLine && onStartWithAmap && (
        <CanvasStartPrompt language={language} onCreateLine={onCreateLine} onStartWithAmap={onStartWithAmap} />
      )}
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
      {!canvasSceneReady && (
        <div role="status" aria-live="polite" className="metro-map-loading"
          style={{ position: 'absolute', inset: 0, zIndex: 1001, display: 'grid', placeItems: 'center',
            background: isAmapMode && amapStyle === 'dark' ? '#151c25' : '#f1f5f9',
            color: isAmapMode && amapStyle === 'dark' ? '#e2e8f0' : '#475569' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, maxWidth: 440, padding: 28, fontSize: 15 }}>
            {!amapError && <Spin />}
            <span>{amapError || (language === 'en-US' ? 'Loading map and network…' : '正在加载地图与线网…')}</span>
          </div>
        </div>
      )}
      <div className="metro-canvas-tools">
        <div ref={toolGroupRef} className="metro-tool-group" data-active-tool={activeTool} role="toolbar" aria-label="Canvas tools">
          {/* 桌面与移动统一的灵动浮岛工具栏：移除会导致位移的小圆点，支持点击平滑飞入与按住左右扫选 */}
          {[
            { key: 'select' as CanvasTool, shortcut: 'V', label: text.tools.select, icon: <SelectOutlined />, hint: text.hints.select },
            { key: 'station' as CanvasTool, shortcut: 'S', label: text.tools.station, icon: <EnvironmentOutlined />, hint: text.hints.station },
            {
              key: 'line' as CanvasTool,
              shortcut: 'L',
              label: text.tools.line,
              icon: <NodeIndexOutlined />,
              hint:
                drawingLine.startStation
                  ? text.hints.lineDrawing(drawingLine.startStation.name)
                  : text.hints.lineIdle
            },
            { key: 'section' as CanvasTool, shortcut: 'W', label: text.tools.section, icon: <LineOutlined />, hint: text.hints.section },
            { key: 'pan' as CanvasTool, shortcut: 'H', label: text.tools.pan, icon: <DragOutlined />, hint: text.hints.pan }
          ].map((tool, index) => {
            const active = activeTool === tool.key;
            return (
              <Tooltip
                key={tool.key}
                title={isCompact ? null : `${tool.label} (${tool.shortcut}) · ${tool.hint}`}
                placement="bottom"
                mouseEnterDelay={0.25}
              >
                <button
                  type="button"
                  className={`metro-tool-button ${active ? 'is-active' : ''}`}
                  data-tool-index={index}
                  onClick={() => setCanvasTool(tool.key)}
                  aria-label={tool.label}
                  aria-pressed={active}
                >
                  <span className="metro-tool-button__icon">{tool.icon}</span>
                  <span className="metro-tool-button__label">{tool.label}</span>
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
      <div className="metro-touch-hint" aria-live="polite">
        <span>{language === 'en-US'
          ? (addingWaypoint ? 'Tap the canvas to place a waypoint' : isDrawing ? `From ${drawingLine.startStation?.name}: tap the destination` : 'Two fingers to move and zoom')
          : addingWaypoint ? '点画布放置途经点 · 双指移动和缩放'
          : isDrawing ? `从${drawingLine.startStation?.name}出发，点击终点站`
          : activeTool === 'pan' ? '单指移动 · 双指缩放 · 长按站点编辑'
          : activeTool === 'station' ? '点空白处加站 · 双指移动和缩放'
          : activeTool === 'line' ? '依次点起点、终点 · 双指移动和缩放'
          : activeTool === 'section' ? '点击区间调整走向 · 双指移动和缩放'
          : '点站点编辑 · 拖动调整位置 · 双指导航'}</span>
        {isDrawing || addingWaypoint ? <button type="button" onClick={() => {
          cancelDrawing(); setAddingWaypoint(false); setSelectedSection(null);
        }}>{language === 'en-US' ? 'Cancel' : '取消'}</button> : null}
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
      {isCompact && mobileViewControlsHost ? createPortal(
        <MobileViewControls language={language} isMapMode={isAmapMode}
          zoomLabel={isAmapMode
            ? (amapRef.current?.getZoom?.() || mapSettings.baseMap.amap?.zoom || 11).toFixed(1)
            : `${Math.round(scale * 100)}%`}
          onZoomOut={zoomOut} onZoomIn={zoomIn} onZoomPercent={setZoomPercent}
          onFitView={() => fitView()} onResetView={resetView} />,
        mobileViewControlsHost
      ) : !isCompact ? <div className="metro-canvas-hud">
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
            {text.zoom} {(amapRef.current?.getZoom?.() || mapSettings.baseMap.amap?.zoom || 11).toFixed(1)}
          </span>
        )}
        <Tooltip title={text.zoomIn}>
          <button type="button" className="metro-canvas-hud__btn" onClick={zoomIn} aria-label={text.zoomIn}>+</button>
        </Tooltip>
        <span className="metro-canvas-hud__divider" />
        <Tooltip title={text.fitView}>
          <button type="button" className="metro-canvas-hud__btn" onClick={() => fitView()} aria-label={text.fitView}>□</button>
        </Tooltip>
        <Tooltip title={text.resetView}>
          <button type="button" className="metro-canvas-hud__btn" onClick={resetView} aria-label={text.resetView}>⌂</button>
        </Tooltip>
      </div> : null}

      <Stage
        ref={stageRef}
        width={stageSize.width}
        height={stageSize.height}
        /* scaleX / scaleY / x / y 不再走 React props —— 交互期 imperative 写入 stage，
           非交互期由上面的 useLayoutEffect 把 state 同步过去。这样 200Hz 鼠标也不会
           触发 200 次 reconcile。 */
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={e => {
          // 拖拽结束（handleMouseUp 内部已经按 click 距离阈值决定要不要触发 handleStageClick）
          handleMouseUp(e);
        }}
        // 触屏单独识别点击、单指编辑、双指导航及系统取消。
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onContextMenu={handleCanvasContextMenu}
        onWheel={handleWheel}
        onClick={handleWaypointPlacement}
        onTap={handleWaypointPlacement}
        style={{ visibility: canvasSceneReady ? 'visible' : 'hidden', pointerEvents: canvasSceneReady ? 'auto' : 'none',
          cursor: activeTool === 'pan' ? 'grab' : isDrawingMode || activeTool === 'station' ? 'crosshair' : 'default' }}
      >
        <Layer listening={canvasSceneReady}>
          {canvasSceneReady && <>
          <Rect
            x={-10000}
            y={-10000}
            width={20000}
            height={20000}
            fill={isAmapMode ? 'rgba(0,0,0,0)' : canvasBackgroundColor}
            listening={false}
          />
          {/* 渲染线路连接线 */}
          {renderLines(suppressShadows)}
          {lineNamePlacements.map(label => (
            <Group key={`line_label_${label.key}`} name="zoom-sized-element" x={label.x} y={label.y} listening={false}>
              <Rect
                width={label.width}
                height={label.height}
                cornerRadius={label.height / 2}
                fill={isMutedAmapStyle ? 'rgba(255,255,255,0.94)' : stylePreset.lineLabelFill}
                stroke={label.line.color}
                strokeWidth={
                  isAmapMode
                    ? Math.max(1.5, scaledLineLabelStrokeWidth)
                    : scaledLineLabelStrokeWidth
                }
                shadowColor={label.line.color}
                shadowBlur={suppressShadows ? 0 : isAmapMode ? 8 : 4}
                shadowOpacity={suppressShadows ? 0 : isAmapMode ? 0.22 : 0.16}
                perfectDrawEnabled={false}
              />
              <Text
                text={label.line.name}
                width={label.width}
                height={label.height}
                align="center"
                verticalAlign="middle"
                wrap="none"
                fontSize={scaledLineLabelFontSize}
                fontStyle={`${stylePreset.lineLabelFontWeight}`}
                fill={isMutedAmapStyle ? '#0f172a' : stylePreset.lineLabelText}
                perfectDrawEnabled={false}
              />
            </Group>
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
                  radius={scaledWaypointRadius}
                  fill={canvasPalette.waypointFill}
                  stroke={canvasPalette.waypointStroke}
                  strokeWidth={scaledWaypointStrokeWidth}
                  shadowColor={canvasPalette.waypointShadow}
                  shadowBlur={suppressShadows ? 0 : 5}
                  perfectDrawEnabled={false}
                  name="touch-edit-node"
                  sectionId={section.id}
                  waypointIndex={idx}
                  draggable={!readOnly && (!isCompact || activeTool === 'select' || activeTool === 'section')}
                  dragDistance={isCompact ? 8 : 3}
                  onDragStart={() => {
                    onBeginInteraction?.();
                    dragWaypointDraftRef.current = null;
                    setIsDraggingNode(true);
                  }}
                  onDragMove={e => {
                    updateWaypoint(section.id, idx, e.target.x(), e.target.y(), true, e.target);
                  }}
                  onDragEnd={commitWaypointDrag}
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
          
          {/* 渲染站点 */}
          {stations.map(station => {
            const stationColor = getStationColor(station.id);
            const labelRect = labelPlacements[station.id];
            const isInterchangeStation = (stationLineCounts[station.id] || 0) > 1;
            const stationPoint = getDisplayPoint(station);
            return (
              <Group
                key={station.id}
                id={station.id}
                name="touch-edit-node touch-station zoom-sized-element"
                dragDistance={isCompact ? 8 : 3}
                x={stationPoint.x}
                y={stationPoint.y}
                draggable={!readOnly && (activeTool === 'select' || (!isCompact && activeTool === 'station'))}
                onDragStart={() => {
                  onBeginInteraction?.();
                  dragStationDraftRef.current = null;
                  setIsDraggingNode(true);
                }}
                onDragMove={e =>
                  handleDragMove(station.id, { x: e.target.x(), y: e.target.y() }, e.target)
                }
                onDragEnd={commitStationDrag}
                onTap={(e) => handleStationTap(station, e)}
                onClick={(e) => {
                  if (isCompact) { touchTapAllowedRef.current = true; handleStationTap(station, e); }
                  else handleStationClick(station, e);
                }}
                onContextMenu={(e) => handleStationRightClick(e, station)}
                style={{ cursor: isDrawingMode ? 'crosshair' : 'pointer' }}
              >
                {isCompact ? <Circle radius={Math.max(scaledNormalStationRadius, 22 / (isAmapMode ? 1 : scale))}
                  fill="rgba(0,0,0,0.001)" /> : null}
                {isDotLabelStyle ? (
                  <>
                    {isInterchangeStation ? (
                      // 换乘站：按 preset.interchangeShape 分 3 种结构（pie / lineColorArcs / concentricRing）
                      (() => {
                        const linesHere = stationToLines.get(station.id) || [];
                        const plan = planInterchange(
                          stylePreset.interchangeShape,
                          stylePreset.interchangeOuterStroke,
                          linesHere.map((l) => l.color)
                        );
                        const darkOutline = isDarkCanvas ? '#f8fafc' : '#0f172a';
                        const outerStrokeColor =
                          plan.outerStroke === 'dark'
                            ? darkOutline
                            : plan.outerStroke === 'lineColor'
                              ? (linesHere[0]?.color || stationColor)
                              : 'transparent';

                        if (plan.shape === 'curvedArrows') {
                          // 弧形互锁箭头：refresh icon 风。
                          // 每条线一个弧体 + 三角尖端，整体往内收一截、不顶到外圈描边
                          // —— 之前 0.5/0.88 太粗太外扩；现在 0.42/0.72 让箭头看起来"嵌"得更深、视觉更轻
                          const innerR = scaledInterchangeRadius * 0.42;
                          const outerR = scaledInterchangeRadius * 0.72;
                          return (
                            <>
                              {/* 白色填充作背景圆 + 命中区：保留 listening 让 Group 的 onContextMenu / onClick 能落到这里
                                  （否则三个 Path 都是 listening=false，点击会穿到下面的区间 Line） */}
                              <Circle
                                radius={scaledInterchangeRadius}
                                fill={canvasPalette.stationStroke}
                                shadowColor={canvasPalette.dotShadow}
                                shadowBlur={suppressShadows ? 0 : 6}
                                perfectDrawEnabled={false}
                              />
                              {plan.curvedArrows.map((arrow, i) => (
                                <Path
                                  key={`arrow_${i}`}
                                  data={buildCurvedArrowPath(0, 0, innerR, outerR, arrow)}
                                  fill={arrow.color}
                                  listening={false}
                                  perfectDrawEnabled={false}
                                />
                              ))}
                              {/* 外圈细深环 */}
                              <Circle
                                radius={scaledInterchangeRadius}
                                fill="transparent"
                                stroke={outerStrokeColor}
                                strokeWidth={scaledInterchangeStrokeWidth}
                                listening={false}
                                perfectDrawEnabled={false}
                              />
                            </>
                          );
                        }

                        if (plan.shape === 'lineColorArcs') {
                          // 大白圆 + 周长按线路色分弧段（经典图册风）
                          // 底圆保留 listening，让父 Group 的右键/点击事件能命中
                          return (
                            <>
                              <Circle
                                radius={scaledInterchangeRadius}
                                fill={canvasPalette.stationStroke}
                                shadowColor={canvasPalette.dotShadow}
                                shadowBlur={suppressShadows ? 0 : 6}
                                perfectDrawEnabled={false}
                              />
                              {plan.sectors.map((s, i) => (
                                <Arc
                                  key={`arc_${i}`}
                                  innerRadius={Math.max(0, scaledInterchangeRadius - scaledInterchangeStrokeWidth)}
                                  outerRadius={scaledInterchangeRadius}
                                  angle={s.sweepDeg}
                                  rotation={s.startDeg}
                                  fill={s.color}
                                  listening={false}
                                  perfectDrawEnabled={false}
                                />
                              ))}
                            </>
                          );
                        }

                        // concentricRing：黑色双圆环 + 白心，线路色不显示在符号内（靠线条颜色穿入识别）
                        // 外圆保留 listening，让父 Group 的右键/点击事件能命中
                        return (
                          <>
                            <Circle
                              radius={scaledInterchangeRadius}
                              fill={canvasPalette.stationStroke}
                              stroke={darkOutline}
                              strokeWidth={scaledInterchangeStrokeWidth}
                              shadowColor={canvasPalette.dotShadow}
                              shadowBlur={suppressShadows ? 0 : 6}
                              perfectDrawEnabled={false}
                            />
                            <Circle
                              radius={scaledInterchangeInnerRadius}
                              fill="transparent"
                              stroke={darkOutline}
                              strokeWidth={scaledInterchangeStrokeWidth * 0.5}
                              listening={false}
                              perfectDrawEnabled={false}
                            />
                          </>
                        );
                      })()
                    ) : (
                      // 普通站：dot = 线路色实心 + 浅描边；ring = 白填 + 线路色描边
                      stylePreset.stationShape === 'ring' ? (
                        <Circle
                          radius={scaledNormalStationRadius}
                          fill={canvasPalette.stationStroke}
                          stroke={stationColor}
                          strokeWidth={scaledNormalStationStrokeWidth}
                          shadowColor={canvasPalette.dotShadow}
                          shadowBlur={suppressShadows ? 0 : 4}
                          perfectDrawEnabled={false}
                        />
                      ) : (
                        <Circle
                          radius={scaledNormalStationRadius}
                          fill={stationColor}
                          stroke={canvasPalette.stationStroke}
                          strokeWidth={scaledNormalStationStrokeWidth}
                          shadowColor={canvasPalette.dotShadow}
                          shadowBlur={suppressShadows ? 0 : 4}
                          perfectDrawEnabled={false}
                        />
                      )
                    )}
                    {labelRect ? (
                      <Group x={labelRect.x - stationPoint.x} y={labelRect.y - stationPoint.y} listening={false}>
                        <Text
                          text={station.name}
                          width={labelRect.width}
                          height={labelRect.height}
                          fontSize={scaledFontSize}
                          fontStyle={`${mapSettings.dotLabelStyle.fontWeight}`}
                          fill={readableLabelText}
                          align="center"
                          verticalAlign="middle"
                          wrap="none"
                          stroke={isLargeGraph ? (isAmapMode ? readableLabelShadow : canvasPalette.labelShadow) : undefined}
                          strokeWidth={isLargeGraph ? Math.max(2, 2.5 * effectiveScale) : 0}
                          fillAfterStrokeEnabled={isLargeGraph}
                          shadowColor={isLargeGraph ? undefined : (isAmapMode ? readableLabelShadow : canvasPalette.labelShadow)}
                          shadowBlur={suppressShadows ? 0 : isAmapMode ? 5 : isDarkCanvas ? 5 : 2}
                          shadowOpacity={suppressShadows ? 0 : 1}
                          perfectDrawEnabled={false}
                        />
                      </Group>
                    ) : null}
                  </>
                ) : (
                  <>
                    <Circle
                      radius={isInterchangeStation ? scaledClassicInterchangeRadius : scaledClassicStationRadius}
                      fill={isStationInCurrentLine(station.id) ? stationColor : canvasPalette.inactiveStationFill}
                      stroke={canvasPalette.stationStroke}
                      strokeWidth={isInterchangeStation ? scaledClassicInterchangeStrokeWidth : scaledClassicStationStrokeWidth}
                      shadowColor={isDarkCanvas ? 'rgba(147,197,253,0.35)' : 'rgba(15,23,42,0.28)'}
                      shadowBlur={suppressShadows ? 0 : isDarkCanvas ? 7 : 4}
                      shadowOffset={{ x: 2 * effectiveScale, y: 2 * effectiveScale }}
                      perfectDrawEnabled={false}
                    />
                    {!isLightAmapRender ? (
                      <Text
                        text={station.name}
                        fontSize={scaledClassicStationTextSize}
                        fill={canvasPalette.stationText}
                        align="center"
                        verticalAlign="middle"
                        width={scaledClassicStationTextBox}
                        height={scaledClassicStationTextBox}
                        offsetX={scaledClassicStationTextBox / 2}
                        offsetY={scaledClassicStationTextBox / 2}
                        shadowColor={isAmapMode ? 'rgba(2,6,23,0.95)' : isDarkCanvas ? 'rgba(2,6,23,0.8)' : 'rgba(15,23,42,0.42)'}
                        shadowBlur={suppressShadows ? 0 : isAmapMode ? 5 : isDarkCanvas ? 3 : 2}
                        shadowOffset={{ x: effectiveScale, y: effectiveScale }}
                        perfectDrawEnabled={false}
                      />
                    ) : null}
                  </>
                )}
              </Group>
            );
          })}
          </>}
        </Layer>
        {/* 顶层轻量交互辅助层：橡皮筋连线预览与动态吸附虚线单独占一层 Canvas，60fps 移动鼠标/拖站点时完全不重绘底层线网 */}
        <Layer listening={false}>
          {canvasSceneReady && (
            <>
              {[0, 1, 2, 3].map((idx) => (
                <Line
                  key={`imp_guide_${idx}`}
                  id={`imperative_guide_${idx}`}
                  points={activeCalibrationGuides[idx] || []}
                  visible={Boolean(activeCalibrationGuides[idx])}
                  stroke={canvasPalette.activeGuide}
                  strokeWidth={1}
                  dash={[6, 6]}
                  opacity={0.9}
                  listening={false}
                  perfectDrawEnabled={false}
                />
              ))}
              {isDrawing && (
                <Line
                  id="metro-drawing-preview"
                  points={drawingPointsRef.current.length >= 4 ? drawingPointsRef.current : drawingLine.points}
                  visible={drawingPointsRef.current.length >= 4 || drawingLine.points.length >= 4}
                  stroke={canvasPalette.drawingLine}
                  strokeWidth={3}
                  lineCap="round"
                  lineJoin="round"
                  dash={[5, 5]}
                  tension={0}
                  listening={false}
                  perfectDrawEnabled={false}
                />
              )}
            </>
          )}
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
          maxLength={64}
          // AntD 5 的 Input 支持 addonAfter；把"翻译"按钮挂在右侧
          addonAfter={
            <Tooltip title="把当前输入的中文站名翻译成英文 / 拼音（AI）">
              <Button
                type="text"
                size="small"
                icon={<TranslationOutlined />}
                loading={translatingStation}
                onClick={handleTranslateStationName}
                style={{ padding: '0 4px' }}
              >
                翻译
              </Button>
            </Tooltip>
          }
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
              {readOnly?<p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere',margin:0}}>{stationInfoModal.note||'暂无公开标注'}</p>:<Input.TextArea
                value={stationInfoModal.note}
                onChange={(e) => setStationInfoModal(prev => ({ ...prev, note: e.target.value }))}
                placeholder="如：机场、高铁站、交通枢纽等"
                rows={3}
              />}
            </div>
            {!readOnly&&<div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button type="primary" onClick={handleSaveStationNote}>保存标注</Button>
            </div>}
          </div>
        )}
      </DraggableModal>
      {isCompact && (stationContextMenu.visible || sectionContextMenu.visible || canvasContextMenu.visible) ? (
        <button type="button" className="metro-context-backdrop" aria-label="关闭编辑菜单" onClick={() => {
          closeStationContextMenu();
          setSectionContextMenu(prev => ({ ...prev, visible: false }));
          setCanvasContextMenu(prev => ({ ...prev, visible: false }));
        }} />
      ) : null}
      {canvasContextMenu.visible && (() => {
        const menuLeft = Math.max(12, Math.min(canvasContextMenu.x, stageSize.width - 204));
        const menuTop = Math.max(12, Math.min(canvasContextMenu.y, stageSize.height - 196));
        return (
          <div
            className="canvas-context-menu metro-floating-menu"
            role="menu"
            aria-label="画布操作"
            onMouseDown={e => e.stopPropagation()}
            style={{ top: menuTop, left: menuLeft, zIndex: 1002 }}
          >
            <div className="metro-floating-menu__header">画布背景</div>
            <button type="button" className="metro-floating-menu__item" onClick={openCanvasColorModal}>
              <BgColorsOutlined />
              <span>更改画布颜色</span>
            </button>
            <button type="button" className="metro-floating-menu__item" onClick={triggerImageImport}>
              <PictureOutlined />
              <span>导入参考底图</span>
            </button>
            <button
              type="button"
              className="metro-floating-menu__item"
              onClick={handleClearBackgroundImage}
              disabled={!canvasBackgroundImage}
            >
              <DeleteOutlined />
              <span>清除参考底图</span>
            </button>
            <div className="metro-floating-menu__divider" />
            <button type="button" className="metro-floating-menu__item" onClick={handleResetCanvasColor}>
              <ReloadOutlined />
              <span>恢复默认画布色</span>
            </button>
          </div>
        );
      })()}
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
        const menuLeft = Math.max(12, Math.min(sectionContextMenu.x, stageSize.width - 228));
        const menuTop = Math.max(12, Math.min(sectionContextMenu.y, stageSize.height - 240));

        return (
          <div
            className="section-context-menu metro-floating-menu"
            role="region"
            aria-label="区间操作"
            onMouseDown={e => e.stopPropagation()}
            style={{ top: menuTop, left: menuLeft, zIndex: 1000, minWidth: 204 }}
          >
            {sectionContextMenu.waypointOnly && currentPoint ? (
              <>
                <div className="metro-floating-menu__header">途经点 #{pointIndex! + 1}</div>
                <button
                  type="button"
                  className="metro-floating-menu__item"
                  onClick={() => {
                    hideWaypoint(sectionKey, pointIndex!);
                    closeSectionMenu();
                  }}
                >
                  <EyeInvisibleOutlined />
                  <span>隐藏途经点控制柄</span>
                </button>
                <div className="metro-floating-menu__divider" />
                <button
                  type="button"
                  className="metro-floating-menu__item is-danger"
                  onClick={() => {
                    deleteWaypoint(sectionKey, pointIndex!);
                    closeSectionMenu();
                  }}
                >
                  <DeleteOutlined />
                  <span>删除途经点</span>
                </button>
              </>
            ) : (
              <>
                <div className="metro-floating-menu__header">区间走向管理</div>
                {sectionWaypoints.length > 0 ? (
                  <div className="metro-floating-menu__wp-list">
                    {sectionWaypoints.map((pt, idx) => (
                      <div key={idx} className="metro-floating-menu__wp-row">
                        <span className="metro-floating-menu__wp-label">途经点 {idx + 1}</span>
                        <button
                          type="button"
                          className="metro-floating-menu__mini-btn"
                          onClick={() => {
                            if (pt.hidden) showWaypoint(sectionKey, idx);
                            else hideWaypoint(sectionKey, idx);
                            closeSectionMenu();
                          }}
                        >
                          {pt.hidden ? <><EyeOutlined /> 显示</> : <><EyeInvisibleOutlined /> 隐藏</>}
                        </button>
                        <button
                          type="button"
                          className="metro-floating-menu__mini-btn is-danger"
                          onClick={() => {
                            deleteWaypoint(sectionKey, idx);
                            closeSectionMenu();
                          }}
                        >
                          删除
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="metro-floating-menu__empty">暂无途经点（切至「区间」工具可添加）</div>
                )}
                {isCompact ? (
                  <button
                    type="button"
                    className="metro-floating-menu__item"
                    onClick={() => {
                      const section = sections.find(item => item.id === sectionKey);
                      const startStation = stations.find(item => item.id === section?.startStationId);
                      const endStation = stations.find(item => item.id === section?.endStationId);
                      if (!section || !startStation || !endStation) return;
                      setSectionContextMenu(prev => ({ ...prev, visible: false }));
                      setCanvasTool('section');
                      setSelectedSection({ sectionId: section.id, lineId: section.lineId, startStation, endStation });
                    }}
                  >
                    <LineOutlined />
                    <span>调整区间走向</span>
                  </button>
                ) : null}
                <div className="metro-floating-menu__divider" />
                <button
                  type="button"
                  className="metro-floating-menu__item is-danger"
                  onClick={() => {
                    onDeleteSection(sectionKey);
                    closeSectionMenu();
                  }}
                >
                  <DeleteOutlined />
                  <span>删除当前区间</span>
                </button>
              </>
            )}
          </div>
        );
      })() : null}

      {/* 站点右键菜单 */}
      {stationContextMenu.visible && (() => {
        const menuLeft = Math.max(12, Math.min(stationContextMenu.x, stageSize.width - 236));
        const menuTop = Math.max(12, Math.min(stationContextMenu.y, stageSize.height - 268));
        const stationId = stationContextMenu.station?.id;
        const canConnectOther = Boolean(currentLineId && getCurrentLineStationOptions(stationId).length > 0);
        return (
          <div
            className="station-context-menu metro-floating-menu"
            role="region"
            aria-label="站点操作"
            onMouseDown={e => e.stopPropagation()}
            style={{ top: menuTop, left: menuLeft, zIndex: 1000, minWidth: 212 }}
          >
            <div className="metro-floating-menu__header">
              <span
                className="metro-floating-menu__dot"
                style={{ backgroundColor: stationId ? getStationColor(stationId) : '#2563eb' }}
              />
              <span className="metro-floating-menu__title">{stationContextMenu.station?.name}</span>
            </div>
            <div
              onMouseEnter={() => setShowConnectAction(true)}
              onMouseLeave={() => setShowConnectAction(false)}
              className="metro-floating-menu__group"
            >
              <button
                type="button"
                className="metro-floating-menu__item"
                onClick={() => {
                  onAddStationToLine(stationContextMenu.station!.id, { mode: 'default' });
                  closeStationContextMenu();
                }}
                disabled={!currentLineId}
              >
                <PlusCircleOutlined />
                <span>{!isCompact && showConnectAction ? '加入当前线路并顺延连线' : '加入当前线路'}</span>
              </button>
              {(showConnectAction || isCompact) && (
                <>
                  <button
                    type="button"
                    className="metro-floating-menu__item is-sub"
                    onClick={handleOpenConnectModal}
                    disabled={!canConnectOther}
                  >
                    <NodeIndexOutlined />
                    <span>指定站点建立连接…</span>
                  </button>
                  <button
                    type="button"
                    className="metro-floating-menu__item is-sub"
                    onClick={() => {
                      onAddStationToLine(stationContextMenu.station!.id, { mode: 'only' });
                      closeStationContextMenu();
                    }}
                    disabled={!currentLineId}
                  >
                    <EnvironmentOutlined />
                    <span>仅加入线路（不连线）</span>
                  </button>
                </>
              )}
            </div>
            <div className="metro-floating-menu__divider" />
            {isCompact ? (
              <button
                type="button"
                className="metro-floating-menu__item"
                onClick={() => {
                  const station = stationContextMenu.station;
                  closeStationContextMenu();
                  if (station) setStationInfoModal({ visible: true, station, note: station.note || '' });
                }}
              >
                <EditOutlined />
                <span>站点详情与标注</span>
              </button>
            ) : null}
            <button type="button" className="metro-floating-menu__item" onClick={handleOpenRenameStation}>
              <EditOutlined />
              <span>修改站点名称</span>
            </button>
            <button type="button" className="metro-floating-menu__item is-danger" onClick={handleDeleteStation}>
              <DeleteOutlined />
              <span>删除站点</span>
            </button>
          </div>
        );
      })()}
    </div>
  );
};

export default Canvas; 
