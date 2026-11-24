import {
  AMAP_REFERENCE_ZOOM,
  computeAmapVisualScales,
  computePlainVisualScales,
  estimateSingleLineTextWidth,
  liveElementScaleRatio,
  plainCanvasElementScale
} from '../lib/canvasZoom';
import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Konva from 'konva';
import { Stage, Layer, Circle, Text, Group, Line, Rect, Arc, Path } from 'react-konva';
import { Input, Button, message, ColorPicker, Dropdown, Tooltip, Spin } from 'antd';
import {
  BgColorsOutlined,
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  DownOutlined,
  DragOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  NodeIndexOutlined,
  PictureOutlined,
  PlusCircleOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  SelectOutlined,
  TranslationOutlined
} from '@ant-design/icons';
import { api } from '../api';
import {
  MapSettings,
  Station,
  StationLabelPosition,
  Line as LineType,
  Section,
  Waypoint,
  LINE_COLORS
} from '../types';
import { getCityStylePreset } from '../stylePresets';
import { planInterchange, buildCurvedArrowPath } from '../lib/interchange';
import {
  computeCornerHandleInfo,
  radiusFromCornerHandleDrag,
  RPoint
} from '../lib/roundedPath';
import {
  buildSectionRenderGeometry,
  canonicalSectionPairKey,
  computeDirectedParallelOffset,
  findWaypointInsertIndex
} from '../lib/offsetPath';
import {
  connectStationsOnLine,
  deleteStationsFromGraph,
  deriveLineTopology,
  insertStationOnSection,
  MapGraph,
  mergeStationsIntoInterchange
} from '../lib/graphOps';
import { SpatialBoxGrid } from '../lib/spatialGrid';
import { AppAction } from '../lib/commandParser';
import { useAmapViewport } from '../lib/useAmapViewport';
import { createId } from '../utils/id';
import DraggableModal from './DraggableModal';
import CanvasStartPrompt from './CanvasStartPrompt';
import CanvasOnboardingModal, {
  hasSeenCanvasOnboarding,
  markCanvasOnboardingSeen
} from './CanvasOnboardingModal';
import { TouchViewportGesture, TouchPoint } from '../lib/touchViewport';
import { useElasticToolbar } from '../lib/useElasticToolbar';
import MobileViewControls from './MobileViewControls';

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
    console.log(`[metro-perf] ${label}: ${ms.toFixed(2)}ms`);
  }
};
const __perfMarkRender = (componentName: string, prevRef: { current: number }) => {
  if (!__perfEnabled) return;
  const now = performance.now();
  const since = now - prevRef.current;
  prevRef.current = now;
  if (since > 0 && since < 2000) {
    console.log(`[metro-perf] ${componentName} render +${since.toFixed(0)}ms since last`);
  }
};

const GUIDE_THRESHOLD_DEG = 8;
const SNAP_THRESHOLD_DEG = 3.5;
const SNAP_MAX_PERP_SCREEN_PX = 12;
const SNAP_ANGLES = [0, 45, 90, 135];
const SECTION_HIT_STROKE_WIDTH = 24;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 5;
const ZOOM_STEP_FACTOR = 1.15;
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
    labelText: '#0f172a',
    labelShadow: 'rgba(255,255,255,0.92)',
    dotShadow: 'rgba(15,23,42,0.2)',
    waypointFill: '#ffffff',
    waypointStroke: '#2563eb',
    waypointShadow: 'rgba(37,99,235,0.24)',
    lineShadowOpacity: 0.28
  },
  dark: {
    background: '#07111f',
    lineGuide: '#475569',
    activeGuide: '#93c5fd',
    drawingLine: '#93c5fd',
    stationStroke: '#07111f',
    labelText: '#f8fafc',
    labelShadow: 'rgba(2,6,23,0.95)',
    dotShadow: 'rgba(147,197,253,0.34)',
    waypointFill: '#07111f',
    waypointStroke: '#93c5fd',
    waypointShadow: 'rgba(147,197,253,0.36)',
    lineShadowOpacity: 0.56
  }
} as const;

const getDefaultCanvasBackground = (theme: MapSettings['canvasTheme']) =>
  CANVAS_THEME_PALETTES[theme].background;

const DEFAULT_AMAP_SETTINGS = {
  center: [116.397428, 39.90923] as [number, number],
  zoom: 11,
  style: 'normal' as const
};

export type CanvasTool = 'select' | 'draw' | 'pan';
const CANVAS_TOOL_ORDER: CanvasTool[] = ['select', 'draw', 'pan'];

const LABEL_POSITION_OPTIONS: Array<{ key: StationLabelPosition; label: string }> = [
  { key: 'auto', label: '自动' },
  { key: 'right', label: '右' },
  { key: 'left', label: '左' },
  { key: 'top', label: '上' },
  { key: 'bottom', label: '下' },
  { key: 'top-right', label: '右上' },
  { key: 'top-left', label: '左上' },
  { key: 'bottom-right', label: '右下' },
  { key: 'bottom-left', label: '左下' },
  { key: 'hidden', label: '隐藏' }
];

function generateNextStationName(stations: ReadonlyArray<Station>): string {
  const existing = new Set(stations.map((s) => s.name.trim()));
  let idx = stations.length + 1;
  while (existing.has(`站点 ${idx}`) || existing.has(`站点${idx}`)) {
    idx += 1;
  }
  return `站点 ${idx}`;
}

