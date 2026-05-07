import React, { useState, useRef, useEffect } from 'react';
import { Stage, Layer, Circle, Text, Group, Line, Rect } from 'react-konva';
import { Input, Button, message, Switch, Space, ColorPicker, Select } from 'antd';
import { MapSettings, Station, Line as LineType, Section, LINE_COLORS } from '../types';
import { getCityStylePreset } from '../stylePresets';
import DraggableModal from './DraggableModal';

const STATION_RADIUS = 18;
const DEFAULT_CANVAS_BACKGROUND_COLOR = '#fafbfc';
const GUIDE_THRESHOLD_DEG = 10;
const SNAP_THRESHOLD_DEG = 2;
const SNAP_ANGLES = [0, 45, 90, 135];
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

type CanvasTool = 'select' | 'station' | 'line' | 'section' | 'pan';
type Waypoint = { x: number; y: number; hidden?: boolean };

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
  onStageReady?: (stage: any) => void;
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
  onStageReady
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
  // 导出按钮悬浮提示
  const [showExportTip, setShowExportTip] = useState(false);
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
  const [newStation, setNewStation] = useState<{ x: number; y: number } | null>(null);
  const [stationName, setStationName] = useState('');
  const [activeTool, setActiveTool] = useState<CanvasTool>('station');
  
  // 绘制模式相关状态
  const [isDrawingMode, setIsDrawingMode] = useState(false);
  const [isSectionMode, setIsSectionMode] = useState(false); // 区间绘制模式
  const [selectedSection, setSelectedSection] = useState<{ sectionId: string; lineId: string; startStation: Station; endStation: Station } | null>(null);
  const [waypoints, setWaypoints] = useState<{ [key: string]: Waypoint[] }>({}); // key: lineId_startId_endId
  const [addingWaypoint, setAddingWaypoint] = useState(false);
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
  const stageRef = useRef<any>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [stageSize, setStageSize] = useState({ width: 960, height: 640 });

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

  // 处理鼠标滚轮缩放
  const handleWheel = (e: any) => {
    e.evt.preventDefault();
    
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
      setLastPointerPosition(pos);
      setMouseDownPosition(pos);
    }
  };

  // 处理拖拽移动
  const handleMouseMove = (e: any) => {
    if (isDragging && activeTool === 'pan') {
      const stage = e.target.getStage();
      const pointer = stage.getPointerPosition();
      
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
        x: (pointer.x - position.x) / scale,
        y: (pointer.y - position.y) / scale
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
    setScale(1);
    setPosition({ x: 0, y: 0 });
  };

  // 放大
  const zoomIn = () => {
    setScale(prev => Math.min(5, prev * 1.2));
  };

  // 缩小
  const zoomOut = () => {
    setScale(prev => Math.max(0.1, prev / 1.2));
  };

  // 适应视图
  const fitView = () => {
    if (stations.length === 0) return;
    
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

  // 导出图片功能
  const exportImage = () => {
    if (!stageRef.current) {
      message.error('无法获取画布');
      return;
    }

    try {
      // 获取当前画布状态
      const stage = stageRef.current;
      const currentScale = stage.scaleX();
      const currentX = stage.x();
      const currentY = stage.y();

      // 临时重置缩放和位置以获取完整视图
      stage.scale({ x: 1, y: 1 });
      stage.position({ x: 0, y: 0 });

      // 获取画布尺寸
      const stageWidth = stage.width();
      const stageHeight = stage.height();

      // 计算所有站点的边界
      let minX = 0, minY = 0, maxX = stageWidth, maxY = stageHeight;
      if (stations.length > 0) {
        minX = Math.min(...stations.map(s => s.x));
        minY = Math.min(...stations.map(s => s.y));
        maxX = Math.max(...stations.map(s => s.x));
        maxY = Math.max(...stations.map(s => s.y));
      }

      // 添加边距
      const padding = 100;
      const contentWidth = maxX - minX + padding * 2;
      const contentHeight = maxY - minY + padding * 2;

      // 设置导出尺寸
      const exportWidth = Math.max(contentWidth, 800);
      const exportHeight = Math.max(contentHeight, 600);

      // 调整画布尺寸
      stage.width(exportWidth);
      stage.height(exportHeight);

      // 居中内容
      const centerX = (exportWidth - (maxX - minX)) / 2;
      const centerY = (exportHeight - (maxY - minY)) / 2;
      stage.position({ x: centerX - minX, y: centerY - minY });

      // 导出为图片
      const dataURL = stage.toDataURL({
        pixelRatio: 2, // 提高图片质量
        mimeType: 'image/png',
        quality: 1
      });

      // 创建下载链接
      const link = document.createElement('a');
      link.download = `metro-line-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
      link.href = dataURL;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      // 恢复原始状态
      stage.scale({ x: currentScale, y: currentScale });
      stage.position({ x: currentX, y: currentY });
      stage.width(stageWidth);
      stage.height(stageHeight);

      message.success('图片导出成功！');
    } catch (error) {
      console.error('导出图片失败:', error);
      message.error('导出图片失败，请重试');
    }
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
          x: (pointer.x - position.x) / scale,
          y: (pointer.y - position.y) / scale
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
      x: (pointer.x - position.x) / scale,
      y: (pointer.y - position.y) / scale
    };
    
    // 检查是否点击了站点
    const clickedStation = stations.find(station => {
      const distance = Math.sqrt(
        Math.pow(station.x - worldPos.x, 2) + Math.pow(station.y - worldPos.y, 2)
      );
      return distance <= 20;
    });
    
    if (clickedStation) {
      if (!drawingLine.startStation) {
        // 开始绘制
        setDrawingLine({
          startStation: clickedStation,
          points: [clickedStation.x, clickedStation.y]
        });
        setDrawingStartPoint({ x: clickedStation.x, y: clickedStation.y });
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
    const allPoints = [...drawingLine.points, endStation.x, endStation.y];
    
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
          const distance = Math.sqrt(
            Math.pow(station.x - x, 2) + Math.pow(station.y - y, 2)
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
        id: Date.now().toString(),
        name: stationName.trim(),
        x: newStation.x,
        y: newStation.y,
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

    let computedGuides: number[][] = [];
    setWaypoints(prev => {
      const current = prev[sectionId] || [];
      const next = [...current];
      const prevPoint = waypointIndex === 0 ? { x: startStation.x, y: startStation.y } : next[waypointIndex - 1];
      const nextPoint = waypointIndex === next.length - 1 ? { x: endStation.x, y: endStation.y } : next[waypointIndex + 1];

      let snappedX = x;
      let snappedY = y;
      const guideLines: number[][] = [];

      const prevGuide = buildAxisGuide(prevPoint.x, prevPoint.y, x, y);
      const nextGuide = buildAxisGuide(x, y, nextPoint.x, nextPoint.y);

      if (prevGuide) {
        guideLines.push(prevGuide);
      }
      if (nextGuide) {
        guideLines.push([x, y, nextGuide[2], nextGuide[3]]);
      }

      const snapCandidates = [
        getDirectionalSnap(prevPoint.x, prevPoint.y, x, y, SNAP_THRESHOLD_DEG),
        getDirectionalSnap(nextPoint.x, nextPoint.y, x, y, SNAP_THRESHOLD_DEG)
      ].filter(Boolean) as Array<{ x: number; y: number; diff: number }>;
      const bestSnap = snapCandidates.sort((a, b) => a.diff - b.diff)[0];
      if (bestSnap) {
        snappedX = bestSnap.x;
        snappedY = bestSnap.y;
      }

      next[waypointIndex] = { ...next[waypointIndex], x: snappedX, y: snappedY };
      computedGuides = guideLines.map(g => [g[0], g[1], g[2], g[3]]);
      return { ...prev, [sectionId]: next };
    });

    if (withGuide) {
      setActiveCalibrationGuides(computedGuides);
    }
  };

  const hideWaypoint = (sectionId: string, waypointIndex: number) => {
    setWaypoints(prev => {
      const current = prev[sectionId] || [];
      return {
        ...prev,
        [sectionId]: current.map((point, index) =>
          index === waypointIndex ? { ...point, hidden: true } : point
        )
      };
    });
  };

  const showWaypoint = (sectionId: string, waypointIndex: number) => {
    setWaypoints(prev => {
      const current = prev[sectionId] || [];
      return {
        ...prev,
        [sectionId]: current.map((point, index) =>
          index === waypointIndex ? { ...point, hidden: false } : point
        )
      };
    });
  };

  const deleteWaypoint = (sectionId: string, waypointIndex: number) => {
    setWaypoints(prev => {
      const current = prev[sectionId] || [];
      return {
        ...prev,
        [sectionId]: current.filter((_, index) => index !== waypointIndex)
      };
    });
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
    const dx = endStation.x - startStation.x;
    const dy = endStation.y - startStation.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    
    if (length === 0) return;
    
    // 计算点击位置到起点的向量
    const vx = clickPosition.x - startStation.x;
    const vy = clickPosition.y - startStation.y;
    
    // 计算投影比例
    const projection = (vx * dx + vy * dy) / (dx * dx + dy * dy);
    const clampedProjection = Math.max(0, Math.min(1, projection));
    
    // 计算新站点的位置
    const newStationPosition = {
      x: startStation.x + clampedProjection * dx,
      y: startStation.y + clampedProjection * dy
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
  const stationLineCounts = stations.reduce<Record<string, number>>((result, station) => {
    result[station.id] = lines.filter(line => line.stationIds.includes(station.id)).length;
    return result;
  }, {});

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
          waypoints: waypoints[section.id] || [],
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

      const rawPoints = [seg.start.x, seg.start.y, ...seg.waypoints.flatMap(p => [p.x, p.y]), seg.end.x, seg.end.y];
      const dx = seg.end.x - seg.start.x;
      const dy = seg.end.y - seg.start.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const normal = { x: -dy / len, y: dx / len };
      const offset = (currentIndex - (total - 1) / 2) * 8;

      const shiftedPoints: number[] = [];
      for (let i = 0; i < rawPoints.length; i += 2) {
        shiftedPoints.push(rawPoints[i] + normal.x * offset, rawPoints[i + 1] + normal.y * offset);
      }

      result.push(
        <Line
          key={`${seg.section.id}_${currentIndex}`}
          points={shiftedPoints}
          stroke={seg.line.color}
          strokeWidth={stylePreset.lineWidth}
          lineCap="round"
          lineJoin="round"
          shadowColor={seg.line.color}
          shadowBlur={stylePreset.lineShadowBlur}
          shadowOpacity={Math.max(canvasPalette.lineShadowOpacity, stylePreset.lineShadowOpacity)}
          tension={0}
          onClick={e => {
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
                const worldPos = { x: (pointer.x - position.x) / scale, y: (pointer.y - position.y) / scale };
                handleLineSegmentClick(seg.line.id, seg.start, seg.end, worldPos);
              }
            }
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
              sectionKey: seg.section.id,
              waypointIndex: null,
              waypointOnly: false
            });
          }}
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

  const labelPlacements = (() => {
    const occupied: LabelRect[] = [];
    const lineSegments = sections
      .map(section => {
        const start = stations.find(station => station.id === section.startStationId);
        const end = stations.find(station => station.id === section.endStationId);
        if (!start || !end) return [];
        const points = [start, ...(waypoints[section.id] || []), end];
        const segments: Array<[number, number, number, number]> = [];
        for (let i = 0; i < points.length - 1; i += 1) {
          segments.push([points[i].x, points[i].y, points[i + 1].x, points[i + 1].y]);
        }
        return segments;
      })
      .flat();

    return stations.reduce<Record<string, LabelRect>>((result, station) => {
      if (station.labelPosition === 'hidden') return result;
      const labelWidth = Math.max(44, station.name.length * dotLabelStyle.fontSize);
      const labelHeight = Math.max(22, dotLabelStyle.fontSize + 10);
      const gap = 12;
      const candidates = [
        { key: 'right', x: station.x + gap, y: station.y - labelHeight / 2 },
        { key: 'left', x: station.x - labelWidth - gap, y: station.y - labelHeight / 2 },
        { key: 'top', x: station.x - labelWidth / 2, y: station.y - labelHeight - gap },
        { key: 'bottom', x: station.x - labelWidth / 2, y: station.y + gap },
        { key: 'top-right', x: station.x + gap, y: station.y - labelHeight - gap },
        { key: 'bottom-right', x: station.x + gap, y: station.y + gap },
        { key: 'top-left', x: station.x - labelWidth - gap, y: station.y - labelHeight - gap },
        { key: 'bottom-left', x: station.x - labelWidth - gap, y: station.y + gap }
      ].filter(candidate => station.labelPosition === 'auto' || !station.labelPosition || candidate.key === station.labelPosition);

      const best = candidates
        .map(candidate => {
          const rect = { x: candidate.x, y: candidate.y, width: labelWidth, height: labelHeight };
          let score = 0;
          occupied.forEach(other => {
            if (rectsOverlap(rect, other)) score += 100;
          });
          stations.forEach(other => {
            if (other.id !== station.id && rectsOverlap(rect, { x: other.x - 8, y: other.y - 8, width: 16, height: 16 })) {
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
  })();

  const lineNamePlacements = (() => {
    if (!mapSettings.showLineNameLabels || lines.length === 0) return [];
    const occupied: LabelRect[] = [
      ...Object.values(labelPlacements),
      ...stations.map(station => ({
        x: station.x - stylePreset.interchangeRadius - 8,
        y: station.y - stylePreset.interchangeRadius - 8,
        width: (stylePreset.interchangeRadius + 8) * 2,
        height: (stylePreset.interchangeRadius + 8) * 2
      }))
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
          const dx = terminal.x - neighbor.x;
          const dy = terminal.y - neighbor.y;
          const len = Math.hypot(dx, dy) || 1;
          const outward = { x: dx / len, y: dy / len };
          const normal = { x: -outward.y, y: outward.x };
          const baseDistance = Math.max(24, stylePreset.interchangeRadius + 14);
          return [0, labelHeight + 8, -(labelHeight + 8), labelHeight * 2 + 16, -(labelHeight * 2 + 16)].map(
            (sideOffset, index) => {
              const centerX = terminal.x + outward.x * (baseDistance + labelWidth / 2) + normal.x * sideOffset;
              const centerY = terminal.y + outward.y * (baseDistance + labelHeight / 2) + normal.y * sideOffset;
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
  })();

  return (
    <div
      ref={containerRef}
      className={`metro-canvas-surface ${isDarkCanvas ? 'is-canvas-dark' : ''}`}
      style={{
        width: '100%',
        height: '100%',
        '--metro-canvas-bg': canvasBackgroundColor,
        backgroundColor: canvasBackgroundColor,
        backgroundImage: canvasBackgroundImage ? `url(${canvasBackgroundImage})` : 'none',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat'
      } as React.CSSProperties}
    >
      <div className="metro-canvas-tools">
        <div className="metro-tool-group" role="toolbar" aria-label="Canvas tools">
          {[
            { key: 'select' as CanvasTool, label: text.tools.select },
            { key: 'station' as CanvasTool, label: text.tools.station },
            { key: 'line' as CanvasTool, label: text.tools.line },
            { key: 'section' as CanvasTool, label: text.tools.section },
            { key: 'pan' as CanvasTool, label: text.tools.pan }
          ].map((tool) => (
            <button
              key={tool.key}
              type="button"
              className={`metro-tool-button ${activeTool === tool.key ? 'is-active' : ''}`}
              onClick={() => setCanvasTool(tool.key)}
            >
              {tool.label}
            </button>
          ))}
        </div>
        <div className="metro-tool-hint">
          {activeTool === 'select' && text.hints.select}
          {activeTool === 'station' && text.hints.station}
          {activeTool === 'line' &&
            (drawingLine.startStation
              ? text.hints.lineDrawing(drawingLine.startStation.name)
              : text.hints.lineIdle)}
          {activeTool === 'section' && text.hints.section}
          {activeTool === 'pan' && text.hints.pan}
        </div>
      </div>
      {/* 区间绘制模式开关 */}
      <div style={{ position: 'absolute', top: 60, left: 16, zIndex: 1001, background: '#fff', padding: '8px 12px', borderRadius: '6px', boxShadow: '0 2px 8px rgba(0,0,0,0.1)', display: 'flex', alignItems: 'center', gap: 8 }}>
        <span>区间绘制模式：</span>
        <Switch checked={isSectionMode} onChange={checked => { setIsSectionMode(checked); setSelectedSection(null); }} checkedChildren="开启" unCheckedChildren="关闭" />
        {isSectionMode && <span style={{ fontSize: '12px', color: '#666' }}>点击区间线条添加途经点（最多3个）</span>}
      </div>
      {isSectionMode && selectedSection && (
        <DraggableModal
          title={`添加途经点（${selectedSection.startStation.name} → ${selectedSection.endStation.name}）`}
          open={!addingWaypoint}
          onOk={() => {
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
            点击“添加途经点”后，在区间内点击画布添加途经点，最多3个，途经点仅用于折线显示
          </div>
          <div>
            已添加途经点数：{(waypoints[selectedSection.sectionId]?.length || 0)}
          </div>
          {/* 列出已添加途经点并可删除 */}
          {(() => {
            const sectionKey = selectedSection.sectionId;
            const points = waypoints[sectionKey] || [];
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
                        const newArr = [...points];
                        newArr.splice(idx, 1);
                        setWaypoints({
                          ...waypoints,
                          [sectionKey]: newArr
                        });
                      }}
                    >删除</Button>
                  </div>
                ))}
              </div>
            );
          })()}
        </DraggableModal>
      )}
      {/* 绘制模式控制 */}
      <div style={{ 
        position: 'absolute', 
        top: 16, 
        left: 16, 
        zIndex: 1000,
        background: '#fff',
        padding: '8px 12px',
        borderRadius: '6px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        display: 'flex',
        alignItems: 'center',
        gap: 8
      }}>
        <span>绘制模式：</span>
        <Switch
          checked={isDrawingMode}
          onChange={setIsDrawingMode}
          checkedChildren="开启"
          unCheckedChildren="关闭"
        />
        {isDrawingMode && (
          <span style={{ fontSize: '12px', color: '#666' }}>
            {drawingLine.startStation 
              ? `绘制中: ${drawingLine.startStation.name} → 移动鼠标绘制 → 点击终点站点` 
              : '点击起始站点开始绘制'}
          </span>
        )}
      </div>

      {/* 缩放控制按钮 */}
      <div style={{ 
        position: 'absolute', 
        top: 16, 
        right: 16, 
        zIndex: 1000,
        background: '#fff',
        padding: '8px',
        borderRadius: '6px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
      }}>
        <Space direction="vertical" size="small">
          <Button size="small" onClick={zoomIn} title={text.zoomIn}>+</Button>
          <Button size="small" onClick={zoomOut} title={text.zoomOut}>-</Button>
          <Button size="small" onClick={fitView} title={text.fitView}>□</Button>
          <Button size="small" onClick={resetView} title={text.resetView}>⌂</Button>
        </Space>
      </div>

      {/* 线段点击功能说明 */}
      {false && !isDrawingMode && (
        <div style={{ 
          position: 'absolute', 
          top: 16, 
          left: 16, 
          zIndex: 1000,
          background: '#fff',
          padding: '8px 12px',
          borderRadius: '6px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          fontSize: '12px',
          color: '#666',
          maxWidth: '250px'
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: '4px' }}>💡 提示：</div>
          <div>点击线路的线条可在两站点间添加新站点</div>
        </div>
      )}

      {/* 缩放信息显示 */}
      <div style={{ 
        position: 'absolute', 
        bottom: 16, 
        right: 16, 
        zIndex: 1000,
        background: '#fff',
        padding: '8px 12px',
        borderRadius: '6px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
        fontSize: '12px',
        color: '#666'
      }}>
        {text.zoom}: {Math.round(scale * 100)}%
      </div>

      {/* 绘制模式使用说明 */}
      {false && isDrawingMode && (
        <div style={{ 
          position: 'absolute', 
          top: 70, 
          left: 16, 
          zIndex: 1000,
          background: '#fff',
          padding: '12px',
          borderRadius: '6px',
          boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
          fontSize: '12px',
          color: '#666',
          maxWidth: '300px'
        }}>
          <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>使用说明：</div>
          <div>1. 点击起始站点开始绘制</div>
          <div>2. 移动鼠标绘制连接线</div>
          <div>3. 点击终点站点完成绘制</div>
          <div>4. 按ESC键取消绘制</div>
          <div style={{ marginTop: '8px', color: '#1890ff' }}>
            系统将自动识别路径上的站点并更新线路顺序
          </div>
          <div style={{ marginTop: '8px', color: '#52c41a' }}>
            绘制模式：平滑曲线 | 非绘制模式：直线
          </div>
        </div>
      )}

      <Stage
        ref={stageRef}
        width={stageSize.width}
        height={stageSize.height}
        scaleX={scale}
        scaleY={scale}
        x={position.x}
        y={position.y}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={e => {
          // 先处理拖拽结束
          handleMouseUp(e);
          // 仅在未拖拽且鼠标左键抬起时，主动触发添加站点弹窗
          if (false && !isDragging && e && e.evt && e.evt.button === 0 && !isSectionMode && !sectionContextMenu.visible) {
            handleStageClick(e);
          }
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
                  x: (pointer.x - position.x) / scale,
                  y: (pointer.y - position.y) / scale
                };
                const sectionKey = selectedSection.sectionId;
                const currentWaypoints = waypoints[sectionKey] || [];
                if (currentWaypoints.length < 2) {
                  setWaypoints({
                    ...waypoints,
                    [sectionKey]: [...currentWaypoints, worldPos]
                  });
                  setAddingWaypoint(false); // 添加后关闭画布添加状态
                } else if (currentWaypoints.length === 2) {
                  // 添加第3个后自动关闭区间选择
                  setWaypoints({
                    ...waypoints,
                    [sectionKey]: [...currentWaypoints, worldPos]
                  });
                  setAddingWaypoint(false);
                  setSelectedSection(null);
                  message.success('已添加3个途经点');
                } else {
                  message.warning('最多只能添加3个途经点');
                  setAddingWaypoint(false);
                  setSelectedSection(null);
                }
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
            fill={canvasBackgroundColor}
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
                fill={stylePreset.lineLabelFill}
                stroke={label.line.color}
                strokeWidth={stylePreset.lineLabelStrokeWidth}
                shadowColor={label.line.color}
                shadowBlur={4}
                shadowOpacity={0.16}
              />
              <Text
                text={label.line.name}
                width={label.width}
                height={label.height}
                align="center"
                verticalAlign="middle"
                fontSize={stylePreset.lineLabelFontSize}
                fontStyle={`${stylePreset.lineLabelFontWeight}`}
                fill={stylePreset.lineLabelText}
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
            const points = waypoints[section.id] || [];
            const visiblePoints = points
              .map((pt, idx) => ({ pt, idx }))
              .filter(({ pt }) => !pt.hidden);
            if (!visiblePoints.length) return null;
            return visiblePoints.map(({ pt, idx }) => (
              <Circle
                key={`wp_${section.id}_${idx}`}
                x={pt.x}
                y={pt.y}
                radius={6}
                fill={canvasPalette.waypointFill}
                stroke={canvasPalette.waypointStroke}
                strokeWidth={2}
                shadowColor={canvasPalette.waypointShadow}
                shadowBlur={5}
                draggable
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
            ));
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
            return (
              <Group
                key={station.id}
                x={station.x}
                y={station.y}
                draggable={activeTool === 'select' || activeTool === 'station'}
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
                          shadowBlur={6}
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
                        shadowBlur={4}
                      />
                    )}
                    {labelRect ? (
                      <Text
                        text={station.name}
                        x={labelRect.x - station.x}
                        y={labelRect.y - station.y}
                        width={labelRect.width}
                        height={labelRect.height}
                        fontSize={dotLabelStyle.fontSize}
                        fontStyle={`${dotLabelStyle.fontWeight}`}
                        fill={dotLabelStyle.color || canvasPalette.labelText}
                        align="center"
                        verticalAlign="middle"
                        shadowColor={canvasPalette.labelShadow}
                        shadowBlur={isDarkCanvas ? 5 : 2}
                        shadowOpacity={1}
                      />
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
                      shadowBlur={isDarkCanvas ? 7 : 4}
                      shadowOffset={{ x: 2, y: 2 }}
                    />
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
                      shadowColor={isDarkCanvas ? 'rgba(2,6,23,0.8)' : 'rgba(15,23,42,0.42)'}
                      shadowBlur={isDarkCanvas ? 3 : 2}
                      shadowOffset={{ x: 1, y: 1 }}
                    />
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
         const currentPoint = pointIndex === null ? null : waypoints[sectionKey]?.[pointIndex];
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
                 {(waypoints[sectionKey]?.length ?? 0) > 0 ? (
                   waypoints[sectionKey].map((pt, idx) => (
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
