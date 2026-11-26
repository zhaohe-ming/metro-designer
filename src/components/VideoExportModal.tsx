import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Checkbox, Dropdown, Input, InputNumber, Select, message } from 'antd';
import type { MenuProps } from 'antd';
import {
  CaretRightOutlined,
  DownOutlined,
  MoreOutlined,
  PauseOutlined,
  PlusOutlined,
  RightOutlined
} from '@ant-design/icons';
import {
  Line,
  MapSettings,
  Section,
  Station,
  VideoAspectRatio,
  VideoDateMode,
  VideoExportConfig,
  VideoFps,
  VideoResolution,
  VideoSpeedMultiplier,
  VideoCameraMode,
  VideoTimelineMode,
  VideoUnopenedStyle
} from '../types';
import {
  computeVideoDimensions,
  generateAutoVideoSegments,
  isValidFlexibleOpenDate,
  normalizeSortableDateKey,
  resolveVideoRoute,
  VideoSegmentInput
} from '../lib/videoModel';
import { createVideoSceneRenderer } from '../lib/exportVideo';
import DraggableModal from './DraggableModal';
import ElasticCapsuleTabs from './ElasticCapsuleTabs';

export type { VideoSegmentInput } from '../lib/videoModel';
export type { VideoExportConfig } from '../types';

interface VideoExportModalProps {
  open: boolean;
  lines: Line[];
  stations: Station[];
  sections: Section[];
  settings?: MapSettings;
  metersPerUnit?: number;
  defaultTitle?: string;
  config?: VideoExportConfig;
  onChange: (config: VideoExportConfig) => void;
  onCancel: () => void;
  onConfirm: (config: VideoExportConfig) => void;
}

const DEFAULT_TITLE_DURATION_SEC = 3;

