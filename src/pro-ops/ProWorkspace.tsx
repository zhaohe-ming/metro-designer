import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Modal, message } from 'antd';
import { Line, MapSettings, Section, Station } from '../types';
import { MapGraph } from '../lib/graphOps';
import { CanvasOverlayRenderContext } from '../components/Canvas';
import ElasticCapsuleTabs from '../components/ElasticCapsuleTabs';
import { isAndroidClient, saveAndroidExport } from '../lib/androidClient';
import { hasDesktopBridge, saveDesktopExport } from '../lib/desktopClient';
import { sanitizeProjectFilename } from '../lib/projectFile';
import { createId } from '../utils/id';
import ProCanvasOverlay from './ProCanvasOverlay';
import {
  calibrateMetersPerUnitBetweenPoints,
  computeNetworkMileageSummary,
  measureSectionDistance
} from './distance';
import { ServiceKinematicsResult, solveServiceKinematics } from './kinematics';
import {
  buildOrderedLineSteps,
  createAllSubCorridorPatternsForLine,
  createLineAllStopPattern,
  createLineExpressPattern,
  listLineRouteVariants,
  reconcileProOps
} from './reconcile';
import {
  buildCorridorDiagramModel,
  buildServiceDiagramSvg,
  rasterizeSvgToPngBlob
} from './corridorDiagram';
import {
  cloneProOpsDocument,
  createDefaultLineSpec,
  createEmptyProOpsDocument,
  normalizeProOpsDocument,
  ProOpsDocument,
  ProRollingStockCode,
  ProRouteStep,
  ProServicePattern,
  ProTrackConnection,
  ROLLING_STOCK_PRESETS
} from './types';
import './proOps.css';

export interface ProCanvasBridge {
  onReadOnlyStationClick: (station: Station) => void;
  onReadOnlySectionClick: (section: Section) => void;
  renderStageOverlay: (ctx: CanvasOverlayRenderContext) => React.ReactNode;
}

export interface ProUndoBridge {
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
}

export interface ProWorkspaceProps {
  lines: Line[];
  stations: Station[];
  sections: Section[];
  mapSettings: MapSettings;
  mapDisplayName: string;
  initialProOps: ProOpsDocument | null;
  isMobileCompact: boolean;
  siderHost: HTMLElement | null;
  stageHost: HTMLElement | null;
  dockHost: HTMLElement | null;
  onProOpsChange: (next: ProOpsDocument) => void;
  onExitProMode: () => void;
  onBindCanvasBridge: (bridge: ProCanvasBridge | null) => void;
  onBindUndoBridge: (bridge: ProUndoBridge | null) => void;
}

/**
 * 允许完整删空多位数字重新填写的数值输入框：
 * - 删除全部数字时自动挂 0 显示（若 allowZero=true 则同步提交 0；若 min > 0 则在输入期间挂 0 不强制弹回原默认值，失焦后再收敛到合法范围）；
 * - 挂 0 状态下直接敲击新数字（如 3）会自动替换占位 0 为 3，敲击小数点（0.）则顺畅输入小数。
 */
interface ProNumberInputProps {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  allowDecimal?: boolean;
  allowZero?: boolean;
  unitSuffix?: string;
  style?: React.CSSProperties;
}

const ProNumberInput: React.FC<ProNumberInputProps> = ({
  value,
  onChange,
  min = 0,
  max = 100000,
  allowDecimal = false,
  allowZero = false,
  unitSuffix,
  style
}) => {
  const [text, setText] = useState<string>(() => String(value));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setText(String(value));
    }
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    let raw = e.target.value.replace(/[^\d.]/g, '');
    if (!allowDecimal) {
      raw = raw.replace(/\./g, '');
    } else {
      const firstDot = raw.indexOf('.');
      if (firstDot >= 0) {
        raw = raw.slice(0, firstDot + 1) + raw.slice(firstDot + 1).replace(/\./g, '');
      }
    }

    // 全部删空时挂 0
    if (raw === '' || raw === '.') {
      setText('0');
      if (allowZero) {
        onChange(0);
      }
      return;
    }

    // 从挂 0 状态继续输入非零数字时（可能出现 "03" 或光标在左时的 "30"），自动去掉占位 0
    if (text === '0' && raw.length === 2 && !raw.includes('.')) {
      if (raw.startsWith('0') && raw[1] !== '0') {
        raw = raw.slice(1);
      } else if (raw.endsWith('0') && raw[0] !== '0') {
        // 光标在挂零 '0' 左侧直接敲入新数字时替换占位 0
        raw = raw[0];
      }
    } else if (raw.length > 1 && raw.startsWith('0') && raw[1] !== '.') {
      raw = raw.replace(/^0+/, '') || '0';
    }

    setText(raw);

    // 末尾刚敲小数点（如 "12."）时暂不截断，等输入小数位
    if (raw.endsWith('.')) return;

    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;

    if (parsed === 0) {
      if (allowZero) onChange(0);
      return;
    }

    const clamped = Math.min(max, Math.max(allowZero ? 0 : min, parsed));
    if (parsed >= (allowZero ? 0 : min)) {
      onChange(clamped);
    }
  };

  const handleBlur = () => {
    focusedRef.current = false;
    const parsed = Number(text);
    const effectiveMin = allowZero ? 0 : min;
    const safe = Number.isFinite(parsed)
      ? Math.min(max, Math.max(effectiveMin, parsed))
      : effectiveMin;
    const rounded = allowDecimal ? Math.round(safe * 100) / 100 : Math.round(safe);
    setText(String(rounded));
    if (rounded !== value) {
      onChange(rounded);
    }
  };

  const inputEl = (
    <input
      type="text"
      inputMode={allowDecimal ? 'decimal' : 'numeric'}
      className="pro-input"
      style={style}
      value={text}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onChange={handleChange}
      onBlur={handleBlur}
    />
  );

  if (!unitSuffix) return inputEl;
  return (
    <div className="pro-input-unit-wrap">
      {inputEl}
      <span className="pro-input-unit-wrap__suffix">{unitSuffix}</span>
    </div>
  );
};

const MAX_PRO_HISTORY = 40;