function generateAutoLineSpec(lines: ReadonlyArray<LineType>): { name: string; color: string } {
  const existingNames = new Set(lines.map((l) => l.name.trim()));
  let num = lines.length + 1;
  while (existingNames.has(`${num}号线`)) {
    num += 1;
  }
  const usedColors = new Set(lines.map((l) => l.color.toLowerCase()));
  const freeColor = LINE_COLORS.find((c) => !usedColors.has(c.toLowerCase())) || LINE_COLORS[(num - 1) % LINE_COLORS.length];
  return { name: `${num}号线`, color: freeColor };
}

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
  onApplyGraphTransaction?: (
    updater: (current: MapGraph) => MapGraph,
    options?: { recordHistory?: boolean; selectLineId?: string | null }
  ) => void;
  onSelectLine?: (lineId: string | null) => void;
  onRemoveStationFromLine?: (lineId: string, stationId: string) => void;
  onMapSettingsChange?: (settings: MapSettings) => void;
  onStageReady?: (stage: any) => void;
  onBeginInteraction?: () => void;
  onCreateLine?: () => void;
  onStartWithAmap?: () => void;
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
  documentKey = 'draft',
  isDocumentLoading = false,
  language = 'zh-CN',
  onAddStation,
  onUpdateStation,
  onAddStationToLine,
  onRenameStation,
  onDeleteSection,
  onDeleteStation,
  onUpdateStations,
  onUpdateSection,
  onApplyGraphTransaction,
  onSelectLine,
  onMapSettingsChange,
  onStageReady,
  onBeginInteraction,
  onCreateLine,
  onStartWithAmap,
  viewCommand,
  mobileViewControlsHost,
  initialViewport,
  fitOnMount,
  onViewportChange,
  isGuest,
  onRequireAuth
}) => {
  const isEn = language === 'en-US';
  const text = isEn
    ? {
        tools: { select: 'Select', draw: 'Draw', pan: 'Pan' },
        hints: {
          select: 'Drag track to add 360° bend · Click bend for arc · Drag blank to box-select · Double-click to edit',
          drawIdle: 'Click blank to place first station · Click any station to extend or pull a branch',
          drawActive: (name: string, wpMode: boolean) =>
            wpMode
              ? `From ${name}: click blank to drop 360° waypoints · Click station to finish · Right-click to lift pen`
              : `From ${name}: click blank to add station · Shift+click for 360° bend · Right-click / Esc to lift pen`,
          pan: 'Drag canvas to pan · Scroll to zoom · Hold Space anytime to grab-pan'
        },
        zoomIn: 'Zoom in',
        zoomOut: 'Zoom out',
        fitView: 'Fit view',
        resetView: 'Reset view',
        zoom: 'Zoom',
        search: 'Find station (Ctrl+F)',
        guide: 'Gestures & Shortcuts (?)'
      }
    : {
        tools: { select: '选择', draw: '绘制', pan: '移动' },
        hints: {
          select: '拖线段拉出 360° 拐点 · 单击拐点调圆弧 · 空白拉框整片平移 · 双击站点改名 / 双击线段补站',
          drawIdle: '点空白建新站起笔 · 点任意已有站从该端延伸或拉支线',
          drawActive: (name: string, wpMode: boolean) =>
            wpMode
              ? `从「${name}」出发：点空白连续打 360° 拐点 · 点站点收尾连入 · 右键抬笔`
              : `从「${name}」连笔：左键落站 · Shift+左键打自由拐点 · 右键/Esc 抬笔换方向`,
          pan: '拖拽平移视图 · 滚轮定档缩放 · 任意模式下按住空格键均可随时抓手平移'
        },
        zoomIn: '放大',
        zoomOut: '缩小',
        fitView: '适应视图',
        resetView: '重置视图',
        zoom: '缩放',
        search: '搜索站点 (Ctrl+F)',
        guide: '手势与快捷键指南 (?)'
      };

  const [isCompact, setIsCompact] = useState(() =>
    window.matchMedia('(max-width: 768px), (max-width: 1024px) and (max-height: 500px)').matches
  );
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
    return () => {
      Konva.hitOnDragEnabled = previous;
    };
  }, [isCompact]);

  // 三态核心工具：只读/移动端默认 pan；空画布默认 draw（一点即画），已有地图默认 select（防误触）
  const [activeTool, setActiveTool] = useState<CanvasTool>(() => {
    if (readOnly) return 'pan';
    if (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(max-width: 768px), (max-width: 1024px) and (max-height: 500px)').matches
    ) {
      return 'pan';
    }
    return stations.length === 0 ? 'draw' : 'select';
  });

  // 连续绘制钢笔状态机
  const [drawAnchorStationId, setDrawAnchorStationId] = useState<string | null>(null);
  const [drawPendingWaypoints, setDrawPendingWaypoints] = useState<Waypoint[]>([]);
  const [drawWaypointSubmode, setDrawWaypointSubmode] = useState(false);
  const drawingPointsRef = useRef<number[]>([]);

  // 选中态：多选站点、选中区间、选中途经点（用于原地调圆弧）
  const [selectedStationIds, setSelectedStationIds] = useState<Set<string>>(() => new Set());
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [selectedWaypoint, setSelectedWaypoint] = useState<{ sectionId: string; waypointIndex: number } | null>(null);
  const [mergeTargetStationId, setMergeTargetStationId] = useState<string | null>(null);
  const [highlightedStationId, setHighlightedStationId] = useState<string | null>(null);

  // 框选矩形（世界坐标）
  const [marqueeWorldRect, setMarqueeWorldRect] = useState<{
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    additive: boolean;
  } | null>(null);

  // 非阻塞行内站点改名胶囊
  const [inlineRename, setInlineRename] = useState<{
    stationId: string;
    value: string;
    originalName: string;
  } | null>(null);
  const inlineRenameInputRef = useRef<HTMLInputElement | null>(null);
  const [translatingInline, setTranslatingInline] = useState(false);

  // 空格键临时抓手 & 中键平移
  const [isSpaceHeld, setIsSpaceHeld] = useState(false);
  const isSpaceHeldRef = useRef(false);
  const isMiddlePanningRef = useRef(false);

  // Ctrl+F 快速搜站 & 新手引导弹窗
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [onboardingState, setOnboardingState] = useState<{ open: boolean; view: 'tour' | 'cheatsheet' }>({
    open: false,
    view: 'tour'
  });

  // 画布背景与右键菜单状态
  const [canvasBackgroundColor, setCanvasBackgroundColor] = useState<string>(() =>
    getDefaultCanvasBackground(mapSettings.canvasTheme)
  );
  const [canvasBackgroundImage, setCanvasBackgroundImage] = useState<string | null>(null);
  const [canvasContextMenu, setCanvasContextMenu] = useState<{ visible: boolean; x: number; y: number }>({
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
  const [stationContextMenu, setStationContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    station: Station | null;
  }>({ visible: false, x: 0, y: 0, station: null });
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
  const [stationInfoModal, setStationInfoModal] = useState<{
    visible: boolean;
    station: Station | null;
    note: string;
  }>({ visible: false, station: null, note: '' });

  const touchGestureRef = useRef(new TouchViewportGesture());
  const touchTapAllowedRef = useRef(false);
  const longPressTimerRef = useRef<number | null>(null);
  const [mouseDownPosition, setMouseDownPosition] = useState<{ x: number; y: number } | null>(null);
  const [activeCalibrationGuides, setActiveCalibrationGuides] = useState<number[][]>([]);

  // O(1) 主键与拓扑缓存表
  const lineOrderMap = useMemo(() => {
    const map = new Map<string, number>();
    lines.forEach((line, idx) => map.set(line.id, idx));
    return map;
  }, [lines]);

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

  const lineTopologyById = useMemo(() => {
    const stationSet = new Set(stations.map((s) => s.id));
    const secsByLine = new Map<string, Section[]>();
    sections.forEach((sec) => {
      const arr = secsByLine.get(sec.lineId);
      if (arr) arr.push(sec);
      else secsByLine.set(sec.lineId, [sec]);
    });
    const map = new Map<string, ReturnType<typeof deriveLineTopology>>();
    lines.forEach((line) => {
      map.set(line.id, deriveLineTopology(line, secsByLine.get(line.id) || [], stationSet));
    });
    return map;
  }, [lines, sections, stations]);

  // 当切换文档或站点被删除时清理悬空的绘制锚点与选中集
  useEffect(() => {
    if (drawAnchorStationId && !stationById.has(drawAnchorStationId)) {
      setDrawAnchorStationId(null);
      setDrawPendingWaypoints([]);
    }
  }, [drawAnchorStationId, stationById]);

  useEffect(() => {
    setDrawAnchorStationId(null);
    setDrawPendingWaypoints([]);
    setSelectedStationIds(new Set());
    setSelectedSectionId(null);
    setSelectedWaypoint(null);
    setInlineRename(null);
  }, [documentKey]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const amapContainerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<any>(null);
  const syncZoomElementSizesRef = useRef<(viewportScale: number) => void>(() => {});
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 960, height: 640 });
  const canvasInteractionEndTimerRef = useRef<number | null>(null);
  const wheelStepLockRef = useRef(0);
  const __perfRenderRef = useRef(performance.now());
  __perfMarkRender('Canvas', __perfRenderRef);
  const lastPointerPositionRef = useRef({ x: 0, y: 0 });
  const latestMapSettingsRef = useRef(mapSettings);
  const previousBaseMapModeRef = useRef(mapSettings.baseMap.mode);
  const [isMapInteracting, setIsMapInteracting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isDraggingNode, setIsDraggingNode] = useState(false);
  const isAmapMode = mapSettings.baseMap.mode === 'amap';

  // 拖拽草稿 refs（60fps 零 React 重渲）
  const dragStationDraftRef = useRef<{
    primaryId: string;
    dx: number;
    dy: number;
    stations: Array<{ id: string; x: number; y: number; lng?: number; lat?: number }>;
    sections: Array<{ sectionId: string; waypoints: Waypoint[] }>;
    mergeTargetId: string | null;
  } | null>(null);
  const groupDragBaseRef = useRef<{
    primaryStart: { x: number; y: number };
    selectedIds: Set<string>;
    stationOrigins: Map<string, { x: number; y: number }>;
    internalSectionOrigins: Map<string, Waypoint[]>;
    affectedSections: Section[];
  } | null>(null);
  const dragWaypointDraftRef = useRef<{ sectionId: string; waypoints: Waypoint[] } | null>(null);
  const pendingSectionDragRef = useRef<{
    sectionId: string;
    lineId: string;
    downPointer: { x: number; y: number };
    downWorld: { x: number; y: number };
    insertedWaypointIndex: number | null;
  } | null>(null);
  const sectionParallelOffsetRef = useRef<Map<string, number>>(new Map());

  const liftDrawingPen = useCallback(() => {
    drawingPointsRef.current = [];
    const previewNode = stageRef.current?.findOne?.('#metro-drawing-preview');
    if (previewNode) {
      previewNode.points([]);
      previewNode.visible(false);
    }
    const ghostDot = stageRef.current?.findOne?.('#metro-drawing-ghost-dot');
    if (ghostDot) {
      ghostDot.visible(false);
      ghostDot.getLayer?.()?.batchDraw?.();
    }
    setDrawAnchorStationId(null);
    setDrawPendingWaypoints([]);
    setDrawWaypointSubmode(false);
    setActiveCalibrationGuides([]);
  }, []);

  const commitInlineRenameIfNeeded = useCallback(() => {
    setInlineRename((current) => {
      if (!current) return null;
      const trimmed = current.value.trim();
      if (trimmed && trimmed !== current.originalName) {
        onRenameStation(current.stationId, trimmed);
      }
      return null;
    });
  }, [onRenameStation]);

  const setCanvasTool = useCallback(
    (tool: CanvasTool) => {
      commitInlineRenameIfNeeded();
      setActiveTool(tool);
      if (tool !== 'draw') {
        liftDrawingPen();
      }
      if (tool === 'draw') {
        setSelectedWaypoint(null);
        setSelectedStationIds(new Set());
      }
    },
    [commitInlineRenameIfNeeded, liftDrawingPen]
  );

  const toolGroupRef = useElasticToolbar(
    CANVAS_TOOL_ORDER.indexOf(activeTool),
    CANVAS_TOOL_ORDER.length,
    !readOnly,
    (index) => setCanvasTool(CANVAS_TOOL_ORDER[index])
  );

  const [scale, setScale] = useState(initialViewport?.scale || 1);
  const [position, setPosition] = useState({ x: initialViewport?.x || 0, y: initialViewport?.y || 0 });
  useEffect(() => {
    onViewportChange?.({ scale, ...position });
  }, [scale, position, onViewportChange]);

  useLayoutEffect(() => {
    latestMapSettingsRef.current = mapSettings;
  }, [mapSettings]);

  const { mapRef: amapRef, ready: amapReady, error: amapError, renderTick: mapRenderTick } = useAmapViewport({
    enabled: isAmapMode,
    containerRef: amapContainerRef,
    documentKey,
    documentLoading: isDocumentLoading,
    viewport: mapSettings.baseMap.amap || DEFAULT_AMAP_SETTINGS,
    width: stageSize.width,
    height: stageSize.height,
    onInteractionChange: setIsMapInteracting,
    onViewportChange: (center, zoom) => {
      const latest = latestMapSettingsRef.current;
      onMapSettingsChange?.({
        ...latest,
        baseMap: {
          mode: 'amap',
          amap: { ...(latest.baseMap.amap || DEFAULT_AMAP_SETTINGS), center, zoom }
        }
      });
    }
  });
  const canvasSceneReady = !isDocumentLoading && (!isAmapMode || amapReady);

  // 首次访问温和弹出 4 步交互微动画引导（延迟 700ms 避免影响首屏及自动化同步单测）
  useEffect(() => {
    if (readOnly || !canvasSceneReady || hasSeenCanvasOnboarding()) return;
    // 空画布正在展示欢迎大卡片时，等用户开始第一笔或已有内容时再自动引导，不叠两层卡片
    const showingStartCard =
      lines.length === 0 &&
      stations.length === 0 &&
      sections.length === 0 &&
      !isAmapMode &&
      !canvasBackgroundImage &&
      Boolean(onCreateLine);
    if (showingStartCard) return;
    const timer = window.setTimeout(() => {
      if (!hasSeenCanvasOnboarding()) {
        setOnboardingState({ open: true, view: 'tour' });
      }
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    readOnly,
    canvasSceneReady,
    lines.length,
    stations.length,
    sections.length,
    isAmapMode,
    canvasBackgroundImage,
    onCreateLine
  ]);

  useEffect(() => {
    if (onStageReady && stageRef.current) {
      onStageReady(stageRef.current);
    }
  }, [onStageReady]);

  // 自动聚焦行内改名框或搜站框
  useEffect(() => {
    if (!inlineRename) return;
    const raf = window.requestAnimationFrame(() => {
      inlineRenameInputRef.current?.focus();
      inlineRenameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [inlineRename]);

  useEffect(() => {
    if (!searchOpen) return;
    const raf = window.requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [searchOpen]);

  const closeAllFloatingMenus = useCallback(() => {
    setStationContextMenu({ visible: false, x: 0, y: 0, station: null });
    setSectionContextMenu((prev) => ({ ...prev, visible: false, waypointOnly: false }));
    setCanvasContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  const getSectionWaypoints = useCallback(
    (sectionId: string): Waypoint[] => sectionById.get(sectionId)?.waypoints || [],
    [sectionById]
  );

  const writeSectionWaypoints = useCallback(
    (sectionId: string, nextWaypoints: Waypoint[]) => {
      if (!onUpdateSection) return;
      onUpdateSection(sectionId, { waypoints: nextWaypoints.length ? nextWaypoints : undefined });
    },
    [onUpdateSection]
  );

  const deleteWaypoint = useCallback(
    (sectionId: string, waypointIndex: number) => {
      onBeginInteraction?.();
      const current = getSectionWaypoints(sectionId);
      writeSectionWaypoints(
        sectionId,
        current.filter((_, index) => index !== waypointIndex)
      );
      setSelectedWaypoint((prev) =>
        prev && prev.sectionId === sectionId && prev.waypointIndex === waypointIndex ? null : prev
      );
    },
    [getSectionWaypoints, onBeginInteraction, writeSectionWaypoints]
  );

  const deleteSelectedItems = useCallback(() => {
    if (selectedWaypoint) {
      deleteWaypoint(selectedWaypoint.sectionId, selectedWaypoint.waypointIndex);
      return;
    }
    if (selectedStationIds.size === 0) return;
    const ids = Array.from(selectedStationIds);
    if (onApplyGraphTransaction) {
      onApplyGraphTransaction((graph) => deleteStationsFromGraph(ids, graph));
    } else {
      ids.forEach((id) => onDeleteStation(id));
    }
    setSelectedStationIds(new Set());
    message.success?.(ids.length > 1 ? `已删除 ${ids.length} 个站点` : '站点已删除');
  }, [deleteWaypoint, onApplyGraphTransaction, onDeleteStation, selectedStationIds, selectedWaypoint]);

  // 全局键盘快捷键：Space 抓手、Esc 抬笔/退回选择、V/D/H 切模式、Delete 批量删除、Ctrl+F 搜站、? 手势指南
  useEffect(() => {
    const isInputTarget = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        if (!document.querySelector('.ant-modal-wrap:not([style*="display: none"])')) {
          e.preventDefault();
          setSearchOpen((prev) => !prev);
          return;
        }
      }

      if (e.code === 'Space' && !isInputTarget(e.target)) {
        if (!isSpaceHeldRef.current) {
          isSpaceHeldRef.current = true;
          setIsSpaceHeld(true);
        }
        e.preventDefault();
        return;
      }

      if (readOnly) return;

      if (e.key === 'Escape') {
        if (searchOpen) {
          setSearchOpen(false);
          return;
        }
        if (inlineRename) {
          setInlineRename(null);
          return;
        }
        if (selectedWaypoint) {
          setSelectedWaypoint(null);
          return;
        }
        if (activeTool === 'draw') {
          if (drawAnchorStationId || drawPendingWaypoints.length > 0) {
            liftDrawingPen();
          } else {
            setCanvasTool('select');
          }
        } else {
          setSelectedStationIds(new Set());
          setSelectedSectionId(null);
        }
        closeAllFloatingMenus();
        return;
      }

      if (isInputTarget(e.target)) return;
      if (document.querySelector('.ant-modal-wrap:not([style*="display: none"])')) return;

      if (e.key === 'Backspace' && activeTool === 'draw' && drawPendingWaypoints.length > 0) {
        e.preventDefault();
        setDrawPendingWaypoints((prev) => prev.slice(0, -1));
        return;
      }

      if ((e.key === 'Delete' || e.key === 'Backspace') && (selectedStationIds.size > 0 || selectedWaypoint)) {
        e.preventDefault();
        deleteSelectedItems();
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault();
        setOnboardingState({ open: true, view: 'cheatsheet' });
        return;
      }

      const key = e.key.toLowerCase();
      if (key === 'v') setCanvasTool('select');
      else if (key === 'd' || key === 'l' || key === 's') setCanvasTool('draw');
      else if (key === 'h') setCanvasTool('pan');
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isSpaceHeldRef.current = false;
        setIsSpaceHeld(false);
      }
    };

    const handleWindowBlur = () => {
      isSpaceHeldRef.current = false;
      setIsSpaceHeld(false);
    };

    const handleGlobalPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (!target.closest('.station-context-menu')) {
        setStationContextMenu({ visible: false, x: 0, y: 0, station: null });
      }
      if (!target.closest('.section-context-menu')) {
        setSectionContextMenu((prev) => ({ ...prev, visible: false }));
      }
      if (!target.closest('.canvas-context-menu')) {
        setCanvasContextMenu((prev) => ({ ...prev, visible: false }));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleWindowBlur);
    document.addEventListener('pointerdown', handleGlobalPointerDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
      document.removeEventListener('pointerdown', handleGlobalPointerDown);
    };
  }, [
    activeTool,
    closeAllFloatingMenus,
    deleteSelectedItems,
    drawAnchorStationId,
    drawPendingWaypoints.length,
    inlineRename,
    liftDrawingPen,
    readOnly,
    searchOpen,
    selectedStationIds.size,
    selectedWaypoint,
    setCanvasTool
  ]);

  useEffect(() => {
    return () => {
      if (canvasInteractionEndTimerRef.current !== null) {
        window.clearTimeout(canvasInteractionEndTimerRef.current);
      }
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    if (isAmapMode) {
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
      if (canvasBackgroundImage) URL.revokeObjectURL(canvasBackgroundImage);
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
        prev.width === nextWidth && prev.height === nextHeight ? prev : { width: nextWidth, height: nextHeight }
      );
    };
    syncStageSize();
    const observer = new ResizeObserver(syncStageSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

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
  }, [stations, isAmapMode, amapReady, mapRenderTick, canvasSceneReady, stageSize.width, stageSize.height, amapRef]);

  const getDisplayPoint = (station: Station) => stationDisplayPoints[station.id] || { x: station.x, y: station.y };

  const getWaypointDisplayPoint = (point: Waypoint) => {
    void mapRenderTick;
    const map = amapRef.current;
    if (isAmapMode && amapReady && map && typeof point.lng === 'number' && typeof point.lat === 'number') {
      const pixel = map.lngLatToContainer?.([point.lng, point.lat]);
      if (pixel) return { x: pixel.x, y: pixel.y };
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

  const worldToScreenPoint = (world: { x: number; y: number }) => {
    if (isAmapMode) return { x: world.x, y: world.y };
    const stage = stageRef.current;
    const sx = stage?.scaleX?.() || scale;
    const ox = stage?.x?.() ?? position.x;
    const oy = stage?.y?.() ?? position.y;
    return { x: world.x * sx + ox, y: world.y * sx + oy };
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
      const frozenStations = stations.map((station) => {
        const point = projectLngLatToContainerPoint(station.lng, station.lat);
        return point ? { ...station, ...point } : station;
      });
      onUpdateStations?.(frozenStations);
      if (onUpdateSection) {
        sections.forEach((section) => {
          if (!section.waypoints?.length) return;
          const nextWaypoints = section.waypoints.map((point) => {
            const projected = projectLngLatToContainerPoint(point.lng, point.lat);
            return projected ? { ...point, ...projected } : point;
          });
          onUpdateSection(section.id, { waypoints: nextWaypoints });
        });
      }
      setScale(1);
      setPosition({ x: 0, y: 0 });
      setIsMapInteracting(false);
      setActiveCalibrationGuides([]);
      closeAllFloatingMenus();
    }
    previousBaseMapModeRef.current = mapSettings.baseMap.mode;
  }, [isAmapMode, mapSettings.baseMap.mode]);

  const startCanvasInteraction = () => {
    if (canvasInteractionEndTimerRef.current !== null) {
      window.clearTimeout(canvasInteractionEndTimerRef.current);
      canvasInteractionEndTimerRef.current = null;
    }
    setIsMapInteracting(true);
  };

  const scheduleCanvasInteractionEnd = (delayMs = 150) => {
    if (canvasInteractionEndTimerRef.current !== null) {
      window.clearTimeout(canvasInteractionEndTimerRef.current);
    }
    canvasInteractionEndTimerRef.current = window.setTimeout(() => {
      canvasInteractionEndTimerRef.current = null;
      const stage = stageRef.current;
      if (stage && !isAmapMode) {
        const pos = stage.position();
        const sx = stage.scaleX();
        setScale((prev) => (Math.abs(sx - prev) > 0.0001 ? sx : prev));
        setPosition((prev) =>
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

    startCanvasInteraction();
    scheduleCanvasInteractionEnd(150);

    const now = performance.now();
    if (now - wheelStepLockRef.current < WHEEL_STEP_LOCK_MS) return;
    wheelStepLockRef.current = now;

    const stage = e.target.getStage();
    const oldScale = stage.scaleX();
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const mousePointTo = {
      x: (pointer.x - stage.x()) / oldScale,
      y: (pointer.y - stage.y()) / oldScale
    };

    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const currentStep = Math.round(Math.log(oldScale / ZOOM_MIN) / Math.log(ZOOM_STEP_FACTOR));
    const steppedScale = ZOOM_MIN * Math.pow(ZOOM_STEP_FACTOR, currentStep + direction);
    const clampedScale = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, steppedScale));
    if (clampedScale === oldScale) return;
    const newPos = {
      x: pointer.x - mousePointTo.x * clampedScale,
      y: pointer.y - mousePointTo.y * clampedScale
    };

    stage.scale({ x: clampedScale, y: clampedScale });
    stage.position(newPos);
    syncZoomElementSizesRef.current(clampedScale);
    stage.batchDraw();
  };

  // 轻柔 360° 辅助吸附（绝不强掰角度：仅在靠近 0/45/90/135° 且屏幕法向偏差 <= 12px 时柔和吸附，按住 Alt 完全关闭）
  const getDirectionalSnap = (
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    thresholdDeg: number,
    checkPerpLimit = false
  ) => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx === 0 && dy === 0) return null;

    const rawAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
    const normalizedAngle = ((rawAngle % 180) + 180) % 180;
    const best = SNAP_ANGLES.map((angle) => {
      const diff = Math.min(Math.abs(normalizedAngle - angle), 180 - Math.abs(normalizedAngle - angle));
      return { angle, diff };
    }).sort((a, b) => a.diff - b.diff)[0];

    if (!best || best.diff > thresholdDeg) return null;

    const radians = (best.angle * Math.PI) / 180;
    const ux = Math.cos(radians);
    const uy = Math.sin(radians);
    const projectedLength = dx * ux + dy * uy;
    const sx = x1 + ux * projectedLength;
    const sy = y1 + uy * projectedLength;

    if (checkPerpLimit) {
      const viewScale = isAmapMode ? 1 : stageRef.current?.scaleX?.() || scale;
      const perpScreen = Math.hypot(x2 - sx, y2 - sy) * viewScale;
      if (perpScreen > SNAP_MAX_PERP_SCREEN_PX) return null;
    }

    return { x: sx, y: sy, diff: best.diff };
  };

  const buildAxisGuide = (x1: number, y1: number, x2: number, y2: number): number[] | null => {
    const snapped = getDirectionalSnap(x1, y1, x2, y2, GUIDE_THRESHOLD_DEG, false);
    return snapped ? [x1, y1, snapped.x, snapped.y] : null;
  };

  const snapWorldPointRelativeTo = (
    rawWorld: { x: number; y: number },
    referencePoints: Array<{ x: number; y: number }>,
    bypassSnap: boolean
  ): { x: number; y: number; guides: number[][] } => {
    if (bypassSnap || isAmapMode) {
      return { x: rawWorld.x, y: rawWorld.y, guides: [] };
    }
    let snappedX = rawWorld.x;
    let snappedY = rawWorld.y;
    const guides: number[][] = [];
    let bestDiff = Number.POSITIVE_INFINITY;

    for (let i = 0; i < referencePoints.length; i += 1) {
      const ref = referencePoints[i];
      const guide = buildAxisGuide(ref.x, ref.y, rawWorld.x, rawWorld.y);
      if (guide) guides.push(guide);
      const snap = getDirectionalSnap(ref.x, ref.y, rawWorld.x, rawWorld.y, SNAP_THRESHOLD_DEG, true);
      if (snap && snap.diff < bestDiff) {
        bestDiff = snap.diff;
        snappedX = snap.x;
        snappedY = snap.y;
      }
    }

    return { x: snappedX, y: snappedY, guides: guides.slice(0, 4) };
  };

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

  const lineCornerRadius = Math.max(0, mapSettings.cornerRadius || 0);

  // 命令式更新区间几何（与静态渲染 100% 共享平行角平分线偏移与单点圆弧计算，松手零跳变）
  const updateSectionKonvaLineImperative = (
    section: Section,
    stationOverrides?: Map<string, { x: number; y: number }>,
    overrideWaypoints?: Waypoint[]
  ) => {
    const stage = stageRef.current;
    if (!stage?.findOne) return;
    const start = stationById.get(section.startStationId);
    const end = stationById.get(section.endStationId);
    if (!start || !end) return;
    const startPt = stationOverrides?.get(start.id) || getDisplayPoint(start);
    const endPt = stationOverrides?.get(end.id) || getDisplayPoint(end);
    const wps = overrideWaypoints !== undefined ? overrideWaypoints : section.waypoints || [];
    const controlPoints: RPoint[] = [
      { x: startPt.x, y: startPt.y },
      ...wps.map((wp) => {
        const dp = getWaypointDisplayPoint(wp);
        return {
          x: dp.x,
          y: dp.y,
          ...(typeof wp.radius === 'number' ? { radius: wp.radius } : {}),
          ...(wp.mode ? { mode: wp.mode } : {})
        };
      }),
      { x: endPt.x, y: endPt.y }
    ];
    const directedOffset = sectionParallelOffsetRef.current.get(section.id) || 0;
    const { renderFlat } = buildSectionRenderGeometry(controlPoints, directedOffset, lineCornerRadius);
    const visNode = stage.findOne(`#sec_vis_${section.id}`);
    const hitNode = stage.findOne(`#sec_hit_${section.id}`);
    visNode?.points?.(renderFlat);
    hitNode?.points?.(renderFlat);
  };

  // 更新某途经点坐标（支持 360° 全自由拖动 + 靠近轴向时柔和吸附）
  const updateWaypointImperativeOrState = (
    sectionId: string,
    waypointIndex: number,
    x: number,
    y: number,
    bypassSnap: boolean,
    circleNode?: any
  ) => {
    const section = sectionById.get(sectionId);
    if (!section) return;
    const startStation = stationById.get(section.startStationId);
    const endStation = stationById.get(section.endStationId);
    if (!startStation || !endStation) return;

    const current = dragWaypointDraftRef.current?.sectionId === sectionId
      ? dragWaypointDraftRef.current.waypoints
      : section.waypoints || [];
    if (!current[waypointIndex]) return;
    const next = [...current];

    const prevPoint =
      waypointIndex === 0 ? getDisplayPoint(startStation) : getWaypointDisplayPoint(next[waypointIndex - 1]);
    const nextPoint =
      waypointIndex === next.length - 1 ? getDisplayPoint(endStation) : getWaypointDisplayPoint(next[waypointIndex + 1]);

    const snapped = snapWorldPointRelativeTo({ x, y }, [prevPoint, nextPoint], bypassSnap);

    next[waypointIndex] = {
      ...next[waypointIndex],
      x: snapped.x,
      y: snapped.y,
      ...(getLngLatFromContainerPoint({ x: snapped.x, y: snapped.y }) || {})
    };

    dragWaypointDraftRef.current = { sectionId, waypoints: next };

    if (stageRef.current?.findOne) {
      if (circleNode && !isAmapMode) {
        circleNode.position?.({ x: snapped.x, y: snapped.y });
      }
      updateImperativeGuides(snapped.guides);
      updateSectionKonvaLineImperative(section, undefined, next);
      stageRef.current.batchDraw?.();
      return;
    }

    writeSectionWaypoints(sectionId, next);
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

  // ==================== 连续绘制动作 ====================

  const placeNewStationInDrawMode = (worldPos: { x: number; y: number }, containerPointer: { x: number; y: number }) => {
    commitInlineRenameIfNeeded();
    const lngLat = getLngLatFromContainerPoint(containerPointer) || {};
    const newStationId = createId();
    const defaultName = generateNextStationName(stations);
    const newStationObj: Station = {
      id: newStationId,
      name: defaultName,
      x: worldPos.x,
      y: worldPos.y,
      ...lngLat
    };

    if (onApplyGraphTransaction) {
      let resolvedLineId = currentLineId;
      onApplyGraphTransaction(
        (graph) => {
          let workingLines = graph.lines;
          let targetLineId =
            resolvedLineId && workingLines.some((l) => l.id === resolvedLineId)
              ? resolvedLineId
              : workingLines[0]?.id || null;

          if (!targetLineId) {
            const spec = generateAutoLineSpec(workingLines);
            targetLineId = createId();
            workingLines = [
              ...workingLines,
              {
                id: targetLineId,
                name: spec.name,
                color: spec.color,
                stationIds: [newStationId],
                sectionIds: [],
                lastAddedStationId: newStationId
              }
            ];
          }
          resolvedLineId = targetLineId;

          const baseGraph: MapGraph = {
            lines: workingLines.map((l) =>
              l.id === targetLineId && !l.stationIds.includes(newStationId)
                ? { ...l, stationIds: [...l.stationIds, newStationId], lastAddedStationId: newStationId }
                : l
            ),
            stations: [...graph.stations, newStationObj],
            sections: graph.sections
          };

          if (drawAnchorStationId && drawAnchorStationId !== newStationId) {
            return connectStationsOnLine(baseGraph, {
              lineId: targetLineId,
              fromStationId: drawAnchorStationId,
              toStationId: newStationId,
              waypoints: drawPendingWaypoints
            }).graph;
          }
          return baseGraph;
        },
        { selectLineId: resolvedLineId || currentLineId }
      );
      if (resolvedLineId && resolvedLineId !== currentLineId) {
        onSelectLine?.(resolvedLineId);
      }
    } else {
      onAddStation(newStationObj);
      if (currentLineId && drawAnchorStationId) {
        onAddStationToLine(newStationId, { mode: 'connect', connectToStationId: drawAnchorStationId });
      }
    }

    setDrawAnchorStationId(newStationId);
    setDrawPendingWaypoints([]);
    setDrawWaypointSubmode(false);
    setInlineRename({ stationId: newStationId, value: defaultName, originalName: defaultName });
  };

  const handleStationClickInDrawMode = (station: Station) => {
    commitInlineRenameIfNeeded();
    // 未起笔：直接从该站起笔（可延伸另一端，或从中间站拉支线）
    if (!drawAnchorStationId) {
      if (!currentLineId) {
        const owningLine = lines.find((l) => l.stationIds.includes(station.id)) || lines[0];
        if (owningLine) onSelectLine?.(owningLine.id);
      }
      setDrawAnchorStationId(station.id);
      setDrawPendingWaypoints([]);
      return;
    }

    // 再次点击当前起笔站 = 抬笔
    if (drawAnchorStationId === station.id) {
      liftDrawingPen();
      return;
    }

    // 已起笔，点击另一已有站：建立换乘连接或闭合环线
    if (onApplyGraphTransaction) {
      let closedLoop = false;
      let resolvedLineId = currentLineId;
      onApplyGraphTransaction(
        (graph) => {
          let workingLines = graph.lines;
          let targetLineId =
            resolvedLineId && workingLines.some((l) => l.id === resolvedLineId)
              ? resolvedLineId
              : workingLines[0]?.id || null;
          if (!targetLineId) {
            const spec = generateAutoLineSpec(workingLines);
            targetLineId = createId();
            workingLines = [
              ...workingLines,
              { id: targetLineId, name: spec.name, color: spec.color, stationIds: [], sectionIds: [] }
            ];
          }
          resolvedLineId = targetLineId;
          const res = connectStationsOnLine(
            { ...graph, lines: workingLines },
            {
              lineId: targetLineId,
              fromStationId: drawAnchorStationId,
              toStationId: station.id,
              waypoints: drawPendingWaypoints
            }
          );
          closedLoop = res.closedLoop;
          return res.graph;
        },
        { selectLineId: resolvedLineId || currentLineId }
      );

      setDrawPendingWaypoints([]);
      setDrawWaypointSubmode(false);
      if (closedLoop) {
        liftDrawingPen();
        message.success?.('已闭合环线连接（已自动抬笔）');
      } else {
        setDrawAnchorStationId(station.id);
      }
    } else {
      onAddStationToLine(station.id, { mode: 'connect', connectToStationId: drawAnchorStationId });
      setDrawAnchorStationId(station.id);
      setDrawPendingWaypoints([]);
    }
  };

  const insertStationIntoSectionAt = (
    section: Section,
    worldPos: { x: number; y: number },
    containerPointer: { x: number; y: number },
    alsoConnectFromAnchor: boolean
  ) => {
    commitInlineRenameIfNeeded();
    const startSt = stationById.get(section.startStationId);
    const endSt = stationById.get(section.endStationId);
    if (!startSt || !endSt) return;

    const proj = findWaypointInsertIndex(
      getDisplayPoint(startSt),
      (section.waypoints || []).map((wp) => ({ ...getWaypointDisplayPoint(wp), mode: wp.mode })),
      getDisplayPoint(endSt),
      worldPos
    );
    const exactWorld = isAmapMode ? worldPos : proj.projectedPoint;
    const lngLat = getLngLatFromContainerPoint(containerPointer) || {};
    const newStationId = createId();
    const defaultName = generateNextStationName(stations);
    const newStationObj: Station = {
      id: newStationId,
      name: defaultName,
      x: exactWorld.x,
      y: exactWorld.y,
      ...lngLat
    };

    if (onApplyGraphTransaction) {
      const targetLineId = currentLineId || section.lineId;
      onApplyGraphTransaction(
        (graph) =>
          insertStationOnSection(graph, {
            sectionId: section.id,
            station: newStationObj,
            splitSharedPair: true,
            ...(alsoConnectFromAnchor && drawAnchorStationId && drawAnchorStationId !== newStationId
              ? {
                  connectFrom: {
                    lineId: targetLineId,
                    fromStationId: drawAnchorStationId,
                    waypoints: drawPendingWaypoints
                  }
                }
              : {})
          }),
        { selectLineId: targetLineId }
      );
    } else {
      onAddStation(newStationObj);
    }

    if (activeTool === 'draw') {
      setDrawAnchorStationId(newStationId);
      setDrawPendingWaypoints([]);
      setDrawWaypointSubmode(false);
    }
    setInlineRename({ stationId: newStationId, value: defaultName, originalName: defaultName });
  };

  // ==================== 站点单选/框选 60fps 拖拽与换乘合并 ====================

  const beginStationDrag = (stationId: string) => {
    onBeginInteraction?.();
    commitInlineRenameIfNeeded();
    setIsDraggingNode(true);
    setMergeTargetStationId(null);

    const originStation = stationById.get(stationId);
    if (!originStation) return;

    const movingSet = selectedStationIds.has(stationId) && selectedStationIds.size > 1
      ? new Set(selectedStationIds)
      : new Set([stationId]);

    const stationOrigins = new Map<string, { x: number; y: number }>();
    movingSet.forEach((id) => {
      const st = stationById.get(id);
      if (st) stationOrigins.set(id, getDisplayPoint(st));
    });

    const internalSectionOrigins = new Map<string, Waypoint[]>();
    const affectedSectionsSet = new Set<Section>();
    sections.forEach((sec) => {
      const startIn = movingSet.has(sec.startStationId);
      const endIn = movingSet.has(sec.endStationId);
      if (startIn || endIn) {
        affectedSectionsSet.add(sec);
      }
      if (startIn && endIn && sec.waypoints?.length) {
        internalSectionOrigins.set(
          sec.id,
          sec.waypoints.map((wp) => ({ ...wp }))
        );
      }
    });

    groupDragBaseRef.current = {
      primaryStart: getDisplayPoint(originStation),
      selectedIds: movingSet,
      stationOrigins,
      internalSectionOrigins,
      affectedSections: Array.from(affectedSectionsSet)
    };
    dragStationDraftRef.current = null;
  };

  const handleStationDragMove = (id: string, pos: { x: number; y: number }, groupNode?: any, altKey = false) => {
    if (touchGestureRef.current.isNavigating) return;
    const base = groupDragBaseRef.current;
    const updatedStation = stationById.get(id);
    if (!updatedStation || !base) return;

    // 多选群组平移
    if (base.selectedIds.size > 1) {
      const dx = pos.x - base.primaryStart.x;
      const dy = pos.y - base.primaryStart.y;
      const stationOverrides = new Map<string, { x: number; y: number }>();
      const movedStationsDraft: Array<{ id: string; x: number; y: number; lng?: number; lat?: number }> = [];
      const stage = stageRef.current;

      base.stationOrigins.forEach((origin, sid) => {
        const nx = origin.x + dx;
        const ny = origin.y + dy;
        stationOverrides.set(sid, { x: nx, y: ny });
        const lngLat = getLngLatFromContainerPoint({ x: nx, y: ny });
        movedStationsDraft.push({ id: sid, x: nx, y: ny, ...(lngLat || {}) });
        if (sid !== id && stage?.findOne) {
          const otherGroup = stage.findOne(`#${sid}`);
          otherGroup?.position?.({ x: nx, y: ny });
        }
      });

      const movedSectionsDraft: Array<{ sectionId: string; waypoints: Waypoint[] }> = [];
      base.affectedSections.forEach((sec) => {
        const internalWps = base.internalSectionOrigins.get(sec.id);
        let nextWps: Waypoint[] | undefined;
        if (internalWps) {
          nextWps = internalWps.map((wp) => {
            const dp = getWaypointDisplayPoint(wp);
            const nx = dp.x + dx;
            const ny = dp.y + dy;
            return {
              ...wp,
              x: nx,
              y: ny,
              ...(getLngLatFromContainerPoint({ x: nx, y: ny }) || {})
            };
          });
          movedSectionsDraft.push({ sectionId: sec.id, waypoints: nextWps });
        }
        updateSectionKonvaLineImperative(sec, stationOverrides, nextWps);
      });

      dragStationDraftRef.current = {
        primaryId: id,
        dx,
        dy,
        stations: movedStationsDraft,
        sections: movedSectionsDraft,
        mergeTargetId: null
      };
      groupNode?.getLayer?.()?.batchDraw?.();
      return;
    }

    // 单站点拖动：检测换乘叠放合并目标 + 相邻途经点/站点八向柔和吸附
    let snappedX = pos.x;
    let snappedY = pos.y;
    let guides: number[][] = [];
    let candidateMergeId: string | null = null;

    if (!altKey) {
      const mergeRadiusWorld = isAmapMode ? 18 : 18 / Math.max(0.35, stageRef.current?.scaleX?.() || scale);
      for (let i = 0; i < stations.length; i += 1) {
        const other = stations[i];
        if (other.id === id) continue;
        const op = getDisplayPoint(other);
        if (Math.hypot(op.x - pos.x, op.y - pos.y) <= mergeRadiusWorld) {
          snappedX = op.x;
          snappedY = op.y;
          candidateMergeId = other.id;
          break;
        }
      }
    }

    if (!candidateMergeId && !isAmapMode) {
      const incidentSections = stationToSections.get(id) || [];
      const refPoints: Array<{ x: number; y: number }> = [];
      incidentSections.forEach((sec) => {
        const wps = sec.waypoints || [];
        if (sec.startStationId === id) {
          if (wps.length > 0) refPoints.push(getWaypointDisplayPoint(wps[0]));
          else {
            const nb = stationById.get(sec.endStationId);
            if (nb) refPoints.push(getDisplayPoint(nb));
          }
        } else {
          if (wps.length > 0) refPoints.push(getWaypointDisplayPoint(wps[wps.length - 1]));
          else {
            const nb = stationById.get(sec.startStationId);
            if (nb) refPoints.push(getDisplayPoint(nb));
          }
        }
      });
      const snapped = snapWorldPointRelativeTo(pos, refPoints, altKey);
      snappedX = snapped.x;
      snappedY = snapped.y;
      guides = snapped.guides;
    }

    if (candidateMergeId !== mergeTargetStationId) {
      setMergeTargetStationId(candidateMergeId);
    }

    const lngLat = getLngLatFromContainerPoint({ x: snappedX, y: snappedY });
    dragStationDraftRef.current = {
      primaryId: id,
      dx: snappedX - base.primaryStart.x,
      dy: snappedY - base.primaryStart.y,
      stations: [{ id, x: snappedX, y: snappedY, ...(lngLat || {}) }],
      sections: [],
      mergeTargetId: candidateMergeId
    };

    if (groupNode?.position && !isAmapMode) {
      groupNode.position({ x: snappedX, y: snappedY });
    }
    updateImperativeGuides(guides);

    const overrides = new Map<string, { x: number; y: number }>([[id, { x: snappedX, y: snappedY }]]);
    if (stageRef.current?.findOne) {
      base.affectedSections.forEach((sec) => updateSectionKonvaLineImperative(sec, overrides));
      groupNode?.getLayer?.()?.batchDraw?.();
    } else {
      onUpdateStation({ ...updatedStation, x: snappedX, y: snappedY, ...(lngLat || {}) });
    }
  };

  const commitStationDrag = () => {
    updateImperativeGuides([]);
    setActiveCalibrationGuides([]);
    setIsDraggingNode(false);
    setMergeTargetStationId(null);
    groupDragBaseRef.current = null;
    const draft = dragStationDraftRef.current;
    dragStationDraftRef.current = null;
    if (!draft) return;

    // 叠放到另一站点上松手 → 合并为换乘站（开始拖拽时已调用过 onBeginInteraction，因此 recordHistory: false）
    if (draft.mergeTargetId && onApplyGraphTransaction) {
      const targetName = stationById.get(draft.mergeTargetId)?.name || '目标站';
      onApplyGraphTransaction(
        (graph) => mergeStationsIntoInterchange(graph, draft.primaryId, draft.mergeTargetId!),
        { recordHistory: false }
      );
      setSelectedStationIds(new Set([draft.mergeTargetId]));
      message.success?.(`已合并至换乘站「${targetName}」（Ctrl+Z 可撤销）`);
      return;
    }

    if (draft.stations.length === 1 && draft.sections.length === 0) {
      const item = draft.stations[0];
      const base = stationById.get(item.id);
      if (!base) return;
      onUpdateStation({
        ...base,
        x: item.x,
        y: item.y,
        ...(item.lng !== undefined && item.lat !== undefined ? { lng: item.lng, lat: item.lat } : {})
      });
      return;
    }

    if (onApplyGraphTransaction) {
      const stMap = new Map(draft.stations.map((s) => [s.id, s]));
      const secWpMap = new Map(draft.sections.map((s) => [s.sectionId, s.waypoints]));
      onApplyGraphTransaction(
        (graph) => ({
          ...graph,
          stations: graph.stations.map((st) => {
            const patch = stMap.get(st.id);
            return patch
              ? {
                  ...st,
                  x: patch.x,
                  y: patch.y,
                  ...(patch.lng !== undefined && patch.lat !== undefined ? { lng: patch.lng, lat: patch.lat } : {})
                }
              : st;
          }),
          sections: graph.sections.map((sec) => {
            const wps = secWpMap.get(sec.id);
            return wps ? { ...sec, waypoints: wps } : sec;
          })
        }),
        { recordHistory: false }
      );
    } else if (onUpdateStations) {
      const stMap = new Map(draft.stations.map((s) => [s.id, s]));
      onUpdateStations(
        stations.map((st) => {
          const patch = stMap.get(st.id);
          return patch ? { ...st, x: patch.x, y: patch.y } : st;
        })
      );
    }
  };

  // ==================== 触屏与鼠标 Stage 事件 ====================

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  };

  const readTouchPoints = (e: any): TouchPoint[] => {
    const stage = stageRef.current;
    if (!stage) return [];
    const rect = stage.container().getBoundingClientRect();
    return Array.from(e.evt.touches as TouchList).map((t) => ({
      id: t.identifier,
      x: ((t.clientX - rect.left) * stage.width()) / rect.width,
      y: ((t.clientY - rect.top) * stage.height()) / rect.height
    }));
  };

  const handleTouchStart = (e: any) => {
    e.evt.preventDefault();
    const points = readTouchPoints(e);
    const gesture = touchGestureRef.current;
    gesture.start(points);
    touchTapAllowedRef.current = false;
    clearLongPress();
    closeAllFloatingMenus();
    if (points.length > 1) {
      stageRef.current?.find('.touch-edit-node').forEach((node: any) => node.stopDrag());
      pendingSectionDragRef.current = null;
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
    const station = stationNode ? stations.find((s) => s.id === stationNode.id()) : null;
    const sectionId = e.target.getAttr('sectionId');
    const waypointIndex = e.target.getAttr('waypointIndex');
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      if (readOnly || !gesture.canLongPress || activeTool === 'draw') return;
      gesture.consume();
      stationNode?.stopDrag();
      pendingSectionDragRef.current = null;
      if (station) {
        setStationContextMenu({ visible: true, station, ...point });
      } else if (sectionId) {
        setSectionContextMenu({
          visible: true,
          sectionKey: sectionId,
          waypointIndex: waypointIndex ?? null,
          waypointOnly: waypointIndex !== undefined,
          ...point
        });
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
      pendingSectionDragRef.current = null;
    }
    if (!gesture.canLongPress) clearLongPress();

    // 选择模式下单指按在线段上直接拖出 360° 途经点
    if (points.length === 1 && pendingSectionDragRef.current && activeTool === 'select' && !readOnly) {
      const pending = pendingSectionDragRef.current;
      const pointer = points[0];
      if (Math.hypot(pointer.x - pending.downPointer.x, pointer.y - pending.downPointer.y) >= 8) {
        const worldPos = getPointerWorldPosition(stage, pointer);
        if (pending.insertedWaypointIndex === null) {
          const sec = sectionById.get(pending.sectionId);
          const sSt = sec ? stationById.get(sec.startStationId) : null;
          const eSt = sec ? stationById.get(sec.endStationId) : null;
          if (sec && sSt && eSt) {
            onBeginInteraction?.();
            const curWps = sec.waypoints || [];
            const { insertIndex } = findWaypointInsertIndex(
              getDisplayPoint(sSt),
              curWps.map((wp) => ({ ...getWaypointDisplayPoint(wp), mode: wp.mode })),
              getDisplayPoint(eSt),
              pending.downWorld
            );
            const newWp: Waypoint = {
              x: worldPos.x,
              y: worldPos.y,
              ...(getLngLatFromContainerPoint(pointer) || {})
            };
            const nextWps = [...curWps.slice(0, insertIndex), newWp, ...curWps.slice(insertIndex)];
            pending.insertedWaypointIndex = insertIndex;
            dragWaypointDraftRef.current = { sectionId: sec.id, waypoints: nextWps };
            setSelectedWaypoint({ sectionId: sec.id, waypointIndex: insertIndex });
            setIsDraggingNode(true);
            writeSectionWaypoints(sec.id, nextWps);
          }
        } else {
          updateWaypointImperativeOrState(pending.sectionId, pending.insertedWaypointIndex, worldPos.x, worldPos.y, false);
        }
        return;
      }
    }

    const next = gesture.move(
      points,
      isAmapMode ? { x: 0, y: 0, scale: 1 } : { ...stage.position(), scale: stage.scaleX() },
      activeTool === 'pan'
    );
    if (!next) return;
    startCanvasInteraction();
    if (isAmapMode && amapRef.current) {
      const map = amapRef.current;
      const center =
        points.length > 1
          ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 }
          : null;
      const anchor = center
        ? getLngLatFromContainerPoint({
            x: (center.x - next.x) / next.scale,
            y: (center.y - next.y) / next.scale
          })
        : null;
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
    if (pendingSectionDragRef.current) {
      if (pendingSectionDragRef.current.insertedWaypointIndex !== null) {
        commitWaypointDrag();
      }
      pendingSectionDragRef.current = null;
    }
    setIsDragging(false);
    scheduleCanvasInteractionEnd(120);
    if (touchTapAllowedRef.current && e.target === stageRef.current) {
      handleBlankStageClick(e);
    }
  };

  const handleTouchCancel = () => {
    clearLongPress();
    touchGestureRef.current.cancel();
    touchTapAllowedRef.current = false;
    pendingSectionDragRef.current = null;
    stageRef.current?.find('.touch-edit-node').forEach((node: any) => node.stopDrag());
    setIsDragging(false);
    setIsDraggingNode(false);
    setActiveCalibrationGuides([]);
    scheduleCanvasInteractionEnd(0);
  };

  const handleMouseDown = (e: any) => {
    const stage = e.target.getStage();
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const button = e.evt?.button ?? 0;

    closeAllFloatingMenus();

    // 鼠标中键或按住空格左键：任何工具下随时抓手平移
    if (button === 1 || (button === 0 && isSpaceHeldRef.current)) {
      e.evt?.preventDefault?.();
      isMiddlePanningRef.current = true;
      setIsDragging(true);
      lastPointerPositionRef.current = pointer;
      setMouseDownPosition(pointer);
      if (!isAmapMode) startCanvasInteraction();
      return;
    }

    if (button !== 0) return;

    if (e.target === stage) {
      setMouseDownPosition(pointer);
      lastPointerPositionRef.current = pointer;
      if (activeTool === 'pan') {
        setIsDragging(true);
        if (!isAmapMode) startCanvasInteraction();
      } else if (activeTool === 'select' && !readOnly) {
        // 准备在空白处拉框多选
        const worldPos = getPointerWorldPosition(stage, pointer);
        setMarqueeWorldRect({
          x1: worldPos.x,
          y1: worldPos.y,
          x2: worldPos.x,
          y2: worldPos.y,
          additive: Boolean(e.evt?.shiftKey)
        });
      }
    }
  };

  const handleMouseMove = (e: any) => {
    const stage = e.target.getStage();
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    // 1. 抓手平移（pan 模式 / 空格键 / 鼠标中键）
    if (isDragging && (activeTool === 'pan' || isMiddlePanningRef.current || isSpaceHeldRef.current)) {
      const last = lastPointerPositionRef.current;
      const dx = pointer.x - last.x;
      const dy = pointer.y - last.y;
      lastPointerPositionRef.current = pointer;

      if (isAmapMode && amapRef.current) {
        amapRef.current.panBy?.(dx, dy);
        return;
      }
      const current = stage.position();
      stage.position({ x: current.x + dx, y: current.y + dy });
      stage.batchDraw();
      return;
    }

    // 2. 选择模式下按住区间线条直接拖出 360° 途经点（点哪小段就插哪小段）
    if (pendingSectionDragRef.current && activeTool === 'select' && !readOnly) {
      const pending = pendingSectionDragRef.current;
      const distPx = Math.hypot(pointer.x - pending.downPointer.x, pointer.y - pending.downPointer.y);
      if (distPx >= 4) {
        const worldPos = getPointerWorldPosition(stage, pointer);
        if (pending.insertedWaypointIndex === null) {
          const sec = sectionById.get(pending.sectionId);
          const sSt = sec ? stationById.get(sec.startStationId) : null;
          const eSt = sec ? stationById.get(sec.endStationId) : null;
          if (sec && sSt && eSt) {
            onBeginInteraction?.();
            const curWps = sec.waypoints || [];
            const { insertIndex } = findWaypointInsertIndex(
              getDisplayPoint(sSt),
              curWps.map((wp) => ({ ...getWaypointDisplayPoint(wp), mode: wp.mode })),
              getDisplayPoint(eSt),
              pending.downWorld
            );
            const newWp: Waypoint = {
              x: worldPos.x,
              y: worldPos.y,
              ...(getLngLatFromContainerPoint(pointer) || {})
            };
            const nextWps = [...curWps.slice(0, insertIndex), newWp, ...curWps.slice(insertIndex)];
            pending.insertedWaypointIndex = insertIndex;
            dragWaypointDraftRef.current = { sectionId: sec.id, waypoints: nextWps };
            setSelectedWaypoint({ sectionId: sec.id, waypointIndex: insertIndex });
            setSelectedSectionId(sec.id);
            setIsDraggingNode(true);
            writeSectionWaypoints(sec.id, nextWps);
          }
        } else {
          updateWaypointImperativeOrState(
            pending.sectionId,
            pending.insertedWaypointIndex,
            worldPos.x,
            worldPos.y,
            Boolean(e.evt?.altKey)
          );
        }
        return;
      }
    }

    // 3. 选择模式下空白处矩形框选
    if (marqueeWorldRect && activeTool === 'select') {
      const worldPos = getPointerWorldPosition(stage, pointer);
      setMarqueeWorldRect((prev) => (prev ? { ...prev, x2: worldPos.x, y2: worldPos.y } : null));
      return;
    }

    // 4. 连续绘制模式下 60fps 幽灵连线与站点预览
    if (activeTool === 'draw' && !readOnly) {
      const rawWorld = getPointerWorldPosition(stage, pointer);
      const anchorSt = drawAnchorStationId ? stationById.get(drawAnchorStationId) : null;
      let lastRefPoint: { x: number; y: number } | null = null;
      if (drawPendingWaypoints.length > 0) {
        lastRefPoint = getWaypointDisplayPoint(drawPendingWaypoints[drawPendingWaypoints.length - 1]);
      } else if (anchorSt) {
        lastRefPoint = getDisplayPoint(anchorSt);
      }

      const snapped = lastRefPoint
        ? snapWorldPointRelativeTo(rawWorld, [lastRefPoint], Boolean(e.evt?.altKey))
        : { x: rawWorld.x, y: rawWorld.y, guides: [] };

      updateImperativeGuides(snapped.guides);

      const ghostDot = stage.findOne?.('#metro-drawing-ghost-dot');
      if (ghostDot) {
        ghostDot.position({ x: snapped.x, y: snapped.y });
        ghostDot.visible(true);
      }

      if (anchorSt) {
        const anchorPt = getDisplayPoint(anchorSt);
        const wpCoords = drawPendingWaypoints.flatMap((wp) => {
          const p = getWaypointDisplayPoint(wp);
          return [p.x, p.y];
        });
        const nextPts = [anchorPt.x, anchorPt.y, ...wpCoords, snapped.x, snapped.y];
        drawingPointsRef.current = nextPts;
        const previewNode = stage.findOne?.('#metro-drawing-preview');
        if (previewNode) {
          previewNode.points(nextPts);
          previewNode.visible(true);
        }
      }
      ghostDot?.getLayer?.()?.batchDraw?.();
    }
  };

  const handleBlankStageClick = (e: any) => {
    if (readOnly) return;
    const stage = e.target.getStage();
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    if (activeTool === 'select') {
      commitInlineRenameIfNeeded();
      setSelectedStationIds(new Set());
      setSelectedSectionId(null);
      setSelectedWaypoint(null);
      return;
    }

    if (activeTool === 'draw') {
      const rawWorld = getPointerWorldPosition(stage, pointer);
      const anchorSt = drawAnchorStationId ? stationById.get(drawAnchorStationId) : null;
      const lastRefPoint =
        drawPendingWaypoints.length > 0
          ? getWaypointDisplayPoint(drawPendingWaypoints[drawPendingWaypoints.length - 1])
          : anchorSt
            ? getDisplayPoint(anchorSt)
            : null;
      const snapped = lastRefPoint
        ? snapWorldPointRelativeTo(rawWorld, [lastRefPoint], Boolean(e.evt?.altKey))
        : { x: rawWorld.x, y: rawWorld.y };

      // 若已起笔且按住 Shift 或开启「拐点」子开关：打 360° 自由途经点（严格按点击顺序排列）
      if (drawAnchorStationId && (e.evt?.shiftKey || drawWaypointSubmode)) {
        const lngLat = getLngLatFromContainerPoint(pointer) || {};
        setDrawPendingWaypoints((prev) => [...prev, { x: snapped.x, y: snapped.y, ...lngLat }]);
        return;
      }

      placeNewStationInDrawMode({ x: snapped.x, y: snapped.y }, pointer);
    }
  };

  const handleMouseUp = (e?: any) => {
    const stage = stageRef.current;
    let isClick = false;
    if (mouseDownPosition && e?.target?.getStage) {
      const pointer = e.target.getStage().getPointerPosition();
      if (pointer) {
        if (Math.abs(pointer.x - mouseDownPosition.x) < 4 && Math.abs(pointer.y - mouseDownPosition.y) < 4) {
          isClick = true;
        }
      }
    }

    const wasPanDrag = isMiddlePanningRef.current || (isDragging && activeTool === 'pan');
    isMiddlePanningRef.current = false;
    setIsDragging(false);
    setMouseDownPosition(null);

    // 完成线段拖出途经点或单击选中区间
    if (pendingSectionDragRef.current) {
      const pending = pendingSectionDragRef.current;
      pendingSectionDragRef.current = null;
      if (pending.insertedWaypointIndex !== null) {
        commitWaypointDrag();
      } else {
        commitInlineRenameIfNeeded();
        setSelectedSectionId(pending.sectionId);
        setSelectedStationIds(new Set());
        setSelectedWaypoint(null);
        onSelectLine?.(pending.lineId);
      }
      return;
    }

    // 完成矩形框选
    if (marqueeWorldRect) {
      const rect = marqueeWorldRect;
      setMarqueeWorldRect(null);
      const minX = Math.min(rect.x1, rect.x2);
      const maxX = Math.max(rect.x1, rect.x2);
      const minY = Math.min(rect.y1, rect.y2);
      const maxY = Math.max(rect.y1, rect.y2);
      if (maxX - minX > 4 || maxY - minY > 4) {
        const hits = new Set<string>(rect.additive ? selectedStationIds : []);
        stations.forEach((st) => {
          const p = getDisplayPoint(st);
          if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) {
            hits.add(st.id);
          }
        });
        setSelectedStationIds(hits);
        setSelectedWaypoint(null);
        return;
      }
    }

    if (!isAmapMode && stage && wasPanDrag) {
      const pos = stage.position();
      const sx = stage.scaleX();
      if (Math.abs(pos.x - position.x) > 0.5 || Math.abs(pos.y - position.y) > 0.5) {
        setPosition({ x: pos.x, y: pos.y });
      }
      if (Math.abs(sx - scale) > 0.001) {
        setScale(sx);
      }
      scheduleCanvasInteractionEnd(120);
      return;
    }

    const isLeftClick = e?.evt && (e.evt.button === 0 || e.evt.button === undefined);
    if (isClick && isLeftClick && e.target === stage && !wasPanDrag) {
      handleBlankStageClick(e);
    }
  };

  // ==================== 视图缩放/定位控制 ====================

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
    if (!stage) {
      setScale(next);
      return;
    }
    const old = stage.scaleX();
    const center = { x: stage.width() / 2, y: stage.height() / 2 };
    const pos = stage.position();
    applyCanvasViewport(next, {
      x: center.x - ((center.x - pos.x) * next) / old,
      y: center.y - ((center.y - pos.y) * next) / old
    });
  };

  const zoomIn = () => {
    if (isAmapMode && amapRef.current) {
      amapRef.current.setZoom?.(Math.min(20, (amapRef.current.getZoom?.() || 11) + 1));
      return;
    }
    setCanvasZoom((stageRef.current?.scaleX() || scale) * 1.2);
  };

  const zoomOut = () => {
    if (isAmapMode && amapRef.current) {
      amapRef.current.setZoom?.(Math.max(3, (amapRef.current.getZoom?.() || 11) - 1));
      return;
    }
    setCanvasZoom((stageRef.current?.scaleX() || scale) / 1.2);
  };

  const setZoomPercent = (percent: number) => {
    setCanvasZoom(Math.max(0.1, Math.min(5, percent / 100)));
  };

  const fitView = (extraPadding = 0, maxZoomCap = 1.15) => {
    if (stations.length === 0) return;
    if (isAmapMode && amapRef.current) {
      const lngLatStations = stations.filter(
        (station) => typeof station.lng === 'number' && typeof station.lat === 'number'
      );
      if (lngLatStations.length) {
        const AMap = (window as any).AMap;
        const bounds = new AMap.Bounds(
          [
            Math.min(...lngLatStations.map((station) => station.lng!)),
            Math.min(...lngLatStations.map((station) => station.lat!))
          ],
          [
            Math.max(...lngLatStations.map((station) => station.lng!)),
            Math.max(...lngLatStations.map((station) => station.lat!))
          ]
        );
        amapRef.current.setBounds?.(bounds, false, [80, 80, 80, 80]);
      }
      return;
    }

    const minX = Math.min(...stations.map((s) => s.x));
    const minY = Math.min(...stations.map((s) => s.y));
    const maxX = Math.max(...stations.map((s) => s.x));
    const maxY = Math.max(...stations.map((s) => s.y));

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
    if (
      initialFitRef.current &&
      !isDocumentLoading &&
      stageSize.width > 0 &&
      stageSize.height > 0 &&
      Math.abs(stageSize.width - (containerRef.current?.clientWidth || stageSize.width)) < 2
    ) {
      initialFitRef.current = false;
      lastFittedDocKeyRef.current = documentKey;
      if (!isAmapMode && stations.length > 0) {
        initialFitViewRef.current(72, 1);
      }
    }
  }, [documentKey, isAmapMode, isDocumentLoading, stageSize.width, stageSize.height, stations.length]);

  const centerOnStation = (stationId: string, pulseHighlight = false) => {
    const st = stationById.get(stationId);
    if (!st) return;
    if (pulseHighlight) {
      setHighlightedStationId(stationId);
      window.setTimeout(() => {
        setHighlightedStationId((cur) => (cur === stationId ? null : cur));
      }, 2200);
    }
    if (isAmapMode && amapRef.current) {
      if (typeof st.lng === 'number' && typeof st.lat === 'number') {
        amapRef.current.setCenter?.([st.lng, st.lat]);
      }
      return;
    }
    const targetScale = Math.max(scale, 1);
    const p = getDisplayPoint(st);
    applyCanvasViewport(targetScale, {
      x: stageSize.width / 2 - p.x * targetScale,
      y: stageSize.height / 2 - p.y * targetScale
    });
  };

  const viewDispatchRef = useRef<(a: AppAction) => void>(() => {});
  viewDispatchRef.current = (a: AppAction) => {
    switch (a.type) {
      case 'zoom':
        setZoomPercent(a.value * 100);
        break;
      case 'zoom_in':
        zoomIn();
        break;
      case 'zoom_out':
        zoomOut();
        break;
      case 'fit':
        fitView();
        break;
      case 'reset':
        resetView();
        break;
      case 'center':
        centerOnStation(a.stationId, true);
        break;
      default:
        break;
    }
  };
  useEffect(() => {
    if (viewCommand) viewDispatchRef.current(viewCommand.action);
  }, [viewCommand]);

  // ==================== 站点点击 / 双击 / 右键 / 背景设置 ====================

  const handleStationClick = (station: Station, e?: any) => {
    if (readOnly) {
      setStationInfoModal({ visible: true, station, note: station.note || '' });
      return;
    }
    if (e?.evt && e.evt.button !== undefined && e.evt.button !== 0) return;

    if (activeTool === 'draw') {
      handleStationClickInDrawMode(station);
      return;
    }

    if (activeTool === 'select') {
      commitInlineRenameIfNeeded();
      setSelectedWaypoint(null);
      if (e?.evt?.shiftKey) {
        setSelectedStationIds((prev) => {
          const next = new Set(prev);
          if (next.has(station.id)) next.delete(station.id);
          else next.add(station.id);
          return next;
        });
      } else {
        setSelectedStationIds(new Set([station.id]));
      }
    }
  };

  const handleStationDoubleClick = (station: Station, e?: any) => {
    if (readOnly) return;
    e?.evt?.preventDefault?.();
    e.cancelBubble = true;
    commitInlineRenameIfNeeded();
    setInlineRename({ stationId: station.id, value: station.name, originalName: station.name });
  };

  const handleStationRightClick = (e: any, station: Station) => {
    if (readOnly) {
      e?.evt?.preventDefault?.();
      return;
    }
    e.evt.preventDefault();
    e.cancelBubble = true;

    // 绘制连笔中右键任意处 = 抬笔（不弹右键菜单）
    if (activeTool === 'draw' && (drawAnchorStationId || drawPendingWaypoints.length > 0)) {
      liftDrawingPen();
      return;
    }

    const stage = e.target.getStage();
    const pointer = stage?.getPointerPosition?.();
    if (pointer) {
      setSectionContextMenu((prev) => ({ ...prev, visible: false }));
      setCanvasContextMenu((prev) => ({ ...prev, visible: false }));
      setStationContextMenu({ visible: true, x: pointer.x, y: pointer.y, station });
    }
  };

  const handleStationTap = (station: Station, e: any) => {
    if (readOnly) {
      if (touchTapAllowedRef.current) handleStationClick(station, e);
      return;
    }
    if (!touchTapAllowedRef.current) return;
    if (activeTool === 'draw') {
      handleStationClickInDrawMode(station);
      return;
    }
    if (activeTool === 'pan') return;
    const pointer = e.target.getStage()?.getPointerPosition();
    if (pointer) {
      setStationContextMenu({ visible: true, station, x: pointer.x, y: pointer.y });
    }
  };

  const handleSaveStationNote = () => {
    if (!stationInfoModal.station) return;
    onUpdateStation({ ...stationInfoModal.station, note: stationInfoModal.note });
    setStationInfoModal((prev) => ({ ...prev, station: { ...prev.station!, note: prev.note } }));
    message.success?.('站点附加标注已更新');
  };

  const handleTranslateInlineRename = async () => {
    if (!inlineRename) return;
    if (isGuest) {
      onRequireAuth?.();
      return;
    }
    const raw = inlineRename.value.trim();
    if (!raw) return;
    setTranslatingInline(true);
    try {
      const { english } = await api.translateStation(raw);
      setInlineRename((prev) => (prev ? { ...prev, value: english } : null));
    } catch (err: any) {
      message.error?.(err?.message || '翻译失败，请稍后再试');
    } finally {
      setTranslatingInline(false);
    }
  };

  const handleCanvasContextMenu = (e: any) => {
    if (readOnly) {
      e?.evt?.preventDefault?.();
      return;
    }
    e.evt.preventDefault();
    if (activeTool === 'draw' && (drawAnchorStationId || drawPendingWaypoints.length > 0)) {
      liftDrawingPen();
      return;
    }
    const stage = e.target.getStage();
    if (!stage || e.target !== stage) return;
    const pointer = stage.getPointerPosition();
    closeAllFloatingMenus();
    setCanvasContextMenu({ visible: true, x: pointer?.x || 0, y: pointer?.y || 0 });
  };

  const handleConfirmCanvasColor = () => {
    setCanvasBackgroundColor(canvasColorModal.currentColor);
    setCanvasColorModal((prev) => ({ ...prev, visible: false, showPicker: false }));
    message.success?.('画布颜色已更新');
  };

  const handleImportImage = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      message.warning?.('请选择图片文件');
      event.target.value = '';
      return;
    }
    if (canvasBackgroundImage) URL.revokeObjectURL(canvasBackgroundImage);
    setCanvasBackgroundImage(URL.createObjectURL(file));
    message.success?.('底图已导入');
    event.target.value = '';
  };

  // ==================== 几何预计算与空间网格避让 ====================

  const stylePreset = getCityStylePreset(mapSettings);

  const stationToLines = useMemo(() => {
    const map = new Map<string, LineType[]>();
    lines.forEach((line) => {
      line.stationIds.forEach((id) => {
        const arr = map.get(id);
        if (arr) {
          if (!arr.includes(line)) arr.push(line);
        } else {
          map.set(id, [line]);
        }
      });
    });
    return map;
  }, [lines]);

  const stationLineCounts = useMemo(() => {
    return stations.reduce<Record<string, number>>((result, station) => {
      result[station.id] = stationToLines.get(station.id)?.length || 0;
      return result;
    }, {});
  }, [stations, stationToLines]);

  const tier1StationIds = useMemo(() => {
    const set = new Set<string>();
    Object.entries(stationLineCounts).forEach(([id, count]) => {
      if (count >= 2) set.add(id);
    });
    lines.forEach((line) => {
      const topo = lineTopologyById.get(line.id);
      if (topo) {
        topo.terminalStationIds.forEach((id) => set.add(id));
      } else if (line.stationIds.length > 0) {
        set.add(line.stationIds[0]);
        set.add(line.stationIds[line.stationIds.length - 1]);
      }
    });
    return set;
  }, [stationLineCounts, lines, lineTopologyById]);

  const labelDensity = mapSettings.labelDensity;

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
  }, [labelDensity, isAmapMode, amapReady, scale, mapRenderTick, mapSettings.baseMap.amap?.zoom, amapRef]);

  const { dotScale, strokeScale, labelScale, pillScale, allowTier1OverlapCull } = visualScales;
  const effectiveScale = labelScale;

  useLayoutEffect(() => {
    const synchronize = (viewportScale: number) => {
      const stage = stageRef.current;
      if (!stage) return;
      const ratio = isAmapMode ? 1 : liveElementScaleRatio(labelDensity, viewportScale, dotScale);
      const elementStrokeScale = isAmapMode ? strokeScale : plainCanvasElementScale(labelDensity, viewportScale);
      stage.find('.zoom-sized-element').forEach((node: any) => node.scale({ x: ratio, y: ratio }));
      stage
        .find('.zoom-sized-stroke')
        .forEach((node: any) => node.strokeWidth(stylePreset.lineWidth * elementStrokeScale));
    };
    syncZoomElementSizesRef.current = synchronize;
    synchronize(stageRef.current?.scaleX() || scale);
  });

  const scaledLineWidth = stylePreset.lineWidth * strokeScale;
  const scaledParallelGap = Math.max(3.5, 8 * strokeScale);
  const scaledNormalStationRadius = stylePreset.normalStationRadius * dotScale;
  const scaledNormalStationStrokeWidth = stylePreset.normalStationStrokeWidth * dotScale;
  const scaledInterchangeRadius = stylePreset.interchangeRadius * dotScale;
  const scaledInterchangeInnerRadius = stylePreset.interchangeInnerRadius * dotScale;
  const scaledInterchangeStrokeWidth = stylePreset.interchangeStrokeWidth * dotScale;
  const scaledWaypointRadius = Math.max(4, 6.2 * dotScale);
  const scaledWaypointStrokeWidth = Math.max(1.4, 2 * dotScale);
  const scaledFontSize = mapSettings.dotLabelStyle.fontSize * labelScale;
  const scaledLineLabelFontSize = stylePreset.lineLabelFontSize * pillScale;
  const scaledLineLabelStrokeWidth = stylePreset.lineLabelStrokeWidth * pillScale;
  const scaledLineLabelPaddingX = stylePreset.lineLabelPaddingX * pillScale;
  const scaledLineLabelPaddingY = stylePreset.lineLabelPaddingY * pillScale;
  const scaledStationLabelMinWidth = 36 * labelScale;
  const scaledStationLabelMinHeight = 20 * labelScale;
  const scaledStationCollisionRadius = Math.max(5, scaledNormalStationRadius + 3 * dotScale);
  const scaledLineCollisionDistance = Math.max(10, scaledLineWidth + 10 * labelScale);
  const scaledLineLabelMinWidth = 48 * pillScale;
  const scaledLineLabelTerminalGap = 12 * pillScale;
  const scaledLineLabelMinDistance = 20 * pillScale;
  const scaledLineLabelSideGap = 7 * pillScale;

  const isLargeGraph = stations.length > 200 || sections.length > 200;

  // 预计算共线平行角平分线偏移与单点圆弧采样几何（彻底修复反向重叠与折角交叉）
  const preparedLineSegments = useMemo(() => {
    if (!canvasSceneReady) {
      sectionParallelOffsetRef.current = new Map();
      return [];
    }
    const rawList: Array<{
      section: Section;
      line: LineType;
      start: Station;
      end: Station;
      waypoints: Waypoint[];
      pairKey: string;
    }> = [];
    for (let i = 0; i < sections.length; i += 1) {
      const section = sections[i];
      const line = lineById.get(section.lineId);
      const start = stationById.get(section.startStationId);
      const end = stationById.get(section.endStationId);
      if (!line || !start || !end) continue;
      rawList.push({
        section,
        line,
        start,
        end,
        waypoints: section.waypoints || [],
        pairKey: canonicalSectionPairKey(section.startStationId, section.endStationId)
      });
    }

    const pairGroups = new Map<string, typeof rawList>();
    rawList.forEach((item) => {
      const arr = pairGroups.get(item.pairKey);
      if (arr) arr.push(item);
      else pairGroups.set(item.pairKey, [item]);
    });
    pairGroups.forEach((arr) => {
      arr.sort((a, b) => (lineOrderMap.get(a.line.id) ?? 0) - (lineOrderMap.get(b.line.id) ?? 0));
    });

    const map = amapRef.current;
    const projectWp = (point: Waypoint) => {
      if (isAmapMode && amapReady && map && typeof point.lng === 'number' && typeof point.lat === 'number') {
        const pixel = map.lngLatToContainer?.([point.lng, point.lat]);
        if (pixel) return { x: pixel.x, y: pixel.y };
      }
      return { x: point.x, y: point.y };
    };

    const offsetMap = new Map<string, number>();
    const prepared = rawList.map((seg) => {
      const group = pairGroups.get(seg.pairKey) || [seg];
      const slotIndex = Math.max(0, group.indexOf(seg));
      const directedOffset = computeDirectedParallelOffset(
        seg.section.startStationId,
        seg.section.endStationId,
        slotIndex,
        group.length,
        scaledParallelGap
      );
      offsetMap.set(seg.section.id, directedOffset);

      const startPoint = stationDisplayPoints[seg.start.id] || { x: seg.start.x, y: seg.start.y };
      const endPoint = stationDisplayPoints[seg.end.id] || { x: seg.end.x, y: seg.end.y };
      const controlPoints: RPoint[] = [
        { x: startPoint.x, y: startPoint.y },
        ...seg.waypoints.map((wp) => {
          const p = projectWp(wp);
          return {
            x: p.x,
            y: p.y,
            ...(typeof wp.radius === 'number' ? { radius: wp.radius } : {}),
            ...(wp.mode ? { mode: wp.mode } : {})
          };
        }),
        { x: endPoint.x, y: endPoint.y }
      ];

      const { shiftedFlat, renderFlat } = buildSectionRenderGeometry(
        controlPoints,
        directedOffset,
        lineCornerRadius
      );

      return {
        ...seg,
        slotIndex,
        shiftedFlat,
        renderFlat
      };
    });

    sectionParallelOffsetRef.current = offsetMap;
    return prepared;
  }, [
    canvasSceneReady,
    sections,
    lineById,
    stationById,
    lineOrderMap,
    stationDisplayPoints,
    isAmapMode,
    amapReady,
    mapRenderTick,
    lineCornerRadius,
    scaledParallelGap,
    amapRef
  ]);

  const isDarkCanvas = mapSettings.canvasTheme === 'dark';
  const canvasPalette = CANVAS_THEME_PALETTES[mapSettings.canvasTheme];
  const dotLabelStyle = mapSettings.dotLabelStyle;
  const amapStyle = mapSettings.baseMap.amap?.style || 'normal';
  const isLightAmapRender = isAmapMode && isMapInteracting;
  const isLightRender = isLightAmapRender || (!isAmapMode && isMapInteracting);
  const skipHeavyLayout = isMapInteracting || isDraggingNode;
  const isMutedAmapStyle = isAmapMode && (amapStyle === 'dark' || amapStyle === 'grey');
  const isFreshAmapStyle = isAmapMode && amapStyle === 'fresh';
  const readableLabelText = isMutedAmapStyle
    ? '#ffffff'
    : isFreshAmapStyle
      ? '#0f172a'
      : dotLabelStyle.color || canvasPalette.labelText;
  const readableLabelShadow = isMutedAmapStyle ? 'rgba(0, 0, 0, 0.92)' : 'rgba(255, 255, 255, 0.98)';

  const currentLine = currentLineId ? lineById.get(currentLineId) || null : null;
  const suppressShadows = isLightRender || isLargeGraph;

  const getStationColor = (stationId: string) => {
    const passing = stationToLines.get(stationId);
    if (currentLine && passing?.some((l) => l.id === currentLine.id)) return currentLine.color;
    return passing?.[0]?.color || '#64748b';
  };

  // 站名八向空间网格自动避让布局
  const labelPlacementsCacheRef = useRef<Record<string, LabelRect>>({});
  const labelPlacements = useMemo(() => {
    if (!canvasSceneReady) {
      labelPlacementsCacheRef.current = {};
      return {};
    }
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
          segmentGrid.insert({
            x: Math.min(prev.x, cur.x) - pad,
            y: Math.min(prev.y, cur.y) - pad,
            width: Math.abs(cur.x - prev.x) + pad * 2,
            height: Math.abs(cur.y - prev.y) + pad * 2,
            x1: prev.x,
            y1: prev.y,
            x2: cur.x,
            y2: cur.y
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
        x1: prev.x,
        y1: prev.y,
        x2: last.x,
        y2: last.y
      });
    }

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
      const gap =
        ((stationLineCounts[station.id] || 0) > 1 ? scaledInterchangeRadius : scaledNormalStationRadius) +
        5 * labelScale;
      const candidates = [
        { key: 'right', x: stationPoint.x + gap, y: stationPoint.y - labelHeight / 2 },
        { key: 'left', x: stationPoint.x - labelWidth - gap, y: stationPoint.y - labelHeight / 2 },
        { key: 'top', x: stationPoint.x - labelWidth / 2, y: stationPoint.y - labelHeight - gap },
        { key: 'bottom', x: stationPoint.x - labelWidth / 2, y: stationPoint.y + gap },
        { key: 'top-right', x: stationPoint.x + gap, y: stationPoint.y - labelHeight - gap },
        { key: 'bottom-right', x: stationPoint.x + gap, y: stationPoint.y + gap },
        { key: 'top-left', x: stationPoint.x - labelWidth - gap, y: stationPoint.y - labelHeight - gap },
        { key: 'bottom-left', x: stationPoint.x - labelWidth - gap, y: stationPoint.y + gap }
      ].filter((candidate) => !hasPinnedPosition || candidate.key === station.labelPosition);

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
    tier1StationIds,
    stationLineCounts,
    allowTier1OverlapCull,
    labelDensity,
    amapRef
  ]);

  // 线路名称胶囊布局（原生适配闭合环线与 Y 型多支线端点）
  const lineNamePlacementsCacheRef = useRef<
    Array<{ key: string; line: LineType; labelText: string; x: number; y: number; width: number; height: number }>
  >([]);
  const lineNamePlacements = useMemo(() => {
    if (!canvasSceneReady) {
      lineNamePlacementsCacheRef.current = [];
      return [];
    }
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
      labelText: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];

    lines.forEach((line) => {
      const topo = lineTopologyById.get(line.id);
      const orderedStations = (topo?.stationIds || line.stationIds)
        .map((id) => stationById.get(id))
        .filter(Boolean) as Station[];
      if (orderedStations.length < 2) return;

      const isLoop = Boolean(topo?.isLoop);
      const labelText = isLoop && !/环/.test(line.name) ? `${line.name}·环线` : line.name;
      const labelWidth = Math.max(
        scaledLineLabelMinWidth,
        Math.ceil(estimateSingleLineTextWidth(labelText, scaledLineLabelFontSize) + scaledLineLabelPaddingX * 2)
      );
      const labelHeight = scaledLineLabelFontSize + scaledLineLabelPaddingY * 2 + 2;

      const terminalPairs = isLoop
        ? [{ terminal: orderedStations[0], neighbor: orderedStations[1], preference: 0, tangentNormal: true }]
        : [
            { terminal: orderedStations[0], neighbor: orderedStations[1], preference: 0, tangentNormal: false },
            {
              terminal: orderedStations[orderedStations.length - 1],
              neighbor: orderedStations[orderedStations.length - 2],
              preference: 4,
              tangentNormal: false
            }
          ];

      const best = terminalPairs
        .flatMap(({ terminal, neighbor, preference, tangentNormal }) => {
          if (!terminal || !neighbor) return [];
          const terminalPoint = pointOf(terminal);
          const neighborPoint = pointOf(neighbor);
          const dx = terminalPoint.x - neighborPoint.x;
          const dy = terminalPoint.y - neighborPoint.y;
          const len = Math.hypot(dx, dy) || 1;
          const outward = tangentNormal ? { x: -dy / len, y: dx / len } : { x: dx / len, y: dy / len };
          const normal = { x: -outward.y, y: outward.x };
          const baseDistance = Math.max(scaledLineLabelMinDistance, scaledInterchangeRadius + scaledLineLabelTerminalGap);
          return [
            0,
            labelHeight + scaledLineLabelSideGap,
            -(labelHeight + scaledLineLabelSideGap),
            labelHeight * 2 + scaledLineLabelSideGap * 2,
            -(labelHeight * 2 + scaledLineLabelSideGap * 2)
          ].map((sideOffset, index) => {
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
          });
        })
        .map((candidate) => {
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
        placements.push({ key: line.id, line, labelText, ...best.rect });
      }
    });

    lineNamePlacementsCacheRef.current = placements;
    return placements;
  }, [
    canvasSceneReady,
    isLightAmapRender,
    skipHeavyLayout,
    mapSettings.showLineNameLabels,
    lines,
    lineTopologyById,
    labelPlacements,
    stations,
    stationById,
    effectiveScale,
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

  // 当前选中途经点的圆弧控制手柄几何
  const activeWaypointArcGeometry = useMemo(() => {
    if (!selectedWaypoint) return null;
    const sec = sectionById.get(selectedWaypoint.sectionId);
    if (!sec || !sec.waypoints || !sec.waypoints[selectedWaypoint.waypointIndex]) return null;
    const idx = selectedWaypoint.waypointIndex;
    const wps = sec.waypoints;
    const wp = wps[idx];
    const startSt = stationById.get(sec.startStationId);
    const endSt = stationById.get(sec.endStationId);
    if (!startSt || !endSt) return null;
    const prevPt = idx === 0 ? getDisplayPoint(startSt) : getWaypointDisplayPoint(wps[idx - 1]);
    const currPt = getWaypointDisplayPoint(wp);
    const nextPt = idx === wps.length - 1 ? getDisplayPoint(endSt) : getWaypointDisplayPoint(wps[idx + 1]);
    const effectiveRadius = typeof wp.radius === 'number' ? wp.radius : lineCornerRadius;
    const minHandleGap = isAmapMode ? 22 : 22 / Math.max(0.3, scale);
    const handleInfo =
      wp.mode === 'arc' ? null : computeCornerHandleInfo(prevPt, currPt, nextPt, effectiveRadius, minHandleGap);
    return {
      section: sec,
      waypoint: wp,
      waypointIndex: idx,
      prevPt,
      currPt,
      nextPt,
      effectiveRadius,
      handleInfo
    };
  }, [selectedWaypoint, sectionById, stationById, stationDisplayPoints, lineCornerRadius, scale, isAmapMode, mapRenderTick]);

  // 搜索匹配结果
  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return stations.slice(0, 8);
    return stations
      .filter((st) => {
        if (st.name.toLowerCase().includes(q)) return true;
        const passing = stationToLines.get(st.id) || [];
        return passing.some((l) => l.name.toLowerCase().includes(q));
      })
      .slice(0, 12);
  }, [searchQuery, stations, stationToLines]);

  const viewportScaleForHit = isAmapMode ? 1 : scale;

  const renderLines = (suppressShadow: boolean) => {
    const result: JSX.Element[] = [];
    const hitStroke = Math.max(SECTION_HIT_STROKE_WIDTH / Math.max(0.28, viewportScaleForHit), scaledLineWidth + 14);

    preparedLineSegments.forEach((seg) => {
      const { slotIndex, renderFlat } = seg;
      const isSelectedSec = selectedSectionId === seg.section.id;

      const handleSectionMouseDown = (e: any) => {
        if (readOnly) return;
        const button = e.evt?.button ?? 0;
        if (button !== 0 || isSpaceHeldRef.current) return;
        if (activeTool === 'select') {
          e.cancelBubble = true;
          const stage = e.target.getStage();
          const pointer = stage?.getPointerPosition?.();
          if (!pointer) return;
          pendingSectionDragRef.current = {
            sectionId: seg.section.id,
            lineId: seg.line.id,
            downPointer: { x: pointer.x, y: pointer.y },
            downWorld: getPointerWorldPosition(stage, pointer),
            insertedWaypointIndex: null
          };
        }
      };

      const handleSectionTouchStart = (e: any) => {
        if (readOnly || activeTool !== 'select') return;
        const points = readTouchPoints(e);
        if (points.length === 1) {
          const stage = e.target.getStage();
          pendingSectionDragRef.current = {
            sectionId: seg.section.id,
            lineId: seg.line.id,
            downPointer: points[0],
            downWorld: getPointerWorldPosition(stage, points[0]),
            insertedWaypointIndex: null
          };
        }
      };

      const handleSectionClick = (e: any) => {
        if (readOnly) return;
        const button = e.evt?.button;
        if (button !== undefined && button !== 0) return;
        if (e.evt?.touches !== undefined && !touchTapAllowedRef.current) return;
        const stage = e.target.getStage();
        const pointer = stage?.getPointerPosition?.();
        if (!stage || !pointer) return;

        if (activeTool === 'draw') {
          e.cancelBubble = true;
          const worldPos = getPointerWorldPosition(stage, pointer);
          insertStationIntoSectionAt(seg.section, worldPos, pointer, Boolean(drawAnchorStationId));
          return;
        }

        if (isCompact && activeTool === 'select') {
          e.cancelBubble = true;
          setSectionContextMenu({
            visible: true,
            x: pointer.x,
            y: pointer.y,
            sectionKey: seg.section.id,
            waypointIndex: null,
            waypointOnly: false
          });
        }
      };

      const handleSectionDblClick = (e: any) => {
        if (readOnly || activeTool !== 'select') return;
        e.evt?.preventDefault?.();
        e.cancelBubble = true;
        pendingSectionDragRef.current = null;
        const stage = e.target.getStage();
        const pointer = stage?.getPointerPosition?.();
        if (!stage || !pointer) return;
        const worldPos = getPointerWorldPosition(stage, pointer);
        insertStationIntoSectionAt(seg.section, worldPos, pointer, false);
      };

      const handleSectionContextMenu = (e: any) => {
        if (readOnly) {
          e?.evt?.preventDefault?.();
          return;
        }
        e.evt.preventDefault();
        e.cancelBubble = true;
        if (activeTool === 'draw' && (drawAnchorStationId || drawPendingWaypoints.length > 0)) {
          liftDrawingPen();
          return;
        }
        const stage = e.target.getStage();
        const pointer = stage?.getPointerPosition?.();
        if (!pointer) return;
        closeAllFloatingMenus();
        setSectionContextMenu({
          visible: true,
          x: pointer.x,
          y: pointer.y,
          sectionKey: seg.section.id,
          waypointIndex: null,
          waypointOnly: false
        });
      };

      result.push(
        <Line
          key={`${seg.section.id}_${slotIndex}_hit`}
          id={`sec_hit_${seg.section.id}`}
          points={renderFlat}
          stroke="rgba(0,0,0,0.001)"
          strokeWidth={hitStroke}
          hitStrokeWidth={hitStroke}
          lineCap="round"
          lineJoin="round"
          perfectDrawEnabled={false}
          sectionId={seg.section.id}
          onMouseDown={handleSectionMouseDown}
          onTouchStart={handleSectionTouchStart}
          onTap={handleSectionClick}
          onClick={handleSectionClick}
          onDblClick={handleSectionDblClick}
          onContextMenu={handleSectionContextMenu}
        />,
        <Line
          key={`${seg.section.id}_${slotIndex}`}
          id={`sec_vis_${seg.section.id}`}
          name="zoom-sized-stroke"
          points={renderFlat}
          stroke={seg.line.color}
          strokeWidth={isSelectedSec ? scaledLineWidth * 1.18 : scaledLineWidth}
          lineCap="round"
          lineJoin="round"
          perfectDrawEnabled={false}
          shadowColor={seg.line.color}
          shadowBlur={suppressShadow ? 0 : isSelectedSec ? stylePreset.lineShadowBlur + 4 : stylePreset.lineShadowBlur}
          shadowOpacity={
            suppressShadow ? 0 : Math.max(canvasPalette.lineShadowOpacity, stylePreset.lineShadowOpacity)
          }
          listening={false}
        />
      );
    });
    return result;
  };

  const anchorStation = drawAnchorStationId ? stationById.get(drawAnchorStationId) || null : null;
  const activeHintText =
    isSpaceHeld
      ? isEn
        ? 'Space held: drag anywhere to pan canvas'
        : '空格抓手已激活：按住左键拖拽即可平移画布'
      : selectedWaypoint
        ? isEn
          ? 'Drag orange handle to adjust arc radius · Switch pure arc · Double-click bend to remove'
          : '拖动橙色手柄调圆弧大小 · 可切过点圆弧 · 双击拐点直接删除'
        : activeTool === 'draw'
          ? anchorStation
            ? text.hints.drawActive(anchorStation.name, drawWaypointSubmode)
            : text.hints.drawIdle
          : activeTool === 'pan'
            ? text.hints.pan
            : text.hints.select;

  const activeCanvasCursor =
    isSpaceHeld || activeTool === 'pan'
      ? isDragging
        ? 'grabbing'
        : 'grab'
      : activeTool === 'draw'
        ? 'crosshair'
        : 'default';

  return (
    <div
      ref={containerRef}
      onTouchCancel={handleTouchCancel}
      className={`metro-canvas-surface ${isDarkCanvas ? 'is-canvas-dark' : ''}`}
      data-map-mode={mapSettings.baseMap.mode}
      aria-busy={!canvasSceneReady}
      style={
        {
          width: '100%',
          height: '100%',
          '--metro-canvas-bg': canvasBackgroundColor,
          backgroundColor: canvasBackgroundColor,
          backgroundImage: !isAmapMode && canvasBackgroundImage ? `url(${canvasBackgroundImage})` : undefined,
          backgroundSize: !isAmapMode && canvasBackgroundImage ? 'cover' : undefined,
          backgroundPosition: !isAmapMode && canvasBackgroundImage ? 'center' : undefined,
          backgroundRepeat: !isAmapMode && canvasBackgroundImage ? 'no-repeat' : undefined
        } as React.CSSProperties
      }
    >
      {lines.length === 0 &&
        stations.length === 0 &&
        sections.length === 0 &&
        !isAmapMode &&
        !canvasBackgroundImage &&
        onCreateLine &&
        onStartWithAmap && (
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
        <div
          role="status"
          aria-live="polite"
          className="metro-map-loading"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 1001,
            display: 'grid',
            placeItems: 'center',
            background: isAmapMode && amapStyle === 'dark' ? '#151c25' : '#f1f5f9',
            color: isAmapMode && amapStyle === 'dark' ? '#e2e8f0' : '#475569'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, maxWidth: 440, padding: 28, fontSize: 15 }}>
            {!amapError && <Spin />}
            <span>{amapError || (isEn ? 'Loading map and network…' : '正在加载地图与线网…')}</span>
          </div>
        </div>
      )}

      {/* 顶部三态灵动工具栏 + 绘制子控制条 + 实时手势上下文轻提示 */}
      <div className="metro-canvas-tools">
        <div
          ref={toolGroupRef}
          className="metro-tool-group"
          data-active-tool={activeTool}
          role="toolbar"
          aria-label="Canvas tools"
        >
          {[
            { key: 'select' as CanvasTool, shortcut: 'V', label: text.tools.select, icon: <SelectOutlined /> },
            { key: 'draw' as CanvasTool, shortcut: 'D', label: text.tools.draw, icon: <NodeIndexOutlined /> },
            { key: 'pan' as CanvasTool, shortcut: 'H', label: text.tools.pan, icon: <DragOutlined /> }
          ].map((tool, index) => {
            const active = activeTool === tool.key;
            return (
              <Tooltip
                key={tool.key}
                title={isCompact ? null : `${tool.label} (${tool.shortcut})`}
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

        {!readOnly && activeTool === 'draw' && (
          <div className="metro-draw-subbar" role="group" aria-label="绘制辅助选项">
            <span className="metro-draw-subbar__line" title={currentLine?.name || '落笔自动建 1号线'}>
              <span
                className="metro-draw-subbar__swatch"
                style={{ backgroundColor: currentLine?.color || LINE_COLORS[0] }}
              />
              {currentLine?.name || (isEn ? 'Auto Line 1' : '自动建 1号线')}
            </span>
            {anchorStation ? (
              <>
                <span className="metro-draw-subbar__sep" />
                <button
                  type="button"
                  className={`metro-draw-subbar__pill${!drawWaypointSubmode ? ' is-active' : ''}`}
                  onClick={() => setDrawWaypointSubmode(false)}
                >
                  {isEn ? 'Station' : '落站点'}
                </button>
                <button
                  type="button"
                  className={`metro-draw-subbar__pill${drawWaypointSubmode ? ' is-active' : ''}`}
                  onClick={() => setDrawWaypointSubmode((v) => !v)}
                  title="连笔途中按住 Shift+左键或开启此项可连续打 360° 途经点"
                >
                  {isEn ? 'Bend (Shift)' : '打拐点'}
                  {drawPendingWaypoints.length > 0 ? ` (${drawPendingWaypoints.length})` : ''}
                </button>
                <button
                  type="button"
                  className="metro-draw-subbar__pill metro-draw-subbar__pill--lift"
                  onClick={liftDrawingPen}
                  title="收起虚线，随后可点任意站点从另一端延伸或拉支线 (右键 / Esc)"
                >
                  {isEn ? 'Lift Pen' : '抬笔'}
                </button>
              </>
            ) : null}
          </div>
        )}

        {!readOnly && !isCompact && <div className="metro-gesture-status">{activeHintText}</div>}
      </div>

      {/* 移动端顶部轻提示条 */}
      <div className="metro-touch-hint" aria-live="polite">
        <span>{activeHintText}</span>
        {anchorStation ? (
          <button type="button" onClick={liftDrawingPen}>
            {isEn ? 'Lift Pen' : '抬笔'}
          </button>
        ) : null}
      </div>

      {/* Ctrl+F 快速搜站浮层 */}
      {searchOpen && (
        <div className="metro-canvas-search" role="search" onMouseDown={(e) => e.stopPropagation()}>
          <div className="metro-canvas-search__head">
            <SearchOutlined style={{ color: '#64748b', fontSize: 13 }} />
            <input
              ref={searchInputRef}
              className="metro-canvas-search__input"
              placeholder={isEn ? 'Station or line name…' : '输入站名或线路名回车定位…'}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && searchResults[0]) {
                  centerOnStation(searchResults[0].id, true);
                  setSearchOpen(false);
                } else if (e.key === 'Escape') {
                  setSearchOpen(false);
                }
              }}
            />
            <button
              type="button"
              className="metro-wp-arc-bar__icon-btn"
              onClick={() => setSearchOpen(false)}
              aria-label="关闭搜索"
            >
              <CloseOutlined style={{ fontSize: 11 }} />
            </button>
          </div>
          <div className="metro-canvas-search__list">
            {searchResults.length === 0 ? (
              <div style={{ padding: '10px 8px', fontSize: 12, color: '#94a3b8', textAlign: 'center' }}>
                {isEn ? 'No matching stations' : '未找到匹配站点'}
              </div>
            ) : (
              searchResults.map((st) => {
                const passingNames = (stationToLines.get(st.id) || []).map((l) => l.name).join(' · ');
                return (
                  <button
                    key={st.id}
                    type="button"
                    className="metro-canvas-search__item"
                    onClick={() => {
                      centerOnStation(st.id, true);
                      setSearchOpen(false);
                    }}
                  >
                    <span>{st.name}</span>
                    <span className="metro-canvas-search__meta">{passingNames || '独立站点'}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* 多选批量操作条 */}
      {!readOnly && selectedStationIds.size > 1 && (
        <div className="metro-multiselect-bar" onMouseDown={(e) => e.stopPropagation()}>
          <span>
            {isEn
              ? `${selectedStationIds.size} stations selected · Drag any to move together`
              : `已选 ${selectedStationIds.size} 个站点 · 拖动任一站可整片平移`}
          </span>
          <button
            type="button"
            className="metro-multiselect-bar__btn metro-multiselect-bar__btn--danger"
            onClick={deleteSelectedItems}
          >
            {isEn ? 'Delete' : '删除选中'}
          </button>
          <button
            type="button"
            className="metro-multiselect-bar__btn"
            onClick={() => setSelectedStationIds(new Set())}
          >
            {isEn ? 'Clear' : '取消选择'}
          </button>
        </div>
      )}

      {/* 右下角画布 HUD（含缩放、适应视图、搜站与 ? 手势速查入口） */}
      {isCompact && mobileViewControlsHost ? (
        createPortal(
          <MobileViewControls
            language={language}
            isMapMode={isAmapMode}
            zoomLabel={
              isAmapMode
                ? (amapRef.current?.getZoom?.() || mapSettings.baseMap.amap?.zoom || 11).toFixed(1)
                : `${Math.round(scale * 100)}%`
            }
            onZoomOut={zoomOut}
            onZoomIn={zoomIn}
            onZoomPercent={setZoomPercent}
            onFitView={() => fitView()}
            onResetView={resetView}
          />,
          mobileViewControlsHost
        )
      ) : !isCompact ? (
        <div className="metro-canvas-hud">
          <Tooltip title={text.zoomOut}>
            <button type="button" className="metro-canvas-hud__btn" onClick={zoomOut} aria-label={text.zoomOut}>
              −
            </button>
          </Tooltip>
          {!isAmapMode ? (
            <Dropdown
              placement="top"
              trigger={['click']}
              menu={{
                items: [50, 75, 100, 125, 150, 200].map((percent) => ({
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
            <button type="button" className="metro-canvas-hud__btn" onClick={zoomIn} aria-label={text.zoomIn}>
              +
            </button>
          </Tooltip>
          <span className="metro-canvas-hud__divider" />
          <Tooltip title={text.fitView}>
            <button type="button" className="metro-canvas-hud__btn" onClick={() => fitView()} aria-label={text.fitView}>
              □
            </button>
          </Tooltip>
          <Tooltip title={text.resetView}>
            <button type="button" className="metro-canvas-hud__btn" onClick={resetView} aria-label={text.resetView}>
              ⌂
            </button>
          </Tooltip>
          <span className="metro-canvas-hud__divider" />
          <Tooltip title={text.search}>
            <button
              type="button"
              className="metro-canvas-hud__btn"
              onClick={() => setSearchOpen((v) => !v)}
              aria-label={text.search}
            >
              <SearchOutlined style={{ fontSize: 12 }} />
            </button>
          </Tooltip>
          {!readOnly && (
            <Tooltip title={text.guide}>
              <button
                type="button"
                className="metro-canvas-hud__btn"
                onClick={() => setOnboardingState({ open: true, view: 'cheatsheet' })}
                aria-label={text.guide}
              >
                <QuestionCircleOutlined style={{ fontSize: 13 }} />
              </button>
            </Tooltip>
          )}
        </div>
      ) : null}

      <Stage
        ref={stageRef}
        width={stageSize.width}
        height={stageSize.height}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onContextMenu={handleCanvasContextMenu}
        onWheel={handleWheel}
        style={{
          visibility: canvasSceneReady ? 'visible' : 'hidden',
          pointerEvents: canvasSceneReady ? 'auto' : 'none',
          cursor: activeCanvasCursor
        }}
      >
        <Layer listening={canvasSceneReady}>
          {canvasSceneReady && (
            <>
              <Rect
                x={-10000}
                y={-10000}
                width={20000}
                height={20000}
                fill={isAmapMode ? 'rgba(0,0,0,0)' : canvasBackgroundColor}
                listening={false}
              />

              {/* 线路区间（含平行角平分线偏移与单点圆弧） */}
              {renderLines(suppressShadows)}

              {/* 终端/环线胶囊名 */}
              {lineNamePlacements.map((label) => (
                <Group
                  key={`line_label_${label.key}`}
                  name="zoom-sized-element"
                  x={label.x}
                  y={label.y}
                  listening={false}
                >
                  <Rect
                    width={label.width}
                    height={label.height}
                    cornerRadius={label.height / 2}
                    fill={isMutedAmapStyle ? 'rgba(255,255,255,0.94)' : stylePreset.lineLabelFill}
                    stroke={label.line.color}
                    strokeWidth={isAmapMode ? Math.max(1.5, scaledLineLabelStrokeWidth) : scaledLineLabelStrokeWidth}
                    shadowColor={label.line.color}
                    shadowBlur={suppressShadows ? 0 : isAmapMode ? 8 : 4}
                    shadowOpacity={suppressShadows ? 0 : isAmapMode ? 0.22 : 0.16}
                    perfectDrawEnabled={false}
                  />
                  <Text
                    text={label.labelText}
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

              {/* 途经点控制柄（单击唤出圆弧拉杆，双击直接删除） */}
              {sections.map((section) => {
                const points = section.waypoints || [];
                const visiblePoints = points
                  .map((pt, idx) => ({ pt, idx }))
                  .filter(({ pt }) => !pt.hidden);
                if (!visiblePoints.length) return null;
                return visiblePoints.map(({ pt, idx }) => {
                  const waypointPoint = getWaypointDisplayPoint(pt);
                  const isSelectedWp =
                    selectedWaypoint?.sectionId === section.id && selectedWaypoint?.waypointIndex === idx;
                  return (
                    <Circle
                      key={`wp_${section.id}_${idx}`}
                      x={waypointPoint.x}
                      y={waypointPoint.y}
                      radius={isSelectedWp ? scaledWaypointRadius * 1.25 : scaledWaypointRadius}
                      fill={isSelectedWp ? '#eff6ff' : canvasPalette.waypointFill}
                      stroke={pt.mode === 'arc' ? '#f59e0b' : canvasPalette.waypointStroke}
                      strokeWidth={isSelectedWp ? scaledWaypointStrokeWidth * 1.35 : scaledWaypointStrokeWidth}
                      shadowColor={canvasPalette.waypointShadow}
                      shadowBlur={suppressShadows ? 0 : 5}
                      perfectDrawEnabled={false}
                      name="touch-edit-node"
                      sectionId={section.id}
                      waypointIndex={idx}
                      draggable={!readOnly && activeTool === 'select' && !isSpaceHeld}
                      dragDistance={isCompact ? 8 : 3}
                      onClick={(e) => {
                        if (readOnly) return;
                        e.cancelBubble = true;
                        commitInlineRenameIfNeeded();
                        setSelectedWaypoint({ sectionId: section.id, waypointIndex: idx });
                        setSelectedSectionId(section.id);
                      }}
                      onTap={(e) => {
                        if (readOnly) return;
                        e.cancelBubble = true;
                        setSelectedWaypoint({ sectionId: section.id, waypointIndex: idx });
                      }}
                      onDblClick={(e) => {
                        if (readOnly) return;
                        e.cancelBubble = true;
                        deleteWaypoint(section.id, idx);
                      }}
                      onDragStart={() => {
                        onBeginInteraction?.();
                        dragWaypointDraftRef.current = null;
                        setSelectedWaypoint({ sectionId: section.id, waypointIndex: idx });
                        setIsDraggingNode(true);
                      }}
                      onDragMove={(e) => {
                        updateWaypointImperativeOrState(
                          section.id,
                          idx,
                          e.target.x(),
                          e.target.y(),
                          Boolean(e.evt?.altKey),
                          e.target
                        );
                      }}
                      onDragEnd={commitWaypointDrag}
                      onContextMenu={(e) => {
                        if (readOnly) return;
                        e.evt.preventDefault();
                        e.cancelBubble = true;
                        const stage = e.target.getStage();
                        const pointer = stage?.getPointerPosition?.();
                        if (!pointer) return;
                        closeAllFloatingMenus();
                        setSectionContextMenu({
                          visible: true,
                          x: pointer.x,
                          y: pointer.y,
                          sectionKey: section.id,
                          waypointIndex: idx,
                          waypointOnly: true
                        });
                      }}
                    />
                  );
                });
              })}

              {/* 选中途经点的圆弧半径拖拽拉杆（Arc Radius Handle） */}
              {!readOnly && activeWaypointArcGeometry && (
                <>
                  <Line
                    points={[
                      activeWaypointArcGeometry.prevPt.x,
                      activeWaypointArcGeometry.prevPt.y,
                      activeWaypointArcGeometry.currPt.x,
                      activeWaypointArcGeometry.currPt.y,
                      activeWaypointArcGeometry.nextPt.x,
                      activeWaypointArcGeometry.nextPt.y
                    ]}
                    stroke="#94a3b8"
                    strokeWidth={1.2 / Math.max(0.35, viewportScaleForHit)}
                    dash={[4, 4]}
                    listening={false}
                    perfectDrawEnabled={false}
                  />
                  {activeWaypointArcGeometry.handleInfo && (
                    <>
                      <Line
                        points={[
                          activeWaypointArcGeometry.currPt.x,
                          activeWaypointArcGeometry.currPt.y,
                          activeWaypointArcGeometry.handleInfo.handleX,
                          activeWaypointArcGeometry.handleInfo.handleY
                        ]}
                        stroke="#f59e0b"
                        strokeWidth={1.6 / Math.max(0.35, viewportScaleForHit)}
                        dash={[3, 3]}
                        listening={false}
                        perfectDrawEnabled={false}
                      />
                      <Circle
                        x={activeWaypointArcGeometry.handleInfo.handleX}
                        y={activeWaypointArcGeometry.handleInfo.handleY}
                        radius={Math.max(5.5, 7 / Math.max(0.45, viewportScaleForHit))}
                        fill="#f59e0b"
                        stroke="#ffffff"
                        strokeWidth={2 / Math.max(0.45, viewportScaleForHit)}
                        draggable
                        onDragStart={(e) => {
                          e.cancelBubble = true;
                          onBeginInteraction?.();
                          setIsDraggingNode(true);
                        }}
                        onDragMove={(e) => {
                          e.cancelBubble = true;
                          const stage = e.target.getStage();
                          const pointer = stage?.getPointerPosition?.();
                          if (!stage || !pointer) return;
                          const worldPointer = getPointerWorldPosition(stage, pointer);
                          const nextR = radiusFromCornerHandleDrag(
                            activeWaypointArcGeometry.prevPt,
                            activeWaypointArcGeometry.currPt,
                            activeWaypointArcGeometry.nextPt,
                            worldPointer
                          );
                          // 锁定手柄自身到角平分线位置，避免自由飞离
                          const updatedInfo = computeCornerHandleInfo(
                            activeWaypointArcGeometry.prevPt,
                            activeWaypointArcGeometry.currPt,
                            activeWaypointArcGeometry.nextPt,
                            nextR,
                            isAmapMode ? 22 : 22 / Math.max(0.3, scale)
                          );
                          if (updatedInfo) {
                            e.target.position({ x: updatedInfo.handleX, y: updatedInfo.handleY });
                          }
                          const curWps = getSectionWaypoints(activeWaypointArcGeometry.section.id);
                          const nextWps = curWps.map((item, i) =>
                            i === activeWaypointArcGeometry.waypointIndex
                              ? { ...item, mode: 'corner' as const, radius: nextR }
                              : item
                          );
                          dragWaypointDraftRef.current = {
                            sectionId: activeWaypointArcGeometry.section.id,
                            waypoints: nextWps
                          };
                          updateSectionKonvaLineImperative(
                            activeWaypointArcGeometry.section,
                            undefined,
                            nextWps
                          );
                          stage.batchDraw?.();
                        }}
                        onDragEnd={(e) => {
                          e.cancelBubble = true;
                          commitWaypointDrag();
                        }}
                      />
                    </>
                  )}
                </>
              )}

              {/* 站点与换乘符号（统一专业线网 dot-label 模式） */}
              {stations.map((station) => {
                const stationColor = getStationColor(station.id);
                const labelRect = labelPlacements[station.id];
                const isInterchangeStation = (stationLineCounts[station.id] || 0) > 1;
                const stationPoint = getDisplayPoint(station);
                const isSelected = selectedStationIds.has(station.id);
                const isDrawAnchor = drawAnchorStationId === station.id && activeTool === 'draw';
                const isMergeTarget = mergeTargetStationId === station.id;
                const isHighlighted = highlightedStationId === station.id;
                const baseR = isInterchangeStation ? scaledInterchangeRadius : scaledNormalStationRadius;

                return (
                  <Group
                    key={station.id}
                    id={station.id}
                    name="touch-edit-node touch-station zoom-sized-element"
                    dragDistance={isCompact ? 8 : 3}
                    x={stationPoint.x}
                    y={stationPoint.y}
                    draggable={!readOnly && activeTool === 'select' && !isSpaceHeld}
                    onDragStart={() => beginStationDrag(station.id)}
                    onDragMove={(e) =>
                      handleStationDragMove(
                        station.id,
                        { x: e.target.x(), y: e.target.y() },
                        e.target,
                        Boolean(e.evt?.altKey)
                      )
                    }
                    onDragEnd={commitStationDrag}
                    onTap={(e) => handleStationTap(station, e)}
                    onClick={(e) => {
                      if (isCompact) {
                        touchTapAllowedRef.current = true;
                        handleStationTap(station, e);
                      } else {
                        handleStationClick(station, e);
                      }
                    }}
                    onDblClick={(e) => handleStationDoubleClick(station, e)}
                    onContextMenu={(e) => handleStationRightClick(e, station)}
                  >
                    {isCompact ? (
                      <Circle
                        radius={Math.max(scaledNormalStationRadius, 22 / (isAmapMode ? 1 : scale))}
                        fill="rgba(0,0,0,0.001)"
                      />
                    ) : null}

                    {/* 起笔锚点光环 / 选中光环 / 换乘合并磁吸光环 / 搜站定位高亮环 */}
                    {(isDrawAnchor || isSelected || isMergeTarget || isHighlighted) && (
                      <Circle
                        radius={baseR + (isMergeTarget || isHighlighted ? 7 : 5) * dotScale}
                        fill={
                          isMergeTarget
                            ? 'rgba(16, 185, 129, 0.18)'
                            : isHighlighted
                              ? 'rgba(245, 158, 11, 0.2)'
                              : 'transparent'
                        }
                        stroke={
                          isMergeTarget
                            ? '#10b981'
                            : isHighlighted
                              ? '#f59e0b'
                              : isDrawAnchor
                                ? currentLine?.color || '#2563eb'
                                : '#3b82f6'
                        }
                        strokeWidth={2 * dotScale}
                        dash={isDrawAnchor ? [4, 3] : undefined}
                        listening={false}
                        perfectDrawEnabled={false}
                      />
                    )}

                    {isInterchangeStation ? (
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
                              ? linesHere[0]?.color || stationColor
                              : 'transparent';

                        if (plan.shape === 'curvedArrows') {
                          const innerR = scaledInterchangeRadius * 0.42;
                          const outerR = scaledInterchangeRadius * 0.72;
                          return (
                            <>
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
                    ) : stylePreset.stationShape === 'ring' ? (
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
                          shadowColor={
                            isLargeGraph ? undefined : isAmapMode ? readableLabelShadow : canvasPalette.labelShadow
                          }
                          shadowBlur={suppressShadows ? 0 : isAmapMode ? 5 : isDarkCanvas ? 5 : 2}
                          shadowOpacity={suppressShadows ? 0 : 1}
                          perfectDrawEnabled={false}
                        />
                      </Group>
                    ) : null}
                  </Group>
                );
              })}
            </>
          )}
        </Layer>

        {/* 顶层轻量交互辅助层：校准虚线、连笔橡皮筋预览、待提交拐点、幽灵落点与框选框 */}
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
                  strokeWidth={1 / Math.max(0.4, viewportScaleForHit)}
                  dash={[6, 6]}
                  opacity={0.9}
                  listening={false}
                  perfectDrawEnabled={false}
                />
              ))}

              {activeTool === 'draw' && (
                <>
                  <Line
                    id="metro-drawing-preview"
                    points={drawingPointsRef.current}
                    visible={Boolean(drawAnchorStationId && drawingPointsRef.current.length >= 4)}
                    stroke={currentLine?.color || canvasPalette.drawingLine}
                    strokeWidth={Math.max(2.5, scaledLineWidth * 0.8)}
                    lineCap="round"
                    lineJoin="round"
                    dash={[6, 5]}
                    opacity={0.85}
                    listening={false}
                    perfectDrawEnabled={false}
                  />
                  {drawPendingWaypoints.map((wp, idx) => {
                    const p = getWaypointDisplayPoint(wp);
                    return (
                      <Circle
                        key={`pending_wp_${idx}`}
                        x={p.x}
                        y={p.y}
                        radius={scaledWaypointRadius * 0.9}
                        fill="#ffffff"
                        stroke={currentLine?.color || '#2563eb'}
                        strokeWidth={2}
                        listening={false}
                        perfectDrawEnabled={false}
                      />
                    );
                  })}
                  <Circle
                    id="metro-drawing-ghost-dot"
                    x={0}
                    y={0}
                    visible={false}
                    radius={drawWaypointSubmode ? scaledWaypointRadius : scaledNormalStationRadius}
                    fill={drawWaypointSubmode ? '#ffffff' : currentLine?.color || LINE_COLORS[0]}
                    stroke={drawWaypointSubmode ? currentLine?.color || '#2563eb' : '#ffffff'}
                    strokeWidth={2}
                    opacity={0.55}
                    listening={false}
                    perfectDrawEnabled={false}
                  />
                </>
              )}

              {marqueeWorldRect && (
                <Rect
                  x={Math.min(marqueeWorldRect.x1, marqueeWorldRect.x2)}
                  y={Math.min(marqueeWorldRect.y1, marqueeWorldRect.y2)}
                  width={Math.abs(marqueeWorldRect.x2 - marqueeWorldRect.x1)}
                  height={Math.abs(marqueeWorldRect.y2 - marqueeWorldRect.y1)}
                  fill="rgba(37, 99, 235, 0.09)"
                  stroke="#3b82f6"
                  strokeWidth={1.2 / Math.max(0.35, viewportScaleForHit)}
                  dash={[5, 4]}
                  listening={false}
                  perfectDrawEnabled={false}
                />
              )}
            </>
          )}
        </Layer>
      </Stage>

      {/* 非阻塞行内站点命名浮层 */}
      {!readOnly && inlineRename && (() => {
        const st = stationById.get(inlineRename.stationId);
        if (!st) return null;
        const screen = worldToScreenPoint(getDisplayPoint(st));
        const left = Math.max(96, Math.min(screen.x, stageSize.width - 96));
        const top = Math.max(58, Math.min(screen.y - 18, stageSize.height - 24));
        return (
          <div
            className="metro-inline-rename"
            style={{ left, top }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              ref={inlineRenameInputRef}
              className="metro-inline-rename__input"
              value={inlineRename.value}
              maxLength={32}
              placeholder="输入站名…"
              onChange={(e) =>
                setInlineRename((prev) => (prev ? { ...prev, value: e.target.value } : null))
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitInlineRenameIfNeeded();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setInlineRename(null);
                }
              }}
            />
            <button
              type="button"
              className="metro-inline-rename__btn"
              onClick={handleTranslateInlineRename}
              disabled={translatingInline}
              title="AI 翻译为英文站名"
            >
              <TranslationOutlined />
            </button>
            <button
              type="button"
              className="metro-inline-rename__btn metro-inline-rename__btn--ok"
              onClick={commitInlineRenameIfNeeded}
              aria-label="确认站名"
            >
              <CheckOutlined />
            </button>
          </div>
        );
      })()}

      {/* 途经点就地圆弧控制器（不用去全局设置调） */}
      {!readOnly && activeWaypointArcGeometry && (() => {
        const screen = worldToScreenPoint(activeWaypointArcGeometry.currPt);
        const left = Math.max(14, Math.min(screen.x + 18, stageSize.width - 266));
        const top = Math.max(58, Math.min(screen.y - 26, stageSize.height - 148));
        const wp = activeWaypointArcGeometry.waypoint;
        const secId = activeWaypointArcGeometry.section.id;
        const wpIdx = activeWaypointArcGeometry.waypointIndex;
        const isArcMode = wp.mode === 'arc';
        const curRadius = Math.round(activeWaypointArcGeometry.effectiveRadius);
        const maxSliderR = Math.max(120, Math.min(600, Math.round(activeWaypointArcGeometry.handleInfo?.maxRadius || 180)));

        const applyWpPatch = (patch: Partial<Waypoint>, record = true) => {
          if (record) onBeginInteraction?.();
          const cur = getSectionWaypoints(secId);
          writeSectionWaypoints(
            secId,
            cur.map((item, i) => (i === wpIdx ? { ...item, ...patch } : item))
          );
        };

        return (
          <div
            className="metro-wp-arc-bar"
            style={{ left, top }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="metro-wp-arc-bar__top">
              <div className="metro-wp-arc-bar__modes">
                <button
                  type="button"
                  className={`metro-wp-arc-bar__mode${!isArcMode ? ' is-active' : ''}`}
                  onClick={() => applyWpPatch({ mode: 'corner', radius: curRadius || 28 })}
                >
                  {isEn ? 'Fillet Arc' : '相切圆弧'}
                </button>
                <button
                  type="button"
                  className={`metro-wp-arc-bar__mode${isArcMode ? ' is-active' : ''}`}
                  onClick={() => applyWpPatch({ mode: 'arc' })}
                >
                  {isEn ? '3-Pt Arc' : '过点正圆弧'}
                </button>
              </div>
              <div className="metro-wp-arc-bar__actions">
                <button
                  type="button"
                  className="metro-wp-arc-bar__icon-btn"
                  title="隐藏该途经点圆点手柄"
                  onClick={() => {
                    applyWpPatch({ hidden: true });
                    setSelectedWaypoint(null);
                  }}
                >
                  <EyeInvisibleOutlined />
                </button>
                <button
                  type="button"
                  className="metro-wp-arc-bar__icon-btn is-danger"
                  title="删除该途经点 (双击)"
                  onClick={() => deleteWaypoint(secId, wpIdx)}
                >
                  <DeleteOutlined />
                </button>
                <button
                  type="button"
                  className="metro-wp-arc-bar__icon-btn"
                  title="关闭"
                  onClick={() => setSelectedWaypoint(null)}
                >
                  <CloseOutlined style={{ fontSize: 11 }} />
                </button>
              </div>
            </div>

            {!isArcMode ? (
              <>
                <div className="metro-wp-arc-bar__presets">
                  {[
                    { label: isEn ? 'Sharp' : '折角 0', r: 0 },
                    { label: isEn ? 'S 20' : '小弧 20', r: 20 },
                    { label: isEn ? 'M 48' : '中弧 48', r: 48 },
                    { label: isEn ? 'L 96' : '大弧 96', r: 96 }
                  ].map((preset) => (
                    <button
                      key={preset.r}
                      type="button"
                      className={`metro-wp-arc-bar__chip${Math.abs(curRadius - preset.r) <= 2 ? ' is-active' : ''}`}
                      onClick={() => applyWpPatch({ mode: 'corner', radius: preset.r })}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <div className="metro-wp-arc-bar__slider-row">
                  <span>{isEn ? 'Radius' : '圆弧半径'}</span>
                  <input
                    type="range"
                    className="metro-wp-arc-bar__slider"
                    min={0}
                    max={maxSliderR}
                    value={Math.min(maxSliderR, curRadius)}
                    onMouseDown={() => onBeginInteraction?.()}
                    onChange={(e) => applyWpPatch({ mode: 'corner', radius: Number(e.target.value) }, false)}
                  />
                  <span className="metro-wp-arc-bar__val">R {curRadius}</span>
                </div>
              </>
            ) : (
              <div className="metro-wp-arc-bar__hint">
                {isEn
                  ? 'Pure circular arc passing through prev → this point → next. Drag point 360° to sculpt.'
                  : '已生成穿过该点的标准正圆弧，直接 360° 拖动圆点即可调整弧度曲率。'}
              </div>
            )}
          </div>
        );
      })()}

      {/* 画布颜色弹窗与隐藏底图上传 */}
      <DraggableModal
        title="更改画布颜色"
        open={canvasColorModal.visible}
        onOk={handleConfirmCanvasColor}
        onCancel={() =>
          setCanvasColorModal((prev) => ({
            ...prev,
            visible: false,
            currentColor: canvasBackgroundColor,
            showPicker: false
          }))
        }
        okText="确认"
        cancelText="取消"
      >
        <div style={{ marginBottom: 16 }}>选择画布底色：</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {LINE_COLORS.map((color) => (
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
              onClick={() => setCanvasColorModal((prev) => ({ ...prev, currentColor: color }))}
            >
              {color === canvasColorModal.currentColor && (
                <span style={{ color: '#fff', fontSize: 15, fontWeight: 'bold' }}>✓</span>
              )}
            </div>
          ))}
        </div>
        <div style={{ marginTop: 16 }}>
          <Button
            type="dashed"
            block
            onClick={() => setCanvasColorModal((prev) => ({ ...prev, showPicker: true }))}
          >
            自定义颜色
          </Button>
        </div>
        {canvasColorModal.showPicker && (
          <div style={{ marginTop: 16, textAlign: 'center' }}>
            <ColorPicker
              value={canvasColorModal.currentColor || getDefaultCanvasBackground(mapSettings.canvasTheme)}
              onChange={(color) => setCanvasColorModal((prev) => ({ ...prev, currentColor: color.toHexString() }))}
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

      {/* 站点详情与附加标注弹窗（保持对公开只读预览与测试的完整兼容） */}
      <DraggableModal
        title="站点信息"
        open={stationInfoModal.visible}
        onCancel={() => setStationInfoModal({ visible: false, station: null, note: '' })}
        footer={null}
      >
        {stationInfoModal.station && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <strong>名称：</strong>
              {stationInfoModal.station.name}
            </div>
            <div>
              <strong>经过线路：</strong>
              {lines
                .filter((line) => line.stationIds.includes(stationInfoModal.station!.id))
                .map((line) => line.name)
                .join('、') || '无'}
            </div>
            <div>
              <strong>是否换乘站：</strong>
              {lines.filter((line) => line.stationIds.includes(stationInfoModal.station!.id)).length > 1
                ? '是'
                : '否'}
            </div>
            <div>
              <div style={{ marginBottom: 6 }}>
                <strong>附加标注：</strong>
              </div>
              {readOnly ? (
                <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>
                  {stationInfoModal.note || '暂无公开标注'}
                </p>
              ) : (
                <Input.TextArea
                  value={stationInfoModal.note}
                  onChange={(e) => setStationInfoModal((prev) => ({ ...prev, note: e.target.value }))}
                  placeholder="如：机场、高铁站、交通枢纽等"
                  rows={3}
                />
              )}
            </div>
            {!readOnly && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <Button type="primary" onClick={handleSaveStationNote}>
                  保存标注
                </Button>
              </div>
            )}
          </div>
        )}
      </DraggableModal>

      {isCompact && (stationContextMenu.visible || sectionContextMenu.visible || canvasContextMenu.visible) ? (
        <button
          type="button"
          className="metro-context-backdrop"
          aria-label="关闭编辑菜单"
          onClick={closeAllFloatingMenus}
        />
      ) : null}

      {/* 画布右键菜单 */}
      {canvasContextMenu.visible &&
        (() => {
          const menuLeft = Math.max(12, Math.min(canvasContextMenu.x, stageSize.width - 208));
          const menuTop = Math.max(12, Math.min(canvasContextMenu.y, stageSize.height - 220));
          return (
            <div
              className="canvas-context-menu metro-floating-menu"
              role="menu"
              aria-label="画布操作"
              onMouseDown={(e) => e.stopPropagation()}
              style={{ top: menuTop, left: menuLeft, zIndex: 1002 }}
            >
              <div className="metro-floating-menu__header">画布与引导</div>
              <button
                type="button"
                className="metro-floating-menu__item"
                onClick={() => {
                  closeAllFloatingMenus();
                  setOnboardingState({ open: true, view: 'cheatsheet' });
                }}
              >
                <QuestionCircleOutlined />
                <span>手势与快捷键指南</span>
              </button>
              <div className="metro-floating-menu__divider" />
              <button
                type="button"
                className="metro-floating-menu__item"
                onClick={() => {
                  closeAllFloatingMenus();
                  setCanvasColorModal({
                    visible: true,
                    currentColor: canvasBackgroundColor,
                    showPicker: false
                  });
                }}
              >
                <BgColorsOutlined />
                <span>更改画布颜色</span>
              </button>
              <button
                type="button"
                className="metro-floating-menu__item"
                onClick={() => {
                  closeAllFloatingMenus();
                  imageInputRef.current?.click();
                }}
              >
                <PictureOutlined />
                <span>导入参考底图</span>
              </button>
              <button
                type="button"
                className="metro-floating-menu__item"
                disabled={!canvasBackgroundImage}
                onClick={() => {
                  if (canvasBackgroundImage) URL.revokeObjectURL(canvasBackgroundImage);
                  setCanvasBackgroundImage(null);
                  closeAllFloatingMenus();
                  message.success?.('参考底图已清除');
                }}
              >
                <DeleteOutlined />
                <span>清除参考底图</span>
              </button>
              <div className="metro-floating-menu__divider" />
              <button
                type="button"
                className="metro-floating-menu__item"
                onClick={() => {
                  setCanvasBackgroundColor(getDefaultCanvasBackground(mapSettings.canvasTheme));
                  closeAllFloatingMenus();
                }}
              >
                <ReloadOutlined />
                <span>恢复默认画布色</span>
              </button>
            </div>
          );
        })()}

      {/* 区间与途经点右键菜单 */}
      {sectionContextMenu.visible && sectionContextMenu.sectionKey
        ? (() => {
            const sectionKey = sectionContextMenu.sectionKey!;
            const pointIndex = sectionContextMenu.waypointIndex;
            const sectionWaypoints = getSectionWaypoints(sectionKey);
            const currentPoint = pointIndex === null ? null : sectionWaypoints[pointIndex];
            const menuLeft = Math.max(12, Math.min(sectionContextMenu.x, stageSize.width - 236));
            const menuTop = Math.max(12, Math.min(sectionContextMenu.y, stageSize.height - 260));

            return (
              <div
                className="section-context-menu metro-floating-menu"
                role="region"
                aria-label="区间操作"
                onMouseDown={(e) => e.stopPropagation()}
                style={{ top: menuTop, left: menuLeft, zIndex: 1000, minWidth: 214 }}
              >
                {sectionContextMenu.waypointOnly && currentPoint && pointIndex !== null ? (
                  <>
                    <div className="metro-floating-menu__header">途经点 #{pointIndex + 1}</div>
                    <button
                      type="button"
                      className="metro-floating-menu__item"
                      onClick={() => {
                        setSelectedWaypoint({ sectionId: sectionKey, waypointIndex: pointIndex });
                        closeAllFloatingMenus();
                      }}
                    >
                      <EditOutlined />
                      <span>调整圆弧半径 / 过点圆弧</span>
                    </button>
                    <button
                      type="button"
                      className="metro-floating-menu__item"
                      onClick={() => {
                        onBeginInteraction?.();
                        writeSectionWaypoints(
                          sectionKey,
                          sectionWaypoints.map((pt, idx) => (idx === pointIndex ? { ...pt, hidden: true } : pt))
                        );
                        closeAllFloatingMenus();
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
                        deleteWaypoint(sectionKey, pointIndex);
                        closeAllFloatingMenus();
                      }}
                    >
                      <DeleteOutlined />
                      <span>删除途经点</span>
                    </button>
                  </>
                ) : (
                  <>
                    <div className="metro-floating-menu__header">区间操作</div>
                    <button
                      type="button"
                      className="metro-floating-menu__item"
                      onClick={() => {
                        const sec = sectionById.get(sectionKey);
                        const stage = stageRef.current;
                        if (sec && stage) {
                          const worldPos = getPointerWorldPosition(stage, {
                            x: sectionContextMenu.x,
                            y: sectionContextMenu.y
                          });
                          closeAllFloatingMenus();
                          insertStationIntoSectionAt(
                            sec,
                            worldPos,
                            { x: sectionContextMenu.x, y: sectionContextMenu.y },
                            false
                          );
                        }
                      }}
                    >
                      <PlusCircleOutlined />
                      <span>在此处插入中间站</span>
                    </button>
                    {sectionWaypoints.length > 0 ? (
                      <div className="metro-floating-menu__wp-list">
                        {sectionWaypoints.map((pt, idx) => (
                          <div key={idx} className="metro-floating-menu__wp-row">
                            <span className="metro-floating-menu__wp-label">拐点 {idx + 1}</span>
                            <button
                              type="button"
                              className="metro-floating-menu__mini-btn"
                              onClick={() => {
                                onBeginInteraction?.();
                                writeSectionWaypoints(
                                  sectionKey,
                                  sectionWaypoints.map((item, i) =>
                                    i === idx ? { ...item, hidden: !item.hidden } : item
                                  )
                                );
                                closeAllFloatingMenus();
                              }}
                            >
                              {pt.hidden ? (
                                <>
                                  <EyeOutlined /> 显示
                                </>
                              ) : (
                                <>
                                  <EyeInvisibleOutlined /> 隐藏
                                </>
                              )}
                            </button>
                            <button
                              type="button"
                              className="metro-floating-menu__mini-btn is-danger"
                              onClick={() => {
                                deleteWaypoint(sectionKey, idx);
                                closeAllFloatingMenus();
                              }}
                            >
                              删除
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="metro-floating-menu__empty">按住线段直接拖动即可生出 360° 途经点</div>
                    )}
                    <div className="metro-floating-menu__divider" />
                    <button
                      type="button"
                      className="metro-floating-menu__item is-danger"
                      onClick={() => {
                        onDeleteSection(sectionKey);
                        closeAllFloatingMenus();
                      }}
                    >
                      <DeleteOutlined />
                      <span>删除当前区间</span>
                    </button>
                  </>
                )}
              </div>
            );
          })()
        : null}

      {/* 站点右键菜单（一键从该站起笔延伸/拉支线 + 站名八向方位固定 + 备注/重命名/删除） */}
      {stationContextMenu.visible &&
        stationContextMenu.station &&
        (() => {
          const st = stationContextMenu.station!;
          const menuLeft = Math.max(12, Math.min(stationContextMenu.x, stageSize.width - 248));
          const menuTop = Math.max(12, Math.min(stationContextMenu.y, stageSize.height - 320));
          const curLabelPos: StationLabelPosition = st.labelPosition || 'auto';

          return (
            <div
              className="station-context-menu metro-floating-menu"
              role="region"
              aria-label="站点操作"
              onMouseDown={(e) => e.stopPropagation()}
              style={{ top: menuTop, left: menuLeft, zIndex: 1000, width: 232 }}
            >
              <div className="metro-floating-menu__header">
                <span className="metro-floating-menu__dot" style={{ backgroundColor: getStationColor(st.id) }} />
                <span className="metro-floating-menu__title">{st.name}</span>
              </div>

              <button
                type="button"
                className="metro-floating-menu__item"
                onClick={() => {
                  closeAllFloatingMenus();
                  if (!currentLineId) {
                    const owning = lines.find((l) => l.stationIds.includes(st.id)) || lines[0];
                    if (owning) onSelectLine?.(owning.id);
                  }
                  setActiveTool('draw');
                  setDrawAnchorStationId(st.id);
                  setDrawPendingWaypoints([]);
                }}
              >
                <NodeIndexOutlined />
                <span>从此处起笔延伸 / 拉支线</span>
              </button>

              <button
                type="button"
                className="metro-floating-menu__item"
                onClick={() => {
                  closeAllFloatingMenus();
                  setInlineRename({ stationId: st.id, value: st.name, originalName: st.name });
                }}
              >
                <EditOutlined />
                <span>修改站名</span>
              </button>

              <button
                type="button"
                className="metro-floating-menu__item"
                onClick={() => {
                  closeAllFloatingMenus();
                  setStationInfoModal({ visible: true, station: st, note: st.note || '' });
                }}
              >
                <PlusCircleOutlined />
                <span>站点详情与备注</span>
              </button>

              <div className="metro-floating-menu__divider" />
              <div style={{ padding: '4px 10px 2px', fontSize: 11, fontWeight: 600, opacity: 0.65 }}>站名方位</div>
              <div className="metro-label-pos-row">
                {LABEL_POSITION_OPTIONS.map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    className={`metro-label-pos-chip${curLabelPos === opt.key ? ' is-active' : ''}`}
                    onClick={() => {
                      onBeginInteraction?.();
                      onUpdateStation({ ...st, labelPosition: opt.key });
                      setStationContextMenu((prev) =>
                        prev.station ? { ...prev, station: { ...prev.station, labelPosition: opt.key } } : prev
                      );
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>

              <div className="metro-floating-menu__divider" />
              <button
                type="button"
                className="metro-floating-menu__item is-danger"
                onClick={() => {
                  onDeleteStation(st.id);
                  closeAllFloatingMenus();
                }}
              >
                <DeleteOutlined />
                <span>删除站点</span>
              </button>
            </div>
          );
        })()}

      <CanvasOnboardingModal
        open={onboardingState.open}
        initialView={onboardingState.view}
        isCompact={isCompact}
        language={language}
        onClose={() => {
          markCanvasOnboardingSeen();
          setOnboardingState((prev) => ({ ...prev, open: false }));
        }}
      />
    </div>
  );
};

export default Canvas;