const createEmptySegment = (defaultDate = ''): VideoSegmentInput => ({
  id: `seg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  lineId: '',
  startStationId: '',
  endStationId: '',
  openDate: defaultDate
});

function formatTimeMMSS(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem < 10 ? '0' : ''}${rem}`;
}

function buildInitialDraft(
  config: VideoExportConfig | undefined,
  defaultTitle: string | undefined,
  lines: Line[],
  stations: Station[],
  sections: Section[]
): VideoExportConfig {
  const hasSavedSegments = Boolean(
    config &&
      config.segments.length > 0 &&
      config.segments.some((s) => s.lineId || s.startStationId || s.endStationId || s.openDate)
  );
  const autoSegments = !hasSavedSegments
    ? generateAutoVideoSegments(lines, stations, sections, config?.dateMode || 'date')
    : [];
  const initialSegments = hasSavedSegments
    ? config!.segments.map((s) => ({ ...s }))
    : autoSegments.length > 0
      ? autoSegments
      : [createEmptySegment('2020-06')];

  return {
    segments: initialSegments,
    title: config?.title ?? (defaultTitle || '城市轨道线网历程'),
    subtitle: config?.subtitle ?? '',
    titleDurationSec: config?.titleDurationSec ?? DEFAULT_TITLE_DURATION_SEC,
    aspectRatio: config?.aspectRatio ?? '16:9',
    resolution: config?.resolution ?? '1080p',
    fps: config?.fps ?? 30,
    speedMultiplier: config?.speedMultiplier ?? 1,
    cameraMode: config?.cameraMode ?? 'gentle',
    unopenedStyle: config?.unopenedStyle ?? 'ghost',
    dateMode: config?.dateMode ?? 'date',
    timelineMode: config?.timelineMode ?? 'chronicle',
    showYearBadge: config?.showYearBadge ?? true,
    showLineLegend: config?.showLineLegend ?? true
  };
}

const VideoExportModal: React.FC<VideoExportModalProps> = ({
  open,
  lines,
  stations,
  sections,
  settings,
  metersPerUnit,
  defaultTitle,
  config,
  onChange,
  onCancel,
  onConfirm
}) => {
  const [draft, setDraft] = useState<VideoExportConfig>(() =>
    buildInitialDraft(config, defaultTitle, lines, stations, sections)
  );
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [titleSectionOpen, setTitleSectionOpen] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [previewFrame, setPreviewFrame] = useState(0);

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const trackBarRef = useRef<HTMLDivElement>(null);
  const scrubbingRef = useRef(false);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const nextDraft = buildInitialDraft(config, defaultTitle, lines, stations, sections);
      setDraft(nextDraft);
      // 仅当只有一个空白占位行时自动展开，已导入多段时全部折叠保持紧凑
      const onlyBlank = nextDraft.segments.length === 1 && !nextDraft.segments[0].lineId;
      setExpandedId(onlyBlank ? nextDraft.segments[0].id : null);
      setTitleSectionOpen(false);
      setPreviewFrame(0);
      setPlaying(true);
    } else if (!open && wasOpenRef.current) {
      setPlaying(false);
    }
    wasOpenRef.current = open;
  }, [open, config, defaultTitle, lines, stations, sections]);

  const updateDraft = (patch: Partial<VideoExportConfig>) => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const segments = draft.segments;
  const dateMode: VideoDateMode = draft.dateMode || 'date';
  const timelineMode: VideoTimelineMode = draft.timelineMode || 'chronicle';
  const aspectRatio: VideoAspectRatio = draft.aspectRatio || '16:9';
  const resolution: VideoResolution = draft.resolution || '1080p';
  const fps: VideoFps = draft.fps || 30;
  const speedMultiplier: VideoSpeedMultiplier = draft.speedMultiplier || 1;
  const cameraMode: VideoCameraMode = draft.cameraMode || 'gentle';
  const unopenedStyle: VideoUnopenedStyle = draft.unopenedStyle || 'ghost';
  const showYearBadge = draft.showYearBadge !== false;
  const showLineLegend = draft.showLineLegend !== false;

  const lineById = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);
  const stationById = useMemo(() => new Map(stations.map((s) => [s.id, s])), [stations]);

  const lineOptions = useMemo(
    () =>
      lines.map((line) => ({
        value: line.id,
        label: (
          <span className="metro-video-line-opt">
            <span className="metro-video-line-opt__dot" style={{ backgroundColor: line.color }} />
            <span>{line.name}</span>
          </span>
        )
      })),
    [lines]
  );

  const getStationOptions = (lineId: string) => {
    const line = lineById.get(lineId);
    if (!line) return [];
    const seen = new Set<string>();
    return line.stationIds
      .filter((id) => {
        if (seen.has(id) || !stationById.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((id) => ({
        label: stationById.get(id)!.name,
        value: id
      }));
  };

  const segmentDiagnostics = useMemo(() => {
    return segments.map((seg) => {
      if (!seg.lineId) return { valid: false, message: '未选择线路', stationCount: 0 };
      if (!seg.startStationId || !seg.endStationId) return { valid: false, message: '未选择起终点', stationCount: 0 };
      if (seg.startStationId === seg.endStationId) return { valid: false, message: '起终点不能相同', stationCount: 0 };
      if (dateMode === 'date' && !isValidFlexibleOpenDate(seg.openDate)) {
        return {
          valid: false,
          message: seg.openDate.trim() ? '日期格式应为 2020 或 2020-06' : '缺少日期',
          stationCount: 0
        };
      }
      try {
        const route = resolveVideoRoute(seg, lines, stations, sections, { dateMode });
        return { valid: true, message: '', stationCount: route.stationIds.length };
      } catch (err: any) {
        return { valid: false, message: err?.message || '起终点未连通', stationCount: 0 };
      }
    });
  }, [segments, lines, stations, sections, dateMode]);

  const validSegments = useMemo(
    () => segments.filter((_, idx) => segmentDiagnostics[idx]?.valid),
    [segments, segmentDiagnostics]
  );

  const previewScene = useMemo(() => {
    if (!open || validSegments.length === 0 || stations.length === 0 || !settings) {
      return null;
    }
    try {
      return createVideoSceneRenderer({
        segments: validSegments,
        lines,
        stations,
        sections,
        settings,
        title: draft.title,
        subtitle: draft.subtitle,
        titleDurationSec: draft.titleDurationSec,
        aspectRatio,
        resolution: '720p',
        fps: 30,
        speedMultiplier,
        cameraMode,
        unopenedStyle,
        dateMode,
        timelineMode,
        showYearBadge,
        showLineLegend,
        metersPerUnit,
        isPreviewPlaceholderMap: settings.baseMap.mode === 'amap'
      });
    } catch {
      return null;
    }
  }, [
    open,
    validSegments,
    lines,
    stations,
    sections,
    settings,
    draft.title,
    draft.subtitle,
    draft.titleDurationSec,
    aspectRatio,
    speedMultiplier,
    cameraMode,
    unopenedStyle,
    dateMode,
    timelineMode,
    showYearBadge,
    showLineLegend,
    metersPerUnit
  ]);

  useEffect(() => {
    if (previewScene && previewFrame >= previewScene.totalFrames) {
      setPreviewFrame(0);
    }
  }, [previewScene, previewFrame]);

  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !previewScene) return;
    if (canvas.width !== previewScene.width || canvas.height !== previewScene.height) {
      canvas.width = previewScene.width;
      canvas.height = previewScene.height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    previewScene.drawFrame(ctx, previewFrame);
  }, [previewScene, previewFrame]);

  useEffect(() => {
    if (!open || !playing || !previewScene) return;
    let rafId = 0;
    let lastTick = performance.now();
    const frameInterval = 1000 / previewScene.fps;

    const loop = (now: number) => {
      const elapsed = now - lastTick;
      if (elapsed >= frameInterval) {
        const advance = Math.max(1, Math.floor(elapsed / frameInterval));
        lastTick = now - (elapsed % frameInterval);
        setPreviewFrame((prev) => {
          const next = prev + advance;
          return next >= previewScene.totalFrames ? 0 : next;
        });
      }
      rafId = window.requestAnimationFrame(loop);
    };

    rafId = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(rafId);
  }, [open, playing, previewScene]);

  const seekFromClientX = (clientX: number) => {
    const bar = trackBarRef.current;
    if (!bar || !previewScene) return;
    const rect = bar.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    setPreviewFrame(Math.min(previewScene.totalFrames - 1, Math.round(ratio * (previewScene.totalFrames - 1))));
  };

  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!previewScene) return;
    scrubbingRef.current = true;
    setPlaying(false);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    seekFromClientX(e.clientX);
  };

  const handleTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    seekFromClientX(e.clientX);
  };

  const handleTrackPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  const handleAutoPopulateFromCanvas = () => {
    const generated = generateAutoVideoSegments(lines, stations, sections, dateMode);
    if (generated.length === 0) {
      message.warning('当前画布暂无已连通的线路');
      return;
    }
    updateDraft({ segments: generated });
    setExpandedId(null);
    setPreviewFrame(0);
    setPlaying(true);
    message.success(`已导入 ${generated.length} 个区间`);
  };

  const handleSortByDate = () => {
    const sorted = [...segments].sort((a, b) => {
      const ka = normalizeSortableDateKey(a.openDate);
      const kb = normalizeSortableDateKey(b.openDate);
      if (ka && kb) return ka.localeCompare(kb);
      if (ka) return -1;
      if (kb) return 1;
      return 0;
    });
    updateDraft({ segments: sorted });
    setPreviewFrame(0);
  };

  const handleSelectLine = (segId: string, lineId: string) => {
    const line = lineById.get(lineId);
    const validIds = line ? line.stationIds.filter((id) => stationById.has(id)) : [];
    const autoStart = validIds[0] || '';
    const autoEnd = validIds.length > 1 ? validIds[validIds.length - 1] : '';
    updateDraft({
      segments: segments.map((item) =>
        item.id === segId
          ? { ...item, lineId, startStationId: autoStart, endStationId: autoEnd }
          : item
      )
    });
  };

  const handlePatchSegment = (segId: string, patch: Partial<VideoSegmentInput>) => {
    updateDraft({
      segments: segments.map((item) => (item.id === segId ? { ...item, ...patch } : item))
    });
  };

  const handleMoveSegment = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= segments.length || fromIndex === toIndex) return;
    const next = [...segments];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    updateDraft({ segments: next });
  };

  const handleDuplicateSegment = (index: number) => {
    const src = segments[index];
    const copy: VideoSegmentInput = {
      ...src,
      id: `seg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      phaseLabel: src.phaseLabel ? `${src.phaseLabel}（续）` : ''
    };
    const next = [...segments];
    next.splice(index + 1, 0, copy);
    updateDraft({ segments: next });
    setExpandedId(copy.id);
  };

  const handleDeleteSegment = (id: string) => {
    if (segments.length <= 1) {
      message.warning('至少保留一个区间');
      return;
    }
    updateDraft({ segments: segments.filter((item) => item.id !== id) });
    if (expandedId === id) setExpandedId(null);
  };

  const handleAddSegment = () => {
    const lastDate = segments[segments.length - 1]?.openDate || '';
    const yearMatch = lastDate.match(/^(\d{4})/);
    const nextDefaultDate =
      dateMode === 'sequence' ? '' : yearMatch ? `${Number(yearMatch[1]) + 1}-06` : '2022-06';
    const created = createEmptySegment(nextDefaultDate);
    updateDraft({ segments: [...segments, created] });
    setExpandedId(created.id);
  };

  const handleCloseModal = () => {
    setPlaying(false);
    onChange(draft);
    onCancel();
  };

  const handleConfirmExport = () => {
    const firstInvalidIdx = segmentDiagnostics.findIndex((d) => !d.valid);
    if (firstInvalidIdx >= 0) {
      const badSeg = segments[firstInvalidIdx];
      setExpandedId(badSeg.id);
      message.warning(`第 ${firstInvalidIdx + 1} 行：${segmentDiagnostics[firstInvalidIdx].message}`);
      return;
    }
    const finalConfig: VideoExportConfig = {
      ...draft,
      title: draft.title.trim() || '城市轨道线网历程',
      subtitle: draft.subtitle.trim(),
      titleDurationSec: Math.max(1, Math.min(8, draft.titleDurationSec || DEFAULT_TITLE_DURATION_SEC))
    };
    setPlaying(false);
    onChange(finalConfig);
    onConfirm(finalConfig);
  };

  // 构建分段彩色进度条切片数据（片头灰段 + 各线路色段 + 片尾灰段）
  const timelineSlices = useMemo(() => {
    if (!previewScene || previewScene.totalFrames <= 0) return [];
    const total = previewScene.totalFrames;
    const slices: Array<{ key: string; startPct: number; widthPct: number; color: string; title: string }> = [];
    const firstStart = previewScene.segmentMarkers[0]?.startFrame ?? total;
    if (firstStart > 0) {
      slices.push({
        key: 'intro',
        startPct: 0,
        widthPct: (firstStart / total) * 100,
        color: 'rgba(255, 255, 255, 0.24)',
        title: '片头'
      });
    }
    previewScene.segmentMarkers.forEach((m) => {
      slices.push({
        key: `seg-${m.index}`,
        startPct: (m.startFrame / total) * 100,
        widthPct: Math.max(0.6, ((m.endFrame - m.startFrame) / total) * 100),
        color: m.color,
        title: m.label
      });
    });
    const lastEnd = previewScene.segmentMarkers[previewScene.segmentMarkers.length - 1]?.endFrame ?? 0;
    if (lastEnd < total) {
      slices.push({
        key: 'outro',
        startPct: (lastEnd / total) * 100,
        widthPct: ((total - lastEnd) / total) * 100,
        color: 'rgba(255, 255, 255, 0.24)',
        title: '片尾'
      });
    }
    return slices;
  }, [previewScene]);

  const outputDims = computeVideoDimensions(aspectRatio, resolution);
  const totalSec = previewScene ? previewScene.totalDurationSec : 0;
  const currentSec = previewScene ? previewFrame / previewScene.fps : 0;
  const playheadPct =
    previewScene && previewScene.totalFrames > 1
      ? (Math.min(previewFrame, previewScene.totalFrames - 1) / (previewScene.totalFrames - 1)) * 100
      : 0;

  return (
    <DraggableModal
      className="metro-video-modal"
      title={<span className="metro-video-header__title">导出视频</span>}
      open={open}
      onCancel={handleCloseModal}
      footer={null}
      width={1040}
    >
      <div className="metro-video-studio">
        {/* 左栏：地铁轨道样式时间轴 + 可折叠片头与画面 */}
        <div className="metro-video-left">
          <div className="metro-video-toolbar">
            <button type="button" className="metro-video-text-btn" onClick={handleAutoPopulateFromCanvas}>
              从画布导入
            </button>

            <div className="metro-video-toolbar__right">
              <ElasticCapsuleTabs<VideoDateMode>
                size="sm"
                ariaLabel="时间显示"
                value={dateMode}
                onChange={(next) => updateDraft({ dateMode: next })}
                options={[
                  { value: 'date', label: '年份' },
                  { value: 'sequence', label: '阶段' }
                ]}
              />
              {dateMode === 'date' && segments.length > 1 ? (
                <button type="button" className="metro-video-text-btn" onClick={handleSortByDate}>
                  按时间排序
                </button>
              ) : null}
            </div>
          </div>

          <div className="metro-video-timeline">
            {segments.map((segment, index) => {
              const selectedLine = lineById.get(segment.lineId);
              const startStation = stationById.get(segment.startStationId);
              const endStation = stationById.get(segment.endStationId);
              const diag = segmentDiagnostics[index];
              const isExpanded = expandedId === segment.id;
              const nodeColor = selectedLine?.color || '#9ca3af';
              const isFirst = index === 0;
              const isLast = index === segments.length - 1;

              const dateDisplay =
                dateMode === 'sequence'
                  ? segment.phaseLabel?.trim() || `第 ${index + 1} 期`
                  : segment.openDate.trim() || '未填日期';

              const menuItems: MenuProps['items'] = [
                {
                  key: 'edit',
                  label: isExpanded ? '收起' : '编辑',
                  onClick: () => setExpandedId(isExpanded ? null : segment.id)
                },
                {
                  key: 'up',
                  label: '上移',
                  disabled: isFirst,
                  onClick: () => handleMoveSegment(index, index - 1)
                },
                {
                  key: 'down',
                  label: '下移',
                  disabled: isLast,
                  onClick: () => handleMoveSegment(index, index + 1)
                },
                {
                  key: 'dup',
                  label: '复制一行',
                  onClick: () => handleDuplicateSegment(index)
                },
                { type: 'divider' },
                {
                  key: 'del',
                  label: '删除',
                  danger: true,
                  disabled: segments.length <= 1,
                  onClick: () => handleDeleteSegment(segment.id)
                }
              ];

              return (
                <div
                  key={segment.id}
                  className={`metro-video-track-item${isExpanded ? ' is-expanded' : ''}${dragOverIndex === index ? ' is-drag-over' : ''}`}
                  onDragOver={(e) => {
                    if (dragIndex === null) return;
                    e.preventDefault();
                    setDragOverIndex(index);
                  }}
                  onDragLeave={() => {
                    if (dragOverIndex === index) setDragOverIndex(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragIndex !== null && dragIndex !== index) {
                      handleMoveSegment(dragIndex, index);
                    }
                    setDragIndex(null);
                    setDragOverIndex(null);
                  }}
                >
                  {/* 左侧地铁轨道竖线 + 站点节点（支持拖动排序） */}
                  <div
                    className="metro-video-rail"
                    draggable
                    title="拖动调整顺序"
                    onDragStart={(e) => {
                      setDragIndex(index);
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', String(index));
                    }}
                    onDragEnd={() => {
                      setDragIndex(null);
                      setDragOverIndex(null);
                    }}
                  >
                    {!isFirst ? <span className="metro-video-rail__line is-top" aria-hidden="true" /> : null}
                    <span
                      className="metro-video-rail__node"
                      style={{ borderColor: nodeColor }}
                      aria-hidden="true"
                    />
                    {!isLast ? <span className="metro-video-rail__line is-bottom" aria-hidden="true" /> : null}
                  </div>

                  {/* 右侧内容：紧凑折叠行 / 点击展开编辑 */}
                  <div className="metro-video-row-main">
                    <div
                      className="metro-video-row-summary"
                      role="button"
                      tabIndex={0}
                      onClick={() => setExpandedId(isExpanded ? null : segment.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setExpandedId(isExpanded ? null : segment.id);
                        }
                      }}
                    >
                      <span className="metro-video-row__date" title={dateDisplay}>
                        {dateDisplay}
                      </span>

                      <span className="metro-video-row__line">
                        <span
                          className="metro-video-row__bar"
                          style={{ backgroundColor: nodeColor }}
                          aria-hidden="true"
                        />
                        <span className="metro-video-row__line-name">
                          {selectedLine?.name || '未选线路'}
                        </span>
                      </span>

                      <span className="metro-video-row__route" title={startStation && endStation ? `${startStation.name} → ${endStation.name}` : ''}>
                        {startStation && endStation ? `${startStation.name} → ${endStation.name}` : '点击选择区间'}
                      </span>

                      <span className="metro-video-row__count">
                        {diag.valid ? `${diag.stationCount} 站` : ''}
                      </span>

                      <Dropdown menu={{ items: menuItems }} trigger={['click']} placement="bottomRight">
                        <button
                          type="button"
                          className="metro-video-row__more"
                          aria-label={`更多操作 ${index + 1}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreOutlined />
                        </button>
                      </Dropdown>
                    </div>

                    {!diag.valid ? (
                      <div className="metro-video-row-error">{diag.message}</div>
                    ) : null}

                    {isExpanded ? (
                      <div className="metro-video-row-editor">
                        <div className="metro-video-row-editor__grid3">
                          <Select
                            size="small"
                            options={lineOptions}
                            placeholder="线路"
                            value={segment.lineId || undefined}
                            onChange={(value) => handleSelectLine(segment.id, value)}
                          />
                          <Select
                            size="small"
                            showSearch
                            optionFilterProp="label"
                            options={getStationOptions(segment.lineId)}
                            placeholder="起点"
                            value={segment.startStationId || undefined}
                            disabled={!segment.lineId}
                            onChange={(value) => handlePatchSegment(segment.id, { startStationId: value })}
                          />
                          <Select
                            size="small"
                            showSearch
                            optionFilterProp="label"
                            options={getStationOptions(segment.lineId)}
                            placeholder="终点"
                            value={segment.endStationId || undefined}
                            disabled={!segment.lineId}
                            onChange={(value) => handlePatchSegment(segment.id, { endStationId: value })}
                          />
                        </div>

                        <div className="metro-video-row-editor__grid2">
                          {dateMode === 'date' ? (
                            <>
                              <div className="metro-video-date-field">
                                <Input
                                  size="small"
                                  placeholder="如 2018 或 2018-06"
                                  value={segment.openDate}
                                  maxLength={10}
                                  onChange={(e) => handlePatchSegment(segment.id, { openDate: e.target.value })}
                                />
                                <label className="metro-video-date-picker-btn" title="选择日期">
                                  <span aria-hidden="true">···</span>
                                  <input
                                    type="date"
                                    value={/^\d{4}-\d{2}-\d{2}$/.test(segment.openDate) ? segment.openDate : ''}
                                    onChange={(e) => {
                                      if (e.target.value) {
                                        handlePatchSegment(segment.id, { openDate: e.target.value });
                                      }
                                    }}
                                  />
                                </label>
                              </div>
                              <Input
                                size="small"
                                placeholder="备注（可选）"
                                value={segment.phaseLabel || ''}
                                maxLength={16}
                                onChange={(e) => handlePatchSegment(segment.id, { phaseLabel: e.target.value })}
                              />
                            </>
                          ) : (
                            <Input
                              size="small"
                              style={{ gridColumn: '1 / -1' }}
                              placeholder="备注（可选）"
                              value={segment.phaseLabel || ''}
                              maxLength={20}
                              onChange={(e) => handlePatchSegment(segment.id, { phaseLabel: e.target.value })}
                            />
                          )}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}

            <button type="button" className="metro-video-add-btn" onClick={handleAddSegment}>
              <PlusOutlined /> 添加区间
            </button>
          </div>

          {/* 底部可折叠分组：片头与画面（默认折叠） */}
          <div className="metro-video-collapse">
            <button
              type="button"
              className="metro-video-collapse__trigger"
              aria-expanded={titleSectionOpen}
              onClick={() => setTitleSectionOpen((v) => !v)}
            >
              <span>片头与画面</span>
              {titleSectionOpen ? <DownOutlined /> : <RightOutlined />}
            </button>

            {titleSectionOpen ? (
              <div className="metro-video-collapse__body">
                <div className="metro-video-title-grid">
                  <Input
                    size="small"
                    placeholder="主标题"
                    value={draft.title}
                    maxLength={32}
                    aria-label="视频主标题"
                    onChange={(e) => updateDraft({ title: e.target.value })}
                  />
                  <Input
                    size="small"
                    placeholder="副标题（可选）"
                    value={draft.subtitle}
                    maxLength={48}
                    aria-label="视频副标题"
                    onChange={(e) => updateDraft({ subtitle: e.target.value })}
                  />
                  <InputNumber
                    size="small"
                    min={1}
                    max={8}
                    step={0.5}
                    addonAfter="s"
                    value={draft.titleDurationSec}
                    aria-label="片头停留秒数"
                    onChange={(v) => updateDraft({ titleDurationSec: Number(v) || DEFAULT_TITLE_DURATION_SEC })}
                  />
                </div>

                {dateMode === 'date' ? (
                  <div className="metro-video-option-line">
                    <span className="metro-video-option-label">叙事节奏</span>
                    <ElasticCapsuleTabs<VideoTimelineMode>
                      ariaLabel="叙事节奏"
                      value={timelineMode}
                      onChange={(next) => updateDraft({ timelineMode: next })}
                      options={[
                        { value: 'chronicle', label: '编年史流（同年齐开）' },
                        { value: 'sequential', label: '逐段解说' }
                      ]}
                    />
                  </div>
                ) : null}

                <div className="metro-video-option-line">
                  <span className="metro-video-option-label">运镜</span>
                  <ElasticCapsuleTabs<VideoCameraMode>
                    ariaLabel="运镜"
                    value={cameraMode}
                    onChange={(next) => updateDraft({ cameraMode: next })}
                    options={[
                      { value: 'overview', label: '全景呼吸' },
                      { value: 'gentle', label: '走廊推镜' },
                      { value: 'follow', label: '近景特写' }
                    ]}
                  />
                </div>

                <div className="metro-video-option-line">
                  <span className="metro-video-option-label">未开通线路</span>
                  <ElasticCapsuleTabs<VideoUnopenedStyle>
                    ariaLabel="未开通线路"
                    value={unopenedStyle}
                    onChange={(next) => updateDraft({ unopenedStyle: next })}
                    options={[
                      { value: 'ghost', label: '显示虚影' },
                      { value: 'hidden', label: '隐藏' }
                    ]}
                  />
                </div>

                <div className="metro-video-option-line">
                  <span className="metro-video-option-label">叠加信息</span>
                  <div className="metro-video-checks">
                    <Checkbox
                      checked={showYearBadge}
                      onChange={(e) => updateDraft({ showYearBadge: e.target.checked })}
                    >
                      年份
                    </Checkbox>
                    <Checkbox
                      checked={showLineLegend}
                      onChange={(e) => updateDraft({ showLineLegend: e.target.checked })}
                    >
                      线路图例
                    </Checkbox>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* 右栏：大画幅浅框预览 + 分段彩色进度条 + 精简三行参数 + 常驻底栏 */}
        <div className="metro-video-right">
          <div className="metro-video-right__content">
            <div className="metro-video-preview-frame">
              <div className="metro-video-preview-viewport">
                {previewScene ? (
                  <canvas
                    ref={previewCanvasRef}
                    className="metro-video-preview-canvas"
                    onClick={() => setPlaying((p) => !p)}
                  />
                ) : (
                  <div className="metro-video-preview-empty">
                    在左侧配置有效区间后可在此预览画面
                  </div>
                )}
              </div>

              {previewScene ? (
                <div className="metro-video-player-overlay">
                  <button
                    type="button"
                    className="metro-video-play-btn"
                    onClick={() => setPlaying((p) => !p)}
                    aria-label={playing ? '暂停' : '播放'}
                  >
                    {playing ? <PauseOutlined /> : <CaretRightOutlined />}
                  </button>

                  {/* 按区间分段的线路彩色进度条 */}
                  <div
                    ref={trackBarRef}
                    className="metro-video-segbar"
                    role="slider"
                    aria-label="预览进度"
                    aria-valuemin={0}
                    aria-valuemax={Math.max(0, previewScene.totalFrames - 1)}
                    aria-valuenow={previewFrame}
                    tabIndex={0}
                    onPointerDown={handleTrackPointerDown}
                    onPointerMove={handleTrackPointerMove}
                    onPointerUp={handleTrackPointerUp}
                    onPointerCancel={handleTrackPointerUp}
                  >
                    <div className="metro-video-segbar__track">
                      {timelineSlices.map((slice) => (
                        <span
                          key={slice.key}
                          className="metro-video-segbar__slice"
                          style={{
                            left: `${slice.startPct}%`,
                            width: `${slice.widthPct}%`,
                            backgroundColor: slice.color
                          }}
                          title={slice.title}
                        />
                      ))}
                    </div>
                    <span
                      className="metro-video-segbar__head"
                      style={{ left: `${playheadPct}%` }}
                      aria-hidden="true"
                    />
                  </div>

                  <span className="metro-video-timecode">
                    {formatTimeMMSS(currentSec)} / {formatTimeMMSS(totalSec)}
                  </span>
                </div>
              ) : null}
            </div>

            {/* 三行精简参数表单（无卡片框、无形容词） */}
            <div className="metro-video-params">
              <div className="metro-video-param-row">
                <span className="metro-video-param-label">比例</span>
                <ElasticCapsuleTabs<VideoAspectRatio>
                  ariaLabel="比例"
                  value={aspectRatio}
                  onChange={(next) => updateDraft({ aspectRatio: next })}
                  options={(['16:9', '9:16', '4:3', '1:1'] as const).map((ratio) => ({
                    value: ratio,
                    label: ratio
                  }))}
                />
              </div>

              <div className="metro-video-param-row">
                <span className="metro-video-param-label">规格</span>
                <div className="metro-video-param-pair">
                  <ElasticCapsuleTabs<VideoResolution>
                    ariaLabel="分辨率"
                    value={resolution}
                    onChange={(next) => updateDraft({ resolution: next })}
                    options={(['1080p', '720p'] as const).map((res) => ({
                      value: res,
                      label: res
                    }))}
                  />
                  <ElasticCapsuleTabs<VideoFps>
                    ariaLabel="帧率"
                    value={fps}
                    onChange={(next) => updateDraft({ fps: next })}
                    options={([30, 60] as const).map((f) => ({
                      value: f,
                      label: `${f} fps`
                    }))}
                  />
                </div>
              </div>

              <div className="metro-video-param-row">
                <span className="metro-video-param-label">速度</span>
                <ElasticCapsuleTabs<VideoSpeedMultiplier>
                  ariaLabel="速度"
                  value={speedMultiplier}
                  onChange={(next) => updateDraft({ speedMultiplier: next })}
                  options={([0.75, 1, 1.5, 2] as const).map((spd) => ({
                    value: spd,
                    label: `${spd}×`
                  }))}
                />
              </div>
            </div>
          </div>

          {/* 常驻底部操作栏（1366×768 无需滚动即可看见导出按钮） */}
          <div className="metro-video-footer">
            <span className="metro-video-footer__meta">
              {outputDims.width}×{outputDims.height} · {fps}fps · MP4
              {totalSec > 0 ? ` · ${totalSec.toFixed(1)}s` : ''}
            </span>
            <div className="metro-video-footer__actions">
              <Button size="middle" onClick={handleCloseModal}>
                取消
              </Button>
              <Button type="primary" size="middle" onClick={handleConfirmExport}>
                导出
              </Button>
            </div>
          </div>
        </div>
      </div>
    </DraggableModal>
  );
};

export default VideoExportModal;
