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
import { Stage, Layer, Circle, Text, Group, Line, Rect, Arc, Path, Shape } from 'react-konva';
import { Input, Button, message, ColorPicker, Dropdown, Tooltip, Spin } from 'antd';
import {
  ArrowDownOutlined,
  ArrowLeftOutlined,
  ArrowRightOutlined,
  ArrowUpOutlined,
  BgColorsOutlined,
  CheckOutlined,
  CloseOutlined,
  CompassOutlined,
  DeleteOutlined,
  DisconnectOutlined,
  DownOutlined,
  DragOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  EyeOutlined,
  NodeIndexOutlined,
  PictureOutlined,
  PlusCircleOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
  ReloadOutlined,
  SearchOutlined,
  SelectOutlined,
  SwapOutlined,
  TranslationOutlined
} from '@ant-design/icons';
import { api } from '../api';
import {
  LightCityFeature,
  LightCityLabelKind,
  LightCityPoint,
  LightCityRoadKind,
  LightCitySettings,
  LightCityZoneKind,
  MapSettings,
  Station,
  StationLabelPosition,
  Line as LineType,
  Section,
  Waypoint,
  LINE_COLORS,
  normalizeMapSettings
} from '../types';
import {
  drawLightCityToCanvas2D,
  generateLightCity,
  getLightCityPalette,
  resolveLightCityPolygonIterations,
  resolveLightCityRoadMetrics,
  resolveLightCitySplineSegments,
  sampleRoundedRoadPolyline,
  sampleSmoothClosedPolygon,
  sampleSmoothOpenSpline,
  shouldFeatherLightCityEdges,
  snapTerrainDrawPoint,
  TerrainSnapResult
} from '../lib/lightCity';
import { LightCitySculptBar, TerrainTool } from './LightCityPanel';
import { getCityStylePreset } from '../stylePresets';
import { resolveLineBadgeColors, resolveReadableStationLabelColor } from '../lib/canvasTheme';
import { planInterchange, buildCurvedArrowPath } from '../lib/interchange';
import {
  computeCornerHandleInfo,
  radiusFromCornerHandleDrag,
  RPoint
} from '../lib/roundedPath';
import {
  buildSectionRenderGeometry,
  computeNetworkParallelLayout,
  findWaypointInsertIndex,
  moveLineInParallelOrder,
  SectionParallelMeta
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
import ElasticCapsuleTabs from './ElasticCapsuleTabs';
import CanvasStartPrompt from './CanvasStartPrompt';
import CanvasOnboardingModal, {
  hasSeenCanvasOnboarding,
  markCanvasOnboardingSeen
} from './CanvasOnboardingModal';
import { TouchViewportGesture, TouchPoint } from '../lib/touchViewport';
import { useElasticToolbar } from '../lib/useElasticToolbar';
import MobileViewControls from './MobileViewControls';
import { useVisualViewport } from '../hooks/useVisualViewport';
import {
  computeTouchAimScreenPoint,
  shouldActivateTouchAim,
  triggerLightHaptic
} from '../lib/mobileTouchAim';

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
const DRAW_STATION_SNAP_SCREEN_PX = 16;
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
  center: [116.391276, 39.907335] as [number, number],
  zoom: 11,
  style: 'normal' as const,
  coordSystem: 'wgs84' as const
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

export interface CanvasOverlayRenderContext {
  scale: number;
  isAmapMode: boolean;
  isDarkCanvas: boolean;
  getStationDisplayPoint: (station: Station) => { x: number; y: number };
  getWaypointDisplayPoint: (wp: Waypoint) => { x: number; y: number };
}

interface CanvasProps {
  readOnly?: boolean;
  onReadOnlyStationClick?: (station: Station) => void;
  onReadOnlySectionClick?: (section: Section) => void;
  renderStageOverlay?: (ctx: CanvasOverlayRenderContext) => React.ReactNode;
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
  onStartWithLightCity?: () => void;
  onStartWithAmap?: () => void;
  externalOpenTerrainSculptSeq?: number;
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
  onReadOnlyStationClick,
  onReadOnlySectionClick,
  renderStageOverlay,
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
  onRemoveStationFromLine,
  onMapSettingsChange,
  onStageReady,
  onBeginInteraction,
  onCreateLine,
  onStartWithLightCity,
  onStartWithAmap,
  externalOpenTerrainSculptSeq,
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
        touchHints: {
          select: 'Tap station to edit · Drag track for bend · 2 fingers to navigate',
          drawIdle: 'Tap blank to place station · Tap station to extend',
          drawActive: (name: string) => `From ${name}: tap blank to add station`,
          pan: '1 finger pan · 2 fingers zoom · Long-press station to edit'
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
        touchHints: {
          select: '点站点编辑 · 拖线段拉拐点 · 双指缩放平移',
          drawIdle: '点空白建站起笔 · 点已有站延伸或拉支线',
          drawActive: (name: string) => `从「${name}」连笔：点空白落站 · 点已有站连入`,
          pan: '单指平移 · 双指缩放 · 长按站点唤出菜单'
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

  // 默认工具：只读与移动端为 pan，桌面端统一为 select（由用户手动建线/选线后再进入绘制）
  const [activeTool, setActiveTool] = useState<CanvasTool>(() => {
    if (readOnly) return 'pan';
    if (
      typeof window !== 'undefined' &&
      window.matchMedia?.('(max-width: 768px), (max-width: 1024px) and (max-height: 500px)').matches
    ) {
      return 'pan';
    }
    return 'select';
  });

  // 连续绘制钢笔状态机
  const [drawAnchorStationId, setDrawAnchorStationId] = useState<string | null>(null);
  const [drawPendingWaypoints, setDrawPendingWaypoints] = useState<Waypoint[]>([]);
  const [drawWaypointSubmode, setDrawWaypointSubmode] = useState(false);
  const [drawSnapStationId, setDrawSnapStationId] = useState<string | null>(null);
  const drawSnapStationIdRef = useRef<string | null>(null);
  const drawingPointsRef = useRef<number[]>([]);

  // 选中态与圆弧编辑器彻底分离：
  // selectedWaypoint 仅用于选中高亮或按 Delete 删除；
  // arcEditorWaypoint 仅在右键途经点一级菜单点击「调整圆弧」后才打开，绝不与一级菜单同时弹出！
  const [selectedStationIds, setSelectedStationIds] = useState<Set<string>>(() => new Set());
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [selectedWaypoint, setSelectedWaypoint] = useState<{ sectionId: string; waypointIndex: number } | null>(null);
  const [arcEditorWaypoint, setArcEditorWaypoint] = useState<{ sectionId: string; waypointIndex: number } | null>(null);
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

  useVisualViewport();
  const [mobileLabelPosOpen, setMobileLabelPosOpen] = useState(false);

  // 直接节点引用表（彻底消灭 stage.findOne 递归全树查找导致的跟随延迟）
  const containerRef = useRef<HTMLDivElement | null>(null);
  const amapContainerRef = useRef<HTMLDivElement | null>(null);
  const cursorDotDomRef = useRef<HTMLDivElement | null>(null);
  const touchAimDomRef = useRef<HTMLDivElement | null>(null);
  const touchAimStemDomRef = useRef<HTMLDivElement | null>(null);
  const touchAimStateRef = useRef<{
    active: boolean;
    originScreen: { x: number; y: number };
    aimedScreen: { x: number; y: number };
    aimedWorld: { x: number; y: number };
    snapStationId: string | null;
  } | null>(null);
  const lastSectionTapRef = useRef<{
    sectionId: string;
    world: { x: number; y: number };
    screen: { x: number; y: number };
  } | null>(null);
  const stageRef = useRef<any>(null);
  const overlayLayerRef = useRef<any>(null);
  const drawingPreviewLineRef = useRef<any>(null);
  const tempDragWaypointRef = useRef<any>(null);
  const guideLineRefs = useRef<Array<any>>([null, null, null, null]);
  const sectionVisNodeMapRef = useRef<Map<string, any>>(new Map());
  const sectionHitNodeMapRef = useRef<Map<string, any>>(new Map());
  const stationGroupNodeMapRef = useRef<Map<string, any>>(new Map());

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
  const previousDocumentKeyRef = useRef(documentKey);
  const [isMapInteracting, setIsMapInteracting] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isDraggingNode, setIsDraggingNode] = useState(false);
  const isAmapMode = mapSettings.baseMap.mode === 'amap';
  const isLightCityMode = mapSettings.baseMap.mode === 'light-city';
  const lightCity = mapSettings.baseMap.lightCity;

  // 轻城市「底图造景」独立状态（平时关闭，地形元素 100% 锁定防误触）
  const [terrainEditMode, setTerrainEditMode] = useState(false);
  const [terrainTool, setTerrainTool] = useState<TerrainTool>('select');
  const [terrainRiverWidth, setTerrainRiverWidth] = useState(68);
  const [terrainWaterSubKind, setTerrainWaterSubKind] = useState<'water' | 'island'>('water');
  const [terrainZoneSubKind, setTerrainZoneSubKind] = useState<'urban' | 'park'>('park');
  const [terrainRoadSubKind, setTerrainRoadSubKind] = useState<LightCityRoadKind>('express');
  const [terrainLabelSubKind, setTerrainLabelSubKind] = useState<LightCityLabelKind>('district');
  const [terrainDraftPoints, setTerrainDraftPoints] = useState<LightCityPoint[]>([]);
  const [terrainHoverWorld, setTerrainHoverWorld] = useState<LightCityPoint | null>(null);
  const [terrainSnap, setTerrainSnap] = useState<TerrainSnapResult | null>(null);
  const [selectedTerrainFeatureId, setSelectedTerrainFeatureId] = useState<string | null>(null);
  const [terrainLabelDraft, setTerrainLabelDraft] = useState<{
    x: number;
    y: number;
    value: string;
    editingFeatureId?: string;
  } | null>(null);
  const terrainLabelInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isLightCityMode && terrainEditMode) {
      setTerrainEditMode(false);
      setTerrainDraftPoints([]);
      setTerrainSnap(null);
      setSelectedTerrainFeatureId(null);
      setTerrainLabelDraft(null);
    }
  }, [isLightCityMode, terrainEditMode]);

  useEffect(() => {
    if (externalOpenTerrainSculptSeq && isLightCityMode && !readOnly) {
      setTerrainEditMode(true);
      setTerrainTool('river');
      setTerrainDraftPoints([]);
      setTerrainSnap(null);
      setSelectedTerrainFeatureId(null);
    }
  }, [externalOpenTerrainSculptSeq, isLightCityMode, readOnly]);

  useEffect(() => {
    if (terrainLabelDraft) {
      requestAnimationFrame(() => {
        terrainLabelInputRef.current?.focus();
        terrainLabelInputRef.current?.select();
      });
    }
  }, [terrainLabelDraft]);

  const commitLightCityUpdate = useCallback(
    (updater: (current: LightCitySettings) => LightCitySettings, recordHistory = true) => {
      if (!onMapSettingsChange) return;
      if (recordHistory) onBeginInteraction?.();
      const baseCurrent: LightCitySettings =
        latestMapSettingsRef.current.baseMap.lightCity ||
        generateLightCity({ archetype: 'river', stations, language });
      const nextLc = updater(baseCurrent);
      onMapSettingsChange(
        normalizeMapSettings({
          ...latestMapSettingsRef.current,
          baseMap: {
            ...latestMapSettingsRef.current.baseMap,
            mode: 'light-city',
            lightCity: nextLc
          }
        })
      );
    },
    [language, onBeginInteraction, onMapSettingsChange, stations]
  );

  const selectedTerrainFeature = useMemo(
    () => lightCity?.features.find((f) => f.id === selectedTerrainFeatureId) || null,
    [lightCity, selectedTerrainFeatureId]
  );

  const finishTerrainDraft = useCallback(
    (closeLoop = false) => {
      if (!terrainDraftPoints.length) return;
      const pts = terrainDraftPoints.map((p) => ({
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10
      }));
      const newId = `lc_${Date.now().toString(36)}_${Math.floor(Math.random() * 999)}`;
      let newFeature: LightCityFeature | null = null;
      if (terrainTool === 'river' && pts.length >= 2) {
        newFeature = { id: newId, type: 'river', width: terrainRiverWidth, points: pts };
      } else if (terrainTool === 'waterArea' && pts.length >= 3) {
        newFeature =
          terrainWaterSubKind === 'island'
            ? { id: newId, type: 'zone', kind: 'island', points: pts }
            : { id: newId, type: 'waterArea', points: pts };
      } else if (terrainTool === 'zone' && pts.length >= 3) {
        newFeature = { id: newId, type: 'zone', kind: terrainZoneSubKind, points: pts };
      } else if (terrainTool === 'road' && pts.length >= 2) {
        newFeature = {
          id: newId,
          type: 'road',
          kind: terrainRoadSubKind,
          ...(closeLoop && pts.length >= 3 ? { closed: true } : {}),
          points: pts
        };
      }
      setTerrainDraftPoints([]);
      if (newFeature) {
        commitLightCityUpdate((cur) => ({
          ...cur,
          features: [...cur.features, newFeature!]
        }));
        setSelectedTerrainFeatureId(newFeature.id);
      }
    },
    [
      commitLightCityUpdate,
      terrainDraftPoints,
      terrainRiverWidth,
      terrainRoadSubKind,
      terrainTool,
      terrainWaterSubKind,
      terrainZoneSubKind
    ]
  );

  const commitTerrainLabelDraft = useCallback(() => {
    if (!terrainLabelDraft) return;
    const val = terrainLabelDraft.value.trim();
    const editingId = terrainLabelDraft.editingFeatureId;
    const { x, y } = terrainLabelDraft;
    setTerrainLabelDraft(null);
    if (!val) return;
    if (editingId) {
      commitLightCityUpdate((cur) => ({
        ...cur,
        features: cur.features.map((f) => (f.id === editingId && f.type === 'label' ? { ...f, text: val } : f))
      }));
      return;
    }
    const newId = `lbl_${Date.now().toString(36)}_${Math.floor(Math.random() * 999)}`;
    commitLightCityUpdate((cur) => ({
      ...cur,
      features: [
        ...cur.features,
        { id: newId, type: 'label', kind: terrainLabelSubKind, x, y, text: val }
      ]
    }));
    setSelectedTerrainFeatureId(newId);
  }, [commitLightCityUpdate, terrainLabelDraft, terrainLabelSubKind]);

  const deleteSelectedTerrainFeature = useCallback(() => {
    if (!selectedTerrainFeatureId) return;
    const targetId = selectedTerrainFeatureId;
    setSelectedTerrainFeatureId(null);
    commitLightCityUpdate((cur) => ({
      ...cur,
      features: cur.features.filter((f) => f.id !== targetId)
    }));
  }, [commitLightCityUpdate, selectedTerrainFeatureId]);

  const handleRerollLightCity = useCallback(() => {
    const currentArch = lightCity?.archetype && lightCity.archetype !== 'custom' ? lightCity.archetype : 'river';
    const nextSeed = Math.floor(100000 + Math.random() * 899999);
    const fresh = generateLightCity({ archetype: currentArch, seed: nextSeed, stations, language });
    commitLightCityUpdate((cur) => ({
      ...fresh,
      opacity: cur.opacity,
      layerVisibility: cur.layerVisibility
    }));
    setSelectedTerrainFeatureId(null);
    setTerrainDraftPoints([]);
  }, [commitLightCityUpdate, language, lightCity?.archetype, stations]);

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

  // 拖拽草稿 refs（全程 60fps 零 React 重渲）
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
    baseWaypoints: Waypoint[];
  } | null>(null);
  const sectionParallelOffsetRef = useRef<Map<string, number>>(new Map());

  const hideTouchAim = useCallback(() => {
    touchAimStateRef.current = null;
    if (touchAimDomRef.current) {
      touchAimDomRef.current.style.opacity = '0';
    }
    if (touchAimStemDomRef.current) {
      touchAimStemDomRef.current.style.opacity = '0';
    }
  }, []);

  useEffect(() => {
    setMobileLabelPosOpen(false);
  }, [selectedStationIds]);

  const hideCursorDot = useCallback(() => {
    if (cursorDotDomRef.current) {
      cursorDotDomRef.current.style.opacity = '0';
    }
    hideTouchAim();
    if (drawSnapStationIdRef.current !== null) {
      drawSnapStationIdRef.current = null;
      setDrawSnapStationId(null);
    }
  }, [hideTouchAim]);

  const clearImperativeGuides = useCallback(() => {
    for (let i = 0; i < 4; i += 1) {
      const g = guideLineRefs.current[i];
      if (g) {
        g.points([]);
        g.visible(false);
      }
    }
    overlayLayerRef.current?.batchDraw?.();
  }, []);

  const liftDrawingPen = useCallback(() => {
    drawingPointsRef.current = [];
    if (drawingPreviewLineRef.current) {
      drawingPreviewLineRef.current.points([]);
      drawingPreviewLineRef.current.visible(false);
    }
    clearImperativeGuides();
    setDrawAnchorStationId(null);
    setDrawPendingWaypoints([]);
    setDrawWaypointSubmode(false);
  }, [clearImperativeGuides]);

  useEffect(() => {
    if (drawAnchorStationId && !stationById.has(drawAnchorStationId)) {
      liftDrawingPen();
    }
  }, [drawAnchorStationId, stationById, liftDrawingPen]);

  useEffect(() => {
    liftDrawingPen();
    hideCursorDot();
    setSelectedStationIds(new Set());
    setSelectedSectionId(null);
    setSelectedWaypoint(null);
    setArcEditorWaypoint(null);
    setInlineRename(null);
  }, [documentKey, hideCursorDot, liftDrawingPen]);

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
      if (tool !== 'pan') {
        setTerrainEditMode(false);
        setTerrainDraftPoints([]);
        setTerrainSnap(null);
        setTerrainLabelDraft(null);
      }
      setActiveTool(tool);
      if (tool !== 'draw') {
        liftDrawingPen();
        hideCursorDot();
      } else {
        setSelectedWaypoint(null);
        setArcEditorWaypoint(null);
        setSelectedStationIds(new Set());
      }
    },
    [commitInlineRenameIfNeeded, hideCursorDot, liftDrawingPen]
  );

  const toolGroupRef = useElasticToolbar(
    terrainEditMode && activeTool !== 'pan' ? -1 : CANVAS_TOOL_ORDER.indexOf(activeTool),
    CANVAS_TOOL_ORDER.length,
    !readOnly,
    (index) => setCanvasTool(CANVAS_TOOL_ORDER[index])
  );

  const [scale, setScale] = useState(initialViewport?.scale || 1);
  const [position, setPosition] = useState({ x: initialViewport?.x || 0, y: initialViewport?.y || 0 });
  const preAmapViewportRef = useRef({ scale: initialViewport?.scale || 1, x: initialViewport?.x || 0, y: initialViewport?.y || 0 });
  useEffect(() => {
    if (!isAmapMode) {
      preAmapViewportRef.current = { scale, x: position.x, y: position.y };
    }
    onViewportChange?.({ scale, ...position });
  }, [scale, position, isAmapMode, onViewportChange]);

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

  useEffect(() => {
    if (readOnly || !canvasSceneReady || hasSeenCanvasOnboarding()) return;
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

  useEffect(() => {
    if (!inlineRename) return;
    if (isCompact && !isAmapMode) {
      const st = stationById.get(inlineRename.stationId);
      const stage = stageRef.current;
      if (st && stage && stageSize.width > 0 && stageSize.height > 0) {
        const curScale = stage.scaleX() || scale;
        const nextPos = {
          x: stageSize.width / 2 - st.x * curScale,
          y: Math.max(96, stageSize.height * 0.3) - st.y * curScale
        };
        stage.position(nextPos);
        stage.batchDraw();
        setPosition(nextPos);
      }
    }
    const raf = window.requestAnimationFrame(() => {
      inlineRenameInputRef.current?.focus();
      inlineRenameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [inlineRename?.stationId]);

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
      setArcEditorWaypoint((prev) =>
        prev && prev.sectionId === sectionId && prev.waypointIndex === waypointIndex ? null : prev
      );
    },
    [getSectionWaypoints, onBeginInteraction, writeSectionWaypoints]
  );

  const deleteSelectedItems = useCallback(() => {
    if (arcEditorWaypoint) {
      deleteWaypoint(arcEditorWaypoint.sectionId, arcEditorWaypoint.waypointIndex);
      return;
    }
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
  }, [
    arcEditorWaypoint,
    deleteWaypoint,
    onApplyGraphTransaction,
    onDeleteStation,
    selectedStationIds,
    selectedWaypoint
  ]);

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
          hideCursorDot();
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
        if (terrainLabelDraft) {
          setTerrainLabelDraft(null);
          return;
        }
        if (terrainEditMode) {
          if (terrainDraftPoints.length > 0) {
            setTerrainDraftPoints([]);
          } else if (selectedTerrainFeatureId) {
            setSelectedTerrainFeatureId(null);
          } else {
            setTerrainEditMode(false);
          }
          return;
        }
        if (inlineRename) {
          setInlineRename(null);
          return;
        }
        if (arcEditorWaypoint) {
          setArcEditorWaypoint(null);
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

      if (terrainEditMode) {
        if (e.key === 'Enter' && terrainDraftPoints.length > 0) {
          e.preventDefault();
          finishTerrainDraft(false);
          return;
        }
        if (e.key === 'Backspace' && terrainDraftPoints.length > 0) {
          e.preventDefault();
          setTerrainDraftPoints((prev) => prev.slice(0, -1));
          return;
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && selectedTerrainFeatureId) {
          e.preventDefault();
          deleteSelectedTerrainFeature();
          return;
        }
        const tKey = e.key.toLowerCase();
        if (tKey === 'v') {
          setCanvasTool('select');
          return;
        }
        if (tKey === 'd' || tKey === 'l' || tKey === 's') {
          setCanvasTool('draw');
          return;
        }
        if (tKey === 'h') {
          setCanvasTool('pan');
          return;
        }
        return;
      }

      if (e.key === 'Backspace' && activeTool === 'draw' && drawPendingWaypoints.length > 0) {
        e.preventDefault();
        setDrawPendingWaypoints((prev) => prev.slice(0, -1));
        return;
      }

      if (
        (e.key === 'Delete' || e.key === 'Backspace') &&
        (selectedStationIds.size > 0 || selectedWaypoint || arcEditorWaypoint)
      ) {
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
      hideCursorDot();
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
    arcEditorWaypoint,
    closeAllFloatingMenus,
    deleteSelectedItems,
    drawAnchorStationId,
    drawPendingWaypoints.length,
    hideCursorDot,
    inlineRename,
    liftDrawingPen,
    readOnly,
    searchOpen,
    selectedStationIds.size,
    selectedTerrainFeatureId,
    selectedWaypoint,
    setCanvasTool,
    terrainDraftPoints.length,
    terrainEditMode,
    terrainLabelDraft,
    deleteSelectedTerrainFeature,
    finishTerrainDraft
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
    if (!isAmapMode || !amapReady || !map) return null;
    const AMap = (window as any).AMap;
    const pixelArg = AMap?.Pixel ? new AMap.Pixel(point.x, point.y) : { x: point.x, y: point.y };
    const lngLat = map.containerToLngLat?.(pixelArg);
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
    const previousDocKey = previousDocumentKeyRef.current;
    const isSameDocument = previousDocKey === documentKey;
    previousBaseMapModeRef.current = mapSettings.baseMap.mode;
    previousDocumentKeyRef.current = documentKey;

    // 切换不同存档/工程（例如从地理底图存档打开轻城市或纯画布存档）绝不能触发底图模式转换拉伸！
    // 轻城市与纯画布共享 100% 纯世界像素坐标，切换存档时直接重置或沿用目标存档视口即可。
    if (!isSameDocument || isDocumentLoading) {
      if (!isSameDocument && !isAmapMode) {
        const nextScale = initialViewport?.scale || 1;
        const nextPos = { x: initialViewport?.x || 0, y: initialViewport?.y || 0 };
        setScale(nextScale);
        setPosition(nextPos);
        preAmapViewportRef.current = { scale: nextScale, ...nextPos };
      }
      return;
    }

    const hasGeoStations = stations.some(
      (st) =>
        typeof st.lng === 'number' &&
        Number.isFinite(st.lng) &&
        typeof st.lat === 'number' &&
        Number.isFinite(st.lat)
    );

    if (previousMode === 'amap' && !isAmapMode && amapRef.current && hasGeoStations) {
      // 同一份方案内手动从地理底图切换至纯画布/轻城市：
      // 1) 将经纬度投影至屏幕像素后，围绕线网质心按标准参考缩放级（AMAP_REFERENCE_ZOOM = 11.8）与最小站间距（>= 78px）径向舒展世界坐标；
      // 2) 站点与途经点统一按同一质心与同一倍率同步变换（即使个别途经点缺失 lng/lat 也同步回退变换，杜绝站点与途经点比例撕裂）；
      // 3) 同步将初始画布视口设为 1 / stretch 并锚定质心，使切换瞬间屏幕视觉零跳变。
      const currentZoom =
        amapRef.current.getZoom?.() || mapSettings.baseMap.amap?.zoom || AMAP_REFERENCE_ZOOM;
      const projectedByStationId = new Map<string, { x: number; y: number }>();
      let sumX = 0;
      let sumY = 0;
      let count = 0;
      stations.forEach((st) => {
        const pt = projectLngLatToContainerPoint(st.lng, st.lat) || { x: st.x, y: st.y };
        projectedByStationId.set(st.id, pt);
        sumX += pt.x;
        sumY += pt.y;
        count += 1;
      });
      const cx = count > 0 ? sumX / count : stageSize.width / 2;
      const cy = count > 0 ? sumY / count : stageSize.height / 2;

      const zoomStretch = Math.max(1, Math.min(6, Math.pow(2, AMAP_REFERENCE_ZOOM - currentZoom)));
      const sectionScreenLengths: number[] = [];
      sections.forEach((sec) => {
        const pA = projectedByStationId.get(sec.startStationId);
        const pB = projectedByStationId.get(sec.endStationId);
        if (!pA || !pB) return;
        const d = Math.hypot(pB.x - pA.x, pB.y - pA.y);
        if (d > 1) sectionScreenLengths.push(d);
      });
      let spacingStretch = 1;
      if (sectionScreenLengths.length > 0) {
        sectionScreenLengths.sort((a, b) => a - b);
        const medianLen = sectionScreenLengths[Math.floor(sectionScreenLengths.length / 2)];
        spacingStretch = 78 / Math.max(14, medianLen);
      }
      const stretch =
        stations.length >= 2
          ? Math.min(8, Math.max(1, zoomStretch, spacingStretch))
          : Math.min(6, Math.max(1, zoomStretch));

      const stretchCoord = (pt: { x: number; y: number }) => ({
        x: Math.round((cx + (pt.x - cx) * stretch) * 10) / 10,
        y: Math.round((cy + (pt.y - cy) * stretch) * 10) / 10
      });

      const stripAndProjectStation = (station: Station): Station => {
        const point =
          projectedByStationId.get(station.id) ||
          projectLngLatToContainerPoint(station.lng, station.lat) || { x: station.x, y: station.y };
        const { lng: _lng, lat: _lat, ...rest } = station;
        const stretched = stretchCoord(point);
        return { ...rest, x: stretched.x, y: stretched.y };
      };
      const stripAndProjectSection = (section: Section): Section => {
        if (!section.waypoints?.length) return section;
        const nextWaypoints = section.waypoints.map((point) => {
          const projected = projectLngLatToContainerPoint(point.lng, point.lat) || {
            x: point.x,
            y: point.y
          };
          const { lng: _lng, lat: _lat, ...rest } = point;
          const stretched = stretchCoord(projected);
          return {
            ...rest,
            x: stretched.x,
            y: stretched.y,
            ...(typeof rest.radius === 'number' && stretch > 1.01
              ? { radius: Math.round(rest.radius * stretch * 10) / 10 }
              : {})
          };
        });
        return { ...section, waypoints: nextWaypoints };
      };

      const nextStationsPreview = stations.map(stripAndProjectStation);

      if (onApplyGraphTransaction) {
        onApplyGraphTransaction(
          (graph) => ({
            ...graph,
            stations: graph.stations.map(stripAndProjectStation),
            sections: graph.sections.map(stripAndProjectSection)
          }),
          { recordHistory: false }
        );
      } else {
        onUpdateStations?.(nextStationsPreview);
        if (onUpdateSection) {
          sections.forEach((sec) => {
            if (!sec.waypoints?.length) return;
            onUpdateSection(sec.id, { waypoints: stripAndProjectSection(sec).waypoints });
          });
        }
      }

      // 若是直接从地理底图一键切入预设轻城市模板，同步用舒展后的真实画布坐标对齐轻城市地貌包围盒
      if (
        mapSettings.baseMap.mode === 'light-city' &&
        mapSettings.baseMap.lightCity &&
        mapSettings.baseMap.lightCity.archetype !== 'custom' &&
        onMapSettingsChange
      ) {
        const curLc = mapSettings.baseMap.lightCity;
        const alignedLc = generateLightCity({
          archetype: curLc.archetype,
          seed: curLc.seed,
          stations: nextStationsPreview,
          language
        });
        onMapSettingsChange(
          normalizeMapSettings({
            ...mapSettings,
            baseMap: {
              ...mapSettings.baseMap,
              mode: 'light-city',
              lightCity: {
                ...alignedLc,
                opacity: curLc.opacity,
                layerVisibility: curLc.layerVisibility
              }
            }
          })
        );
      }

      const nextScale =
        stretch > 1.02 ? Math.max(0.18, Math.min(1, Number((1 / stretch).toFixed(3)))) : 1;
      const nextPos =
        stretch > 1.02
          ? {
              x: Math.round(cx - cx * nextScale),
              y: Math.round(cy - cy * nextScale)
            }
          : { x: 0, y: 0 };

      setScale(nextScale);
      setPosition(nextPos);
      preAmapViewportRef.current = { scale: nextScale, ...nextPos };
      setIsMapInteracting(false);
      clearImperativeGuides();
      closeAllFloatingMenus();
    }
  }, [documentKey, isDocumentLoading, isAmapMode, mapSettings.baseMap.mode]);

  // 从纯画布 / 轻城市切入地理底图（或地理底图下存在尚未绑定经纬度的站点/拐点）时：
  // 自动将画布点位映射为当前真实地图视野内的 WGS-84 经纬度，保证线网立即跟随地图平移与缩放！
  useLayoutEffect(() => {
    if (readOnly || !isAmapMode || !amapReady || !amapRef.current || isDocumentLoading) return;
    const map = amapRef.current;
    if (typeof map.containerToLngLat !== 'function') return;

    const missingStation = stations.some(
      (s) => typeof s.lng !== 'number' || !Number.isFinite(s.lng) || typeof s.lat !== 'number' || !Number.isFinite(s.lat)
    );
    const missingWaypoint = sections.some((sec) =>
      (sec.waypoints || []).some(
        (wp) =>
          typeof wp.lng !== 'number' || !Number.isFinite(wp.lng) || typeof wp.lat !== 'number' || !Number.isFinite(wp.lat)
      )
    );
    if (!missingStation && !missingWaypoint) return;

    const hasAnyGeoStation = stations.some(
      (s) => typeof s.lng === 'number' && Number.isFinite(s.lng) && typeof s.lat === 'number' && Number.isFinite(s.lat)
    );

    const viewW = Math.max(320, stageSize.width);
    const viewH = Math.max(320, stageSize.height);
    let toContainerPoint = (pt: { x: number; y: number }) => ({ x: pt.x, y: pt.y });

    if (!hasAnyGeoStation) {
      const vp = preAmapViewportRef.current;
      const allRawPts: Array<{ x: number; y: number }> = [
        ...stations.map((s) => ({ x: s.x, y: s.y })),
        ...sections.flatMap((sec) => (sec.waypoints || []).map((wp) => ({ x: wp.x, y: wp.y })))
      ];
      if (allRawPts.length > 0) {
        let minSx = Infinity;
        let minSy = Infinity;
        let maxSx = -Infinity;
        let maxSy = -Infinity;
        let minRx = Infinity;
        let minRy = Infinity;
        let maxRx = -Infinity;
        let maxRy = -Infinity;
        allRawPts.forEach((p) => {
          const sx = p.x * vp.scale + vp.x;
          const sy = p.y * vp.scale + vp.y;
          minSx = Math.min(minSx, sx);
          minSy = Math.min(minSy, sy);
          maxSx = Math.max(maxSx, sx);
          maxSy = Math.max(maxSy, sy);
          minRx = Math.min(minRx, p.x);
          minRy = Math.min(minRy, p.y);
          maxRx = Math.max(maxRx, p.x);
          maxRy = Math.max(maxRy, p.y);
        });
        const cx = (minSx + maxSx) / 2;
        const cy = (minSy + maxSy) / 2;
        const spanS = Math.max(maxSx - minSx, maxSy - minSy);
        const fitsCurrentScreen =
          cx >= viewW * 0.12 &&
          cx <= viewW * 0.88 &&
          cy >= viewH * 0.12 &&
          cy <= viewH * 0.88 &&
          spanS <= Math.max(viewW, viewH) * 1.35 &&
          (allRawPts.length <= 1 || spanS >= 60);

        if (fitsCurrentScreen) {
          toContainerPoint = (p) => ({ x: p.x * vp.scale + vp.x, y: p.y * vp.scale + vp.y });
        } else {
          const rawW = Math.max(1, maxRx - minRx);
          const rawH = Math.max(1, maxRy - minRy);
          const fitScale =
            allRawPts.length <= 1
              ? 1
              : Math.min((viewW * 0.66) / rawW, (viewH * 0.66) / rawH, 2.5);
          const rcx = (minRx + maxRx) / 2;
          const rcy = (minRy + maxRy) / 2;
          toContainerPoint = (p) => ({
            x: (p.x - rcx) * fitScale + viewW / 2,
            y: (p.y - rcy) * fitScale + viewH / 2
          });
        }
      }
    }

    const bindPointToGeo = <T extends { x: number; y: number; lng?: number; lat?: number }>(pt: T): T => {
      if (typeof pt.lng === 'number' && Number.isFinite(pt.lng) && typeof pt.lat === 'number' && Number.isFinite(pt.lat)) {
        return pt;
      }
      const cPt = toContainerPoint(pt);
      const AMap = (window as any).AMap;
      const pixelArg = AMap?.Pixel ? new AMap.Pixel(cPt.x, cPt.y) : cPt;
      const ll = map.containerToLngLat(pixelArg);
      if (!ll || !Number.isFinite(ll.lng) || !Number.isFinite(ll.lat)) return pt;
      return {
        ...pt,
        x: Math.round(cPt.x * 10) / 10,
        y: Math.round(cPt.y * 10) / 10,
        lng: ll.lng,
        lat: ll.lat
      };
    };

    if (onApplyGraphTransaction) {
      onApplyGraphTransaction(
        (graph) => ({
          ...graph,
          stations: graph.stations.map(bindPointToGeo),
          sections: graph.sections.map((sec) =>
            sec.waypoints?.length
              ? { ...sec, waypoints: sec.waypoints.map(bindPointToGeo) }
              : sec
          )
        }),
        { recordHistory: false }
      );
    } else {
      if (missingStation) {
        onUpdateStations?.(stations.map(bindPointToGeo));
      }
      if (missingWaypoint && onUpdateSection) {
        sections.forEach((sec) => {
          if (!sec.waypoints?.length) return;
          onUpdateSection(sec.id, { waypoints: sec.waypoints.map(bindPointToGeo) });
        });
      }
    }
  }, [
    readOnly,
    isAmapMode,
    amapReady,
    isDocumentLoading,
    stations,
    sections,
    stageSize.width,
    stageSize.height,
    amapRef,
    onApplyGraphTransaction,
    onUpdateStations,
    onUpdateSection
  ]);

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

  // 轻柔 360° 轴向辅助吸附
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

  // O(1) 直接写辅助层虚线，彻底消除 stage.findOne 递归全树扫描
  const updateImperativeGuides = (guides: number[][]) => {
    for (let i = 0; i < 4; i += 1) {
      const node = guideLineRefs.current[i];
      if (!node) continue;
      if (guides[i]) {
        node.points(guides[i]);
        node.visible(true);
      } else {
        node.points([]);
        node.visible(false);
      }
    }
    overlayLayerRef.current?.batchDraw?.();
  };

  // 查找绘制模式下鼠标是否靠近既有站点（16px 屏幕半径内磁吸锁定，防止误建重叠站点并给出动作提示）
  const findNearestStationInDrawCapture = (
    rawWorld: { x: number; y: number },
    bypassCapture: boolean
  ): Station | null => {
    if (bypassCapture || stations.length === 0) return null;
    const viewScale = isAmapMode ? 1 : stageRef.current?.scaleX?.() || scale;
    const captureWorldRadius = DRAW_STATION_SNAP_SCREEN_PX / Math.max(0.25, viewScale);
    let nearest: Station | null = null;
    let minD = captureWorldRadius;
    for (let i = 0; i < stations.length; i += 1) {
      const st = stations[i];
      const pt = getDisplayPoint(st);
      const d = Math.hypot(pt.x - rawWorld.x, pt.y - rawWorld.y);
      if (d <= minD) {
        minD = d;
        nearest = st;
      }
    }
    return nearest;
  };

  const lineCornerRadius = Math.max(0, mapSettings.cornerRadius || 0);

  // O(1) 命令式更新某条区间 Konva 线条坐标（直取 Map 引用，零全树搜索）
  const updateSectionKonvaLineImperative = (
    section: Section,
    stationOverrides?: Map<string, { x: number; y: number }>,
    overrideWaypoints?: Waypoint[]
  ) => {
    const visNode = sectionVisNodeMapRef.current.get(section.id);
    const hitNode = sectionHitNodeMapRef.current.get(section.id);
    if (!visNode && !hitNode) return;
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
    visNode?.points?.(renderFlat);
    hitNode?.points?.(renderFlat);
  };

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

    const current =
      dragWaypointDraftRef.current?.sectionId === sectionId
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

    if (stageRef.current) {
      if (circleNode && !isAmapMode) {
        circleNode.position?.({ x: snapped.x, y: snapped.y });
      }
      if (tempDragWaypointRef.current?.visible?.()) {
        tempDragWaypointRef.current.position({ x: snapped.x, y: snapped.y });
      }
      updateImperativeGuides(snapped.guides);
      updateSectionKonvaLineImperative(section, undefined, next);
      stageRef.current.batchDraw?.();
      return;
    }

    writeSectionWaypoints(sectionId, next);
  };

  const commitWaypointDrag = () => {
    if (tempDragWaypointRef.current) {
      tempDragWaypointRef.current.visible(false);
    }
    clearImperativeGuides();
    setIsDraggingNode(false);
    const draft = dragWaypointDraftRef.current;
    dragWaypointDraftRef.current = null;
    if (draft) {
      writeSectionWaypoints(draft.sectionId, draft.waypoints);
    }
  };

  // ==================== 连续绘制动作（不自动偷偷建线，尊重手动建线/选线） ====================

  const requireSelectedLineForDraw = (): LineType | null => {
    const line = currentLineId ? lineById.get(currentLineId) || null : null;
    if (line) return line;
    if (lines.length === 0) {
      message.info?.(isEn ? 'Please create a line on the left first' : '请先在左侧新建一条线路');
      onCreateLine?.();
    } else {
      message.warning?.(isEn ? 'Please select a line on the left first' : '请先在左侧选择要绘制的线路');
    }
    return null;
  };

  const placeNewStationInDrawMode = (
    worldPos: { x: number; y: number },
    containerPointer: { x: number; y: number }
  ) => {
    commitInlineRenameIfNeeded();
    const targetLine = requireSelectedLineForDraw();
    if (!targetLine) return;

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
      onApplyGraphTransaction((graph) => {
        const baseGraph: MapGraph = {
          lines: graph.lines.map((l) =>
            l.id === targetLine.id && !l.stationIds.includes(newStationId)
              ? { ...l, stationIds: [...l.stationIds, newStationId], lastAddedStationId: newStationId }
              : l
          ),
          stations: [...graph.stations, newStationObj],
          sections: graph.sections
        };

        if (drawAnchorStationId && drawAnchorStationId !== newStationId) {
          return connectStationsOnLine(baseGraph, {
            lineId: targetLine.id,
            fromStationId: drawAnchorStationId,
            toStationId: newStationId,
            waypoints: drawPendingWaypoints
          }).graph;
        }
        return baseGraph;
      });
    } else {
      onAddStation(newStationObj);
      if (drawAnchorStationId) {
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
    // 未起笔：若尚未选中线路但该站已归属某条线，顺手选中该线；否则检查当前是否已选线路
    if (!drawAnchorStationId) {
      if (!currentLineId) {
        const owningLine = lines.find((l) => l.stationIds.includes(station.id));
        if (owningLine) {
          onSelectLine?.(owningLine.id);
        } else if (!requireSelectedLineForDraw()) {
          return;
        }
      }
      setDrawAnchorStationId(station.id);
      setDrawPendingWaypoints([]);
      return;
    }

    if (drawAnchorStationId === station.id) {
      liftDrawingPen();
      return;
    }

    const targetLine = requireSelectedLineForDraw();
    if (!targetLine) return;

    if (onApplyGraphTransaction) {
      let closedLoop = false;
      onApplyGraphTransaction((graph) => {
        const res = connectStationsOnLine(graph, {
          lineId: targetLine.id,
          fromStationId: drawAnchorStationId,
          toStationId: station.id,
          waypoints: drawPendingWaypoints
        });
        closedLoop = res.closedLoop;
        return res.graph;
      });

      setDrawPendingWaypoints([]);
      setDrawWaypointSubmode(false);
      if (closedLoop) {
        liftDrawingPen();
        message.success?.('已闭合连接（已自动抬笔）');
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
    setArcEditorWaypoint(null);
    setIsDraggingNode(true);
    setMergeTargetStationId(null);

    const originStation = stationById.get(stationId);
    if (!originStation) return;

    const movingSet =
      selectedStationIds.has(stationId) && selectedStationIds.size > 1
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

    if (base.selectedIds.size > 1) {
      const dx = pos.x - base.primaryStart.x;
      const dy = pos.y - base.primaryStart.y;
      const stationOverrides = new Map<string, { x: number; y: number }>();
      const movedStationsDraft: Array<{ id: string; x: number; y: number; lng?: number; lat?: number }> = [];

      base.stationOrigins.forEach((origin, sid) => {
        const nx = origin.x + dx;
        const ny = origin.y + dy;
        stationOverrides.set(sid, { x: nx, y: ny });
        const lngLat = getLngLatFromContainerPoint({ x: nx, y: ny });
        movedStationsDraft.push({ id: sid, x: nx, y: ny, ...(lngLat || {}) });
        if (sid !== id) {
          stationGroupNodeMapRef.current.get(sid)?.position?.({ x: nx, y: ny });
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
    if (stageRef.current) {
      base.affectedSections.forEach((sec) => updateSectionKonvaLineImperative(sec, overrides));
      groupNode?.getLayer?.()?.batchDraw?.();
    } else {
      onUpdateStation({ ...updatedStation, x: snappedX, y: snappedY, ...(lngLat || {}) });
    }
  };

  const commitStationDrag = () => {
    clearImperativeGuides();
    setIsDraggingNode(false);
    setMergeTargetStationId(null);
    groupDragBaseRef.current = null;
    const draft = dragStationDraftRef.current;
    dragStationDraftRef.current = null;
    if (!draft) return;

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

  // ==================== 0ms 原生容器级 PointerMove 预览（彻底消除 Konva 拾取延迟） ====================

  const handleContainerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (
      readOnly ||
      terrainEditMode ||
      activeTool !== 'draw' ||
      isSpaceHeldRef.current ||
      e.pointerType === 'touch'
    ) {
      hideCursorDot();
      return;
    }
    const container = containerRef.current;
    const stage = stageRef.current;
    if (!container || !stage) return;

    // 悬停在顶部工具栏、搜索框、右键菜单等浮层上时隐藏画布跟随圆点
    const targetEl = e.target as HTMLElement | null;
    if (targetEl && targetEl.tagName !== 'CANVAS') {
      hideCursorDot();
      return;
    }

    const rect = container.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;
    const rawWorld = getPointerWorldPosition(stage, { x: localX, y: localY });

    const placingWaypoint = Boolean(drawAnchorStationId && (e.shiftKey || drawWaypointSubmode));
    const snapStation = placingWaypoint
      ? null
      : findNearestStationInDrawCapture(rawWorld, Boolean(e.altKey));

    if ((snapStation?.id || null) !== drawSnapStationIdRef.current) {
      drawSnapStationIdRef.current = snapStation?.id || null;
      setDrawSnapStationId(snapStation?.id || null);
    }

    const anchorSt = drawAnchorStationId ? stationById.get(drawAnchorStationId) : null;
    let lastRefPoint: { x: number; y: number } | null = null;
    if (drawPendingWaypoints.length > 0) {
      lastRefPoint = getWaypointDisplayPoint(drawPendingWaypoints[drawPendingWaypoints.length - 1]);
    } else if (anchorSt) {
      lastRefPoint = getDisplayPoint(anchorSt);
    }

    let finalWorldX = rawWorld.x;
    let finalWorldY = rawWorld.y;
    let guides: number[][] = [];

    if (snapStation) {
      const sp = getDisplayPoint(snapStation);
      finalWorldX = sp.x;
      finalWorldY = sp.y;
    } else if (lastRefPoint) {
      const snapped = snapWorldPointRelativeTo(rawWorld, [lastRefPoint], Boolean(e.altKey));
      finalWorldX = snapped.x;
      finalWorldY = snapped.y;
      guides = snapped.guides;
    }

    // 1) 直接以 GPU translate3d 更新跟随小圆点（0ms 延迟；重合到既有站点时隐藏实心新建圆点，改由站点磁吸环+提示标接管）
    const dotEl = cursorDotDomRef.current;
    if (dotEl) {
      if (snapStation) {
        dotEl.style.opacity = '0';
      } else {
        const screenPt = worldToScreenPoint({ x: finalWorldX, y: finalWorldY });
        const dotDiameter = placingWaypoint ? 11 : 14;
        const half = dotDiameter / 2;
        const lineColor = (currentLineId && lineById.get(currentLineId)?.color) || LINE_COLORS[0];
        dotEl.style.width = `${dotDiameter}px`;
        dotEl.style.height = `${dotDiameter}px`;
        dotEl.style.background = placingWaypoint ? '#ffffff' : lineColor;
        dotEl.style.border = placingWaypoint ? `2.2px solid ${lineColor}` : '2px solid #ffffff';
        dotEl.style.boxShadow = '0 2px 6px rgba(15, 23, 42, 0.22)';
        dotEl.style.opacity = '0.86';
        dotEl.style.transform = `translate3d(${screenPt.x - half}px, ${screenPt.y - half}px, 0)`;
      }
    }

    // 2) O(1) 直接更新顶层轻量辅助层的橡皮筋连线与校准虚线
    if (anchorSt && drawingPreviewLineRef.current) {
      const anchorPt = getDisplayPoint(anchorSt);
      const wpCoords = drawPendingWaypoints.flatMap((wp) => {
        const p = getWaypointDisplayPoint(wp);
        return [p.x, p.y];
      });
      const nextPts = [anchorPt.x, anchorPt.y, ...wpCoords, finalWorldX, finalWorldY];
      drawingPointsRef.current = nextPts;
      drawingPreviewLineRef.current.points(nextPts);
      drawingPreviewLineRef.current.visible(true);
    }
    updateImperativeGuides(guides);
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

  const beginOrMovePendingSectionWaypoint = (stage: any, pointer: { x: number; y: number }, altKey: boolean) => {
    const pending = pendingSectionDragRef.current;
    if (!pending) return;
    const worldPos = getPointerWorldPosition(stage, pointer);
    if (pending.insertedWaypointIndex === null) {
      const sec = sectionById.get(pending.sectionId);
      const sSt = sec ? stationById.get(sec.startStationId) : null;
      const eSt = sec ? stationById.get(sec.endStationId) : null;
      if (!sec || !sSt || !eSt) return;

      onBeginInteraction?.();
      setArcEditorWaypoint(null);
      setIsDraggingNode(true);
      const curWps = pending.baseWaypoints;
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
      if (tempDragWaypointRef.current) {
        tempDragWaypointRef.current.position({ x: worldPos.x, y: worldPos.y });
        tempDragWaypointRef.current.visible(true);
      }
      updateSectionKonvaLineImperative(sec, undefined, nextWps);
      stage.batchDraw?.();
      return;
    }

    updateWaypointImperativeOrState(pending.sectionId, pending.insertedWaypointIndex, worldPos.x, worldPos.y, altKey);
  };

  const handleTouchStart = (e: any) => {
    e.evt.preventDefault();
    const points = readTouchPoints(e);
    const gesture = touchGestureRef.current;
    gesture.start(points);
    touchTapAllowedRef.current = false;
    clearLongPress();
    closeAllFloatingMenus();
    hideTouchAim();
    if (points.length > 1) {
      stageRef.current?.find('.touch-edit-node').forEach((node: any) => node.stopDrag());
      pendingSectionDragRef.current = null;
      setIsDraggingNode(false);
      clearImperativeGuides();
      setIsDragging(false);
      startCanvasInteraction();
      return;
    }
    if (activeTool === 'pan') startCanvasInteraction();
    if (points.length !== 1) return;
    const point = points[0];

    const canTouchAimInTerrain =
      !readOnly && terrainEditMode && terrainTool !== 'select' && terrainTool !== 'label';
    const canTouchAimInDraw = !readOnly && !terrainEditMode && activeTool === 'draw';
    if ((canTouchAimInDraw || canTouchAimInTerrain) && stageRef.current) {
      touchAimStateRef.current = {
        active: false,
        originScreen: point,
        aimedScreen: point,
        aimedWorld: getPointerWorldPosition(stageRef.current, point),
        snapStationId: null
      };
    }

    const stationNode = e.target.findAncestor('.touch-station', true);
    const station = stationNode ? stations.find((s) => s.id === stationNode.id()) : null;
    const sectionId = e.target.getAttr('sectionId');
    const waypointIndex = e.target.getAttr('waypointIndex');
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      if (readOnly || !gesture.canLongPress || activeTool === 'draw' || terrainEditMode) return;
      gesture.consume();
      stationNode?.stopDrag();
      pendingSectionDragRef.current = null;
      setArcEditorWaypoint(null);
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

  const renderTouchAimDom = (
    finger: { x: number; y: number },
    aimed: { x: number; y: number },
    accentColor: string,
    snappedToTarget: boolean
  ) => {
    const reticle = touchAimDomRef.current;
    const stem = touchAimStemDomRef.current;
    if (reticle) {
      reticle.style.borderColor = accentColor;
      reticle.style.opacity = '1';
      reticle.dataset.snapped = snappedToTarget ? 'true' : 'false';
      reticle.style.transform = `translate3d(${aimed.x - 15}px, ${aimed.y - 15}px, 0)`;
    }
    if (stem) {
      const dy = Math.max(0, finger.y - aimed.y);
      if (dy >= 12) {
        stem.style.height = `${dy}px`;
        stem.style.borderColor = accentColor;
        stem.style.opacity = '0.72';
        stem.style.transform = `translate3d(${aimed.x}px, ${aimed.y}px, 0)`;
      } else {
        stem.style.opacity = '0';
      }
    }
  };

  const handleTouchMove = (e: any) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const points = readTouchPoints(e);
    const gesture = touchGestureRef.current;
    if (points.length > 1) {
      hideTouchAim();
      clearImperativeGuides();
      if (drawSnapStationIdRef.current !== null) {
        drawSnapStationIdRef.current = null;
        setDrawSnapStationId(null);
      }
      if (!gesture.isNavigating) {
        stage.find('.touch-edit-node').forEach((node: any) => node.stopDrag());
        pendingSectionDragRef.current = null;
      }
    }
    if (!gesture.canLongPress) clearLongPress();

    // 触屏按住偏移准星瞄准（上移 52px 完全避开指腹遮挡，支持实时 45° 参考线与换乘磁吸震动）
    if (points.length === 1 && touchAimStateRef.current && !readOnly && !gesture.isNavigating) {
      const aim = touchAimStateRef.current;
      const finger = points[0];
      if (!aim.active && shouldActivateTouchAim(aim.originScreen, finger)) {
        aim.active = true;
        gesture.consume();
        clearLongPress();
      }
      if (aim.active) {
        const aimedScreen = computeTouchAimScreenPoint(finger, stageSize);
        const rawWorld = getPointerWorldPosition(stage, aimedScreen);

        if (terrainEditMode && terrainTool !== 'select' && terrainTool !== 'label') {
          if (
            (terrainTool === 'waterArea' || terrainTool === 'zone' || terrainTool === 'road') &&
            terrainDraftPoints.length >= 3
          ) {
            const first = terrainDraftPoints[0];
            const closeDistWorld = 18 / Math.max(0.25, scale);
            if (Math.hypot(rawWorld.x - first.x, rawWorld.y - first.y) <= closeDistWorld) {
              aim.aimedScreen = aimedScreen;
              aim.aimedWorld = { x: first.x, y: first.y };
              setTerrainHoverWorld({ x: first.x, y: first.y });
              setTerrainSnap(null);
              renderTouchAimDom(finger, worldToScreenPoint(first), '#10b981', true);
              return;
            }
          }
          const snapped = snapTerrainDrawPoint({
            rawPoint: rawWorld,
            lightCity,
            tool: terrainTool,
            viewportScale: scale,
            altKey: false
          });
          aim.aimedScreen = aimedScreen;
          aim.aimedWorld = { x: snapped.x, y: snapped.y };
          setTerrainHoverWorld({ x: snapped.x, y: snapped.y });
          setTerrainSnap((prev) => {
            if (snapped.snapped && !prev?.snapped) triggerLightHaptic(6);
            return snapped.snapped ? snapped : null;
          });
          renderTouchAimDom(
            finger,
            snapped.snapped ? worldToScreenPoint(snapped) : aimedScreen,
            '#2563eb',
            snapped.snapped
          );
          return;
        }

        if (activeTool === 'draw') {
          const placingWaypoint = Boolean(drawAnchorStationId && drawWaypointSubmode);
          const snapStation = placingWaypoint ? null : findNearestStationInDrawCapture(rawWorld, false);
          if ((snapStation?.id || null) !== drawSnapStationIdRef.current) {
            drawSnapStationIdRef.current = snapStation?.id || null;
            setDrawSnapStationId(snapStation?.id || null);
            if (snapStation) triggerLightHaptic(8);
          }

          const anchorSt = drawAnchorStationId ? stationById.get(drawAnchorStationId) : null;
          const lastRefPoint =
            drawPendingWaypoints.length > 0
              ? getWaypointDisplayPoint(drawPendingWaypoints[drawPendingWaypoints.length - 1])
              : anchorSt
                ? getDisplayPoint(anchorSt)
                : null;

          let finalWorldX = rawWorld.x;
          let finalWorldY = rawWorld.y;
          let guides: number[][] = [];

          if (snapStation) {
            const sp = getDisplayPoint(snapStation);
            finalWorldX = sp.x;
            finalWorldY = sp.y;
          } else if (lastRefPoint) {
            const snapped = snapWorldPointRelativeTo(rawWorld, [lastRefPoint], false);
            finalWorldX = snapped.x;
            finalWorldY = snapped.y;
            guides = snapped.guides;
          }

          aim.aimedScreen = aimedScreen;
          aim.aimedWorld = { x: finalWorldX, y: finalWorldY };
          aim.snapStationId = snapStation?.id || null;

          if (anchorSt && drawingPreviewLineRef.current) {
            const anchorPt = getDisplayPoint(anchorSt);
            const wpCoords = drawPendingWaypoints.flatMap((wp) => {
              const p = getWaypointDisplayPoint(wp);
              return [p.x, p.y];
            });
            const nextPts = [anchorPt.x, anchorPt.y, ...wpCoords, finalWorldX, finalWorldY];
            drawingPointsRef.current = nextPts;
            drawingPreviewLineRef.current.points(nextPts);
            drawingPreviewLineRef.current.visible(true);
          }
          updateImperativeGuides(guides);

          const lineColor = (currentLineId && lineById.get(currentLineId)?.color) || LINE_COLORS[0];
          const displayScreen = worldToScreenPoint({ x: finalWorldX, y: finalWorldY });
          renderTouchAimDom(finger, displayScreen, lineColor, Boolean(snapStation));
          return;
        }
      }
    }

    if (points.length === 1 && pendingSectionDragRef.current && activeTool === 'select' && !readOnly) {
      const pending = pendingSectionDragRef.current;
      const pointer = points[0];
      if (Math.hypot(pointer.x - pending.downPointer.x, pointer.y - pending.downPointer.y) >= 8) {
        beginOrMovePendingSectionWaypoint(stage, pointer, false);
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
    const activeAim = !remaining.length && touchAimStateRef.current?.active ? { ...touchAimStateRef.current } : null;
    if (!remaining.length) {
      hideTouchAim();
      clearImperativeGuides();
      if (drawSnapStationIdRef.current !== null) {
        drawSnapStationIdRef.current = null;
        setDrawSnapStationId(null);
      }
    }
    touchTapAllowedRef.current = touchGestureRef.current.end(remaining);
    if (remaining.length) return;

    if (activeAim && !readOnly) {
      if (terrainEditMode && terrainTool !== 'select' && terrainTool !== 'label') {
        if (
          (terrainTool === 'waterArea' || terrainTool === 'zone' || terrainTool === 'road') &&
          terrainDraftPoints.length >= 3
        ) {
          const first = terrainDraftPoints[0];
          const closeDistWorld = 18 / Math.max(0.25, scale);
          if (Math.hypot(activeAim.aimedWorld.x - first.x, activeAim.aimedWorld.y - first.y) <= closeDistWorld) {
            finishTerrainDraft(true);
            setTerrainSnap(null);
            setIsDragging(false);
            scheduleCanvasInteractionEnd(80);
            return;
          }
        }
        const pt = {
          x: Math.round(activeAim.aimedWorld.x * 10) / 10,
          y: Math.round(activeAim.aimedWorld.y * 10) / 10
        };
        setTerrainDraftPoints((prev) => [...prev, pt]);
        setTerrainSnap(null);
      } else if (activeTool === 'draw') {
        if (activeAim.snapStationId) {
          const st = stationById.get(activeAim.snapStationId);
          if (st) handleStationClickInDrawMode(st);
        } else if (drawAnchorStationId && drawWaypointSubmode) {
          const lngLat = getLngLatFromContainerPoint(activeAim.aimedScreen) || {};
          setDrawPendingWaypoints((prev) => [
            ...prev,
            { x: activeAim.aimedWorld.x, y: activeAim.aimedWorld.y, ...lngLat }
          ]);
        } else {
          placeNewStationInDrawMode(activeAim.aimedWorld, activeAim.aimedScreen);
        }
      }
      setIsDragging(false);
      scheduleCanvasInteractionEnd(80);
      return;
    }

    if (pendingSectionDragRef.current) {
      if (pendingSectionDragRef.current.insertedWaypointIndex !== null) {
        const secId = pendingSectionDragRef.current.sectionId;
        const idx = pendingSectionDragRef.current.insertedWaypointIndex;
        commitWaypointDrag();
        setSelectedWaypoint({ sectionId: secId, waypointIndex: idx });
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
    hideTouchAim();
    touchGestureRef.current.cancel();
    touchTapAllowedRef.current = false;
    pendingSectionDragRef.current = null;
    if (tempDragWaypointRef.current) tempDragWaypointRef.current.visible(false);
    stageRef.current?.find('.touch-edit-node').forEach((node: any) => node.stopDrag());
    setIsDragging(false);
    setIsDraggingNode(false);
    clearImperativeGuides();
    scheduleCanvasInteractionEnd(0);
  };

  const handleMouseDown = (e: any) => {
    const stage = e.target.getStage();
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;
    const button = e.evt?.button ?? 0;

    closeAllFloatingMenus();

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
      } else if (!terrainEditMode && activeTool === 'select' && !readOnly) {
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

    // 选择模式按住区间线条拖出 360° 途经点（全程命令式 60fps 零全树重渲，松手才提交）
    if (pendingSectionDragRef.current && activeTool === 'select' && !readOnly) {
      const pending = pendingSectionDragRef.current;
      const distPx = Math.hypot(pointer.x - pending.downPointer.x, pointer.y - pending.downPointer.y);
      if (distPx >= 4) {
        beginOrMovePendingSectionWaypoint(stage, pointer, Boolean(e.evt?.altKey));
        return;
      }
    }

    if (terrainEditMode && terrainTool !== 'select' && terrainTool !== 'label') {
      const worldPos = getPointerWorldPosition(stage, pointer);
      if (
        (terrainTool === 'waterArea' || terrainTool === 'zone' || terrainTool === 'road') &&
        terrainDraftPoints.length >= 3
      ) {
        const first = terrainDraftPoints[0];
        const closeDistWorld = 18 / Math.max(0.25, scale);
        if (Math.hypot(worldPos.x - first.x, worldPos.y - first.y) <= closeDistWorld) {
          setTerrainHoverWorld({ x: first.x, y: first.y });
          setTerrainSnap(null);
          return;
        }
      }
      const snapped = snapTerrainDrawPoint({
        rawPoint: worldPos,
        lightCity,
        tool: terrainTool,
        viewportScale: scale,
        altKey: Boolean(e.evt?.altKey)
      });
      setTerrainHoverWorld({ x: snapped.x, y: snapped.y });
      setTerrainSnap(snapped.snapped ? snapped : null);
    }

    if (marqueeWorldRect && activeTool === 'select' && !terrainEditMode) {
      const worldPos = getPointerWorldPosition(stage, pointer);
      setMarqueeWorldRect((prev) => (prev ? { ...prev, x2: worldPos.x, y2: worldPos.y } : null));
    }
  };

  const handleBlankStageClick = (e: any) => {
    if (readOnly) return;
    const stage = e.target.getStage();
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    if (terrainEditMode) {
      if (terrainLabelDraft) {
        commitTerrainLabelDraft();
        return;
      }
      const rawWorld = getPointerWorldPosition(stage, pointer);
      const rawPt = { x: Math.round(rawWorld.x * 10) / 10, y: Math.round(rawWorld.y * 10) / 10 };

      if (terrainTool === 'select') {
        setSelectedTerrainFeatureId(null);
        return;
      }

      if (terrainTool === 'label') {
        setTerrainLabelDraft({
          x: rawPt.x,
          y: rawPt.y,
          value: terrainLabelSubKind === 'water' ? '清澜江' : terrainLabelSubKind === 'district' ? '中心城区' : '科创片区'
        });
        return;
      }

      // 若在闭合多边形/环路绘制中点回首个顶点附近，优先自动闭合完成
      if (
        (terrainTool === 'waterArea' || terrainTool === 'zone' || terrainTool === 'road') &&
        terrainDraftPoints.length >= 3
      ) {
        const first = terrainDraftPoints[0];
        const closeDistWorld = 18 / Math.max(0.25, scale);
        if (Math.hypot(rawWorld.x - first.x, rawWorld.y - first.y) <= closeDistWorld) {
          finishTerrainDraft(true);
          setTerrainSnap(null);
          return;
        }
      }

      const snapped = snapTerrainDrawPoint({
        rawPoint: rawWorld,
        lightCity,
        tool: terrainTool,
        viewportScale: scale,
        altKey: Boolean(e.evt?.altKey)
      });
      const pt = { x: snapped.x, y: snapped.y };
      setTerrainDraftPoints((prev) => [...prev, pt]);
      return;
    }

    if (activeTool === 'select') {
      commitInlineRenameIfNeeded();
      setSelectedStationIds(new Set());
      setSelectedSectionId(null);
      setSelectedWaypoint(null);
      setArcEditorWaypoint(null);
      return;
    }

    if (activeTool === 'draw') {
      const rawWorld = getPointerWorldPosition(stage, pointer);
      const placingWaypoint = Boolean(drawAnchorStationId && (e.evt?.shiftKey || drawWaypointSubmode));

      // 若处于磁吸捕获站点圈内（16px），直接走站点起笔/连入逻辑，彻底避免在既有站边缘误建重叠站点
      if (!placingWaypoint) {
        const capturedStation = findNearestStationInDrawCapture(rawWorld, Boolean(e.evt?.altKey));
        if (capturedStation) {
          handleStationClickInDrawMode(capturedStation);
          return;
        }
      }

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

      if (placingWaypoint) {
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

    if (pendingSectionDragRef.current) {
      const pending = pendingSectionDragRef.current;
      pendingSectionDragRef.current = null;
      if (pending.insertedWaypointIndex !== null) {
        commitWaypointDrag();
        setSelectedWaypoint({ sectionId: pending.sectionId, waypointIndex: pending.insertedWaypointIndex });
        setSelectedSectionId(pending.sectionId);
      } else {
        commitInlineRenameIfNeeded();
        setSelectedSectionId(pending.sectionId);
        setSelectedStationIds(new Set());
        setSelectedWaypoint(null);
        setArcEditorWaypoint(null);
        onSelectLine?.(pending.lineId);
      }
      return;
    }

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
        setArcEditorWaypoint(null);
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
        const sw: [number, number] = [
          Math.min(...lngLatStations.map((station) => station.lng!)),
          Math.min(...lngLatStations.map((station) => station.lat!))
        ];
        const ne: [number, number] = [
          Math.max(...lngLatStations.map((station) => station.lng!)),
          Math.max(...lngLatStations.map((station) => station.lat!))
        ];
        const AMap = (window as any).AMap;
        const bounds = AMap?.Bounds ? new AMap.Bounds(sw, ne) : { sw, ne };
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
      case 'toggle_search':
        setSearchOpen((v) => !v);
        break;
      case 'open_guide':
        setOnboardingState({ open: true, view: 'cheatsheet' });
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
      if (onReadOnlyStationClick) {
        onReadOnlyStationClick(station);
        return;
      }
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
      setArcEditorWaypoint(null);
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
    setArcEditorWaypoint(null);
    setInlineRename({ stationId: station.id, value: station.name, originalName: station.name });
  };

  const handleStationRightClick = (e: any, station: Station) => {
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
    if (pointer) {
      setArcEditorWaypoint(null);
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
    if (isCompact) {
      commitInlineRenameIfNeeded();
      closeAllFloatingMenus();
      setArcEditorWaypoint(null);
      setSelectedWaypoint(null);
      setSelectedSectionId(null);
      setSelectedStationIds(new Set([station.id]));
      return;
    }
    const pointer = e.target.getStage()?.getPointerPosition();
    if (pointer) {
      setArcEditorWaypoint(null);
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
    if (terrainEditMode) {
      if (terrainDraftPoints.length > 0) {
        finishTerrainDraft(false);
      }
      return;
    }
    if (activeTool === 'draw' && (drawAnchorStationId || drawPendingWaypoints.length > 0)) {
      liftDrawingPen();
      return;
    }
    const stage = e.target.getStage();
    if (!stage || e.target !== stage) return;
    const pointer = stage.getPointerPosition();
    setArcEditorWaypoint(null);
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
  const scaledParallelGap = Math.max(3.8, Math.max(8.8, stylePreset.lineWidth + 4) * strokeScale);
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

  const parallelSceneData = useMemo(() => {
    if (!canvasSceneReady) {
      sectionParallelOffsetRef.current = new Map();
      return {
        segments: [] as Array<{
          section: Section;
          line: LineType;
          start: Station;
          end: Station;
          waypoints: Waypoint[];
          slotIndex: number;
          shiftedFlat: number[];
          renderFlat: number[];
        }>,
        parallelMetaBySectionId: new Map<string, SectionParallelMeta>(),
        stationTrackNudges: new Map<string, { dx: number; dy: number }>()
      };
    }

    const map = amapRef.current;
    const projectWp = (point: Waypoint) => {
      if (isAmapMode && amapReady && map && typeof point.lng === 'number' && typeof point.lat === 'number') {
        const pixel = map.lngLatToContainer?.([point.lng, point.lat]);
        if (pixel) return { x: pixel.x, y: pixel.y };
      }
      return { x: point.x, y: point.y };
    };

    const rawList: Array<{
      section: Section;
      line: LineType;
      start: Station;
      end: Station;
      waypoints: Waypoint[];
      controlPoints: RPoint[];
    }> = [];

    for (let i = 0; i < sections.length; i += 1) {
      const section = sections[i];
      const line = lineById.get(section.lineId);
      const start = stationById.get(section.startStationId);
      const end = stationById.get(section.endStationId);
      if (!line || !start || !end) continue;
      const startPoint = stationDisplayPoints[start.id] || { x: start.x, y: start.y };
      const endPoint = stationDisplayPoints[end.id] || { x: end.x, y: end.y };
      const wps = section.waypoints || [];
      const controlPoints: RPoint[] = [
        { x: startPoint.x, y: startPoint.y },
        ...wps.map((wp) => {
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
      rawList.push({
        section,
        line,
        start,
        end,
        waypoints: wps,
        controlPoints
      });
    }

    const layout = computeNetworkParallelLayout({
      sections: rawList.map((item) => ({
        id: item.section.id,
        lineId: item.section.lineId,
        startStationId: item.section.startStationId,
        endStationId: item.section.endStationId,
        points: item.controlPoints,
        parallelOrder: item.section.parallelOrder
      })),
      lineOrderMap,
      gap: scaledParallelGap,
      stationLineCounts
    });

    const offsetMap = new Map<string, number>();
    const prepared = rawList.map((seg) => {
      const meta = layout.bySectionId.get(seg.section.id);
      const directedOffset = meta?.directedOffset || 0;
      const slotIndex = meta?.slotIndex || 0;
      offsetMap.set(seg.section.id, directedOffset);

      const { shiftedFlat, renderFlat } = buildSectionRenderGeometry(
        seg.controlPoints,
        directedOffset,
        lineCornerRadius
      );

      return {
        section: seg.section,
        line: seg.line,
        start: seg.start,
        end: seg.end,
        waypoints: seg.waypoints,
        slotIndex,
        shiftedFlat,
        renderFlat
      };
    });

    sectionParallelOffsetRef.current = offsetMap;
    return {
      segments: prepared,
      parallelMetaBySectionId: layout.bySectionId,
      stationTrackNudges: layout.stationTrackNudges
    };
  }, [
    canvasSceneReady,
    sections,
    lineById,
    stationById,
    lineOrderMap,
    stationLineCounts,
    stationDisplayPoints,
    isAmapMode,
    amapReady,
    mapRenderTick,
    lineCornerRadius,
    scaledParallelGap,
    amapRef
  ]);

  const preparedLineSegments = parallelSceneData.segments;
  const parallelMetaBySectionId = parallelSceneData.parallelMetaBySectionId;
  const stationTrackNudges = parallelSceneData.stationTrackNudges;

  const handleReorderParallelSection = useCallback(
    (
      sectionId: string,
      direction: 'swap' | 'prev' | 'next' | 'reset',
      singleSectionOnly = false
    ) => {
      const sec = sectionById.get(sectionId);
      const meta = parallelMetaBySectionId.get(sectionId);
      if (!sec || !meta || meta.totalSlots < 2) return;

      const targetIds = new Set(
        singleSectionOnly ? meta.localGroupSectionIds : meta.corridorSectionIds
      );
      const nextOrder =
        direction === 'reset'
          ? undefined
          : moveLineInParallelOrder(meta.orderedLineIds, sec.lineId, direction);

      if (onApplyGraphTransaction) {
        onApplyGraphTransaction((graph) => ({
          ...graph,
          sections: graph.sections.map((item) =>
            targetIds.has(item.id) ? { ...item, parallelOrder: nextOrder } : item
          )
        }));
      } else if (onUpdateSection) {
        onBeginInteraction?.();
        targetIds.forEach((id) => {
          onUpdateSection(id, { parallelOrder: nextOrder });
        });
      }

      if (nextOrder) {
        const names = nextOrder
          .map((lid) => lineById.get(lid)?.name || lid)
          .join(' → ');
        const axisText = meta.axisHint === 'horizontal' ? '上→下' : '左→右';
        message.success?.(`已更新并行顺序（${axisText}）：${names}`);
      } else {
        message.success?.('已恢复默认并行顺序');
      }
    },
    [
      lineById,
      onApplyGraphTransaction,
      onBeginInteraction,
      onUpdateSection,
      parallelMetaBySectionId,
      sectionById
    ]
  );

  const isDarkCanvas = mapSettings.canvasTheme === 'dark';
  const canvasPalette = CANVAS_THEME_PALETTES[mapSettings.canvasTheme];
  const dotLabelStyle = mapSettings.dotLabelStyle;
  const amapStyle = mapSettings.baseMap.amap?.style || 'normal';
  const isLightAmapRender = isAmapMode && isMapInteracting;
  const isLightRender = isLightAmapRender || (!isAmapMode && isMapInteracting);
  const skipHeavyLayout = isMapInteracting || isDraggingNode;
  const isMutedAmapStyle = isAmapMode && (amapStyle === 'dark' || amapStyle === 'grey');
  const isFreshAmapStyle = isAmapMode && amapStyle === 'fresh';
  const usesDarkLabelSurface = isMutedAmapStyle || (!isFreshAmapStyle && isDarkCanvas);
  const readableLabelText = isMutedAmapStyle
    ? '#ffffff'
    : isFreshAmapStyle
      ? '#0f172a'
      : resolveReadableStationLabelColor(
          dotLabelStyle.color,
          isDarkCanvas,
          '#0f172a',
          canvasPalette.labelText
        );
  const readableLabelShadow = usesDarkLabelSurface
    ? 'rgba(2, 6, 23, 0.94)'
    : 'rgba(255, 255, 255, 0.98)';
  const lineBadgeColors = resolveLineBadgeColors(
    stylePreset.lineLabelFill,
    stylePreset.lineLabelText,
    isMutedAmapStyle || (!isAmapMode && isDarkCanvas)
  );

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
        // 仅高德地理底图模式下 stationDisplayPoints 为当前视口容器像素坐标；纯画布与轻城市模式为无限世界坐标，不应拿视口宽高误罚世界坐标站名
        if (
          isAmapMode &&
          (rect.x < 0 || rect.y < 0 || rect.x + rect.width > stageSize.width || rect.y + rect.height > stageSize.height)
        ) {
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

      // 若用户手工拖拽自定义过该线路标签的位置，优先采用用户放置点
      if (line.labelPosition) {
        let customCenter: { x: number; y: number } | null = null;
        if (
          isAmapMode &&
          typeof line.labelPosition.lng === 'number' &&
          typeof line.labelPosition.lat === 'number'
        ) {
          customCenter = projectLngLatToContainerPoint(line.labelPosition.lng, line.labelPosition.lat);
        } else if (!isAmapMode && Number.isFinite(line.labelPosition.x) && Number.isFinite(line.labelPosition.y)) {
          customCenter = { x: line.labelPosition.x, y: line.labelPosition.y };
        }
        if (customCenter && Number.isFinite(customCenter.x) && Number.isFinite(customCenter.y)) {
          const customRect = {
            x: customCenter.x - labelWidth / 2,
            y: customCenter.y - labelHeight / 2,
            width: labelWidth,
            height: labelHeight
          };
          occupiedGrid.insert(customRect);
          placements.push({ key: line.id, line, labelText, ...customRect });
          return;
        }
      }

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

  // 仅当用户通过右键菜单明确点击「调整圆弧」时才计算并显示圆弧控制拉杆与弹窗
  const activeWaypointArcGeometry = useMemo(() => {
    if (!arcEditorWaypoint) return null;
    const sec = sectionById.get(arcEditorWaypoint.sectionId);
    if (!sec || !sec.waypoints || !sec.waypoints[arcEditorWaypoint.waypointIndex]) return null;
    const idx = arcEditorWaypoint.waypointIndex;
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
  }, [arcEditorWaypoint, sectionById, stationById, stationDisplayPoints, lineCornerRadius, scale, isAmapMode, mapRenderTick]);

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
            insertedWaypointIndex: null,
            baseWaypoints: [...(seg.section.waypoints || [])]
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
            insertedWaypointIndex: null,
            baseWaypoints: [...(seg.section.waypoints || [])]
          };
        }
      };

      const handleSectionClick = (e: any) => {
        if (readOnly) {
          if (onReadOnlySectionClick) {
            e.cancelBubble = true;
            onReadOnlySectionClick(seg.section);
          }
          return;
        }
        const button = e.evt?.button;
        if (button !== undefined && button !== 0) return;
        if (e.evt?.touches !== undefined && !touchTapAllowedRef.current) return;
        const stage = e.target.getStage();
        const pointer = stage?.getPointerPosition?.();
        if (!stage || !pointer) return;

        if (activeTool === 'draw') {
          e.cancelBubble = true;
          const worldPos = getPointerWorldPosition(stage, pointer);
          const captured = findNearestStationInDrawCapture(worldPos, Boolean(e.evt?.altKey));
          if (captured) {
            handleStationClickInDrawMode(captured);
            return;
          }
          insertStationIntoSectionAt(seg.section, worldPos, pointer, Boolean(drawAnchorStationId));
          return;
        }

        if (isCompact && activeTool === 'select') {
          e.cancelBubble = true;
          commitInlineRenameIfNeeded();
          closeAllFloatingMenus();
          lastSectionTapRef.current = {
            sectionId: seg.section.id,
            world: getPointerWorldPosition(stage, pointer),
            screen: { x: pointer.x, y: pointer.y }
          };
          setArcEditorWaypoint(null);
          setSelectedWaypoint(null);
          setSelectedStationIds(new Set());
          setSelectedSectionId(seg.section.id);
          onSelectLine?.(seg.line.id);
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
        setArcEditorWaypoint(null);
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
          ref={(node) => {
            if (node) sectionHitNodeMapRef.current.set(seg.section.id, node);
            else sectionHitNodeMapRef.current.delete(seg.section.id);
          }}
          points={renderFlat}
          stroke="rgba(0,0,0,0.001)"
          strokeWidth={hitStroke}
          hitStrokeWidth={hitStroke}
          lineCap="round"
          lineJoin="round"
          perfectDrawEnabled={false}
          listening={activeTool !== 'pan' && !isSpaceHeld}
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
          ref={(node) => {
            if (node) sectionVisNodeMapRef.current.set(seg.section.id, node);
            else sectionVisNodeMapRef.current.delete(seg.section.id);
          }}
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
  const drawSnapStation = drawSnapStationId ? stationById.get(drawSnapStationId) || null : null;

  const activeCanvasCursor =
    isSpaceHeld || activeTool === 'pan'
      ? isDragging
        ? 'grabbing'
        : 'grab'
      : terrainEditMode
        ? terrainTool === 'select'
          ? 'default'
          : 'crosshair'
        : activeTool === 'draw'
          ? 'crosshair'
          : 'default';

  const lightCityPalette = getLightCityPalette(isDarkCanvas);
  const effectiveCanvasBg = isLightCityMode ? lightCityPalette.canvasBg : canvasBackgroundColor;

  return (
    <div
      ref={containerRef}
      onPointerMove={handleContainerPointerMove}
      onPointerLeave={hideCursorDot}
      onTouchCancel={handleTouchCancel}
      className={`metro-canvas-surface ${isDarkCanvas ? 'is-canvas-dark' : ''}`}
      data-map-mode={mapSettings.baseMap.mode}
      aria-busy={!canvasSceneReady}
      style={
        {
          width: '100%',
          height: '100%',
          '--metro-canvas-bg': effectiveCanvasBg,
          backgroundColor: effectiveCanvasBg,
          backgroundImage: !isAmapMode && !isLightCityMode && canvasBackgroundImage ? `url(${canvasBackgroundImage})` : undefined,
          backgroundSize: !isAmapMode && !isLightCityMode && canvasBackgroundImage ? 'cover' : undefined,
          backgroundPosition: !isAmapMode && !isLightCityMode && canvasBackgroundImage ? 'center' : undefined,
          backgroundRepeat: !isAmapMode && !isLightCityMode && canvasBackgroundImage ? 'no-repeat' : undefined
        } as React.CSSProperties
      }
    >
      {/* 0ms GPU 硬件直连跟随小圆点（仅在绘制模式空白区激活，重合既有站时自动隐身让位） */}
      <div ref={cursorDotDomRef} className="metro-draw-cursor-dot" style={{ opacity: 0 }} aria-hidden="true" />
      {/* 移动端按住偏移 52px 瞄准连接杆与十字准星靶环（零重绘 GPU 跟随） */}
      <div ref={touchAimStemDomRef} className="metro-touch-aim-stem" style={{ opacity: 0 }} aria-hidden="true" />
      <div ref={touchAimDomRef} className="metro-touch-aim-reticle" style={{ opacity: 0 }} aria-hidden="true" />

      {/* 绘制模式下靠近既有站点的重合动作提示标 */}
      {!readOnly && activeTool === 'draw' && drawSnapStation && (() => {
        const screen = worldToScreenPoint(getDisplayPoint(drawSnapStation));
        const left = Math.max(72, Math.min(screen.x, stageSize.width - 72));
        const top = Math.max(54, screen.y - 18);
        let label = '';
        let dotColor = currentLine?.color || '#3b82f6';
        if (!drawAnchorStationId) {
          label = isEn ? `Start from "${drawSnapStation.name}"` : `从「${drawSnapStation.name}」起笔`;
        } else if (drawAnchorStationId === drawSnapStation.id) {
          label = isEn ? 'Click to lift pen' : '点击抬笔结束当前段';
          dotColor = '#f59e0b';
        } else if (currentLine?.stationIds.includes(drawSnapStation.id)) {
          label = isEn ? `Close loop to "${drawSnapStation.name}"` : `连接闭合至「${drawSnapStation.name}」`;
          dotColor = '#10b981';
        } else {
          label = isEn ? `Transfer at "${drawSnapStation.name}"` : `接入「${drawSnapStation.name}」换乘`;
          dotColor = '#3b82f6';
        }
        return (
          <div className="metro-draw-snap-badge" style={{ left, top }}>
            <span className="metro-draw-snap-badge__dot" style={{ backgroundColor: dotColor }} />
            <span>{label}</span>
          </div>
        );
      })()}

      {lines.length === 0 &&
        stations.length === 0 &&
        sections.length === 0 &&
        !isAmapMode &&
        !isLightCityMode &&
        !canvasBackgroundImage &&
        onCreateLine &&
        onStartWithAmap && (
          <CanvasStartPrompt
            language={language}
            onCreateLine={onCreateLine}
            onStartWithLightCity={onStartWithLightCity}
            onStartWithAmap={onStartWithAmap}
          />
        )}

      {isAmapMode && (
        <div
          ref={amapContainerRef}
          className="metro-amap-layer"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 0,
            background: isDarkCanvas ? '#07111f' : '#eef6ff'
          }}
        />
      )}

      {!canvasSceneReady && (() => {
        const darkLoadingSurface =
          isDarkCanvas ||
          (isAmapMode && amapStyle === 'dark') ||
          (typeof document !== 'undefined' && document.body?.dataset?.interfaceTheme === 'dark');
        return (
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
            background: darkLoadingSurface ? '#0b1220' : '#f1f5f9',
            color: darkLoadingSurface ? '#e2e8f0' : '#475569'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, maxWidth: 440, padding: 28, fontSize: 15 }}>
            {!amapError && <Spin />}
            <span>{amapError || (isEn ? 'Loading map and network…' : '正在加载地图与线网…')}</span>
          </div>
        </div>
        );
      })()}

      {/* 顶部三态主工具栏（桌面端居左上，移动端居顶居中，全程保持稳定 DOM 节点以支持横向滑动弹性反馈） */}
      <div className="metro-canvas-tools">
        <div
          ref={toolGroupRef}
          className="metro-tool-group"
          data-active-tool={terrainEditMode && activeTool !== 'pan' ? 'none' : activeTool}
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
                  className={`metro-tool-button ${active && !terrainEditMode ? 'is-active' : ''}`}
                  data-tool-index={index}
                  onClick={() => {
                    if (terrainEditMode && tool.key !== 'pan') {
                      setTerrainEditMode(false);
                      setTerrainDraftPoints([]);
                      setTerrainSnap(null);
                    }
                    setCanvasTool(tool.key);
                  }}
                  aria-label={tool.label}
                  aria-pressed={active && !terrainEditMode}
                >
                  <span className="metro-tool-button__icon">{tool.icon}</span>
                  <span className="metro-tool-button__label">{tool.label}</span>
                </button>
              </Tooltip>
            );
          })}
        </div>

        {!readOnly && !terrainEditMode && (isLightCityMode || activeTool === 'draw') && (
          <div className="metro-canvas-tools__subrow">
            {isLightCityMode && (
              <button
                type="button"
                className="metro-draw-subbar__pill metro-lightcity-entry-btn"
                onClick={() => {
                  liftDrawingPen();
                  setSelectedStationIds(new Set());
                  setSelectedSectionId(null);
                  setSelectedWaypoint(null);
                  setArcEditorWaypoint(null);
                  setTerrainEditMode(true);
                }}
              >
                <CompassOutlined />
                <span>{isEn ? 'Edit Basemap' : '编辑底图'}</span>
              </button>
            )}

            {activeTool === 'draw' && (
              <div className="metro-draw-subbar" role="group" aria-label="绘制辅助选项">
                <Dropdown
                  trigger={['click']}
                  placement="bottomLeft"
                  menu={{
                    items: [
                      ...lines.map((line) => ({
                        key: line.id,
                        label: (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: line.id === currentLineId ? 700 : 500 }}>
                            <span style={{ width: 9, height: 9, borderRadius: '50%', backgroundColor: line.color, flexShrink: 0 }} />
                            <span>{line.name}</span>
                          </span>
                        ),
                        onClick: () => onSelectLine?.(line.id)
                      })),
                      ...(onCreateLine
                        ? [
                            ...(lines.length > 0 ? [{ type: 'divider' as const }] : []),
                            {
                              key: '__create_line__',
                              icon: <PlusOutlined />,
                              label: isEn ? 'New line…' : '新建线路…',
                              onClick: () => onCreateLine()
                            }
                          ]
                        : [])
                    ]
                  }}
                >
                  {currentLine ? (
                    <button
                      type="button"
                      className="metro-draw-subbar__line metro-draw-subbar__line-btn"
                      title={isEn ? 'Switch line' : '点击切换绘制线路'}
                    >
                      <span className="metro-draw-subbar__swatch" style={{ backgroundColor: currentLine.color }} />
                      <span>{currentLine.name}</span>
                      <DownOutlined style={{ fontSize: 9, opacity: 0.65 }} />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="metro-draw-subbar__pill"
                      onClick={() => {
                        if (lines.length === 0 && onCreateLine) onCreateLine();
                      }}
                    >
                      {lines.length > 0
                        ? isEn
                          ? 'Select line ▾'
                          : '选择绘制线路 ▾'
                        : isEn
                          ? '+ Create first line'
                          : '+ 新建第一条线路'}
                    </button>
                  )}
                </Dropdown>
                {anchorStation ? (
                  <>
                    <span className="metro-draw-subbar__sep" />
                    <ElasticCapsuleTabs<'station' | 'bend'>
                      size="sm"
                      ariaLabel="落点模式切换"
                      value={drawWaypointSubmode ? 'bend' : 'station'}
                      onChange={(mode) => setDrawWaypointSubmode(mode === 'bend')}
                      options={[
                        { value: 'station', label: isEn ? 'Station' : '落站点' },
                        {
                          value: 'bend',
                          label: `${isEn ? 'Bend' : '打拐点'}${
                            drawPendingWaypoints.length > 0 ? ` (${drawPendingWaypoints.length})` : ''
                          }`
                        }
                      ]}
                    />
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
          </div>
        )}

        {!readOnly && isLightCityMode && terrainEditMode && (
          <LightCitySculptBar
            tool={terrainTool}
            onChangeTool={(next) => {
              setTerrainDraftPoints([]);
              setTerrainSnap(null);
              setTerrainLabelDraft(null);
              setTerrainTool(next);
            }}
            riverWidth={terrainRiverWidth}
            onChangeRiverWidth={setTerrainRiverWidth}
            waterSubKind={terrainWaterSubKind}
            onChangeWaterSubKind={setTerrainWaterSubKind}
            zoneSubKind={terrainZoneSubKind}
            onChangeZoneSubKind={setTerrainZoneSubKind}
            roadSubKind={terrainRoadSubKind}
            onChangeRoadSubKind={setTerrainRoadSubKind}
            labelSubKind={terrainLabelSubKind}
            onChangeLabelSubKind={setTerrainLabelSubKind}
            draftPointCount={terrainDraftPoints.length}
            onFinishDraft={(closeLoop) => {
              finishTerrainDraft(closeLoop);
              setTerrainSnap(null);
            }}
            onCancelDraft={() => {
              setTerrainDraftPoints([]);
              setTerrainSnap(null);
            }}
            selectedFeature={selectedTerrainFeature}
            onUpdateSelectedFeature={(patch) => {
              if (!selectedTerrainFeatureId) return;
              commitLightCityUpdate((cur) => ({
                ...cur,
                features: cur.features.map((f) =>
                  f.id === selectedTerrainFeatureId ? ({ ...f, ...patch } as LightCityFeature) : f
                )
              }));
            }}
            onDeleteSelectedFeature={deleteSelectedTerrainFeature}
            onRerollCity={handleRerollLightCity}
            onOpenTemplatePicker={() => onStartWithLightCity?.()}
            onExitSculpt={() => {
              setTerrainDraftPoints([]);
              setTerrainSnap(null);
              setSelectedTerrainFeatureId(null);
              setTerrainLabelDraft(null);
              setTerrainEditMode(false);
            }}
            language={language}
          />
        )}

        {!readOnly && selectedStationIds.size > 1 && (
          <div className="metro-multiselect-bar" onMouseDown={(e) => e.stopPropagation()}>
            <span>
              {isEn
                ? `${selectedStationIds.size} selected`
                : `已选 ${selectedStationIds.size} 站`}
            </span>
            <button
              type="button"
              className="metro-multiselect-bar__btn metro-multiselect-bar__btn--danger"
              onClick={deleteSelectedItems}
            >
              {isEn ? 'Delete' : '删除'}
            </button>
            <button
              type="button"
              className="metro-multiselect-bar__btn"
              onClick={() => setSelectedStationIds(new Set())}
            >
              {isEn ? 'Clear' : '取消'}
            </button>
          </div>
        )}
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

      {/* 右下角画布 HUD（右侧按钮统一 topRight 对齐，彻底防止 Tooltip 越过视口右边界撑出滚动条） */}
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
          <Tooltip title={text.zoomOut} placement="top">
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
          <Tooltip title={text.zoomIn} placement="top">
            <button type="button" className="metro-canvas-hud__btn" onClick={zoomIn} aria-label={text.zoomIn}>
              +
            </button>
          </Tooltip>
          <span className="metro-canvas-hud__divider" />
          <Tooltip title={text.fitView} placement="topRight">
            <button type="button" className="metro-canvas-hud__btn" onClick={() => fitView()} aria-label={text.fitView}>
              □
            </button>
          </Tooltip>
          <Tooltip title={text.resetView} placement="topRight">
            <button type="button" className="metro-canvas-hud__btn" onClick={resetView} aria-label={text.resetView}>
              ⌂
            </button>
          </Tooltip>
          <span className="metro-canvas-hud__divider" />
          <Tooltip title={text.search} placement="topRight">
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
            <Tooltip title={text.guide} placement="topRight">
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
        {/* 底层独立静态底图 Layer（listening=false，无命中缓冲）：
            鼠标移动、悬停站点、绘制预览线、拖拽站点时此 Layer 零重绘；平移/缩放时直接贴预渲染羽化超采样位图或 Path2D 合批 */}
        <Layer listening={false}>
          {canvasSceneReady && (
            <>
              <Rect
                x={-50000}
                y={-50000}
                width={100000}
                height={100000}
                fill={isAmapMode ? 'rgba(0,0,0,0)' : effectiveCanvasBg}
                listening={false}
                perfectDrawEnabled={false}
              />
              {isLightCityMode && lightCity && !terrainEditMode && (
                <Shape
                  listening={false}
                  perfectDrawEnabled={false}
                  sceneFunc={(konvaCtx) => {
                    const rawCtx = (konvaCtx as any)._context as CanvasRenderingContext2D | undefined;
                    if (!rawCtx) return;
                    drawLightCityToCanvas2D({
                      ctx: rawCtx,
                      lightCity,
                      isDark: isDarkCanvas,
                      worldToCanvas: (pt) => pt,
                      worldScale: 1,
                      identityWorldTransform: true
                    });
                  }}
                />
              )}
            </>
          )}
        </Layer>

        <Layer listening={canvasSceneReady && activeTool !== 'pan' && !isSpaceHeld}>
          {canvasSceneReady && (
            <>
              {/* 底图造景态（terrainEditMode）：挂载逐要素可交互 Konva 节点，支持直接点选拖拽塑形 */}
              {isLightCityMode && lightCity && terrainEditMode && (
                <Group
                  opacity={Math.max(0.25, Math.min(1, lightCity.opacity ?? 1))}
                  listening={!readOnly && terrainEditMode && terrainTool === 'select' && activeTool !== 'pan' && !isSpaceHeld}
                >
                  {/* 1. 城区板块与公园绿地 */}
                  {lightCity.layerVisibility.zones &&
                    lightCity.features.map((f) => {
                      if (f.type !== 'zone' || f.kind === 'island') return null;
                      if (shouldFeatherLightCityEdges(lightCity) && f.kind === 'urban') return null;
                      const isSel = terrainEditMode && selectedTerrainFeatureId === f.id;
                      const flat = sampleSmoothClosedPolygon(f.points, resolveLightCityPolygonIterations(f.points));
                      return (
                        <Line
                          key={f.id}
                          points={flat}
                          closed
                          fill={f.kind === 'park' ? lightCityPalette.parkFill : lightCityPalette.urbanFill}
                          stroke={
                            isSel
                              ? '#2563eb'
                              : f.kind === 'park'
                                ? lightCityPalette.parkStroke
                                : lightCityPalette.urbanStroke
                          }
                          strokeWidth={isSel ? 2.4 / Math.max(0.35, viewportScaleForHit) : 1.2}
                          perfectDrawEnabled={false}
                          onClick={(e) => {
                            if (!terrainEditMode || terrainTool !== 'select') return;
                            e.cancelBubble = true;
                            setSelectedTerrainFeatureId(f.id);
                          }}
                          onTap={(e) => {
                            if (!terrainEditMode || terrainTool !== 'select') return;
                            e.cancelBubble = true;
                            setSelectedTerrainFeatureId(f.id);
                          }}
                        />
                      );
                    })}

                  {/* 2. 湖海面与主干河流（双遍融合：Pass 1 先铺全部水系外岸线，Pass 2 再统一铺水体填充，彻底消除多条河流重合/分汊/入海口处的深色断缝） */}
                  {lightCity.layerVisibility.water && (
                    <>
                      {lightCity.features.map((f) => {
                        const isSel = terrainEditMode && selectedTerrainFeatureId === f.id;
                        if (f.type === 'waterArea') {
                          const flat = sampleSmoothClosedPolygon(f.points, resolveLightCityPolygonIterations(f.points));
                          return (
                            <Line
                              key={`wb_${f.id}`}
                              points={flat}
                              closed
                              fill={lightCityPalette.waterBank}
                              stroke={isSel ? '#2563eb' : lightCityPalette.waterBank}
                              strokeWidth={isSel ? 3.2 / Math.max(0.35, viewportScaleForHit) : 2.6}
                              lineJoin="round"
                              perfectDrawEnabled={false}
                              listening={false}
                            />
                          );
                        }
                        if (f.type === 'river') {
                          const flat = sampleSmoothOpenSpline(f.points, resolveLightCitySplineSegments(f.points));
                          const bankAdd = f.width < 12 ? 2 : 3;
                          return (
                            <Line
                              key={`wb_${f.id}`}
                              points={flat}
                              stroke={isSel ? '#2563eb' : lightCityPalette.waterBank}
                              strokeWidth={f.width + bankAdd}
                              lineCap="round"
                              lineJoin="round"
                              perfectDrawEnabled={false}
                              listening={false}
                            />
                          );
                        }
                        return null;
                      })}
                      {lightCity.features.map((f) => {
                        if (f.type === 'waterArea') {
                          const flat = sampleSmoothClosedPolygon(f.points, resolveLightCityPolygonIterations(f.points));
                          return (
                            <Line
                              key={`wf_${f.id}`}
                              points={flat}
                              closed
                              fill={lightCityPalette.waterFill}
                              strokeEnabled={false}
                              perfectDrawEnabled={false}
                              onClick={(e) => {
                                if (!terrainEditMode || terrainTool !== 'select') return;
                                e.cancelBubble = true;
                                setSelectedTerrainFeatureId(f.id);
                              }}
                              onTap={(e) => {
                                if (!terrainEditMode || terrainTool !== 'select') return;
                                e.cancelBubble = true;
                                setSelectedTerrainFeatureId(f.id);
                              }}
                            />
                          );
                        }
                        if (f.type === 'river') {
                          const flat = sampleSmoothOpenSpline(f.points, resolveLightCitySplineSegments(f.points));
                          return (
                            <Line
                              key={`wf_${f.id}`}
                              points={flat}
                              stroke={lightCityPalette.waterFill}
                              strokeWidth={f.width}
                              hitStrokeWidth={Math.max(f.width, 22 / Math.max(0.35, viewportScaleForHit))}
                              lineCap="round"
                              lineJoin="round"
                              perfectDrawEnabled={false}
                              onClick={(e) => {
                                if (!terrainEditMode || terrainTool !== 'select') return;
                                e.cancelBubble = true;
                                setSelectedTerrainFeatureId(f.id);
                              }}
                              onTap={(e) => {
                                if (!terrainEditMode || terrainTool !== 'select') return;
                                e.cancelBubble = true;
                                setSelectedTerrainFeatureId(f.id);
                              }}
                            />
                          );
                        }
                        return null;
                      })}
                    </>
                  )}

                  {/* 3. 江心洲与海湾离岛 */}
                  {(lightCity.layerVisibility.water || lightCity.layerVisibility.zones) &&
                    lightCity.features.map((f) => {
                      if (f.type !== 'zone' || f.kind !== 'island') return null;
                      const isSel = terrainEditMode && selectedTerrainFeatureId === f.id;
                      const flat = sampleSmoothClosedPolygon(f.points, resolveLightCityPolygonIterations(f.points));
                      return (
                        <Line
                          key={f.id}
                          points={flat}
                          closed
                          fill={lightCityPalette.islandFill}
                          stroke={isSel ? '#2563eb' : lightCityPalette.islandStroke}
                          strokeWidth={isSel ? 2.4 / Math.max(0.35, viewportScaleForHit) : 1.5}
                          perfectDrawEnabled={false}
                          onClick={(e) => {
                            if (!terrainEditMode || terrainTool !== 'select') return;
                            e.cancelBubble = true;
                            setSelectedTerrainFeatureId(f.id);
                          }}
                          onTap={(e) => {
                            if (!terrainEditMode || terrainTool !== 'select') return;
                            e.cancelBubble = true;
                            setSelectedTerrainFeatureId(f.id);
                          }}
                        />
                      );
                    })}

                  {/* 4. 三级道路与环路（双遍融合：路口交汇无缝贯通） */}
                  {lightCity.layerVisibility.roads && (
                    <>
                      {lightCity.features.map((f) => {
                        if (f.type !== 'road') return null;
                        const isSel = terrainEditMode && selectedTerrainFeatureId === f.id;
                        const closed = Boolean(f.closed);
                        const m = resolveLightCityRoadMetrics(f.kind, f.points.length, lightCityPalette);
                        const flat = sampleRoundedRoadPolyline(f.points, closed, m.cornerRadius);
                        return (
                          <Line
                            key={`ro_${f.id}`}
                            points={flat}
                            closed={closed}
                            stroke={isSel ? '#2563eb' : m.outerColor}
                            strokeWidth={m.outerW}
                            lineCap="round"
                            lineJoin="round"
                            perfectDrawEnabled={false}
                            listening={false}
                          />
                        );
                      })}
                      {lightCity.features.map((f) => {
                        if (f.type !== 'road') return null;
                        const closed = Boolean(f.closed);
                        const m = resolveLightCityRoadMetrics(f.kind, f.points.length, lightCityPalette);
                        const flat = sampleRoundedRoadPolyline(f.points, closed, m.cornerRadius);
                        return (
                          <Line
                            key={`ri_${f.id}`}
                            points={flat}
                            closed={closed}
                            stroke={m.innerColor}
                            strokeWidth={m.innerW}
                            hitStrokeWidth={Math.max(m.outerW + 10, 18 / Math.max(0.35, viewportScaleForHit))}
                            lineCap="round"
                            lineJoin="round"
                            perfectDrawEnabled={false}
                            onClick={(e) => {
                              if (!terrainEditMode || terrainTool !== 'select') return;
                              e.cancelBubble = true;
                              setSelectedTerrainFeatureId(f.id);
                            }}
                            onTap={(e) => {
                              if (!terrainEditMode || terrainTool !== 'select') return;
                              e.cancelBubble = true;
                              setSelectedTerrainFeatureId(f.id);
                            }}
                          />
                        );
                      })}
                    </>
                  )}

                  {/* 5. 极简片区水印地名 */}
                  {lightCity.layerVisibility.labels &&
                    lightCity.features.map((f) => {
                      if (f.type !== 'label') return null;
                      const isSel = terrainEditMode && selectedTerrainFeatureId === f.id;
                      const fontSize = f.kind === 'district' ? 20 : f.kind === 'water' ? 15 : 16;
                      const boxW = Math.max(120, f.text.length * (fontSize + 6));
                      const fill = isSel
                        ? '#2563eb'
                        : f.kind === 'district'
                          ? lightCityPalette.labelDistrict
                          : f.kind === 'water'
                            ? lightCityPalette.labelWater
                            : lightCityPalette.labelSubdistrict;
                      return (
                        <Text
                          key={f.id}
                          x={f.x - boxW / 2}
                          y={f.y - fontSize * 0.7}
                          width={boxW}
                          height={fontSize * 1.4}
                          align="center"
                          verticalAlign="middle"
                          text={f.text}
                          fontSize={fontSize}
                          fontStyle={f.kind === 'water' ? 'italic bold' : 'bold'}
                          letterSpacing={3}
                          fill={fill}
                          perfectDrawEnabled={false}
                          draggable={!readOnly && terrainEditMode && terrainTool === 'select' && !isSpaceHeld}
                          onClick={(e) => {
                            if (!terrainEditMode || terrainTool !== 'select') return;
                            e.cancelBubble = true;
                            setSelectedTerrainFeatureId(f.id);
                          }}
                          onTap={(e) => {
                            if (!terrainEditMode || terrainTool !== 'select') return;
                            e.cancelBubble = true;
                            if (selectedTerrainFeatureId === f.id) {
                              setTerrainLabelDraft({
                                x: f.x,
                                y: f.y,
                                value: f.text,
                                editingFeatureId: f.id
                              });
                            } else {
                              setSelectedTerrainFeatureId(f.id);
                            }
                          }}
                          onDblClick={(e) => {
                            if (!terrainEditMode) return;
                            e.cancelBubble = true;
                            setSelectedTerrainFeatureId(f.id);
                            setTerrainLabelDraft({
                              x: f.x,
                              y: f.y,
                              value: f.text,
                              editingFeatureId: f.id
                            });
                          }}
                          onDragEnd={(e) => {
                            const nx = Math.round((e.target.x() + boxW / 2) * 10) / 10;
                            const ny = Math.round((e.target.y() + fontSize * 0.7) * 10) / 10;
                            commitLightCityUpdate((cur) => ({
                              ...cur,
                              features: cur.features.map((item) =>
                                item.id === f.id && item.type === 'label' ? { ...item, x: nx, y: ny } : item
                              )
                            }));
                          }}
                        />
                      );
                    })}
                </Group>
              )}

              {/* 底图造景态：选中要素的节点拖拽与中点插入控制柄 + 正在绘制的河道/片区/干道实时预览 */}
              {!readOnly && isLightCityMode && terrainEditMode && (
                <Group listening={activeTool !== 'pan' && !isSpaceHeld}>
                  {terrainTool === 'select' &&
                    selectedTerrainFeature &&
                    selectedTerrainFeature.type !== 'label' && (() => {
                      const pts = selectedTerrainFeature.points;
                      const isClosed =
                        selectedTerrainFeature.type === 'zone' ||
                        selectedTerrainFeature.type === 'waterArea' ||
                        Boolean(selectedTerrainFeature.type === 'road' && selectedTerrainFeature.closed);
                      const minPts =
                        selectedTerrainFeature.type === 'river' ||
                        (selectedTerrainFeature.type === 'road' && !selectedTerrainFeature.closed)
                          ? 2
                          : 3;
                      const handleR = 6 / Math.max(0.35, viewportScaleForHit);
                      const midR = 4.2 / Math.max(0.35, viewportScaleForHit);
                      const edgeCount = isClosed ? pts.length : Math.max(0, pts.length - 1);

                      return (
                        <>
                          <Line
                            points={pts.flatMap((p) => [p.x, p.y])}
                            closed={isClosed}
                            stroke="#3b82f6"
                            strokeWidth={1.3 / Math.max(0.35, viewportScaleForHit)}
                            dash={[5 / Math.max(0.35, viewportScaleForHit), 4 / Math.max(0.35, viewportScaleForHit)]}
                            listening={false}
                            perfectDrawEnabled={false}
                          />
                          {/* 边中点加点手柄：单击即可在该边插入新节点方便精细塑形 */}
                          {Array.from({ length: edgeCount }).map((_, idx) => {
                            const a = pts[idx];
                            const b = pts[(idx + 1) % pts.length];
                            const mx = Math.round(((a.x + b.x) / 2) * 10) / 10;
                            const my = Math.round(((a.y + b.y) / 2) * 10) / 10;
                            return (
                              <Circle
                                key={`lc_mid_${selectedTerrainFeature.id}_${idx}`}
                                x={mx}
                                y={my}
                                radius={midR}
                                fill="#dbeafe"
                                stroke="#2563eb"
                                strokeWidth={1.4 / Math.max(0.35, viewportScaleForHit)}
                                hitStrokeWidth={12 / Math.max(0.35, viewportScaleForHit)}
                                onClick={(e) => {
                                  e.cancelBubble = true;
                                  commitLightCityUpdate((cur) => ({
                                    ...cur,
                                    features: cur.features.map((item) => {
                                      if (item.id !== selectedTerrainFeature.id || item.type === 'label') return item;
                                      const nextPts = [
                                        ...item.points.slice(0, idx + 1),
                                        { x: mx, y: my },
                                        ...item.points.slice(idx + 1)
                                      ];
                                      return { ...item, points: nextPts };
                                    })
                                  }));
                                }}
                              />
                            );
                          })}
                          {/* 顶点拖拽与双击删点手柄 */}
                          {pts.map((pt, idx) => (
                            <Circle
                              key={`lc_vtx_${selectedTerrainFeature.id}_${idx}`}
                              x={pt.x}
                              y={pt.y}
                              radius={handleR}
                              fill="#ffffff"
                              stroke="#2563eb"
                              strokeWidth={2 / Math.max(0.35, viewportScaleForHit)}
                              hitStrokeWidth={14 / Math.max(0.35, viewportScaleForHit)}
                              draggable
                              onClick={(e) => {
                                e.cancelBubble = true;
                              }}
                              onDblClick={(e) => {
                                e.cancelBubble = true;
                                if (pts.length <= minPts) return;
                                commitLightCityUpdate((cur) => ({
                                  ...cur,
                                  features: cur.features.map((item) => {
                                    if (item.id !== selectedTerrainFeature.id || item.type === 'label') return item;
                                    return {
                                      ...item,
                                      points: item.points.filter((_, i) => i !== idx)
                                    };
                                  })
                                }));
                              }}
                              onDragEnd={(e) => {
                                const nx = Math.round(e.target.x() * 10) / 10;
                                const ny = Math.round(e.target.y() * 10) / 10;
                                commitLightCityUpdate((cur) => ({
                                  ...cur,
                                  features: cur.features.map((item) => {
                                    if (item.id !== selectedTerrainFeature.id || item.type === 'label') return item;
                                    return {
                                      ...item,
                                      points: item.points.map((p, i) => (i === idx ? { x: nx, y: ny } : p))
                                    };
                                  })
                                }));
                              }}
                            />
                          ))}
                        </>
                      );
                    })()}

                  {/* 绘制新河流/水体/干道/片区时：显影同类既有要素的历史节点锚点（大体量实景城市自动按鼠标邻域裁剪避免数千圆点卡顿） + 实时磁吸靶环 */}
                  {terrainTool !== 'select' && terrainTool !== 'label' && lightCity && (() => {
                    const invS = 1 / Math.max(0.35, viewportScaleForHit);
                    const denseScene = lightCity.features.length > 100;
                    const localR = 160 * invS;
                    const refVertices: Array<{ key: string; x: number; y: number }> = [];
                    lightCity.features.forEach((f) => {
                      if (f.type === 'label') return;
                      const match =
                        terrainTool === 'river' || terrainTool === 'waterArea'
                          ? f.type === 'river' || f.type === 'waterArea'
                          : terrainTool === 'road'
                            ? f.type === 'road'
                            : f.type === 'zone';
                      if (!match) return;
                      f.points.forEach((pt, idx) => {
                        if (denseScene) {
                          if (!terrainHoverWorld) return;
                          if (Math.abs(pt.x - terrainHoverWorld.x) > localR || Math.abs(pt.y - terrainHoverWorld.y) > localR) return;
                          if (refVertices.length >= 260) return;
                        }
                        refVertices.push({ key: `ref_${f.id}_${idx}`, x: pt.x, y: pt.y });
                      });
                    });
                    const snapText = terrainSnap?.snapped
                      ? terrainSnap.kind === 'vertex'
                        ? isEn
                          ? 'Snap to node'
                          : '接入既有节点'
                        : isEn
                          ? 'Branch / merge'
                          : terrainTool === 'road'
                            ? '接入既有干道'
                            : '从河道分汊/汇入'
                      : '';
                    return (
                      <>
                        {refVertices.map((rv) => (
                          <Circle
                            key={rv.key}
                            x={rv.x}
                            y={rv.y}
                            radius={4.2 * invS}
                            fill="#ffffff"
                            stroke="#3b82f6"
                            strokeWidth={1.6 * invS}
                            opacity={0.78}
                            listening={false}
                            perfectDrawEnabled={false}
                          />
                        ))}
                        {terrainSnap?.snapped && (
                          <Group x={terrainSnap.x} y={terrainSnap.y} listening={false}>
                            <Circle
                              radius={8.5 * invS}
                              fill="rgba(37, 99, 235, 0.16)"
                              stroke="#2563eb"
                              strokeWidth={2 * invS}
                              perfectDrawEnabled={false}
                            />
                            <Circle
                              radius={3.4 * invS}
                              fill="#2563eb"
                              perfectDrawEnabled={false}
                            />
                            {snapText && (
                              <Text
                                x={11 * invS}
                                y={-7 * invS}
                                text={snapText}
                                fontSize={11.5 * invS}
                                fontStyle="bold"
                                fill="#1d4ed8"
                                perfectDrawEnabled={false}
                              />
                            )}
                          </Group>
                        )}
                      </>
                    );
                  })()}

                  {/* 正在落点绘制中的地形草稿实时预览 */}
                  {terrainDraftPoints.length > 0 && (() => {
                    const previewPts = terrainHoverWorld
                      ? [...terrainDraftPoints, terrainHoverWorld]
                      : terrainDraftPoints;
                    const isPoly = terrainTool === 'waterArea' || terrainTool === 'zone';
                    const flat =
                      terrainTool === 'river'
                        ? sampleSmoothOpenSpline(previewPts, 8)
                        : isPoly && previewPts.length >= 3
                          ? sampleSmoothClosedPolygon(previewPts, 2)
                          : sampleRoundedRoadPolyline(previewPts, false, 30);
                    return (
                      <>
                        <Line
                          points={flat}
                          closed={isPoly && previewPts.length >= 3}
                          fill={
                            terrainTool === 'waterArea'
                              ? terrainWaterSubKind === 'island'
                                ? 'rgba(246, 247, 249, 0.86)'
                                : 'rgba(200, 225, 244, 0.72)'
                              : terrainTool === 'zone'
                                ? terrainZoneSubKind === 'park'
                                  ? 'rgba(222, 237, 227, 0.78)'
                                  : 'rgba(235, 239, 244, 0.8)'
                                : undefined
                          }
                          stroke={terrainTool === 'river' ? lightCityPalette.waterFill : '#2563eb'}
                          strokeWidth={
                            terrainTool === 'river'
                              ? terrainRiverWidth
                              : terrainTool === 'road'
                                ? terrainRoadSubKind === 'express'
                                  ? 9
                                  : terrainRoadSubKind === 'street'
                                    ? 3.2
                                    : 6
                                : 2 / Math.max(0.35, viewportScaleForHit)
                          }
                          lineCap="round"
                          lineJoin="round"
                          dash={
                            terrainTool === 'river'
                              ? undefined
                              : [6 / Math.max(0.35, viewportScaleForHit), 4 / Math.max(0.35, viewportScaleForHit)]
                          }
                          opacity={0.86}
                          listening={false}
                          perfectDrawEnabled={false}
                        />
                        {terrainDraftPoints.map((pt, idx) => (
                          <Circle
                            key={`draft_pt_${idx}`}
                            x={pt.x}
                            y={pt.y}
                            radius={(idx === 0 ? 6.5 : 4.8) / Math.max(0.35, viewportScaleForHit)}
                            fill={idx === 0 ? '#dbeafe' : '#ffffff'}
                            stroke="#2563eb"
                            strokeWidth={2 / Math.max(0.35, viewportScaleForHit)}
                            listening={false}
                            perfectDrawEnabled={false}
                          />
                        ))}
                      </>
                    );
                  })()}
                </Group>
              )}

              <Group
                opacity={terrainEditMode ? 0.32 : 1}
                listening={!terrainEditMode && activeTool !== 'pan' && !isSpaceHeld}
              >
              {renderLines(suppressShadows)}

              {lineNamePlacements.map((label) => {
                const canDragBadge =
                  !readOnly &&
                  !terrainEditMode &&
                  activeTool === 'select' &&
                  !isSpaceHeld &&
                  !mapSettings.lockLineNameLabels &&
                  Boolean(onApplyGraphTransaction);
                return (
                  <Group
                    key={`line_label_${label.key}`}
                    name="zoom-sized-element"
                    x={label.x}
                    y={label.y}
                    listening={canDragBadge}
                    draggable={canDragBadge}
                    onMouseEnter={(e) => {
                      if (!canDragBadge) return;
                      const container = e.target.getStage()?.container();
                      if (container) container.style.cursor = 'grab';
                    }}
                    onMouseLeave={(e) => {
                      if (!canDragBadge) return;
                      const container = e.target.getStage()?.container();
                      if (container) container.style.cursor = '';
                    }}
                    onMouseDown={(e) => {
                      if (canDragBadge) e.cancelBubble = true;
                    }}
                    onTouchStart={(e) => {
                      if (canDragBadge) e.cancelBubble = true;
                    }}
                    onDragStart={(e) => {
                      e.cancelBubble = true;
                      const container = e.target.getStage()?.container();
                      if (container) container.style.cursor = 'grabbing';
                    }}
                    onDragMove={(e) => {
                      e.cancelBubble = true;
                    }}
                    onDragEnd={(e) => {
                      e.cancelBubble = true;
                      const container = e.target.getStage()?.container();
                      if (container) container.style.cursor = 'grab';
                      if (!onApplyGraphTransaction) return;
                      const centerX = e.target.x() + label.width / 2;
                      const centerY = e.target.y() + label.height / 2;
                      const geoLl = isAmapMode ? getLngLatFromContainerPoint({ x: centerX, y: centerY }) : null;
                      const nextLabelPos = {
                        x: Math.round(centerX * 10) / 10,
                        y: Math.round(centerY * 10) / 10,
                        ...(geoLl
                          ? {
                              lng: Number(geoLl.lng.toFixed(6)),
                              lat: Number(geoLl.lat.toFixed(6))
                            }
                          : label.line.labelPosition?.lng !== undefined && label.line.labelPosition?.lat !== undefined
                            ? {
                                lng: label.line.labelPosition.lng,
                                lat: label.line.labelPosition.lat
                              }
                            : {})
                      };
                      onApplyGraphTransaction(
                        (curr) => ({
                          ...curr,
                          lines: curr.lines.map((l) =>
                            l.id === label.line.id ? { ...l, labelPosition: nextLabelPos } : l
                          )
                        }),
                        { recordHistory: true }
                      );
                    }}
                    onDblClick={(e) => {
                      if (!canDragBadge || !onApplyGraphTransaction || !label.line.labelPosition) return;
                      e.cancelBubble = true;
                      onApplyGraphTransaction(
                        (curr) => ({
                          ...curr,
                          lines: curr.lines.map((l) =>
                            l.id === label.line.id ? { ...l, labelPosition: undefined } : l
                          )
                        }),
                        { recordHistory: true }
                      );
                      message.success?.('已恢复该线路名称标签的自动跟随排布');
                    }}
                  >
                    <Rect
                      width={label.width}
                      height={label.height}
                      cornerRadius={label.height / 2}
                      fill={lineBadgeColors.fill}
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
                      fill={lineBadgeColors.text}
                      perfectDrawEnabled={false}
                    />
                  </Group>
                );
              })}

              {/* 途经点控制柄：支持全局「默认隐藏途经点」开关（选中或调节圆弧时仍显示当前控制柄） */}
              {sections.map((section) => {
                const points = section.waypoints || [];
                const hideByDefault = Boolean(mapSettings.hideWaypoints);
                const visiblePoints = points
                  .map((pt, idx) => ({ pt, idx }))
                  .filter(({ pt, idx }) => {
                    const isActivelySelected =
                      (selectedWaypoint?.sectionId === section.id && selectedWaypoint?.waypointIndex === idx) ||
                      (arcEditorWaypoint?.sectionId === section.id && arcEditorWaypoint?.waypointIndex === idx);
                    if (isActivelySelected) return true;
                    if (hideByDefault) return false;
                    return !pt.hidden;
                  });
                if (!visiblePoints.length) return null;
                return visiblePoints.map(({ pt, idx }) => {
                  const waypointPoint = getWaypointDisplayPoint(pt);
                  const isSelectedWp =
                    (selectedWaypoint?.sectionId === section.id && selectedWaypoint?.waypointIndex === idx) ||
                    (arcEditorWaypoint?.sectionId === section.id && arcEditorWaypoint?.waypointIndex === idx);
                  return (
                    <Circle
                      key={`wp_${section.id}_${idx}`}
                      x={waypointPoint.x}
                      y={waypointPoint.y}
                      radius={isSelectedWp ? scaledWaypointRadius * 1.22 : scaledWaypointRadius}
                      fill={isSelectedWp ? (isDarkCanvas ? '#1e3a8a' : '#eff6ff') : canvasPalette.waypointFill}
                      stroke={pt.mode === 'arc' ? '#f59e0b' : canvasPalette.waypointStroke}
                      strokeWidth={isSelectedWp ? scaledWaypointStrokeWidth * 1.35 : scaledWaypointStrokeWidth}
                      hitStrokeWidth={14 / Math.max(0.35, viewportScaleForHit)}
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
                        if (e.evt && e.evt.button !== undefined && e.evt.button !== 0) return;
                        e.cancelBubble = true;
                        commitInlineRenameIfNeeded();
                        setSelectedWaypoint({ sectionId: section.id, waypointIndex: idx });
                        setSelectedSectionId(section.id);
                      }}
                      onTap={(e) => {
                        if (readOnly) return;
                        e.cancelBubble = true;
                        if (isCompact) {
                          commitInlineRenameIfNeeded();
                          closeAllFloatingMenus();
                          setSelectedStationIds(new Set());
                          setSelectedSectionId(section.id);
                          setSelectedWaypoint({ sectionId: section.id, waypointIndex: idx });
                          setArcEditorWaypoint({ sectionId: section.id, waypointIndex: idx });
                          return;
                        }
                        const pointer = e.target.getStage()?.getPointerPosition?.();
                        if (pointer) {
                          setArcEditorWaypoint(null);
                          setSectionContextMenu({
                            visible: true,
                            x: pointer.x,
                            y: pointer.y,
                            sectionKey: section.id,
                            waypointIndex: idx,
                            waypointOnly: true
                          });
                        }
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
                        // 右键只弹一级菜单，先收起圆弧调整浮窗，避免两个弹窗叠在一起
                        setArcEditorWaypoint(null);
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

              {/* 仅在一级菜单选择「调整圆弧」后才挂载圆弧半径拖拽拉杆 */}
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
                        hitStrokeWidth={12 / Math.max(0.45, viewportScaleForHit)}
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

              {/* 站点与换乘符号 */}
              {stations.map((station) => {
                const stationColor = getStationColor(station.id);
                const labelRect = labelPlacements[station.id];
                const isInterchangeStation = (stationLineCounts[station.id] || 0) > 1;
                const stationPoint = getDisplayPoint(station);
                const isSelected = selectedStationIds.has(station.id);
                const isDrawAnchor = drawAnchorStationId === station.id && activeTool === 'draw';
                const isDrawSnapped = drawSnapStationId === station.id && activeTool === 'draw';
                const isMergeTarget = mergeTargetStationId === station.id;
                const isHighlighted = highlightedStationId === station.id;
                const baseR = isInterchangeStation ? scaledInterchangeRadius : scaledNormalStationRadius;

                return (
                  <Group
                    key={station.id}
                    id={station.id}
                    ref={(node) => {
                      if (node) stationGroupNodeMapRef.current.set(station.id, node);
                      else stationGroupNodeMapRef.current.delete(station.id);
                    }}
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

                    {(isDrawAnchor || isDrawSnapped || isSelected || isMergeTarget || isHighlighted) && (() => {
                      const hlNudge = !isInterchangeStation ? stationTrackNudges.get(station.id) : undefined;
                      return (
                        <Circle
                          x={hlNudge ? hlNudge.dx : 0}
                          y={hlNudge ? hlNudge.dy : 0}
                          radius={baseR + (isMergeTarget || isHighlighted || isDrawSnapped ? 7 : 5) * dotScale}
                          fill={
                            isMergeTarget || isDrawSnapped
                              ? 'rgba(37, 99, 235, 0.14)'
                              : isHighlighted
                                ? 'rgba(245, 158, 11, 0.2)'
                                : 'transparent'
                          }
                          stroke={
                            isMergeTarget
                              ? '#10b981'
                              : isHighlighted
                                ? '#f59e0b'
                                : isDrawSnapped
                                  ? currentLine?.color || '#2563eb'
                                  : isDrawAnchor
                                    ? currentLine?.color || '#2563eb'
                                    : '#3b82f6'
                          }
                          strokeWidth={2.2 * dotScale}
                          dash={isDrawAnchor && !isDrawSnapped ? [4, 3] : undefined}
                          listening={false}
                          perfectDrawEnabled={false}
                        />
                      );
                    })()}

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
                    ) : (() => {
                      const dotNudge = stationTrackNudges.get(station.id);
                      const nx = dotNudge ? dotNudge.dx : 0;
                      const ny = dotNudge ? dotNudge.dy : 0;
                      return stylePreset.stationShape === 'ring' ? (
                        <Circle
                          x={nx}
                          y={ny}
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
                          x={nx}
                          y={ny}
                          radius={scaledNormalStationRadius}
                          fill={stationColor}
                          stroke={canvasPalette.stationStroke}
                          strokeWidth={scaledNormalStationStrokeWidth}
                          shadowColor={canvasPalette.dotShadow}
                          shadowBlur={suppressShadows ? 0 : 4}
                          perfectDrawEnabled={false}
                        />
                      );
                    })()}

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
              </Group>
            </>
          )}
        </Layer>

        {/* 顶层纯命令式交互辅助层（直接 ref 引用，仅含极少辅助节点，重绘耗时 < 0.1ms） */}
        <Layer ref={overlayLayerRef} listening={false}>
          {canvasSceneReady && (
            <>
              {[0, 1, 2, 3].map((idx) => (
                <Line
                  key={`imp_guide_${idx}`}
                  ref={(node) => {
                    guideLineRefs.current[idx] = node;
                  }}
                  points={[]}
                  visible={false}
                  stroke={canvasPalette.activeGuide}
                  strokeWidth={1 / Math.max(0.4, viewportScaleForHit)}
                  dash={[6, 6]}
                  opacity={0.9}
                  listening={false}
                  perfectDrawEnabled={false}
                />
              ))}

              <Circle
                ref={tempDragWaypointRef}
                x={0}
                y={0}
                visible={false}
                radius={scaledWaypointRadius * 1.15}
                fill={isDarkCanvas ? '#1e3a8a' : '#eff6ff'}
                stroke={canvasPalette.waypointStroke}
                strokeWidth={scaledWaypointStrokeWidth}
                listening={false}
                perfectDrawEnabled={false}
              />

              {activeTool === 'draw' && (
                <>
                  <Line
                    ref={drawingPreviewLineRef}
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
                        fill={canvasPalette.waypointFill}
                        stroke={currentLine?.color || '#2563eb'}
                        strokeWidth={2}
                        listening={false}
                        perfectDrawEnabled={false}
                      />
                    );
                  })}
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
        {renderStageOverlay
          ? renderStageOverlay({
              scale: viewportScaleForHit,
              isAmapMode,
              isDarkCanvas,
              getStationDisplayPoint: getDisplayPoint,
              getWaypointDisplayPoint
            })
          : null}
      </Stage>

      {/* 底图造景态：行内片区/水系地名输入框（移动端自动吸附在软键盘上方） */}
      {!readOnly && terrainLabelDraft && (() => {
        const screen = worldToScreenPoint({ x: terrainLabelDraft.x, y: terrainLabelDraft.y });
        const left = Math.max(96, Math.min(screen.x, stageSize.width - 96));
        const top = Math.max(58, Math.min(screen.y - 18, stageSize.height - 24));
        return (
          <div
            className={`metro-inline-rename${isCompact ? ' is-mobile-docked' : ''}`}
            style={isCompact ? undefined : { left, top }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <input
              ref={terrainLabelInputRef}
              className="metro-inline-rename__input"
              value={terrainLabelDraft.value}
              maxLength={24}
              placeholder="输入片区或河流名称…"
              onChange={(e) =>
                setTerrainLabelDraft((prev) => (prev ? { ...prev, value: e.target.value } : null))
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitTerrainLabelDraft();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setTerrainLabelDraft(null);
                }
              }}
            />
            {isCompact ? (
              <button
                type="button"
                className="metro-inline-rename__btn"
                onClick={() => setTerrainLabelDraft(null)}
                aria-label="取消"
              >
                <CloseOutlined />
              </button>
            ) : null}
            <button
              type="button"
              className="metro-inline-rename__btn metro-inline-rename__btn--ok"
              onClick={commitTerrainLabelDraft}
              aria-label="确认片区地名"
            >
              <CheckOutlined />
            </button>
          </div>
        );
      })()}

      {/* 非阻塞行内站点命名浮层（移动端自动贴合虚拟键盘正上方，杜绝输入法遮挡） */}
      {!readOnly && inlineRename && (() => {
        const st = stationById.get(inlineRename.stationId);
        if (!st) return null;
        const screen = worldToScreenPoint(getDisplayPoint(st));
        const left = Math.max(96, Math.min(screen.x, stageSize.width - 96));
        const top = Math.max(58, Math.min(screen.y - 18, stageSize.height - 24));
        return (
          <div
            className={`metro-inline-rename${isCompact ? ' is-mobile-docked' : ''}`}
            style={isCompact ? undefined : { left, top }}
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
            {isCompact ? (
              <button
                type="button"
                className="metro-inline-rename__btn"
                onClick={() => setInlineRename(null)}
                aria-label="取消改名"
              >
                <CloseOutlined />
              </button>
            ) : null}
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

      {/* 移动端非阻塞选中态动作抽屉条（覆盖站点改名/起笔/八向方位/备注 与 区间插站/并行对调/拐点调节，且不阻挡单指继续拖拽站点） */}
      {isCompact &&
        !readOnly &&
        !terrainEditMode &&
        !inlineRename &&
        !arcEditorWaypoint &&
        activeTool === 'select' &&
        (() => {
          if (selectedStationIds.size === 1) {
            const stId = Array.from(selectedStationIds)[0];
            const st = stationById.get(stId);
            if (!st) return null;
            const curLabelPos: StationLabelPosition = st.labelPosition || 'auto';
            const inCurrentLine = Boolean(currentLine && currentLine.stationIds.includes(st.id));
            return (
              <div className="metro-mobile-sel-bar" onMouseDown={(e) => e.stopPropagation()}>
                <div className="metro-mobile-sel-bar__row">
                  <span className="metro-mobile-sel-bar__title">
                    <span
                      className="metro-floating-menu__dot"
                      style={{ backgroundColor: getStationColor(st.id) }}
                    />
                    <span>{st.name}</span>
                  </span>
                  <div className="metro-mobile-sel-bar__actions">
                    <button
                      type="button"
                      className="metro-mobile-sel-bar__chip is-primary"
                      onClick={() =>
                        setInlineRename({ stationId: st.id, value: st.name, originalName: st.name })
                      }
                    >
                      <EditOutlined /> {isEn ? 'Rename' : '改名'}
                    </button>
                    <button
                      type="button"
                      className="metro-mobile-sel-bar__chip"
                      onClick={() => {
                        if (!currentLineId) {
                          const owning = lines.find((l) => l.stationIds.includes(st.id));
                          if (owning) onSelectLine?.(owning.id);
                          else if (!requireSelectedLineForDraw()) return;
                        }
                        setSelectedStationIds(new Set());
                        setActiveTool('draw');
                        setDrawAnchorStationId(st.id);
                        setDrawPendingWaypoints([]);
                      }}
                    >
                      <NodeIndexOutlined /> {isEn ? 'Extend' : '起笔/支线'}
                    </button>
                    <button
                      type="button"
                      className={`metro-mobile-sel-bar__chip${mobileLabelPosOpen ? ' is-active' : ''}`}
                      onClick={() => setMobileLabelPosOpen((v) => !v)}
                    >
                      {isEn ? 'Label' : '站名方位'}
                    </button>
                    <button
                      type="button"
                      className="metro-mobile-sel-bar__chip"
                      onClick={() => setStationInfoModal({ visible: true, station: st, note: st.note || '' })}
                    >
                      {isEn ? 'Note' : '备注'}
                    </button>
                    {inCurrentLine && currentLine && onRemoveStationFromLine ? (
                      <button
                        type="button"
                        className="metro-mobile-sel-bar__chip"
                        onClick={() => {
                          onRemoveStationFromLine(currentLine.id, st.id);
                          setSelectedStationIds(new Set());
                        }}
                      >
                        <DisconnectOutlined /> {isEn ? 'Detach' : '移出当前线'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="metro-mobile-sel-bar__chip is-danger"
                      onClick={() => {
                        onDeleteStation(st.id);
                        setSelectedStationIds(new Set());
                      }}
                    >
                      <DeleteOutlined />
                    </button>
                    <button
                      type="button"
                      className="metro-mobile-sel-bar__close"
                      onClick={() => setSelectedStationIds(new Set())}
                      aria-label="关闭选中条"
                    >
                      <CloseOutlined />
                    </button>
                  </div>
                </div>
                {mobileLabelPosOpen ? (
                  <div className="metro-mobile-sel-bar__subrow">
                    {LABEL_POSITION_OPTIONS.map((opt) => (
                      <button
                        key={opt.key}
                        type="button"
                        className={`metro-label-pos-chip${curLabelPos === opt.key ? ' is-active' : ''}`}
                        onClick={() => {
                          onBeginInteraction?.();
                          onUpdateStation({ ...st, labelPosition: opt.key });
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          }

          if (selectedSectionId) {
            const sec = sectionById.get(selectedSectionId);
            if (!sec) return null;
            const secLine = lineById.get(sec.lineId);
            const pMeta = parallelMetaBySectionId.get(sec.id);
            const isHoriz = pMeta?.axisHint === 'horizontal';
            const secWps = getSectionWaypoints(sec.id);
            return (
              <div className="metro-mobile-sel-bar" onMouseDown={(e) => e.stopPropagation()}>
                <div className="metro-mobile-sel-bar__row">
                  <span className="metro-mobile-sel-bar__title">
                    <span
                      className="metro-floating-menu__dot"
                      style={{ backgroundColor: secLine?.color || '#3b82f6' }}
                    />
                    <span>{secLine ? `${secLine.name} · 区间` : '区间'}</span>
                  </span>
                  <div className="metro-mobile-sel-bar__actions">
                    <button
                      type="button"
                      className="metro-mobile-sel-bar__chip is-primary"
                      onClick={() => {
                        const sSt = stationById.get(sec.startStationId);
                        const eSt = stationById.get(sec.endStationId);
                        const fallbackWorld =
                          sSt && eSt
                            ? { x: (sSt.x + eSt.x) / 2, y: (sSt.y + eSt.y) / 2 }
                            : { x: 0, y: 0 };
                        const tap =
                          lastSectionTapRef.current?.sectionId === sec.id
                            ? lastSectionTapRef.current
                            : { world: fallbackWorld, screen: worldToScreenPoint(fallbackWorld) };
                        setSelectedSectionId(null);
                        insertStationIntoSectionAt(sec, tap.world, tap.screen, false);
                      }}
                    >
                      <PlusCircleOutlined /> {isEn ? 'Insert Station' : '在此插站'}
                    </button>
                    {pMeta && pMeta.totalSlots === 2 ? (
                      <button
                        type="button"
                        className="metro-mobile-sel-bar__chip"
                        onClick={() => handleReorderParallelSection(sec.id, 'swap', false)}
                      >
                        <SwapOutlined /> {isHoriz ? '对调上下' : '对调左右'}
                      </button>
                    ) : null}
                    {pMeta && pMeta.totalSlots > 2 ? (
                      <>
                        <button
                          type="button"
                          className="metro-mobile-sel-bar__chip"
                          disabled={pMeta.slotIndex <= 0}
                          onClick={() => handleReorderParallelSection(sec.id, 'prev', false)}
                        >
                          {isHoriz ? <ArrowUpOutlined /> : <ArrowLeftOutlined />}
                        </button>
                        <button
                          type="button"
                          className="metro-mobile-sel-bar__chip"
                          disabled={pMeta.slotIndex >= pMeta.totalSlots - 1}
                          onClick={() => handleReorderParallelSection(sec.id, 'next', false)}
                        >
                          {isHoriz ? <ArrowDownOutlined /> : <ArrowRightOutlined />}
                        </button>
                      </>
                    ) : null}
                    {secWps.map((_, idx) => (
                      <button
                        key={idx}
                        type="button"
                        className="metro-mobile-sel-bar__chip"
                        onClick={() => {
                          setSelectedWaypoint({ sectionId: sec.id, waypointIndex: idx });
                          setArcEditorWaypoint({ sectionId: sec.id, waypointIndex: idx });
                        }}
                      >
                        {isEn ? `Bend ${idx + 1}` : `拐点 ${idx + 1}`}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="metro-mobile-sel-bar__chip is-danger"
                      onClick={() => {
                        onDeleteSection(sec.id);
                        setSelectedSectionId(null);
                      }}
                    >
                      <DeleteOutlined />
                    </button>
                    <button
                      type="button"
                      className="metro-mobile-sel-bar__close"
                      onClick={() => setSelectedSectionId(null)}
                      aria-label="关闭选中条"
                    >
                      <CloseOutlined />
                    </button>
                  </div>
                </div>
              </div>
            );
          }
          return null;
        })()}

      {/* 途经点圆弧调节弹窗（桌面端悬浮在节点旁，移动端自动沉入底部主控坞正上方） */}
      {!readOnly && activeWaypointArcGeometry && (() => {
        const screen = worldToScreenPoint(activeWaypointArcGeometry.currPt);
        const left = Math.max(14, Math.min(screen.x + 18, stageSize.width - 276));
        const top = Math.max(58, Math.min(screen.y - 26, stageSize.height - 156));
        const wp = activeWaypointArcGeometry.waypoint;
        const secId = activeWaypointArcGeometry.section.id;
        const wpIdx = activeWaypointArcGeometry.waypointIndex;
        const isArcMode = wp.mode === 'arc';
        const curRadius = Math.round(activeWaypointArcGeometry.effectiveRadius);
        const maxSliderR = Math.max(
          120,
          Math.min(600, Math.round(activeWaypointArcGeometry.handleInfo?.maxRadius || 180))
        );

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
            className={`metro-wp-arc-bar${isCompact ? ' is-mobile-docked' : ''}`}
            style={isCompact ? undefined : { left, top }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="metro-wp-arc-bar__top">
              <ElasticCapsuleTabs<'corner' | 'arc'>
                size="sm"
                ariaLabel="圆弧模式切换"
                value={isArcMode ? 'arc' : 'corner'}
                onChange={(mode) => {
                  if (mode === 'arc') applyWpPatch({ mode: 'arc' });
                  else applyWpPatch({ mode: 'corner', radius: curRadius || 28 });
                }}
                options={[
                  { value: 'corner', label: isEn ? 'Fillet Arc' : '相切圆弧' },
                  { value: 'arc', label: isEn ? '3-Pt Arc' : '过点正圆弧' }
                ]}
              />
              <div className="metro-wp-arc-bar__actions">
                <button
                  type="button"
                  className="metro-wp-arc-bar__icon-btn"
                  title="隐藏该途经点圆点手柄"
                  onClick={() => {
                    applyWpPatch({ hidden: true });
                    setArcEditorWaypoint(null);
                  }}
                >
                  <EyeInvisibleOutlined />
                </button>
                <button
                  type="button"
                  className="metro-wp-arc-bar__icon-btn is-danger"
                  title="删除该途经点"
                  onClick={() => deleteWaypoint(secId, wpIdx)}
                >
                  <DeleteOutlined />
                </button>
                <button
                  type="button"
                  className="metro-wp-arc-bar__icon-btn"
                  title="关闭"
                  onClick={() => setArcEditorWaypoint(null)}
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
                  : '已生成穿过该点的标准正圆弧，直接 360° 拖动圆点即可调整曲率。'}
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

      {/* 站点详情与附加标注弹窗 */}
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

      {/* 区间与途经点一级右键菜单（点击「调整圆弧」后才打开二级圆弧面板） */}
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
                        closeAllFloatingMenus();
                        setSelectedWaypoint({ sectionId: sectionKey, waypointIndex: pointIndex });
                        setArcEditorWaypoint({ sectionId: sectionKey, waypointIndex: pointIndex });
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
                    {(() => {
                      const sec = sectionById.get(sectionKey);
                      const pMeta = parallelMetaBySectionId.get(sectionKey);
                      if (!sec || !pMeta || pMeta.totalSlots < 2) return null;
                      const isHoriz = pMeta.axisHint === 'horizontal';
                      const isMultiCorridor = pMeta.corridorSectionIds.length > pMeta.localGroupSectionIds.length;
                      const hasCustomOrder = Boolean(sec.parallelOrder && sec.parallelOrder.length >= 2);
                      return (
                        <>
                          <div
                            style={{
                              padding: '4px 10px 6px',
                              fontSize: 11.5,
                              display: 'flex',
                              flexWrap: 'wrap',
                              alignItems: 'center',
                              gap: 5,
                              opacity: 0.88
                            }}
                          >
                            <span style={{ opacity: 0.68 }}>{isHoriz ? '上→下：' : '左→右：'}</span>
                            {pMeta.orderedLineIds.map((lid, idx) => {
                              const lObj = lineById.get(lid);
                              if (!lObj) return null;
                              return (
                                <span
                                  key={lid}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 3,
                                    fontWeight: lid === sec.lineId ? 700 : 500
                                  }}
                                >
                                  {idx > 0 && <span style={{ opacity: 0.45 }}>·</span>}
                                  <span
                                    style={{
                                      width: 7,
                                      height: 7,
                                      borderRadius: '50%',
                                      backgroundColor: lObj.color,
                                      display: 'inline-block'
                                    }}
                                  />
                                  <span>{lObj.name}</span>
                                </span>
                              );
                            })}
                          </div>

                          {pMeta.totalSlots === 2 ? (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              <button
                                type="button"
                                className="metro-floating-menu__item"
                                style={{ flex: 1 }}
                                onClick={(ev) => {
                                  handleReorderParallelSection(sectionKey, 'swap', Boolean(ev.altKey));
                                  closeAllFloatingMenus();
                                }}
                              >
                                <SwapOutlined />
                                <span>{isHoriz ? '对调并行上下顺序' : '对调并行左右顺序'}</span>
                              </button>
                              {isMultiCorridor && (
                                <button
                                  type="button"
                                  className="metro-floating-menu__mini-btn"
                                  title="仅对调当前单区间的并行位置，保持其余共线段不变"
                                  onClick={() => {
                                    handleReorderParallelSection(sectionKey, 'swap', true);
                                    closeAllFloatingMenus();
                                  }}
                                >
                                  仅本段
                                </button>
                              )}
                            </div>
                          ) : (
                            <div style={{ display: 'flex', gap: 4, padding: '2px 6px 4px' }}>
                              <button
                                type="button"
                                className="metro-floating-menu__mini-btn"
                                style={{ flex: 1, justifyContent: 'center' }}
                                disabled={pMeta.slotIndex <= 0}
                                onClick={(ev) => {
                                  handleReorderParallelSection(sectionKey, 'prev', Boolean(ev.altKey));
                                  closeAllFloatingMenus();
                                }}
                              >
                                {isHoriz ? <ArrowUpOutlined /> : <ArrowLeftOutlined />}
                                <span>{isHoriz ? '上移' : '左移'}</span>
                              </button>
                              <button
                                type="button"
                                className="metro-floating-menu__mini-btn"
                                style={{ flex: 1, justifyContent: 'center' }}
                                disabled={pMeta.slotIndex >= pMeta.totalSlots - 1}
                                onClick={(ev) => {
                                  handleReorderParallelSection(sectionKey, 'next', Boolean(ev.altKey));
                                  closeAllFloatingMenus();
                                }}
                              >
                                {isHoriz ? <ArrowDownOutlined /> : <ArrowRightOutlined />}
                                <span>{isHoriz ? '下移' : '右移'}</span>
                              </button>
                              {hasCustomOrder && (
                                <button
                                  type="button"
                                  className="metro-floating-menu__mini-btn"
                                  title="恢复按左侧线路列表排序"
                                  onClick={() => {
                                    handleReorderParallelSection(sectionKey, 'reset', false);
                                    closeAllFloatingMenus();
                                  }}
                                >
                                  重置
                                </button>
                              )}
                            </div>
                          )}
                          <div className="metro-floating-menu__divider" />
                        </>
                      );
                    })()}
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
                                closeAllFloatingMenus();
                                setSelectedWaypoint({ sectionId: sectionKey, waypointIndex: idx });
                                setArcEditorWaypoint({ sectionId: sectionKey, waypointIndex: idx });
                              }}
                            >
                              圆弧
                            </button>
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

      {/* 站点右键菜单 */}
      {stationContextMenu.visible &&
        stationContextMenu.station &&
        (() => {
          const st = stationContextMenu.station!;
          const menuLeft = Math.max(12, Math.min(stationContextMenu.x, stageSize.width - 248));
          const menuTop = Math.max(12, Math.min(stationContextMenu.y, stageSize.height - 340));
          const curLabelPos: StationLabelPosition = st.labelPosition || 'auto';
          const inCurrentLine = Boolean(currentLine && currentLine.stationIds.includes(st.id));

          return (
            <div
              className="station-context-menu metro-floating-menu"
              role="region"
              aria-label="站点操作"
              onMouseDown={(e) => e.stopPropagation()}
              style={{ top: menuTop, left: menuLeft, zIndex: 1000, width: 236 }}
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
                    const owning = lines.find((l) => l.stationIds.includes(st.id));
                    if (owning) onSelectLine?.(owning.id);
                    else if (!requireSelectedLineForDraw()) return;
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
              {inCurrentLine && currentLine && onRemoveStationFromLine && (
                <button
                  type="button"
                  className="metro-floating-menu__item"
                  onClick={() => {
                    onRemoveStationFromLine(currentLine.id, st.id);
                    closeAllFloatingMenus();
                    message.success?.(`已将「${st.name}」移出${currentLine.name}`);
                  }}
                >
                  <DisconnectOutlined />
                  <span>从「{currentLine.name}」移除</span>
                </button>
              )}
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
