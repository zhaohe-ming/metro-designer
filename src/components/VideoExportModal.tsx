import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, InputNumber, Select, Tooltip, message } from 'antd';
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  CaretRightOutlined,
  CopyOutlined,
  DeleteOutlined,
  PauseOutlined,
  PlusOutlined,
  SortAscendingOutlined,
  ThunderboltOutlined,
  VideoCameraOutlined
} from '@ant-design/icons';
import {
  Line,
  MapSettings,
  Section,
  Station,
  VideoAspectRatio,
  VideoCameraMode,
  VideoDateMode,
  VideoExportConfig,
  VideoFps,
  VideoResolution,
  VideoSpeedMultiplier,
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

export type { VideoSegmentInput } from '../lib/videoModel';
export type { VideoExportConfig } from '../types';

interface VideoExportModalProps {
  open: boolean;
  lines: Line[];
  stations: Station[];
  sections: Section[];
  settings?: MapSettings;
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
  const autoSegments = !hasSavedSegments ? generateAutoVideoSegments(lines, stations, sections, config?.dateMode || 'date') : [];
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
  defaultTitle,
  config,
  onChange,
  onCancel,
  onConfirm
}) => {
  const [draft, setDraft] = useState<VideoExportConfig>(() =>
    buildInitialDraft(config, defaultTitle, lines, stations, sections)
  );
  const [playing, setPlaying] = useState(false);
  const [previewFrame, setPreviewFrame] = useState(0);

  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const wasOpenRef = useRef(false);

  // 每次打开弹窗时同步最新地图配置；若尚未配置区间则智能提取画布已有线路以便立即预览
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const nextDraft = buildInitialDraft(config, defaultTitle, lines, stations, sections);
      setDraft(nextDraft);
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

  // 逐行校验状态（内联友好提示，不打断编辑）
  const segmentDiagnostics = useMemo(() => {
    return segments.map((seg) => {
      if (!seg.lineId) return { valid: false, message: '请选择线路', stationCount: 0 };
      if (!seg.startStationId || !seg.endStationId) return { valid: false, message: '请选择起终点站', stationCount: 0 };
      if (seg.startStationId === seg.endStationId) return { valid: false, message: '起点与终点不能相同', stationCount: 0 };
      if (dateMode === 'date' && !isValidFlexibleOpenDate(seg.openDate)) {
        return {
          valid: false,
          message: seg.openDate.trim() ? '日期格式示例：2020 或 2020-06' : '请填写年份或日期',
          stationCount: 0
        };
      }
      try {
        const route = resolveVideoRoute(seg, lines, stations, sections, { dateMode });
        return { valid: true, message: `共 ${route.stationIds.length} 站`, stationCount: route.stationIds.length };
      } catch (err: any) {
        return { valid: false, message: err?.message || '站点未连通', stationCount: 0 };
      }
    });
  }, [segments, lines, stations, sections, dateMode]);

  const validSegments = useMemo(
    () => segments.filter((_, idx) => segmentDiagnostics[idx]?.valid),
    [segments, segmentDiagnostics]
  );

  // 构建实时预览渲染器（用预览帧率 30fps 保持轻快，画面布局与 1080p 完全等比一致）
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
        showYearBadge,
        showLineLegend,
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
    showYearBadge,
    showLineLegend
  ]);

  // 预览帧越界时自动夹紧
  useEffect(() => {
    if (previewScene && previewFrame >= previewScene.totalFrames) {
      setPreviewFrame(0);
    }
  }, [previewScene, previewFrame]);

  // 绘制当前预览帧到右侧 Canvas
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

  // 实时预览播放循环
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
          if (next >= previewScene.totalFrames) {
            return 0;
          }
          return next;
        });
      }
      rafId = window.requestAnimationFrame(loop);
    };

    rafId = window.requestAnimationFrame(loop);
    return () => window.cancelAnimationFrame(rafId);
  }, [open, playing, previewScene]);

  const handleAutoPopulateFromCanvas = () => {
    const generated = generateAutoVideoSegments(lines, stations, sections, dateMode);
    if (generated.length === 0) {
      message.warning('当前画布还没有已连接两个以上站点的线路，请先在画布连线后再试');
      return;
    }
    updateDraft({ segments: generated });
    setPreviewFrame(0);
    setPlaying(true);
    message.success(`已自动导入 ${generated.length} 段线路区间`);
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
    message.success('已按开通时间先后排序');
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

  const handleMoveSegment = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= segments.length) return;
    const next = [...segments];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    updateDraft({ segments: next });
  };

  const handleDuplicateSegment = (index: number) => {
    const src = segments[index];
    const copy: VideoSegmentInput = {
      ...src,
      id: `seg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      phaseLabel: src.phaseLabel ? `${src.phaseLabel}（续）` : '二期延伸'
    };
    const next = [...segments];
    next.splice(index + 1, 0, copy);
    updateDraft({ segments: next });
  };

  const handleDeleteSegment = (id: string) => {
    if (segments.length <= 1) {
      message.warning('至少保留一个区间步骤');
      return;
    }
    updateDraft({ segments: segments.filter((item) => item.id !== id) });
  };

  const handleAddSegment = () => {
    const lastDate = segments[segments.length - 1]?.openDate || '';
    const yearMatch = lastDate.match(/^(\d{4})/);
    const nextDefaultDate =
      dateMode === 'sequence' ? '' : yearMatch ? `${Number(yearMatch[1]) + 1}-06` : '2022-06';
    updateDraft({ segments: [...segments, createEmptySegment(nextDefaultDate)] });
  };

  const handleCloseModal = () => {
    setPlaying(false);
    // 关闭弹窗时一次性同步配置（避免每次按键污染画布 Ctrl+Z 历史）
    onChange(draft);
    onCancel();
  };

  const handleConfirmExport = () => {
    const firstInvalidIdx = segmentDiagnostics.findIndex((d) => !d.valid);
    if (firstInvalidIdx >= 0) {
      message.warning(`步骤 ${firstInvalidIdx + 1} 尚未完善：${segmentDiagnostics[firstInvalidIdx].message}`);
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

  const outputDims = computeVideoDimensions(aspectRatio, resolution);
  const totalSec = previewScene ? previewScene.totalDurationSec : 0;
  const currentSec = previewScene ? previewFrame / previewScene.fps : 0;

  return (
    <DraggableModal
      className="metro-video-modal"
      title={
        <div className="metro-video-header">
          <div className="metro-video-header__brand">
            <span className="metro-video-header__icon" aria-hidden="true">
              <VideoCameraOutlined />
            </span>
            <span>导出动态演进视频</span>
            <span className="metro-video-header__badge">MP4 高清直出</span>
          </div>
        </div>
      }
      open={open}
      onCancel={handleCloseModal}
      footer={null}
      width={980}
    >
      <div className="metro-video-studio">
        {/* 左栏：智能区间编排 + 片头与视觉选项 */}
        <div className="metro-video-left">
          <div className="metro-video-toolbar">
            <Button
              size="small"
              type="primary"
              ghost
              icon={<ThunderboltOutlined />}
              onClick={handleAutoPopulateFromCanvas}
            >
              一键导入画布线路
            </Button>

            <div className="metro-video-toolbar__right">
              <div className="metro-video-seg-pills" role="tablist" aria-label="时间展示模式">
                <button
                  type="button"
                  className={dateMode === 'date' ? 'is-active' : ''}
                  onClick={() => updateDraft({ dateMode: 'date' })}
                >
                  年份/日期
                </button>
                <button
                  type="button"
                  className={dateMode === 'sequence' ? 'is-active' : ''}
                  onClick={() => updateDraft({ dateMode: 'sequence' })}
                >
                  按阶段顺序
                </button>
              </div>

              {dateMode === 'date' && segments.length > 1 ? (
                <Tooltip title="按填写的年份/日期从早到晚重排步骤">
                  <Button size="small" icon={<SortAscendingOutlined />} onClick={handleSortByDate}>
                    按时间排序
                  </Button>
                </Tooltip>
              ) : null}
            </div>
          </div>

          {/* 区间时间轴卡片列表（编辑过程保持稳定顺序，绝不边输文字边乱跳行） */}
          <div className="metro-video-seg-list">
            {segments.map((segment, index) => {
              const selectedLine = lineById.get(segment.lineId);
              const diag = segmentDiagnostics[index];
              const accentColor = selectedLine?.color || '#94a3b8';

              return (
                <div
                  key={segment.id}
                  className={`metro-video-seg-card${diag?.valid ? '' : ' is-incomplete'}`}
                  style={{ ['--seg-color' as any]: accentColor }}
                >
                  <div className="metro-video-seg-card__bar" />
                  <div className="metro-video-seg-card__body">
                    <div className="metro-video-seg-card__head">
                      <div className="metro-video-seg-card__step">
                        <span className="metro-video-seg-card__num">#{index + 1}</span>
                        <span className={`metro-video-seg-card__status ${diag?.valid ? 'is-ok' : 'is-warn'}`}>
                          {diag?.valid ? `✓ ${diag.message}` : diag?.message}
                        </span>
                      </div>

                      <div className="metro-video-seg-card__ops">
                        <Tooltip title="上移">
                          <button
                            type="button"
                            disabled={index === 0}
                            onClick={() => handleMoveSegment(index, -1)}
                            aria-label={`上移步骤 ${index + 1}`}
                          >
                            <ArrowUpOutlined />
                          </button>
                        </Tooltip>
                        <Tooltip title="下移">
                          <button
                            type="button"
                            disabled={index === segments.length - 1}
                            onClick={() => handleMoveSegment(index, 1)}
                            aria-label={`下移步骤 ${index + 1}`}
                          >
                            <ArrowDownOutlined />
                          </button>
                        </Tooltip>
                        <Tooltip title="复制此行（便于同线路拆分为一期 / 二期）">
                          <button
                            type="button"
                            onClick={() => handleDuplicateSegment(index)}
                            aria-label={`复制步骤 ${index + 1}`}
                          >
                            <CopyOutlined />
                          </button>
                        </Tooltip>
                        <Tooltip title="删除步骤">
                          <button
                            type="button"
                            className="is-danger"
                            onClick={() => handleDeleteSegment(segment.id)}
                            aria-label={`删除步骤 ${index + 1}`}
                          >
                            <DeleteOutlined />
                          </button>
                        </Tooltip>
                      </div>
                    </div>

                    <div className="metro-video-seg-card__grid3">
                      <Select
                        size="small"
                        options={lineOptions}
                        placeholder="选择线路"
                        value={segment.lineId || undefined}
                        onChange={(value) => handleSelectLine(segment.id, value)}
                      />
                      <Select
                        size="small"
                        showSearch
                        optionFilterProp="label"
                        options={getStationOptions(segment.lineId)}
                        placeholder="起点站"
                        value={segment.startStationId || undefined}
                        disabled={!segment.lineId}
                        onChange={(value) => handlePatchSegment(segment.id, { startStationId: value })}
                      />
                      <Select
                        size="small"
                        showSearch
                        optionFilterProp="label"
                        options={getStationOptions(segment.lineId)}
                        placeholder="终点站"
                        value={segment.endStationId || undefined}
                        disabled={!segment.lineId}
                        onChange={(value) => handlePatchSegment(segment.id, { endStationId: value })}
                      />
                    </div>

                    <div className="metro-video-seg-card__grid2">
                      {dateMode === 'date' ? (
                        <>
                          <div className="metro-video-date-field">
                            <Input
                              size="small"
                              placeholder="年份或日期，如 2018 / 2018-06 / 2018-06-28"
                              value={segment.openDate}
                              maxLength={10}
                              onChange={(e) => handlePatchSegment(segment.id, { openDate: e.target.value })}
                            />
                            <label className="metro-video-date-picker-btn" title="从日历选择精确日期">
                              📅
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
                            placeholder="阶段备注（可选，如：首通段 / 东延）"
                            value={segment.phaseLabel || ''}
                            maxLength={16}
                            onChange={(e) => handlePatchSegment(segment.id, { phaseLabel: e.target.value })}
                          />
                        </>
                      ) : (
                        <Input
                          size="small"
                          style={{ gridColumn: '1 / -1' }}
                          placeholder={`阶段文案（可选，默认显示「第 ${index + 1} 阶段」，可填如：一期工程）`}
                          value={segment.phaseLabel || ''}
                          maxLength={20}
                          onChange={(e) => handlePatchSegment(segment.id, { phaseLabel: e.target.value })}
                        />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            <Button type="dashed" size="small" block icon={<PlusOutlined />} onClick={handleAddSegment}>
              新增开通区间
            </Button>
          </div>

          {/* 片头与画面叙事设置 */}
          <div className="metro-video-config-box">
            <div className="metro-video-config-box__title">片头与镜头表现</div>
            <div className="metro-video-title-grid">
              <Input
                size="small"
                placeholder="主标题（例：北京轨道交通演进史）"
                value={draft.title}
                maxLength={32}
                aria-label="视频主标题"
                onChange={(e) => updateDraft({ title: e.target.value })}
              />
              <Input
                size="small"
                placeholder="副标题（可选，例：1969 — 2026）"
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
                addonAfter="秒"
                value={draft.titleDurationSec}
                aria-label="片头停留秒数"
                onChange={(v) => updateDraft({ titleDurationSec: Number(v) || DEFAULT_TITLE_DURATION_SEC })}
              />
            </div>

            <div className="metro-video-toggles-row">
              <div className="metro-video-mini-group">
                <span className="metro-video-mini-label">运镜</span>
                <div className="metro-video-seg-pills">
                  <button
                    type="button"
                    className={cameraMode === 'overview' ? 'is-active' : ''}
                    onClick={() => updateDraft({ cameraMode: 'overview' })}
                  >
                    全局俯瞰
                  </button>
                  <button
                    type="button"
                    className={cameraMode === 'gentle' ? 'is-active' : ''}
                    onClick={() => updateDraft({ cameraMode: 'gentle' })}
                  >
                    轻柔推镜
                  </button>
                  <button
                    type="button"
                    className={cameraMode === 'follow' ? 'is-active' : ''}
                    onClick={() => updateDraft({ cameraMode: 'follow' })}
                  >
                    特写跟随
                  </button>
                </div>
              </div>

              <div className="metro-video-mini-group">
                <span className="metro-video-mini-label">未开通</span>
                <div className="metro-video-seg-pills">
                  <button
                    type="button"
                    className={unopenedStyle === 'ghost' ? 'is-active' : ''}
                    onClick={() => updateDraft({ unopenedStyle: 'ghost' })}
                  >
                    淡影底图
                  </button>
                  <button
                    type="button"
                    className={unopenedStyle === 'hidden' ? 'is-active' : ''}
                    onClick={() => updateDraft({ unopenedStyle: 'hidden' })}
                  >
                    纯净生长
                  </button>
                </div>
              </div>

              <div className="metro-video-mini-group">
                <span className="metro-video-mini-label">角标</span>
                <div className="metro-video-seg-pills">
                  <button
                    type="button"
                    className={showYearBadge ? 'is-active' : ''}
                    onClick={() => updateDraft({ showYearBadge: !showYearBadge })}
                  >
                    年份牌
                  </button>
                  <button
                    type="button"
                    className={showLineLegend ? 'is-active' : ''}
                    onClick={() => updateDraft({ showLineLegend: !showLineLegend })}
                  >
                    线路条
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* 右栏：所见即所得实时预览播放器 + 输出规格与导出动作 */}
        <div className="metro-video-right">
          <div className="metro-video-preview-shell">
            <div className="metro-video-preview-viewport">
              {previewScene ? (
                <canvas
                  ref={previewCanvasRef}
                  className="metro-video-preview-canvas"
                  onClick={() => setPlaying((p) => !p)}
                />
              ) : (
                <div className="metro-video-preview-empty">
                  <VideoCameraOutlined />
                  <div>在左侧选择一条已连线的线路后，此处将实时播放动态预览</div>
                </div>
              )}
            </div>

            {previewScene ? (
              <div className="metro-video-player-bar">
                <button
                  type="button"
                  className="metro-video-play-btn"
                  onClick={() => setPlaying((p) => !p)}
                  aria-label={playing ? '暂停预览' : '播放预览'}
                >
                  {playing ? <PauseOutlined /> : <CaretRightOutlined />}
                </button>

                <div className="metro-video-scrubber-wrap">
                  <input
                    type="range"
                    className="metro-video-scrubber"
                    min={0}
                    max={Math.max(0, previewScene.totalFrames - 1)}
                    value={Math.min(previewFrame, Math.max(0, previewScene.totalFrames - 1))}
                    onChange={(e) => {
                      setPlaying(false);
                      setPreviewFrame(Number(e.target.value));
                    }}
                  />
                  <div className="metro-video-markers" aria-hidden="true">
                    {previewScene.segmentMarkers.map((m) => (
                      <span
                        key={m.index}
                        className="metro-video-marker-dot"
                        style={{
                          left: `${(m.startFrame / Math.max(1, previewScene.totalFrames)) * 100}%`,
                          backgroundColor: m.color
                        }}
                        title={`${m.label}`}
                      />
                    ))}
                  </div>
                </div>

                <span className="metro-video-timecode">
                  {formatTimeMMSS(currentSec)} / {formatTimeMMSS(totalSec)}
                </span>
              </div>
            ) : null}
          </div>

          {/* 成片画幅、清晰度、帧率与倍速规格卡 */}
          <div className="metro-video-spec-card">
            <div className="metro-video-spec-row">
              <span className="metro-video-spec-label">画幅比例</span>
              <div className="metro-video-seg-pills">
                {(
                  [
                    { key: '16:9', label: '16:9 横屏' },
                    { key: '9:16', label: '9:16 竖屏' },
                    { key: '4:3', label: '4:3' },
                    { key: '1:1', label: '1:1' }
                  ] as const
                ).map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    className={aspectRatio === item.key ? 'is-active' : ''}
                    onClick={() => updateDraft({ aspectRatio: item.key })}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="metro-video-spec-row">
              <span className="metro-video-spec-label">画质帧率</span>
              <div className="metro-video-spec-inline">
                <div className="metro-video-seg-pills">
                  <button
                    type="button"
                    className={resolution === '1080p' ? 'is-active' : ''}
                    onClick={() => updateDraft({ resolution: '1080p' })}
                  >
                    1080P 超清
                  </button>
                  <button
                    type="button"
                    className={resolution === '720p' ? 'is-active' : ''}
                    onClick={() => updateDraft({ resolution: '720p' })}
                  >
                    720P 轻量
                  </button>
                </div>

                <div className="metro-video-seg-pills">
                  <button
                    type="button"
                    className={fps === 30 ? 'is-active' : ''}
                    onClick={() => updateDraft({ fps: 30 })}
                  >
                    30 FPS
                  </button>
                  <button
                    type="button"
                    className={fps === 60 ? 'is-active' : ''}
                    onClick={() => updateDraft({ fps: 60 })}
                  >
                    60 FPS
                  </button>
                </div>
              </div>
            </div>

            <div className="metro-video-spec-row">
              <span className="metro-video-spec-label">演进节奏</span>
              <div className="metro-video-seg-pills">
                {(
                  [
                    { val: 0.75, label: '0.75x 舒缓' },
                    { val: 1, label: '1x 标准' },
                    { val: 1.5, label: '1.5x 轻快' },
                    { val: 2, label: '2x 快节奏' }
                  ] as const
                ).map((s) => (
                  <button
                    key={s.val}
                    type="button"
                    className={speedMultiplier === s.val ? 'is-active' : ''}
                    onClick={() => updateDraft({ speedMultiplier: s.val })}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="metro-video-spec-summary">
              <span>
                输出尺寸：{outputDims.width} × {outputDims.height} · {fps}fps
              </span>
              <span>{totalSec > 0 ? `总时长约 ${totalSec.toFixed(1)} 秒` : '待完善区间'}</span>
            </div>
          </div>

          <div className="metro-video-footer">
            <Button onClick={handleCloseModal}>保存配置并关闭</Button>
            <Button type="primary" size="middle" icon={<VideoCameraOutlined />} onClick={handleConfirmExport}>
              极速合成并导出视频
            </Button>
          </div>
        </div>
      </div>
    </DraggableModal>
  );
};

export default VideoExportModal;