const ProWorkspace: React.FC<ProWorkspaceProps> = ({
  lines,
  stations,
  sections,
  mapSettings,
  mapDisplayName,
  initialProOps,
  isMobileCompact,
  siderHost,
  stageHost,
  dockHost,
  onProOpsChange,
  onExitProMode,
  onBindCanvasBridge,
  onBindUndoBridge
}) => {
  const graph: MapGraph = useMemo(() => ({ lines, stations, sections }), [lines, stations, sections]);
  const isGeoMode = mapSettings.baseMap.mode === 'amap';

  const [doc, setDoc] = useState<ProOpsDocument>(() => {
    const normalized = normalizeProOpsDocument(initialProOps) || createEmptyProOpsDocument();
    return reconcileProOps({ lines, stations, sections }, normalized).proOps;
  });

  const lastInitialRef = useRef<ProOpsDocument | null>(initialProOps);
  useEffect(() => {
    if (initialProOps !== lastInitialRef.current) {
      lastInitialRef.current = initialProOps;
      const normalized = normalizeProOpsDocument(initialProOps) || createEmptyProOpsDocument();
      const reconciled = reconcileProOps(graph, normalized);
      setDoc(reconciled.proOps);
      pastRef.current = [];
      futureRef.current = [];
      setHistoryTick((t) => t + 1);
    }
  }, [initialProOps, graph]);

  const docRef = useRef<ProOpsDocument>(doc);
  docRef.current = doc;
  const pastRef = useRef<ProOpsDocument[]>([]);
  const futureRef = useRef<ProOpsDocument[]>([]);
  const [, setHistoryTick] = useState(0);

  const commitDoc = useCallback(
    (updater: ProOpsDocument | ((prev: ProOpsDocument) => ProOpsDocument), recordHistory = true) => {
      const prev = docRef.current;
      const rawNext = typeof updater === 'function' ? updater(prev) : updater;
      const reconciled = reconcileProOps(graph, rawNext).proOps;
      if (recordHistory) {
        pastRef.current = [...pastRef.current.slice(-(MAX_PRO_HISTORY - 1)), cloneProOpsDocument(prev)];
        futureRef.current = [];
        setHistoryTick((t) => t + 1);
      }
      docRef.current = reconciled;
      setDoc(reconciled);
      lastInitialRef.current = reconciled;
      onProOpsChange(reconciled);
    },
    [graph, onProOpsChange]
  );

  const handleProUndo = useCallback(() => {
    if (pastRef.current.length === 0) return;
    const previous = pastRef.current[pastRef.current.length - 1];
    pastRef.current = pastRef.current.slice(0, -1);
    futureRef.current = [cloneProOpsDocument(docRef.current), ...futureRef.current.slice(0, MAX_PRO_HISTORY - 1)];
    const reconciled = reconcileProOps(graph, previous).proOps;
    docRef.current = reconciled;
    setDoc(reconciled);
    lastInitialRef.current = reconciled;
    onProOpsChange(reconciled);
    setHistoryTick((t) => t + 1);
  }, [graph, onProOpsChange]);

  const handleProRedo = useCallback(() => {
    if (futureRef.current.length === 0) return;
    const next = futureRef.current[0];
    futureRef.current = futureRef.current.slice(1);
    pastRef.current = [...pastRef.current.slice(-(MAX_PRO_HISTORY - 1)), cloneProOpsDocument(docRef.current)];
    const reconciled = reconcileProOps(graph, next).proOps;
    docRef.current = reconciled;
    setDoc(reconciled);
    lastInitialRef.current = reconciled;
    onProOpsChange(reconciled);
    setHistoryTick((t) => t + 1);
  }, [graph, onProOpsChange]);

  useEffect(() => {
    onBindUndoBridge({
      canUndo: pastRef.current.length > 0,
      canRedo: futureRef.current.length > 0,
      undo: handleProUndo,
      redo: handleProRedo
    });
    return () => onBindUndoBridge(null);
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        e.stopPropagation();
        if (e.shiftKey) handleProRedo();
        else handleProUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        e.stopPropagation();
        handleProRedo();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [handleProUndo, handleProRedo]);

  const reconciledState = useMemo(() => reconcileProOps(graph, doc), [graph, doc]);
  const validations = reconciledState.validations;

  const mileageSummary = useMemo(
    () => computeNetworkMileageSummary(graph, reconciledState.proOps, isGeoMode),
    [graph, reconciledState.proOps, isGeoMode]
  );

  const kinematicsMap = useMemo(() => {
    const res: Record<string, ServiceKinematicsResult> = {};
    reconciledState.proOps.servicePatterns.forEach((p) => {
      const val = validations[p.id] || {
        patternId: p.id,
        status: 'broken',
        issues: [],
        healedSplitCount: 0
      };
      res[p.id] = solveServiceKinematics(graph, reconciledState.proOps, p, val, isGeoMode);
    });
    return res;
  }, [graph, reconciledState.proOps, validations, isGeoMode]);

  const [activeTab, setActiveTab] = useState<'services' | 'scale' | 'connections'>('services');
  const [targetLineId, setTargetLineId] = useState<string>(() => lines[0]?.id || '');
  const [targetVariantKey, setTargetVariantKey] = useState<string>('');
  const [selectedPatternId, setSelectedPatternId] = useState<string | null>(
    () => doc.servicePatterns[0]?.id || null
  );
  const [selectedStationId, setSelectedStationId] = useState<string | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);

  const [rulerMode, setRulerMode] = useState(false);
  const [rulerStations, setRulerStations] = useState<Station[]>([]);
  const [rulerKmVal, setRulerKmVal] = useState<number>(2);

  const [dockCollapsed, setDockCollapsed] = useState(false);
  const [axisMode, setAxisMode] = useState<'line' | 'pattern'>('line');
  const [corridorLineId, setCorridorLineId] = useState<string>(() => lines[0]?.id || '');

  const [shortTurnModalOpen, setShortTurnModalOpen] = useState(false);
  const [stStartId, setStStartId] = useState<string>('');
  const [stEndId, setStEndId] = useState<string>('');

  const [throughModalOpen, setThroughModalOpen] = useState(false);
  const [thConnId, setThConnId] = useState<string>('');
  const [thStartId, setThStartId] = useState<string>('');
  const [thEndId, setThEndId] = useState<string>('');
  const [thExpress, setThExpress] = useState<boolean>(false);

  const [connFromLineId, setConnFromLineId] = useState<string>(() => lines[0]?.id || '');
  const [connFromStationId, setConnFromStationId] = useState<string>('');
  const [connToLineId, setConnToLineId] = useState<string>(() => lines[1]?.id || lines[0]?.id || '');
  const [connToStationId, setConnToStationId] = useState<string>('');
  const [connDistanceM, setConnDistanceM] = useState<number>(180);
  const [connSpeedKmh, setConnSpeedKmh] = useState<number>(45);

  const lineVariants = useMemo(
    () => (targetLineId ? listLineRouteVariants(graph, targetLineId) : []),
    [graph, targetLineId]
  );

  useEffect(() => {
    if (!lines.some((l) => l.id === targetLineId)) {
      setTargetLineId(lines[0]?.id || '');
    }
    if (!lines.some((l) => l.id === corridorLineId)) {
      setCorridorLineId(lines[0]?.id || '');
    }
  }, [lines, targetLineId, corridorLineId]);

  useEffect(() => {
    if (!lineVariants.some((v) => v.key === targetVariantKey)) {
      setTargetVariantKey(lineVariants[0]?.key || '');
    }
  }, [lineVariants, targetVariantKey]);

  useEffect(() => {
    if (
      selectedPatternId &&
      !reconciledState.proOps.servicePatterns.some((p) => p.id === selectedPatternId)
    ) {
      setSelectedPatternId(reconciledState.proOps.servicePatterns[0]?.id || null);
    } else if (!selectedPatternId && reconciledState.proOps.servicePatterns.length > 0) {
      setSelectedPatternId(reconciledState.proOps.servicePatterns[0].id);
    }
  }, [reconciledState.proOps.servicePatterns, selectedPatternId]);

  const activePattern = useMemo(
    () => reconciledState.proOps.servicePatterns.find((p) => p.id === selectedPatternId) || null,
    [reconciledState.proOps.servicePatterns, selectedPatternId]
  );

  const handleStationClickOnCanvas = useCallback(
    (station: Station) => {
      if (rulerMode) {
        setRulerStations((prev) => {
          if (prev.length === 0) return [station];
          if (prev.length === 1) {
            if (prev[0].id === station.id) return prev;
            return [prev[0], station];
          }
          return [station];
        });
        return;
      }
      setSelectedStationId(station.id);
      setSelectedSectionId(null);
      if (!isMobileCompact) {
        setActiveTab('scale');
      }
    },
    [rulerMode, isMobileCompact]
  );

  const handleSectionClickOnCanvas = useCallback(
    (section: Section) => {
      if (rulerMode) return;
      setSelectedSectionId(section.id);
      setSelectedStationId(null);
      if (!isMobileCompact) {
        setActiveTab('scale');
      }
    },
    [rulerMode, isMobileCompact]
  );

  const renderStageOverlay = useCallback(
    (ctx: CanvasOverlayRenderContext) => (
      <ProCanvasOverlay
        ctx={ctx}
        lines={lines}
        sections={sections}
        stations={stations}
        proOps={reconciledState.proOps}
        activePattern={activePattern}
        activeValidation={activePattern ? validations[activePattern.id] : null}
        activeKinematics={activePattern ? kinematicsMap[activePattern.id] : null}
        selectedStationId={selectedStationId}
        selectedSectionId={selectedSectionId}
        rulerPoints={rulerStations}
      />
    ),
    [
      lines,
      sections,
      stations,
      reconciledState.proOps,
      activePattern,
      validations,
      kinematicsMap,
      selectedStationId,
      selectedSectionId,
      rulerStations
    ]
  );

  useEffect(() => {
    onBindCanvasBridge({
      onReadOnlyStationClick: handleStationClickOnCanvas,
      onReadOnlySectionClick: handleSectionClickOnCanvas,
      renderStageOverlay
    });
    return () => onBindCanvasBridge(null);
  }, [onBindCanvasBridge, handleStationClickOnCanvas, handleSectionClickOnCanvas, renderStageOverlay]);

  const diagramModel = useMemo(
    () =>
      buildCorridorDiagramModel({
        graph,
        proOps: reconciledState.proOps,
        validations,
        kinematicsMap,
        isGeoMode,
        axisMode,
        targetLineId: corridorLineId,
        targetPatternId: selectedPatternId
      }),
    [
      graph,
      reconciledState.proOps,
      validations,
      kinematicsMap,
      isGeoMode,
      axisMode,
      corridorLineId,
      selectedPatternId
    ]
  );

  // ==================== 业务操作动作 ====================

  const handleBootstrapAllLinesLocal = () => {
    const created: ProServicePattern[] = [];
    lines.forEach((line) => {
      created.push(...createAllSubCorridorPatternsForLine(graph, line.id));
    });
    if (created.length === 0) {
      message.warning('当前线网还没有已连接的区间，请先在「线网绘制」中连接至少两个站点');
      return;
    }
    commitDoc((prev) => ({
      ...prev,
      servicePatterns: [...prev.servicePatterns, ...created]
    }));
    setSelectedPatternId(created[0].id);
    setCorridorLineId(lines[0]?.id || '');
    message.success(`已为全网各主支线及区段生成 ${created.length} 条普通车交路`);
  };

  const handleAddLocalPattern = () => {
    if (!targetLineId) return;
    const p = createLineAllStopPattern(graph, targetLineId, targetVariantKey || undefined);
    if (!p) {
      message.warning('该线路尚无有效连接区间');
      return;
    }
    commitDoc((prev) => ({ ...prev, servicePatterns: [...prev.servicePatterns, p] }));
    setSelectedPatternId(p.id);
    setCorridorLineId(targetLineId);
    message.success(`已创建「${p.name}」`);
  };

  const handleAddExpressPattern = () => {
    if (!targetLineId) return;
    const p = createLineExpressPattern(graph, targetLineId, targetVariantKey || undefined);
    if (!p) {
      message.warning('该线路尚无有效连接区间');
      return;
    }
    commitDoc((prev) => ({ ...prev, servicePatterns: [...prev.servicePatterns, p] }));
    setSelectedPatternId(p.id);
    setCorridorLineId(targetLineId);
    message.success(`已创建「${p.name}」`);
  };

  const openShortTurnBuilder = () => {
    const line = lines.find((l) => l.id === targetLineId);
    if (!line || line.stationIds.length < 2) {
      message.warning('请先选择一条至少含 2 座车站的线路');
      return;
    }
    setStStartId(line.stationIds[0]);
    setStEndId(
      line.stationIds[Math.min(line.stationIds.length - 1, Math.max(1, Math.floor(line.stationIds.length * 0.6)))]
    );
    setShortTurnModalOpen(true);
  };

  const handleConfirmShortTurn = () => {
    const line = lines.find((l) => l.id === targetLineId);
    if (!line || !stStartId || !stEndId) return;
    const steps = buildOrderedLineSteps(graph, line.id, {
      startStationId: stStartId,
      endStationId: stEndId
    });
    if (steps.length === 0) {
      message.error('所选起止站在本线上处于不连通分段或无法连通，请选择同一连通区段内的车站');
      return;
    }
    const stationMap = new Map(stations.map((s) => [s.id, s]));
    const sName = stationMap.get(stStartId)?.name || '起点';
    const eName = stationMap.get(stEndId)?.name || '终点';
    const pattern: ProServicePattern = {
      id: createId(),
      name:
        stStartId === stEndId
          ? `${line.name} 环线 (${sName}始发)`
          : `${line.name} 区间 (${sName}-${eName})`,
      code: stStartId === stEndId ? '环行' : '区间',
      color: line.color,
      category: stStartId === stEndId ? 'local' : 'short_turn',
      stopAtStart: true,
      routeSteps: steps,
      headwaySec: 300,
      bidirectional: stStartId !== stEndId
    };
    commitDoc((prev) => ({
      ...prev,
      stationProfiles: {
        ...prev.stationProfiles,
        [stStartId]: { ...prev.stationProfiles[stStartId], hasTurnback: true },
        [stEndId]: { ...prev.stationProfiles[stEndId], hasTurnback: true }
      },
      servicePatterns: [...prev.servicePatterns, pattern]
    }));
    setSelectedPatternId(pattern.id);
    setCorridorLineId(line.id);
    setShortTurnModalOpen(false);
    message.success(`已创建交路「${pattern.name}」`);
  };

  const sharedJunctionCandidates = useMemo(() => {
    const stationMap = new Map(stations.map((s) => [s.id, s]));
    const existingSet = new Set(
      reconciledState.proOps.trackConnections.map(
        (c) => `${c.fromLineId}:${c.fromStationId}->${c.toLineId}:${c.toStationId}`
      )
    );
    const items: Array<{
      stationId: string;
      stationName: string;
      lineA: Line;
      lineB: Line;
    }> = [];
    for (let i = 0; i < lines.length; i += 1) {
      for (let j = i + 1; j < lines.length; j += 1) {
        const setB = new Set(lines[j].stationIds);
        lines[i].stationIds.forEach((sid) => {
          if (!setB.has(sid)) return;
          const keyAB = `${lines[i].id}:${sid}->${lines[j].id}:${sid}`;
          const keyBA = `${lines[j].id}:${sid}->${lines[i].id}:${sid}`;
          if (existingSet.has(keyAB) || existingSet.has(keyBA)) return;
          const st = stationMap.get(sid);
          if (st) {
            items.push({
              stationId: sid,
              stationName: st.name,
              lineA: lines[i],
              lineB: lines[j]
            });
          }
        });
      }
    }
    return items;
  }, [lines, stations, reconciledState.proOps.trackConnections]);

  const handleQuickAddSameStationJunction = (stationId: string, stationName: string, lineA: Line, lineB: Line) => {
    const conn: ProTrackConnection = {
      id: createId(),
      name: `${stationName} (${lineA.name}⇄${lineB.name})`,
      kind: 'same_station_junction',
      fromLineId: lineA.id,
      fromStationId: stationId,
      toLineId: lineB.id,
      toStationId: stationId,
      fromStationNameHint: stationName,
      toStationNameHint: stationName,
      distanceMeters: 180,
      speedLimitKmh: 45,
      bidirectional: true
    };
    commitDoc((prev) => ({
      ...prev,
      trackConnections: [...prev.trackConnections, conn]
    }));
    message.success(`已启用跨线道岔「${conn.name}」`);
  };

  const handleCreateCustomConnection = () => {
    if (!connFromLineId || !connFromStationId || !connToLineId || !connToStationId) {
      message.warning('请完整选择跨线连接的两端线路与车站');
      return;
    }
    if (connFromLineId === connToLineId && connFromStationId === connToStationId) {
      message.warning('跨线连接两端不能是同一条线路的同一车站');
      return;
    }
    const stationMap = new Map(stations.map((s) => [s.id, s]));
    const lineMap = new Map(lines.map((l) => [l.id, l]));
    const sFrom = stationMap.get(connFromStationId);
    const sTo = stationMap.get(connToStationId);
    const lFrom = lineMap.get(connFromLineId);
    const lTo = lineMap.get(connToLineId);
    const isSameSt = connFromStationId === connToStationId;
    const conn: ProTrackConnection = {
      id: createId(),
      name: isSameSt
        ? `${sFrom?.name || ''} (${lFrom?.name || ''}⇄${lTo?.name || ''})`
        : `${sFrom?.name || ''}—${sTo?.name || ''} 联络线`,
      kind: isSameSt ? 'same_station_junction' : 'inter_station_link',
      fromLineId: connFromLineId,
      fromStationId: connFromStationId,
      toLineId: connToLineId,
      toStationId: connToStationId,
      fromStationNameHint: sFrom?.name,
      toStationNameHint: sTo?.name,
      distanceMeters: Math.max(15, Math.round(connDistanceM || 180)),
      speedLimitKmh: Math.max(15, Math.min(200, Math.round(connSpeedKmh || 45))),
      bidirectional: true
    };
    commitDoc((prev) => ({
      ...prev,
      trackConnections: [...prev.trackConnections, conn]
    }));
    message.success(`已添加轨行连接「${conn.name}」`);
  };

  const openThroughRunningBuilder = () => {
    const validConns = reconciledState.proOps.trackConnections.filter(
      (c) => !reconciledState.brokenConnectionIds.has(c.id)
    );
    if (validConns.length === 0) {
      setActiveTab('connections');
      message.info('共站换乘不等于轨道连通：请先在「跨线连接」页启用至少一处跨线道岔或联络线');
      return;
    }
    const first = validConns[0];
    setThConnId(first.id);
    const fromLine = lines.find((l) => l.id === first.fromLineId);
    const toLine = lines.find((l) => l.id === first.toLineId);
    setThStartId(fromLine?.stationIds.find((id) => id !== first.fromStationId) || first.fromStationId);
    setThEndId(toLine?.stationIds.filter((id) => id !== first.toStationId).slice(-1)[0] || first.toStationId);
    setThroughModalOpen(true);
  };

  const handleConfirmThroughPattern = () => {
    const conn = reconciledState.proOps.trackConnections.find((c) => c.id === thConnId);
    if (!conn || !thStartId || !thEndId) return;

    const stationLineCounts = new Map<string, number>();
    lines.forEach((l) => {
      new Set(l.stationIds).forEach((sid) => {
        stationLineCounts.set(sid, (stationLineCounts.get(sid) || 0) + 1);
      });
    });

    const stopPred = thExpress
      ? (sid: string, isTerm: boolean) => isTerm || (stationLineCounts.get(sid) || 1) >= 2
      : undefined;

    const leg1 =
      thStartId === conn.fromStationId
        ? []
        : buildOrderedLineSteps(graph, conn.fromLineId, {
            startStationId: thStartId,
            endStationId: conn.fromStationId,
            stopPredicate: stopPred
          });

    if (thStartId !== conn.fromStationId && leg1.length === 0) {
      message.error('第一段起点到跨线连接点无法连通');
      return;
    }

    const leg2 =
      thEndId === conn.toStationId
        ? []
        : buildOrderedLineSteps(graph, conn.toLineId, {
            startStationId: conn.toStationId,
            endStationId: thEndId,
            stopPredicate: stopPred
          });

    if (thEndId !== conn.toStationId && leg2.length === 0) {
      message.error('跨线连接点到第二段终点无法连通');
      return;
    }

    const stationMap = new Map(stations.map((s) => [s.id, s]));
    const lineMap = new Map(lines.map((l) => [l.id, l]));
    const connStep: ProRouteStep = {
      kind: 'connection',
      connectionId: conn.id,
      fromLineId: conn.fromLineId,
      fromStationId: conn.fromStationId,
      toLineId: conn.toLineId,
      toStationId: conn.toStationId,
      fromStationNameHint: stationMap.get(conn.fromStationId)?.name,
      toStationNameHint: stationMap.get(conn.toStationId)?.name,
      stopAtEnd: true
    };

    const routeSteps = [...leg1, connStep, ...leg2];
    if (routeSteps.length === 0) {
      message.warning('跨线交路至少需要包含一段运行区间');
      return;
    }

    routeSteps[routeSteps.length - 1] = {
      ...routeSteps[routeSteps.length - 1],
      stopAtEnd: true
    };

    const l1Name = lineMap.get(conn.fromLineId)?.name || 'A线';
    const l2Name = lineMap.get(conn.toLineId)?.name || 'B线';
    const pattern: ProServicePattern = {
      id: createId(),
      name: `${l1Name}-${l2Name} ${thExpress ? '跨线直快' : '跨线贯通'}`,
      code: thExpress ? '直快' : '跨线',
      color: '#7c3aed',
      category: 'through',
      stopAtStart: true,
      routeSteps,
      headwaySec: 360,
      bidirectional: true
    };

    commitDoc((prev) => ({
      ...prev,
      servicePatterns: [...prev.servicePatterns, pattern]
    }));
    setSelectedPatternId(pattern.id);
    setAxisMode('pattern');
    setThroughModalOpen(false);
    message.success(`已创建跨线交路「${pattern.name}」`);
  };

  const handleToggleStepStop = (patternId: string, stepIndex: number) => {
    commitDoc((prev) => ({
      ...prev,
      servicePatterns: prev.servicePatterns.map((p) => {
        if (p.id !== patternId) return p;
        if (stepIndex < 0 || stepIndex >= p.routeSteps.length - 1) return p;
        const nextSteps = p.routeSteps.map((s, idx) =>
          idx === stepIndex ? { ...s, stopAtEnd: !s.stopAtEnd } : s
        );
        return { ...p, routeSteps: nextSteps };
      })
    }));
  };

  const handleReversePattern = (pattern: ProServicePattern) => {
    if (pattern.routeSteps.length === 0) return;
    const stationMap = new Map(stations.map((s) => [s.id, s]));
    const reversedSteps: ProRouteStep[] = [...pattern.routeSteps]
      .reverse()
      .map((step, idx, arr) => {
        const isLast = idx === arr.length - 1;
        const origIdx = pattern.routeSteps.length - 1 - idx;
        const nextStopAtEnd = isLast
          ? true
          : origIdx === 0
            ? pattern.stopAtStart
            : pattern.routeSteps[origIdx - 1].stopAtEnd;
        if (step.kind === 'section') {
          return {
            kind: 'section',
            sectionId: step.sectionId,
            lineId: step.lineId,
            fromStationId: step.toStationId,
            toStationId: step.fromStationId,
            fromStationNameHint: stationMap.get(step.toStationId)?.name || step.toStationNameHint,
            toStationNameHint: stationMap.get(step.fromStationId)?.name || step.fromStationNameHint,
            stopAtEnd: nextStopAtEnd
          };
        }
        return {
          kind: 'connection',
          connectionId: step.connectionId,
          fromLineId: step.toLineId,
          fromStationId: step.toStationId,
          toLineId: step.fromLineId,
          toStationId: step.fromStationId,
          fromStationNameHint: stationMap.get(step.toStationId)?.name || step.toStationNameHint,
          toStationNameHint: stationMap.get(step.fromStationId)?.name || step.fromStationNameHint,
          stopAtEnd: nextStopAtEnd
        };
      });

    commitDoc((prev) => ({
      ...prev,
      servicePatterns: prev.servicePatterns.map((p) =>
        p.id === pattern.id ? { ...p, routeSteps: reversedSteps } : p
      )
    }));
    message.success('已反转交路运行方向');
  };

  const handleRepairBrokenPattern = (pattern: ProServicePattern) => {
    const firstSectionStep = pattern.routeSteps.find((s) => s.kind === 'section');
    const lineId =
      firstSectionStep && firstSectionStep.kind === 'section'
        ? firstSectionStep.lineId
        : lines[0]?.id;
    if (!lineId) return;

    const stationSet = new Set(stations.map((s) => s.id));
    const oldStart = pattern.routeSteps[0]?.fromStationId;
    const oldEnd = pattern.routeSteps[pattern.routeSteps.length - 1]?.toStationId;

    const passedStations = new Set<string>();
    pattern.routeSteps.slice(0, -1).forEach((s) => {
      if (!s.stopAtEnd) passedStations.add(s.toStationId);
    });

    const rebuilt = buildOrderedLineSteps(graph, lineId, {
      startStationId: oldStart && stationSet.has(oldStart) ? oldStart : undefined,
      endStationId: oldEnd && stationSet.has(oldEnd) ? oldEnd : undefined,
      stopPredicate: (sid, isTerminal) => {
        if (isTerminal) return true;
        if (passedStations.has(sid)) return false;
        return pattern.category !== 'nonstop';
      }
    });

    if (rebuilt.length === 0) {
      message.error('当前物理线路尚无有效连通区间，请先返回「线网绘制」补全连线');
      return;
    }

    commitDoc((prev) => ({
      ...prev,
      servicePatterns: prev.servicePatterns.map((p) =>
        p.id === pattern.id ? { ...p, routeSteps: rebuilt } : p
      )
    }));
    message.success(`已沿最新线路拓扑重新接续「${pattern.name}」`);
  };

  const handleApplyRulerCalibration = () => {
    if (rulerStations.length < 2) return;
    if (!Number.isFinite(rulerKmVal) || rulerKmVal <= 0) {
      message.warning('请输入大于 0 的实际距离（公里）');
      return;
    }
    const nextMpu = calibrateMetersPerUnitBetweenPoints(
      rulerStations[0],
      rulerStations[1],
      rulerKmVal * 1000
    );
    if (!nextMpu) {
      message.warning('所选两站坐标重合，请选择相距一定距离的两座车站');
      return;
    }
    commitDoc((prev) => ({
      ...prev,
      scaleConfig: {
        ...prev.scaleConfig,
        metersPerUnit: nextMpu
      }
    }));
    setRulerMode(false);
    setRulerStations([]);
    message.success(`标尺已校准：1 画布单位 = ${nextMpu} 米`);
  };

  const saveExportBlob = async (blob: Blob, filename: string) => {
    if (isAndroidClient) {
      await saveAndroidExport(blob, filename);
      return;
    }
    if (hasDesktopBridge()) {
      const saved = await saveDesktopExport(blob, filename);
      if (saved) message.success(`已导出「${filename}」`);
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    message.success(`已导出「${filename}」`);
  };

  const handleExportDiagramSvg = async () => {
    if (diagramModel.columns.length === 0) {
      message.warning('当前没有可导出的走廊站点');
      return;
    }
    const svg = buildServiceDiagramSvg(diagramModel, mapSettings.canvasTheme);
    const base = sanitizeProjectFilename(`${mapDisplayName}-运行体系导乘图`);
    await saveExportBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `${base}.svg`);
  };

  const handleExportDiagramPng = async () => {
    if (diagramModel.columns.length === 0) {
      message.warning('当前没有可导出的走廊站点');
      return;
    }
    try {
      const svg = buildServiceDiagramSvg(diagramModel, mapSettings.canvasTheme);
      const pngBlob = await rasterizeSvgToPngBlob(svg, 2);
      const base = sanitizeProjectFilename(`${mapDisplayName}-运行体系导乘图`);
      await saveExportBlob(pngBlob, `${base}.png`);
    } catch (err: any) {
      message.error(err?.message || '导出 PNG 失败');
    }
  };

  const stationMap = useMemo(() => new Map(stations.map((s) => [s.id, s])), [stations]);
  const lineMap = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);
  const inspectedStation = selectedStationId ? stationMap.get(selectedStationId) : undefined;
  const inspectedSection = selectedSectionId
    ? sections.find((s) => s.id === selectedSectionId)
    : undefined;

  // ==================== 左侧专业运营工作台面板（桌面/平板） ====================
  const siderContent =
    !isMobileCompact && siderHost
      ? createPortal(
          <div className="pro-sider-shell">
            <div className="pro-sider-header">
              <div className="pro-sider-header__title">
                <span>专业运营</span>
                <span className="pro-sider-header__badge">Phase 1</span>
              </div>
              <button type="button" className="pro-btn pro-btn--sm" onClick={onExitProMode}>
                返回绘制
              </button>
            </div>

            <div className="pro-sider-tabs-wrap">
              <ElasticCapsuleTabs
                size="sm"
                block
                ariaLabel="专业运营功能分栏"
                value={activeTab}
                onChange={setActiveTab}
                options={[
                  { value: 'services', label: '运行体系' },
                  { value: 'scale', label: '标尺制式' },
                  { value: 'connections', label: '跨线连接' }
                ]}
              />
            </div>

            <div className="pro-sider-body">
              {activeTab === 'services' && (
                <>
                  {reconciledState.proOps.servicePatterns.length === 0 && lines.length > 0 && (
                    <div className="pro-card">
                      <div className="pro-card__title">
                        <span>快速开启运行体系</span>
                      </div>
                      <div className="pro-card__hint">
                        越站快车、大小交路与跨线直通均作为独立交路挂载，不增加物理线路数。
                      </div>
                      <button
                        type="button"
                        className="pro-btn pro-btn--primary"
                        onClick={handleBootstrapAllLinesLocal}
                      >
                        一键生成各线普通车
                      </button>
                    </div>
                  )}

                  <div className="pro-card">
                    <div className="pro-card__title">
                      <span>新建运行交路</span>
                    </div>
                    <div className="pro-field">
                      <label>基准物理线路</label>
                      <select
                        className="pro-select"
                        value={targetLineId}
                        onChange={(e) => setTargetLineId(e.target.value)}
                      >
                        {lines.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}（{l.stationIds.length}站）
                          </option>
                        ))}
                      </select>
                    </div>
                    {lineVariants.length > 1 && (
                      <div className="pro-field">
                        <label>走廊路径（主支线 / 独立区段）</label>
                        <select
                          className="pro-select"
                          value={targetVariantKey}
                          onChange={(e) => setTargetVariantKey(e.target.value)}
                        >
                          {lineVariants.map((v) => (
                            <option key={v.key} value={v.key}>
                              {v.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div className="pro-quick-grid">
                      <button type="button" className="pro-btn" onClick={handleAddLocalPattern}>
                        + 全程普通车
                      </button>
                      <button type="button" className="pro-btn" onClick={handleAddExpressPattern}>
                        + 大站快车
                      </button>
                      <button type="button" className="pro-btn" onClick={openShortTurnBuilder}>
                        + 区间 / 环行
                      </button>
                      <button type="button" className="pro-btn" onClick={openThroughRunningBuilder}>
                        + 跨线直通
                      </button>
                    </div>
                  </div>

                  {reconciledState.proOps.servicePatterns.length > 0 && (
                    <div className="pro-card">
                      <div className="pro-card__title">
                        <span>已编排交路（{reconciledState.proOps.servicePatterns.length}）</span>
                      </div>
                      <div className="pro-pattern-list">
                        {reconciledState.proOps.servicePatterns.map((p) => {
                          const val = validations[p.id];
                          const kin = kinematicsMap[p.id];
                          const isBroken = val?.status === 'broken';
                          const isSel = p.id === selectedPatternId;
                          return (
                            <div
                              key={p.id}
                              className={`pro-pattern-item${isSel ? ' is-selected' : ''}${
                                isBroken ? ' is-broken' : ''
                              }`}
                              onClick={() => setSelectedPatternId(p.id)}
                            >
                              <div className="pro-pattern-item__top">
                                <span className="pro-code-pill" style={{ background: p.color }}>
                                  {p.code}
                                </span>
                                <span className="pro-pattern-item__name">{p.name}</span>
                                {isBroken ? (
                                  <span className="pro-status-tag pro-status-tag--broken">断链待修复</span>
                                ) : null}
                              </div>
                              {!isBroken && kin ? (
                                <div className="pro-pattern-item__metrics">
                                  <span>每 {(p.headwaySec / 60).toFixed(1).replace(/\.0$/, '')} 分</span>
                                  <span>{(kin.oneWayTravelSec / 60).toFixed(1)} 分</span>
                                  <span>{kin.commercialSpeedKmh} km/h</span>
                                  <span>配车 {kin.activeTrains} 列</span>
                                </div>
                              ) : (
                                <div className="pro-pattern-item__metrics" style={{ color: '#d97706' }}>
                                  <span>{val?.issues[0]?.message || '区间拓扑已变更，点击修复'}</span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {activePattern && (() => {
                    const val = validations[activePattern.id];
                    const kin = kinematicsMap[activePattern.id];
                    const isBroken = val?.status === 'broken';
                    return (
                      <div className={`pro-card${isBroken ? ' pro-card--warn' : ''}`}>
                        <div className="pro-card__title">
                          <span>交路参数与停靠</span>
                          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                            <button
                              type="button"
                              className="pro-btn pro-btn--sm"
                              onClick={() => handleReversePattern(activePattern)}
                              title="反转上下行方向"
                            >
                              反转
                            </button>
                            <button
                              type="button"
                              className="pro-btn pro-btn--sm pro-btn--danger"
                              onClick={() => {
                                commitDoc((prev) => ({
                                  ...prev,
                                  servicePatterns: prev.servicePatterns.filter(
                                    (item) => item.id !== activePattern.id
                                  )
                                }));
                              }}
                            >
                              删除
                            </button>
                          </div>
                        </div>

                        {isBroken && val && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            <div className="pro-card__hint" style={{ color: '#b45309', fontWeight: 600 }}>
                              检测到线网拓扑修改导致断链（未静默删除交路）：
                            </div>
                            {val.issues.slice(0, 3).map((iss, idx) => (
                              <div key={idx} className="pro-card__hint" style={{ color: '#b45309' }}>
                                • {iss.message}
                              </div>
                            ))}
                            <button
                              type="button"
                              className="pro-btn pro-btn--primary pro-btn--sm"
                              onClick={() => handleRepairBrokenPattern(activePattern)}
                            >
                              沿当前线路首尾重新接续
                            </button>
                          </div>
                        )}

                        <div className="pro-field-row">
                          <div className="pro-field">
                            <label>交路名称</label>
                            <input
                              className="pro-input"
                              value={activePattern.name}
                              onChange={(e) => {
                                const valStr = e.target.value;
                                commitDoc((prev) => ({
                                  ...prev,
                                  servicePatterns: prev.servicePatterns.map((p) =>
                                    p.id === activePattern.id ? { ...p, name: valStr } : p
                                  )
                                }));
                              }}
                            />
                          </div>
                          <div className="pro-field">
                            <label>种别简称</label>
                            <input
                              className="pro-input"
                              maxLength={8}
                              value={activePattern.code}
                              onChange={(e) => {
                                const valStr = e.target.value;
                                commitDoc((prev) => ({
                                  ...prev,
                                  servicePatterns: prev.servicePatterns.map((p) =>
                                    p.id === activePattern.id ? { ...p, code: valStr } : p
                                  )
                                }));
                              }}
                            />
                          </div>
                        </div>

                        <div className="pro-field-row">
                          <div className="pro-field">
                            <label>发车间隔</label>
                            <ProNumberInput
                              value={activePattern.headwaySec}
                              min={60}
                              max={3600}
                              unitSuffix="秒"
                              onChange={(sec) => {
                                commitDoc((prev) => ({
                                  ...prev,
                                  servicePatterns: prev.servicePatterns.map((p) =>
                                    p.id === activePattern.id ? { ...p, headwaySec: sec } : p
                                  )
                                }));
                              }}
                            />
                          </div>
                          <div className="pro-field">
                            <label>标识颜色</label>
                            <input
                              type="color"
                              className="pro-input"
                              style={{ padding: 2, cursor: 'pointer' }}
                              value={activePattern.color}
                              onChange={(e) => {
                                const color = e.target.value;
                                commitDoc((prev) => ({
                                  ...prev,
                                  servicePatterns: prev.servicePatterns.map((p) =>
                                    p.id === activePattern.id ? { ...p, color } : p
                                  )
                                }));
                              }}
                            />
                          </div>
                        </div>

                        {!isBroken && kin && kin.visits.length >= 2 && (
                          <>
                            <div className="pro-card__hint">
                              全程 <strong>{kin.totalDistanceKm} km</strong> · 纯运行{' '}
                              <strong>{(kin.pureRunSec / 60).toFixed(1)} 分</strong> + 停站{' '}
                              <strong>{(kin.totalIntermediateDwellSec / 60).toFixed(1)} 分</strong> · 运能{' '}
                              <strong>{kin.hourlyCapacityPphpd.toLocaleString()} 人/h</strong>
                            </div>
                            <div className="pro-visit-list">
                              <div className="pro-visit-row">
                                <div className="pro-visit-row__left">
                                  <span className="pro-visit-row__idx">1</span>
                                  <span className="pro-visit-row__name">{kin.visits[0].stationName}</span>
                                </div>
                                <span className="pro-stop-toggle is-endpoint">始发 0.0&apos;</span>
                              </div>

                              {activePattern.routeSteps.map((step, sIdx) => {
                                const isSameStJunction =
                                  step.kind === 'connection' && step.fromStationId === step.toStationId;
                                if (isSameStJunction) {
                                  const toL = lineMap.get(step.toLineId);
                                  return (
                                    <div key={`step_junc_${sIdx}`} className="pro-visit-row">
                                      <div className="pro-visit-row__left">
                                        <span className="pro-visit-row__idx">⇄</span>
                                        <span className="pro-visit-row__name" style={{ color: '#0284c7' }}>
                                          道岔转入 {toL?.name || step.toLineId}
                                        </span>
                                      </div>
                                      <span className="pro-stop-toggle is-endpoint">跨线轨行</span>
                                    </div>
                                  );
                                }

                                const stName =
                                  stationMap.get(step.toStationId)?.name ||
                                  step.toStationNameHint ||
                                  step.toStationId;
                                const isLast = sIdx === activePattern.routeSteps.length - 1;
                                const matchedSeg = kin.segments.find((sg) => sg.stepIndex === sIdx);
                                const visitTiming = matchedSeg ? kin.visits[matchedSeg.toVisitIndex] : undefined;

                                return (
                                  <div key={`step_visit_${sIdx}`} className="pro-visit-row">
                                    <div className="pro-visit-row__left">
                                      <span className="pro-visit-row__idx">{sIdx + 2}</span>
                                      <span className="pro-visit-row__name">{stName}</span>
                                    </div>
                                    {isLast ? (
                                      <span className="pro-stop-toggle is-endpoint">
                                        终到 {visitTiming ? `${(visitTiming.arrivalSec / 60).toFixed(1)}'` : ''}
                                      </span>
                                    ) : (
                                      <button
                                        type="button"
                                        className={`pro-stop-toggle ${step.stopAtEnd ? 'is-stop' : 'is-pass'}`}
                                        onClick={() => handleToggleStepStop(activePattern.id, sIdx)}
                                      >
                                        {step.stopAtEnd
                                          ? `● 停靠 ${visitTiming ? `${(visitTiming.arrivalSec / 60).toFixed(1)}'` : ''}`
                                          : `○ 越站 ${visitTiming?.passSpeedKmh ? `${Math.round(visitTiming.passSpeedKmh)}km/h` : ''}`}
                                      </button>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })()}
                </>
              )}

              {activeTab === 'scale' && (
                <>
                  <div className="pro-card">
                    <div className="pro-card__title">
                      <span>标尺与全网里程</span>
                      <span className="pro-sider-header__badge">
                        {mileageSummary.totalLineKm} km
                      </span>
                    </div>
                    {isGeoMode ? (
                      <div className="pro-card__hint">
                        当前为<strong>地理底图模式</strong>：具备经纬度的站点与弯点默认按 WGS84 真实距离测算。
                      </div>
                    ) : (
                      <>
                        <div className="pro-field">
                          <label>1 画布世界单位对应实际距离</label>
                          <ProNumberInput
                            value={reconciledState.proOps.scaleConfig.metersPerUnit}
                            min={0}
                            max={10000}
                            allowDecimal
                            allowZero
                            unitSuffix="米"
                            onChange={(v) => {
                              commitDoc((prev) => ({
                                ...prev,
                                scaleConfig: { ...prev.scaleConfig, metersPerUnit: v }
                              }));
                            }}
                          />
                        </div>
                        <button
                          type="button"
                          className={`pro-btn${rulerMode ? ' pro-btn--primary' : ''}`}
                          onClick={() => {
                            setRulerMode((m) => !m);
                            setRulerStations([]);
                          }}
                        >
                          {rulerMode ? '退出两点标尺校准' : '画布两点标尺校准'}
                        </button>
                      </>
                    )}

                    {mileageSummary.lines.length > 0 && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}>
                        {mileageSummary.lines.map((lm) => (
                          <div key={lm.lineId} className="pro-visit-row">
                            <div className="pro-visit-row__left">
                              <span
                                style={{
                                  width: 8,
                                  height: 8,
                                  borderRadius: '50%',
                                  background: lm.color,
                                  flexShrink: 0
                                }}
                              />
                              <span className="pro-visit-row__name">{lm.lineName}</span>
                            </div>
                            <span style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
                              {lm.lengthKm} km · {lm.stationCount} 站
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="pro-card">
                    <div className="pro-card__title">
                      <span>车辆制式与牵引参数</span>
                    </div>
                    <div className="pro-field">
                      <label>选择物理线路</label>
                      <select
                        className="pro-select"
                        value={targetLineId}
                        onChange={(e) => setTargetLineId(e.target.value)}
                      >
                        {lines.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    {targetLineId && (() => {
                      const spec =
                        reconciledState.proOps.lineSpecs[targetLineId] || createDefaultLineSpec('6B');
                      const patchSpec = (patch: Partial<typeof spec>) => {
                        commitDoc((prev) => ({
                          ...prev,
                          lineSpecs: {
                            ...prev.lineSpecs,
                            [targetLineId]: { ...spec, ...patch }
                          }
                        }));
                      };
                      return (
                        <>
                          <div className="pro-field">
                            <label>列车编组制式</label>
                            <select
                              className="pro-select"
                              value={spec.rollingStock}
                              onChange={(e) => {
                                const code = e.target.value as ProRollingStockCode;
                                patchSpec(createDefaultLineSpec(code));
                              }}
                            >
                              {Object.entries(ROLLING_STOCK_PRESETS).map(([code, preset]) => (
                                <option key={code} value={code}>
                                  {preset.label}
                                </option>
                              ))}
                              <option value="custom">自定义参数</option>
                            </select>
                          </div>
                          <div className="pro-field-row">
                            <div className="pro-field">
                              <label>最高时速</label>
                              <ProNumberInput
                                value={spec.maxSpeedKmh}
                                min={25}
                                max={350}
                                unitSuffix="km/h"
                                onChange={(v) =>
                                  patchSpec({
                                    rollingStock: 'custom',
                                    maxSpeedKmh: v
                                  })
                                }
                              />
                            </div>
                            <div className="pro-field">
                              <label>额定定员</label>
                              <ProNumberInput
                                value={spec.carCapacity}
                                min={100}
                                max={5000}
                                unitSuffix="人"
                                onChange={(v) =>
                                  patchSpec({
                                    rollingStock: 'custom',
                                    carCapacity: v
                                  })
                                }
                              />
                            </div>
                          </div>
                          <div className="pro-field-row">
                            <div className="pro-field">
                              <label>加速度</label>
                              <ProNumberInput
                                value={spec.accelMps2}
                                min={0.2}
                                max={2.5}
                                allowDecimal
                                unitSuffix="m/s²"
                                onChange={(v) =>
                                  patchSpec({
                                    rollingStock: 'custom',
                                    accelMps2: v
                                  })
                                }
                              />
                            </div>
                            <div className="pro-field">
                              <label>折返时间</label>
                              <ProNumberInput
                                value={spec.turnbackSec}
                                min={30}
                                max={600}
                                unitSuffix="秒"
                                onChange={(v) => patchSpec({ turnbackSec: v })}
                              />
                            </div>
                          </div>
                        </>
                      );
                    })()}
                  </div>

                  <div className="pro-card">
                    <div className="pro-card__title">
                      <span>点选配线与限速</span>
                    </div>
                    {!inspectedStation && !inspectedSection && (
                      <div className="pro-card__hint">
                        在右侧画布点击<strong>车站</strong>（设折返线/越行线/停站时分）或<strong>区间</strong>（覆写里程/限速）。
                      </div>
                    )}

                    {inspectedStation && (() => {
                      const prof = reconciledState.proOps.stationProfiles[inspectedStation.id] || {};
                      const updateProf = (patch: Partial<typeof prof>) => {
                        commitDoc((prev) => ({
                          ...prev,
                          stationProfiles: {
                            ...prev.stationProfiles,
                            [inspectedStation.id]: { ...prof, ...patch }
                          }
                        }));
                      };
                      return (
                        <>
                          <div style={{ fontSize: 12.5, fontWeight: 700 }}>
                            车站：{inspectedStation.name}
                          </div>
                          <div className="pro-quick-grid">
                            <button
                              type="button"
                              className={`pro-btn pro-btn--sm${prof.hasTurnback ? ' pro-btn--primary' : ''}`}
                              onClick={() => updateProf({ hasTurnback: !prof.hasTurnback })}
                            >
                              {prof.hasTurnback ? '✓ 具备折返线' : '设为折返站'}
                            </button>
                            <button
                              type="button"
                              className={`pro-btn pro-btn--sm${prof.hasPassingTrack ? ' pro-btn--primary' : ''}`}
                              onClick={() => updateProf({ hasPassingTrack: !prof.hasPassingTrack })}
                            >
                              {prof.hasPassingTrack ? '✓ 具备越行线' : '设为越行站'}
                            </button>
                          </div>
                          <div className="pro-field-row">
                            <div className="pro-field">
                              <label>停站时间 (秒)</label>
                              <input
                                type="number"
                                className="pro-input"
                                placeholder="默认 30/45"
                                value={prof.dwellSec ?? ''}
                                onChange={(e) => {
                                  const raw = e.target.value.trim();
                                  updateProf({
                                    dwellSec: raw === '' ? undefined : Math.max(5, Math.min(600, Number(raw)))
                                  });
                                }}
                              />
                            </div>
                            <div className="pro-field">
                              <label>越站限速 (km/h)</label>
                              <input
                                type="number"
                                className="pro-input"
                                placeholder="不限速"
                                value={prof.passSpeedLimitKmh ?? ''}
                                onChange={(e) => {
                                  const raw = e.target.value.trim();
                                  updateProf({
                                    passSpeedLimitKmh:
                                      raw === '' ? undefined : Math.max(15, Math.min(350, Number(raw)))
                                  });
                                }}
                              />
                            </div>
                          </div>
                        </>
                      );
                    })()}

                    {inspectedSection && (() => {
                      const sA = stationMap.get(inspectedSection.startStationId);
                      const sB = stationMap.get(inspectedSection.endStationId);
                      const line = lineMap.get(inspectedSection.lineId);
                      const measured = measureSectionDistance(
                        inspectedSection,
                        stationMap,
                        reconciledState.proOps.scaleConfig,
                        reconciledState.proOps.sectionOverrides,
                        isGeoMode
                      );
                      const ov = reconciledState.proOps.sectionOverrides[inspectedSection.id] || {};
                      const updateOv = (patch: Partial<typeof ov>) => {
                        commitDoc((prev) => ({
                          ...prev,
                          sectionOverrides: {
                            ...prev.sectionOverrides,
                            [inspectedSection.id]: { ...ov, ...patch }
                          }
                        }));
                      };
                      return (
                        <>
                          <div style={{ fontSize: 12.5, fontWeight: 700 }}>
                            {line?.name || ''}：{sA?.name || ''} — {sB?.name || ''}
                          </div>
                          <div className="pro-card__hint">
                            有效里程：<strong>{(measured.meters / 1000).toFixed(2)} km</strong>（{measured.meters} 米）
                          </div>
                          <div className="pro-field-row">
                            <div className="pro-field">
                              <label>里程覆写 (米)</label>
                              <input
                                type="number"
                                className="pro-input"
                                placeholder="自动测算"
                                value={ov.distanceMetersOverride ?? ''}
                                onChange={(e) => {
                                  const raw = e.target.value.trim();
                                  updateOv({
                                    distanceMetersOverride:
                                      raw === '' ? undefined : Math.max(30, Math.min(200000, Number(raw)))
                                  });
                                }}
                              />
                            </div>
                            <div className="pro-field">
                              <label>区间限速 (km/h)</label>
                              <input
                                type="number"
                                className="pro-input"
                                placeholder="同最高速"
                                value={ov.speedLimitKmh ?? ''}
                                onChange={(e) => {
                                  const raw = e.target.value.trim();
                                  updateOv({
                                    speedLimitKmh:
                                      raw === '' ? undefined : Math.max(15, Math.min(350, Number(raw)))
                                  });
                                }}
                              />
                            </div>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </>
              )}

              {activeTab === 'connections' && (
                <>
                  <div className="pro-card">
                    <div className="pro-card__title">
                      <span>跨线物理轨行连接</span>
                    </div>
                    <div className="pro-card__hint">
                      共站换乘默认无轨道连通；仅添加跨线道岔或联络线后，方可编排跨线直通列车。
                    </div>

                    {sharedJunctionCandidates.length > 0 && (
                      <>
                        <div className="pro-card__hint" style={{ fontWeight: 600, color: 'var(--color-text)' }}>
                          识别到共站枢纽（一键启用同站道岔）：
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                          {sharedJunctionCandidates.slice(0, 8).map((cand, idx) => (
                            <button
                              key={`${cand.stationId}_${idx}`}
                              type="button"
                              className="pro-btn pro-btn--sm"
                              style={{ justifyContent: 'space-between' }}
                              onClick={() =>
                                handleQuickAddSameStationJunction(
                                  cand.stationId,
                                  cand.stationName,
                                  cand.lineA,
                                  cand.lineB
                                )
                              }
                            >
                              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {cand.stationName}：{cand.lineA.name} ⇄ {cand.lineB.name}
                              </span>
                              <span style={{ color: 'var(--color-primary-600)', flexShrink: 0 }}>+ 启用</span>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  <div className="pro-card">
                    <div className="pro-card__title">
                      <span>自定义道岔 / 联络线</span>
                    </div>
                    <div className="pro-field-row">
                      <div className="pro-field">
                        <label>引出线路</label>
                        <select
                          className="pro-select"
                          value={connFromLineId}
                          onChange={(e) => {
                            setConnFromLineId(e.target.value);
                            const l = lines.find((item) => item.id === e.target.value);
                            setConnFromStationId(l?.stationIds[0] || '');
                          }}
                        >
                          {lines.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="pro-field">
                        <label>引出车站</label>
                        <select
                          className="pro-select"
                          value={connFromStationId}
                          onChange={(e) => setConnFromStationId(e.target.value)}
                        >
                          <option value="">请选择车站</option>
                          {(lines.find((l) => l.id === connFromLineId)?.stationIds || []).map((sid) => (
                            <option key={sid} value={sid}>
                              {stationMap.get(sid)?.name || sid}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="pro-field-row">
                      <div className="pro-field">
                        <label>接入线路</label>
                        <select
                          className="pro-select"
                          value={connToLineId}
                          onChange={(e) => {
                            setConnToLineId(e.target.value);
                            const l = lines.find((item) => item.id === e.target.value);
                            setConnToStationId(l?.stationIds[0] || '');
                          }}
                        >
                          {lines.map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="pro-field">
                        <label>接入车站</label>
                        <select
                          className="pro-select"
                          value={connToStationId}
                          onChange={(e) => setConnToStationId(e.target.value)}
                        >
                          <option value="">请选择车站</option>
                          {(lines.find((l) => l.id === connToLineId)?.stationIds || []).map((sid) => (
                            <option key={sid} value={sid}>
                              {stationMap.get(sid)?.name || sid}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="pro-field-row">
                      <div className="pro-field">
                        <label>轨道长度</label>
                        <ProNumberInput
                          value={connDistanceM}
                          min={15}
                          max={30000}
                          unitSuffix="米"
                          onChange={setConnDistanceM}
                        />
                      </div>
                      <div className="pro-field">
                        <label>连接限速</label>
                        <ProNumberInput
                          value={connSpeedKmh}
                          min={15}
                          max={160}
                          unitSuffix="km/h"
                          onChange={setConnSpeedKmh}
                        />
                      </div>
                    </div>

                    <button
                      type="button"
                      className="pro-btn pro-btn--primary"
                      onClick={handleCreateCustomConnection}
                    >
                      + 添加轨行连接
                    </button>
                  </div>

                  {reconciledState.proOps.trackConnections.length > 0 && (
                    <div className="pro-card">
                      <div className="pro-card__title">
                        <span>已启用连接（{reconciledState.proOps.trackConnections.length}）</span>
                      </div>
                      {reconciledState.proOps.trackConnections.map((conn) => {
                        const isBroken = reconciledState.brokenConnectionIds.has(conn.id);
                        return (
                          <div key={conn.id} className="pro-visit-row">
                            <div
                              className="pro-visit-row__left"
                              style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}
                            >
                              <span className="pro-visit-row__name">{conn.name}</span>
                              <span
                                style={{
                                  fontSize: 10,
                                  color: isBroken ? '#d97706' : 'var(--color-text-muted)'
                                }}
                              >
                                {isBroken
                                  ? '两端车站已变动'
                                  : `${conn.distanceMeters}m · 限速 ${conn.speedLimitKmh}km/h`}
                              </span>
                            </div>
                            <button
                              type="button"
                              className="pro-btn pro-btn--sm pro-btn--danger"
                              onClick={() =>
                                commitDoc((prev) => ({
                                  ...prev,
                                  trackConnections: prev.trackConnections.filter((c) => c.id !== conn.id)
                                }))
                              }
                            >
                              移除
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>,
          siderHost
        )
      : null;

  // ==================== 画布内部：仅在两点标尺校准激活时展示引导条（去掉图1常驻提示） ====================
  const stageRulerHud =
    rulerMode && stageHost
      ? createPortal(
          <div className="pro-stage-top-hud">
            <span style={{ fontWeight: 700, color: 'var(--color-primary-600)' }}>两点标尺校准：</span>
            {rulerStations.length === 0 && <span>请依次在画布上点击两座车站（1/2）</span>}
            {rulerStations.length === 1 && (
              <span>已选点 A「{rulerStations[0].name}」，请点击点 B 车站（2/2）</span>
            )}
            {rulerStations.length === 2 && (
              <>
                <span>
                  {rulerStations[0].name} → {rulerStations[1].name} 实际距离：
                </span>
                <ProNumberInput
                  value={rulerKmVal}
                  min={0.05}
                  max={500}
                  allowDecimal
                  unitSuffix="km"
                  style={{ width: 88, height: 26 }}
                  onChange={setRulerKmVal}
                />
                <button
                  type="button"
                  className="pro-btn pro-btn--primary pro-btn--sm"
                  onClick={handleApplyRulerCalibration}
                >
                  确认校准
                </button>
              </>
            )}
            <button
              type="button"
              className="pro-btn pro-btn--sm"
              onClick={() => {
                setRulerMode(false);
                setRulerStations([]);
              }}
            >
              取消
            </button>
          </div>,
          stageHost
        )
      : null;

  // ==================== 底部独立停靠导乘图（位于画布容器下方，与右下角缩放栏零重叠） ====================
  const bottomDockContent = dockHost
    ? createPortal(
        <div className={`pro-strip-dock${dockCollapsed ? ' is-collapsed' : ''}`}>
          <div className="pro-strip-dock__bar">
            <div className="pro-strip-dock__bar-left">
              <span className="pro-strip-dock__title">运行体系导乘图</span>
              {!dockCollapsed && (
                <select
                  className="pro-select"
                  style={{ width: 'auto', height: 26 }}
                  value={axisMode === 'pattern' ? '__pattern__' : corridorLineId}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === '__pattern__') {
                      setAxisMode('pattern');
                    } else {
                      setAxisMode('line');
                      setCorridorLineId(val);
                    }
                  }}
                >
                  {lines.map((l) => (
                    <option key={l.id} value={l.id}>
                      全拓扑走廊：{l.name}
                    </option>
                  ))}
                  {activePattern ? (
                    <option value="__pattern__">交路全程轴：「{activePattern.name}」</option>
                  ) : null}
                </select>
              )}
            </div>

            <div className="pro-strip-dock__bar-right">
              {!dockCollapsed && (
                <>
                  <button
                    type="button"
                    className="pro-btn pro-btn--sm"
                    onClick={() => void handleExportDiagramSvg()}
                  >
                    导出 SVG
                  </button>
                  <button
                    type="button"
                    className="pro-btn pro-btn--sm"
                    onClick={() => void handleExportDiagramPng()}
                  >
                    导出 PNG
                  </button>
                </>
              )}
              {isMobileCompact && (
                <button
                  type="button"
                  className="pro-btn pro-btn--primary pro-btn--sm"
                  onClick={onExitProMode}
                >
                  返回绘图
                </button>
              )}
              <button
                type="button"
                className="pro-btn pro-btn--sm"
                onClick={() => setDockCollapsed((c) => !c)}
              >
                {dockCollapsed ? '展开导乘图' : '收起'}
              </button>
            </div>
          </div>

          {!dockCollapsed && (
            <div className="pro-strip-dock__scroll">
              {diagramModel.columns.length === 0 ? (
                <div className="pro-card__hint" style={{ padding: '12px 4px' }}>
                  当前走廊暂无车站，请先在线网绘制模式绘制线路与车站。
                </div>
              ) : (
                <div className="pro-strip-matrix">
                  <div className="pro-strip-header-row">
                    <div className="pro-strip-left-col">
                      <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--color-text)' }}>
                        {diagramModel.title}
                      </div>
                      <div style={{ fontSize: 10.5, color: 'var(--color-text-muted)' }}>
                        {diagramModel.subtitle}
                      </div>
                    </div>
                    <div className="pro-strip-stations-track">
                      {diagramModel.columns.map((col) => {
                        const isBreak = col.colIndex > 0 && !col.connectToPrev;
                        return (
                          <div
                            key={`col_${col.colIndex}`}
                            className={`pro-strip-station-col${isBreak ? ' is-subcorridor-break' : ''}`}
                          >
                            {col.subCorridorLabel ? (
                              <span
                                className="pro-strip-station-col__subtag"
                                title={col.subCorridorLabel}
                              >
                                {col.subCorridorLabel}
                              </span>
                            ) : (
                              <span
                                className="pro-strip-station-col__line-pill"
                                style={{ background: col.lineColor }}
                              >
                                {col.lineName}
                              </span>
                            )}
                            <span className="pro-strip-station-col__km">
                              {col.cumulativeKm.toFixed(1)}km
                            </span>
                            <span className="pro-strip-station-col__name" title={col.stationName}>
                              {col.stationName}
                            </span>
                            <div className="pro-strip-station-col__transfers">
                              {col.transferLines.slice(0, 2).map((tr) => (
                                <span
                                  key={tr.id}
                                  className="pro-strip-transfer-dot"
                                  style={{ background: tr.color }}
                                >
                                  {tr.name.slice(0, 4)}
                                </span>
                              ))}
                              {col.hasTurnback ? (
                                <span
                                  className="pro-strip-transfer-dot"
                                  style={{ background: '#475569' }}
                                  title="具备折返线"
                                >
                                  折
                                </span>
                              ) : null}
                              {col.hasPassingTrack ? (
                                <span
                                  className="pro-strip-transfer-dot"
                                  style={{ background: '#0284c7' }}
                                  title="具备越行线"
                                >
                                  越
                                </span>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {diagramModel.rows.length === 0 ? (
                    <div
                      style={{
                        padding: '10px 12px',
                        borderRadius: 8,
                        border: '1px dashed var(--color-border-strong)',
                        fontSize: 12,
                        color: 'var(--color-text-muted)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 8
                      }}
                    >
                      <span>尚未给本走廊编排运行交路（普通车 / 快车 / 跨线车）</span>
                      {!isMobileCompact && lines.length > 0 ? (
                        <button
                          type="button"
                          className="pro-btn pro-btn--primary pro-btn--sm"
                          onClick={handleBootstrapAllLinesLocal}
                        >
                          一键生成基准交路
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    diagramModel.rows.map((row) => {
                      const p = row.pattern;
                      const kin = row.kinematics;
                      const isBroken = row.validation.status === 'broken';
                      const isRowActive = p.id === selectedPatternId;
                      const colW = 76;

                      return (
                        <div
                          key={p.id}
                          className={`pro-strip-service-row${isRowActive ? ' is-active' : ''}`}
                          onClick={() => setSelectedPatternId(p.id)}
                        >
                          <div className="pro-strip-left-col">
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <span className="pro-code-pill" style={{ background: p.color }}>
                                {p.code}
                              </span>
                              <span
                                style={{
                                  fontSize: 12,
                                  fontWeight: 700,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap'
                                }}
                              >
                                {p.name}
                              </span>
                            </div>
                            <div
                              style={{
                                fontSize: 10.5,
                                color: isBroken ? '#d97706' : 'var(--color-text-muted)',
                                marginTop: 2,
                                display: 'flex',
                                alignItems: 'center',
                                gap: 5,
                                flexWrap: 'wrap'
                              }}
                            >
                              {isBroken ? (
                                <span>断链待修复</span>
                              ) : (
                                <>
                                  <span>
                                    每 {(p.headwaySec / 60).toFixed(1).replace(/\.0$/, '')} 分 ·{' '}
                                    {(kin.oneWayTravelSec / 60).toFixed(1)} 分
                                  </span>
                                  {row.savedMinutesVsLocal ? (
                                    <span className="pro-status-tag pro-status-tag--saved">
                                      省 {row.savedMinutesVsLocal} 分
                                    </span>
                                  ) : null}
                                </>
                              )}
                            </div>
                          </div>

                          {!isBroken && (
                            <div className="pro-strip-cells-wrap" style={{ color: p.color }}>
                              {row.spans.map((sp, spIdx) => {
                                const left = sp.startCol * colW + colW / 2;
                                const width = Math.max(0, (sp.endCol - sp.startCol) * colW);
                                const prevSp = spIdx > 0 ? row.spans[spIdx - 1] : null;
                                const showBridge =
                                  prevSp &&
                                  diagramModel.columns[prevSp.endCol]?.stationId ===
                                    diagramModel.columns[sp.startCol]?.stationId;
                                const bridgeLeft = prevSp ? prevSp.endCol * colW + colW / 2 : 0;
                                return (
                                  <React.Fragment key={`span_${p.id}_${spIdx}`}>
                                    {showBridge && (
                                      <div
                                        className="pro-strip-band-bridge"
                                        style={{
                                          left: bridgeLeft,
                                          width: Math.max(0, left - bridgeLeft)
                                        }}
                                      />
                                    )}
                                    <div
                                      className="pro-strip-band-line"
                                      style={{
                                        left,
                                        width,
                                        background: p.color
                                      }}
                                    />
                                  </React.Fragment>
                                );
                              })}
                              {row.cells.map((cell) => {
                                const col = diagramModel.columns[cell.colIndex];
                                const isBreak = cell.colIndex > 0 && col && !col.connectToPrev;
                                return (
                                  <div
                                    key={`cell_${p.id}_${cell.colIndex}`}
                                    className={`pro-strip-cell${isBreak ? ' is-subcorridor-break' : ''}`}
                                    style={{ color: p.color }}
                                    title={
                                      cell.kind === 'pass'
                                        ? `越站直通（通过速度 ${cell.passSpeedKmh || 0} km/h）`
                                        : cell.kind === 'stop'
                                          ? `停靠站（+${cell.arrivalMin ?? 0} 分）`
                                          : undefined
                                    }
                                  >
                                    {(cell.kind === 'origin' || cell.kind === 'terminus') && (
                                      <span className="pro-strip-node-terminal" />
                                    )}
                                    {cell.kind === 'stop' && <span className="pro-strip-node-stop" />}
                                    {cell.arrivalMin !== undefined &&
                                      cell.kind !== 'none' &&
                                      cell.kind !== 'pass' &&
                                      cell.kind !== 'origin' && (
                                        <span className="pro-strip-cell__min">
                                          {cell.arrivalMin.toFixed(1)}&apos;
                                        </span>
                                      )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          )}
        </div>,
        dockHost
      )
    : null;

  return (
    <>
      {siderContent}
      {stageRulerHud}
      {bottomDockContent}

      <Modal
        open={shortTurnModalOpen}
        title="新建区间 / 环行交路"
        okText="创建交路"
        cancelText="取消"
        onCancel={() => setShortTurnModalOpen(false)}
        onOk={handleConfirmShortTurn}
        destroyOnClose
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 8 }}>
          <div className="pro-field">
            <label>所属物理线路</label>
            <select
              className="pro-select"
              value={targetLineId}
              onChange={(e) => {
                const lid = e.target.value;
                setTargetLineId(lid);
                const l = lines.find((item) => item.id === lid);
                setStStartId(l?.stationIds[0] || '');
                setStEndId(l?.stationIds[l.stationIds.length - 1] || '');
              }}
            >
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>
          <div className="pro-field-row">
            <div className="pro-field">
              <label>折返起点站（环线可选同站绕圈）</label>
              <select
                className="pro-select"
                value={stStartId}
                onChange={(e) => setStStartId(e.target.value)}
              >
                {(lines.find((l) => l.id === targetLineId)?.stationIds || []).map((sid) => (
                  <option key={sid} value={sid}>
                    {stationMap.get(sid)?.name || sid}
                  </option>
                ))}
              </select>
            </div>
            <div className="pro-field">
              <label>折返终点站</label>
              <select
                className="pro-select"
                value={stEndId}
                onChange={(e) => setStEndId(e.target.value)}
              >
                {(lines.find((l) => l.id === targetLineId)?.stationIds || []).map((sid) => (
                  <option key={sid} value={sid}>
                    {stationMap.get(sid)?.name || sid}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="pro-card__hint">
            创建后将自动为所选起止车站标记「具备折返配线」。
          </div>
        </div>
      </Modal>

      <Modal
        open={throughModalOpen}
        title="新建跨线直通交路"
        okText="创建跨线交路"
        cancelText="取消"
        onCancel={() => setThroughModalOpen(false)}
        onOk={handleConfirmThroughPattern}
        destroyOnClose
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, paddingTop: 8 }}>
          <div className="pro-field">
            <label>经由的物理跨线连接（道岔 / 联络线）</label>
            <select
              className="pro-select"
              value={thConnId}
              onChange={(e) => {
                const cid = e.target.value;
                setThConnId(cid);
                const c = reconciledState.proOps.trackConnections.find((item) => item.id === cid);
                if (c) {
                  const fl = lines.find((l) => l.id === c.fromLineId);
                  const tl = lines.find((l) => l.id === c.toLineId);
                  setThStartId(fl?.stationIds.find((id) => id !== c.fromStationId) || c.fromStationId);
                  setThEndId(tl?.stationIds.filter((id) => id !== c.toStationId).slice(-1)[0] || c.toStationId);
                }
              }}
            >
              {reconciledState.proOps.trackConnections
                .filter((c) => !reconciledState.brokenConnectionIds.has(c.id))
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}（限速 {c.speedLimitKmh} km/h）
                  </option>
                ))}
            </select>
          </div>
          {(() => {
            const conn = reconciledState.proOps.trackConnections.find((c) => c.id === thConnId);
            if (!conn) return null;
            const fromLine = lines.find((l) => l.id === conn.fromLineId);
            const toLine = lines.find((l) => l.id === conn.toLineId);
            return (
              <div className="pro-field-row">
                <div className="pro-field">
                  <label>{fromLine?.name || '始发线'} 始发站</label>
                  <select
                    className="pro-select"
                    value={thStartId}
                    onChange={(e) => setThStartId(e.target.value)}
                  >
                    {(fromLine?.stationIds || []).map((sid) => (
                      <option key={sid} value={sid}>
                        {stationMap.get(sid)?.name || sid}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="pro-field">
                  <label>{toLine?.name || '接入线'} 终到站</label>
                  <select
                    className="pro-select"
                    value={thEndId}
                    onChange={(e) => setThEndId(e.target.value)}
                  >
                    {(toLine?.stationIds || []).map((sid) => (
                      <option key={sid} value={sid}>
                        {stationMap.get(sid)?.name || sid}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })()}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={thExpress}
              onChange={(e) => setThExpress(e.target.checked)}
            />
            <span>按「跨线大站直快」生成初始停靠（默认仅停首末站、跨线节点与换乘枢纽）</span>
          </label>
        </div>
      </Modal>
    </>
  );
};

export default ProWorkspace;
