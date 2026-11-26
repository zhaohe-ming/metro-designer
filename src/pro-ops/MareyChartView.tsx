import React, { useRef } from 'react';
import { formatClockSec, MareyDiagramModel, MareyMarker } from './timetable';

export interface MareyChartViewProps {
  model: MareyDiagramModel;
  zoomX: number;
  isDark: boolean;
  simTimeSec: number;
  selectedPatternId: string | null;
  onSelectPattern: (patternId: string) => void;
  onScrubTime: (nextSec: number) => void;
  onToggleStationPassingTrack: (stationId: string) => void;
  onResolveConflictPassingStation: (stationId: string, stationName: string) => void;
  onAutoResolveAllCorridorConflicts?: () => void;
}

const MareyChartView: React.FC<MareyChartViewProps> = ({
  model,
  zoomX,
  isDark,
  simTimeSec,
  selectedPatternId,
  onSelectPattern,
  onScrubTime,
  onToggleStationPassingTrack,
  onResolveConflictPassingStation,
  onAutoResolveAllCorridorConflicts
}) => {
  const plotSvgRef = useRef<SVGSVGElement | null>(null);
  const draggingPlayheadRef = useRef(false);

  if (model.stations.length < 2) {
    return (
      <div className="pro-card__hint" style={{ padding: '14px 8px' }}>
        当前线路走廊至少需要 2 座连通车站才能铺画斜线运行图。
      </div>
    );
  }

  const durationSec = Math.max(60, model.windowEndSec - model.windowStartSec);
  const durationMin = durationSec / 60;
  const plotW = Math.round(Math.max(680, durationMin * 15) * zoomX);
  const plotH = Math.max(210, model.stations.length * 32);
  const topRulerH = 26;
  const padY = 14;

  const timeToX = (sec: number) => ((sec - model.windowStartSec) / durationSec) * plotW;
  const ratioToY = (r: number) => topRulerH + padY + r * (plotH - padY * 2);

  const stepMin = zoomX >= 1.8 ? 2 : 5;
  const majorMin = zoomX >= 1.8 ? 10 : 15;
  const startMin = Math.ceil(model.windowStartSec / 60);
  const endMin = Math.floor(model.windowEndSec / 60);

  const gridMajor = isDark ? 'rgba(148, 163, 184, 0.24)' : 'rgba(15, 23, 42, 0.14)';
  const gridMinor = isDark ? 'rgba(148, 163, 184, 0.10)' : 'rgba(15, 23, 42, 0.06)';
  const textSub = isDark ? '#94a3b8' : '#64748b';

  const scrubFromClientX = (clientX: number) => {
    const svgEl = plotSvgRef.current;
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    const relX = Math.max(0, Math.min(plotW, clientX - rect.left));
    const sec = model.windowStartSec + (relX / plotW) * durationSec;
    onScrubTime(Math.round(sec));
  };

  const handleMarkerClick = (e: React.MouseEvent, mk: MareyMarker) => {
    e.stopPropagation();
    if (mk.kind === 'conflict' && mk.suggestedPassingStationId) {
      onResolveConflictPassingStation(
        mk.suggestedPassingStationId,
        mk.suggestedPassingStationName || '前序车站'
      );
    }
  };

  const playheadX = timeToX(
    Math.max(model.windowStartSec, Math.min(model.windowEndSec, simTimeSec))
  );

  const topBottleneck = model.bottlenecks?.[0];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {topBottleneck && (
        <div className="pro-marey-diagnosis">
          <div className="pro-marey-diagnosis__text">
            <strong>冲突原因说明：</strong>
            {topBottleneck.summary}
            {model.bottlenecks.length > 1 ? `（另有 ${model.bottlenecks.length - 1} 处同类瓶颈）` : ''}
          </div>
          {onAutoResolveAllCorridorConflicts && (
            <button
              type="button"
              className="pro-btn pro-btn--primary pro-btn--sm"
              style={{ flexShrink: 0 }}
              onClick={onAutoResolveAllCorridorConflicts}
            >
              一键配越行并错峰消解
            </button>
          )}
        </div>
      )}
      <div className="pro-marey-wrap">
      {/* 左侧固定纵轴车站与里程标尺（可直接点选切换 [越] 越行配线！） */}
      <div className="pro-marey-yaxis" style={{ height: topRulerH + plotH }}>
        <div className="pro-marey-yaxis__head" style={{ height: topRulerH }}>
          <span>里程 / 车站</span>
          <span title="点击车站右侧按钮可一键开关越行待避配线">越行</span>
        </div>
        <div className="pro-marey-yaxis__body" style={{ height: plotH }}>
          {model.stations.map((st) => {
            const topPx = padY + st.yRatio * (plotH - padY * 2);
            return (
              <div
                key={`my_st_${st.index}`}
                className="pro-marey-yaxis__item"
                style={{ top: topPx }}
              >
                <span className="pro-marey-yaxis__km">{st.cumulativeKm.toFixed(1)}</span>
                <span className="pro-marey-yaxis__name" title={st.stationName}>
                  {st.stationName}
                </span>
                <button
                  type="button"
                  className={`pro-marey-pass-btn${st.hasPassingTrack ? ' is-on' : ''}`}
                  title={
                    st.hasPassingTrack
                      ? `已启用「${st.stationName}」越行配线（慢车可在此自动待避让行快车）`
                      : `点击为「${st.stationName}」启用越行配线`
                  }
                  onClick={() => onToggleStationPassingTrack(st.stationId)}
                >
                  越
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* 右侧横向可滚动时间铺画区（点击或拖拽时间标尺可实时联动全网列车位置！） */}
      <div className="pro-marey-plot-scroll">
        <svg
          ref={plotSvgRef}
          width={plotW}
          height={topRulerH + plotH}
          style={{ display: 'block', cursor: 'crosshair', userSelect: 'none' }}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            draggingPlayheadRef.current = true;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            scrubFromClientX(e.clientX);
          }}
          onPointerMove={(e) => {
            if (!draggingPlayheadRef.current) return;
            scrubFromClientX(e.clientX);
          }}
          onPointerUp={() => {
            draggingPlayheadRef.current = false;
          }}
          onPointerCancel={() => {
            draggingPlayheadRef.current = false;
          }}
        >
          {/* 顶部时间刻度带 */}
          <rect
            x={0}
            y={0}
            width={plotW}
            height={topRulerH}
            fill={isDark ? '#111c30' : '#f1f5f9'}
          />

          {(() => {
            const nodes: React.ReactNode[] = [];
            for (let m = startMin; m <= endMin; m += 1) {
              if ((m - startMin) % stepMin !== 0 && m % majorMin !== 0) continue;
              const x = timeToX(m * 60);
              const isMajor = m % majorMin === 0 || m === startMin;
              nodes.push(
                <line
                  key={`tg_${m}`}
                  x1={x}
                  y1={topRulerH}
                  x2={x}
                  y2={topRulerH + plotH}
                  stroke={isMajor ? gridMajor : gridMinor}
                  strokeWidth={isMajor ? 1.1 : 0.8}
                />
              );
              if (isMajor) {
                nodes.push(
                  <text
                    key={`tl_${m}`}
                    x={x}
                    y={17}
                    textAnchor="middle"
                    fontSize={10.5}
                    fontWeight={600}
                    fill={textSub}
                  >
                    {formatClockSec(m * 60)}
                  </text>
                );
              }
            }
            return nodes;
          })()}

          {/* 横向车站基准线 */}
          {model.stations.map((st) => {
            const y = ratioToY(st.yRatio);
            return (
              <line
                key={`hl_${st.index}`}
                x1={0}
                y1={y}
                x2={plotW}
                y2={y}
                stroke={st.hasPassingTrack ? 'rgba(16, 185, 129, 0.35)' : gridMinor}
                strokeWidth={st.hasPassingTrack ? 1.3 : 0.9}
                strokeDasharray={st.hasPassingTrack ? '5,3' : undefined}
              />
            );
          })}

          {/* 车次运行斜线 */}
          {model.threads.map((th) => {
            if (th.points.length < 2) return null;
            const d = th.points
              .map((pt, idx) => `${idx === 0 ? 'M' : 'L'}${timeToX(pt.timeSec).toFixed(1)},${ratioToY(pt.yRatio).toFixed(1)}`)
              .join(' ');
            const isSel = th.patternId === selectedPatternId;
            const isDown = th.direction === 'down';

            return (
              <g
                key={th.id}
                style={{ cursor: 'pointer' }}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectPattern(th.patternId);
                }}
              >
                <path
                  d={d}
                  fill="none"
                  stroke={th.color}
                  strokeWidth={isSel ? 3.1 : isDown ? 1.7 : 2.2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeDasharray={isDown ? '6,4' : undefined}
                  opacity={isSel ? 1 : isDown ? 0.65 : 0.88}
                >
                  <title>{`${th.trainCode}（点击高亮所属交路）`}</title>
                </path>

                {/* 待避水平绿阶高亮 */}
                {th.points.map((pt, idx) => {
                  if (idx === 0 || !pt.isOvertakeHold) return null;
                  const prev = th.points[idx - 1];
                  if (Math.abs(prev.yRatio - pt.yRatio) > 1e-4) return null;
                  return (
                    <line
                      key={`hold_${th.id}_${idx}`}
                      x1={timeToX(prev.timeSec)}
                      y1={ratioToY(prev.yRatio)}
                      x2={timeToX(pt.timeSec)}
                      y2={ratioToY(pt.yRatio)}
                      stroke="#10b981"
                      strokeWidth={4.5}
                      strokeLinecap="round"
                    >
                      <title>{`${th.trainCode} 在越行站待避让行快车`}</title>
                    </line>
                  );
                })}
              </g>
            );
          })}

          {/* 越行成功点（绿点）与追踪冲突点（红点，点击可一键设越行站消解！） */}
          {model.markers.map((mk) => {
            const cx = timeToX(mk.timeSec);
            const cy = ratioToY(mk.yRatio);
            if (mk.kind === 'overtake') {
              return (
                <circle
                  key={mk.id}
                  cx={cx}
                  cy={cy}
                  r={4.8}
                  fill="#10b981"
                  stroke={isDark ? '#0b1220' : '#ffffff'}
                  strokeWidth={1.8}
                >
                  <title>{mk.label}</title>
                </circle>
              );
            }
            return (
              <g
                key={mk.id}
                style={{ cursor: mk.suggestedPassingStationId ? 'pointer' : 'help' }}
                onClick={(e) => handleMarkerClick(e, mk)}
              >
                <circle
                  cx={cx}
                  cy={cy}
                  r={10}
                  fill="rgba(239, 68, 68, 0.22)"
                />
                <circle
                  cx={cx}
                  cy={cy}
                  r={6}
                  fill="#ef4444"
                  stroke="#ffffff"
                  strokeWidth={1.8}
                >
                  <title>
                    {mk.suggestedPassingStationName
                      ? `${mk.label}\n👉 点击一键将「${mk.suggestedPassingStationName}」设为越行站自动待避消解`
                      : mk.label}
                  </title>
                </circle>
              </g>
            );
          })}

          {/* 实时动态回放时间指针线（Playhead） */}
          <line
            x1={playheadX}
            y1={0}
            x2={playheadX}
            y2={topRulerH + plotH}
            stroke="#f59e0b"
            strokeWidth={2}
          />
          <rect
            x={Math.max(0, Math.min(plotW - 52, playheadX - 26))}
            y={3}
            width={52}
            height={18}
            rx={9}
            fill="#f59e0b"
          />
          <text
            x={Math.max(26, Math.min(plotW - 26, playheadX))}
            y={15.5}
            textAnchor="middle"
            fontSize={10}
            fontWeight={800}
            fill="#ffffff"
          >
            {formatClockSec(simTimeSec, true).slice(0, 8)}
          </text>
        </svg>
      </div>
      </div>
    </div>
  );
};

export default MareyChartView;
