import React from 'react';
import { Circle, Group, Layer, Line as KonvaLine, Rect, Text as KonvaText } from 'react-konva';
import { Line, Section, Station } from '../types';
import { CanvasOverlayRenderContext } from '../components/Canvas';
import { ServiceKinematicsResult } from './kinematics';
import { LiveTrainSnapshot } from './timetable';
import {
  ProOpsDocument,
  ProServicePattern,
  ProServiceValidation
} from './types';

export interface ProCanvasOverlayProps {
  ctx: CanvasOverlayRenderContext;
  lines: Line[];
  sections: Section[];
  stations: Station[];
  proOps: ProOpsDocument;
  activePattern?: ProServicePattern | null;
  activeValidation?: ProServiceValidation | null;
  activeKinematics?: ServiceKinematicsResult | null;
  selectedStationId?: string | null;
  selectedSectionId?: string | null;
  rulerPoints?: Station[];
  liveTrains?: LiveTrainSnapshot[];
}

function interpolateAlongPts(
  pts: Array<{ x: number; y: number }>,
  progress: number
): { x: number; y: number; nx: number; ny: number } {
  if (pts.length === 0) return { x: 0, y: 0, nx: 0, ny: -1 };
  if (pts.length === 1) return { x: pts[0].x, y: pts[0].y, nx: 0, ny: -1 };

  const segLens: number[] = [];
  let totalLen = 0;
  for (let i = 1; i < pts.length; i += 1) {
    const len = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    segLens.push(len);
    totalLen += len;
  }

  if (totalLen < 1e-3) {
    return { x: pts[0].x, y: pts[0].y, nx: 0, ny: -1 };
  }

  const target = Math.max(0, Math.min(1, progress)) * totalLen;
  let acc = 0;
  for (let i = 0; i < segLens.length; i += 1) {
    const sl = segLens[i];
    if (acc + sl >= target || i === segLens.length - 1) {
      const localT = sl > 1e-4 ? (target - acc) / sl : 0;
      const pA = pts[i];
      const pB = pts[i + 1];
      const dx = pB.x - pA.x;
      const dy = pB.y - pA.y;
      const norm = Math.hypot(dx, dy) || 1;
      // 右手法向偏移单位向量（使上下行双线对向列车各自靠右错开行驶，不迎头重叠）
      const nx = -dy / norm;
      const ny = dx / norm;
      return {
        x: pA.x + dx * localT,
        y: pA.y + dy * localT,
        nx,
        ny
      };
    }
    acc += sl;
  }

  const last = pts[pts.length - 1];
  return { x: last.x, y: last.y, nx: 0, ny: -1 };
}

const ProCanvasOverlay: React.FC<ProCanvasOverlayProps> = ({
  ctx,
  sections,
  stations,
  proOps,
  activePattern,
  activeValidation,
  activeKinematics,
  selectedStationId,
  selectedSectionId,
  rulerPoints = [],
  liveTrains = []
}) => {
  const { scale, isAmapMode, isDarkCanvas, getStationDisplayPoint, getWaypointDisplayPoint } = ctx;
  const invScale = isAmapMode ? 1 : 1 / Math.max(0.2, scale);

  const stationMap = React.useMemo(() => new Map(stations.map((s) => [s.id, s])), [stations]);
  const sectionMap = React.useMemo(() => new Map(sections.map((s) => [s.id, s])), [sections]);
  const connMap = React.useMemo(
    () => new Map(proOps.trackConnections.map((c) => [c.id, c])),
    [proOps.trackConnections]
  );

  const buildSectionOrderedPoints = (sec: Section, forward: boolean): Array<{ x: number; y: number }> => {
    const sStart = stationMap.get(sec.startStationId);
    const sEnd = stationMap.get(sec.endStationId);
    if (!sStart || !sEnd) return [];
    const rawPts = [
      getStationDisplayPoint(sStart),
      ...(sec.waypoints || []).map((wp) => getWaypointDisplayPoint(wp)),
      getStationDisplayPoint(sEnd)
    ];
    return forward ? rawPts : [...rawPts].reverse();
  };

  const buildSectionFlatPoints = (sec: Section, forward: boolean): number[] => {
    const ordered = buildSectionOrderedPoints(sec, forward);
    const flat: number[] = [];
    ordered.forEach((p) => {
      flat.push(p.x, p.y);
    });
    return flat;
  };

  const selectedSection = selectedSectionId ? sectionMap.get(selectedSectionId) : undefined;
  const selectedStation = selectedStationId ? stationMap.get(selectedStationId) : undefined;

  return (
    <Layer name="pro-ops-overlay" listening={false}>
      {/* 1. 所有异站跨线联络线（仅专业模式可见） */}
      {proOps.trackConnections
        .filter((conn) => conn.kind === 'inter_station_link')
        .map((conn) => {
          const fromSt = stationMap.get(conn.fromStationId);
          const toSt = stationMap.get(conn.toStationId);
          if (!fromSt || !toSt) return null;
          const p1 = getStationDisplayPoint(fromSt);
          const p2 = getStationDisplayPoint(toSt);
          return (
            <KonvaLine
              key={`link_${conn.id}`}
              points={[p1.x, p1.y, p2.x, p2.y]}
              stroke={isDarkCanvas ? '#38bdf8' : '#0284c7'}
              strokeWidth={3 * invScale}
              dash={[7 * invScale, 5 * invScale]}
              lineCap="round"
              opacity={0.82}
              perfectDrawEnabled={false}
            />
          );
        })}

      {/* 2. 当前选中运行交路走廊高亮与停靠/越站节点 */}
      {activePattern && activeValidation?.status === 'valid' && activeKinematics?.status === 'valid' && (
        <Group>
          {activePattern.routeSteps.map((step, idx) => {
            if (step.kind === 'section') {
              const sec = sectionMap.get(step.sectionId);
              if (!sec) return null;
              const forward = sec.startStationId === step.fromStationId;
              const pts = buildSectionFlatPoints(sec, forward);
              if (pts.length < 4) return null;
              return (
                <React.Fragment key={`pat_sec_${idx}`}>
                  <KonvaLine
                    points={pts}
                    stroke={isDarkCanvas ? '#07111f' : '#ffffff'}
                    strokeWidth={11 * invScale}
                    lineCap="round"
                    lineJoin="round"
                    opacity={0.86}
                    perfectDrawEnabled={false}
                  />
                  <KonvaLine
                    points={pts}
                    stroke={activePattern.color}
                    strokeWidth={6.5 * invScale}
                    lineCap="round"
                    lineJoin="round"
                    perfectDrawEnabled={false}
                  />
                </React.Fragment>
              );
            }

            const conn = connMap.get(step.connectionId);
            if (!conn || conn.kind === 'same_station_junction') return null;
            const fromSt = stationMap.get(step.fromStationId);
            const toSt = stationMap.get(step.toStationId);
            if (!fromSt || !toSt) return null;
            const p1 = getStationDisplayPoint(fromSt);
            const p2 = getStationDisplayPoint(toSt);
            return (
              <KonvaLine
                key={`pat_conn_${idx}`}
                points={[p1.x, p1.y, p2.x, p2.y]}
                stroke={activePattern.color}
                strokeWidth={5.5 * invScale}
                dash={[8 * invScale, 5 * invScale]}
                lineCap="round"
                perfectDrawEnabled={false}
              />
            );
          })}

          {(() => {
            const byStation = new Map<
              string,
              { hasStop: boolean; hasPass: boolean; isEndpoint: boolean; hasJunction: boolean }
            >();
            activeKinematics.visits.forEach((v, idx) => {
              const prev = byStation.get(v.stationId) || {
                hasStop: false,
                hasPass: false,
                isEndpoint: false,
                hasJunction: false
              };
              if (idx === 0 || idx === activeKinematics.visits.length - 1) {
                prev.isEndpoint = true;
                prev.hasStop = true;
              } else if (v.isStop) {
                prev.hasStop = true;
              } else {
                prev.hasPass = true;
              }
              if (v.switchedToLineId) prev.hasJunction = true;
              byStation.set(v.stationId, prev);
            });

            return Array.from(byStation.entries()).map(([sid, role]) => {
              const st = stationMap.get(sid);
              if (!st) return null;
              const pt = getStationDisplayPoint(st);

              if (role.isEndpoint) {
                return (
                  <Group key={`visit_node_${sid}`} x={pt.x} y={pt.y}>
                    <Circle
                      radius={10.5 * invScale}
                      fill={isDarkCanvas ? '#0f172a' : '#ffffff'}
                      stroke={activePattern.color}
                      strokeWidth={3.6 * invScale}
                      perfectDrawEnabled={false}
                    />
                    <Circle
                      radius={4.2 * invScale}
                      fill={activePattern.color}
                      perfectDrawEnabled={false}
                    />
                  </Group>
                );
              }

              if (role.hasStop) {
                return (
                  <Group key={`visit_node_${sid}`} x={pt.x} y={pt.y}>
                    <Circle
                      radius={8 * invScale}
                      fill={isDarkCanvas ? '#0f172a' : '#ffffff'}
                      stroke={activePattern.color}
                      strokeWidth={3.2 * invScale}
                      perfectDrawEnabled={false}
                    />
                    {role.hasJunction ? (
                      <Circle
                        radius={12 * invScale}
                        stroke="#f59e0b"
                        strokeWidth={2 * invScale}
                        dash={[4 * invScale, 3 * invScale]}
                        perfectDrawEnabled={false}
                      />
                    ) : null}
                  </Group>
                );
              }

              return (
                <Group key={`visit_node_${sid}`} x={pt.x} y={pt.y}>
                  <Circle
                    radius={5.2 * invScale}
                    fill={activePattern.color}
                    stroke={isDarkCanvas ? '#0f172a' : '#ffffff'}
                    strokeWidth={1.8 * invScale}
                    opacity={0.92}
                    perfectDrawEnabled={false}
                  />
                </Group>
              );
            });
          })()}
        </Group>
      )}

      {/* 3. 点选区间检视高亮 */}
      {selectedSection && (() => {
        const pts = buildSectionFlatPoints(selectedSection, true);
        if (pts.length < 4) return null;
        return (
          <KonvaLine
            points={pts}
            stroke="#f59e0b"
            strokeWidth={9 * invScale}
            dash={[8 * invScale, 5 * invScale]}
            lineCap="round"
            lineJoin="round"
            perfectDrawEnabled={false}
          />
        );
      })()}

      {/* 4. 点选车站检视光环 */}
      {selectedStation && (() => {
        const pt = getStationDisplayPoint(selectedStation);
        return (
          <Circle
            x={pt.x}
            y={pt.y}
            radius={14 * invScale}
            fill="rgba(245, 158, 11, 0.16)"
            stroke="#f59e0b"
            strokeWidth={2.6 * invScale}
            perfectDrawEnabled={false}
          />
        );
      })()}

      {/* 5. 两点标尺校准锚点 */}
      {rulerPoints.length >= 1 && (() => {
        const p1 = getStationDisplayPoint(rulerPoints[0]);
        const p2 = rulerPoints[1] ? getStationDisplayPoint(rulerPoints[1]) : null;
        return (
          <Group>
            {p2 && (
              <KonvaLine
                points={[p1.x, p1.y, p2.x, p2.y]}
                stroke="#2563eb"
                strokeWidth={2.8 * invScale}
                dash={[6 * invScale, 4 * invScale]}
                perfectDrawEnabled={false}
              />
            )}
            {rulerPoints.map((st, idx) => {
              const p = getStationDisplayPoint(st);
              return (
                <Group key={`ruler_pt_${st.id}_${idx}`} x={p.x} y={p.y}>
                  <Circle
                    radius={12 * invScale}
                    fill="#2563eb"
                    stroke="#ffffff"
                    strokeWidth={2.5 * invScale}
                    perfectDrawEnabled={false}
                  />
                  <Rect
                    x={-28 * invScale}
                    y={-28 * invScale}
                    width={56 * invScale}
                    height={16 * invScale}
                    cornerRadius={8 * invScale}
                    fill="#1d4ed8"
                    perfectDrawEnabled={false}
                  />
                  <KonvaText
                    x={-28 * invScale}
                    y={-25 * invScale}
                    width={56 * invScale}
                    align="center"
                    text={`标尺点 ${idx === 0 ? 'A' : 'B'}`}
                    fontSize={10 * invScale}
                    fontStyle="bold"
                    fill="#ffffff"
                    perfectDrawEnabled={false}
                  />
                </Group>
              );
            })}
          </Group>
        );
      })()}

      {/* 6. Phase 2 实时列车动态仿真回放层（双线靠右分边运行 + 越行站待避外移视觉演示） */}
      {liveTrains.length > 0 && (
        <Group>
          {liveTrains.map((tr) => {
            const fromSt = stationMap.get(tr.fromStationId);
            const toSt = stationMap.get(tr.toStationId);
            if (!fromSt) return null;

            let pts: Array<{ x: number; y: number }>;
            if (tr.status !== 'running') {
              const pFrom = getStationDisplayPoint(fromSt);
              const pTo = toSt ? getStationDisplayPoint(toSt) : { x: pFrom.x + 1, y: pFrom.y };
              pts = [pFrom, pTo];
            } else if (tr.sectionId) {
              const sec = sectionMap.get(tr.sectionId);
              if (sec) {
                const forward = sec.startStationId === tr.fromStationId;
                pts = buildSectionOrderedPoints(sec, forward);
              } else {
                pts = toSt
                  ? [getStationDisplayPoint(fromSt), getStationDisplayPoint(toSt)]
                  : [getStationDisplayPoint(fromSt)];
              }
            } else {
              pts = toSt
                ? [getStationDisplayPoint(fromSt), getStationDisplayPoint(toSt)]
                : [getStationDisplayPoint(fromSt)];
            }

            const interp = interpolateAlongPts(pts, tr.status === 'running' ? tr.progress : 0);
            // 待避慢车外移至副线（9.5px），让正线快车从内侧高速超越；正常上下行靠右微偏（3.6px）
            const lateralOffset = (tr.status === 'yielding' ? 9.5 : 3.6) * invScale;
            const cx = interp.x + interp.nx * lateralOffset;
            const cy = interp.y + interp.ny * lateralOffset;

            return (
              <Group key={tr.trainId} x={cx} y={cy}>
                {tr.status === 'yielding' && (
                  <Circle
                    radius={10.5 * invScale}
                    fill="rgba(16, 185, 129, 0.22)"
                    stroke="#10b981"
                    strokeWidth={1.6 * invScale}
                    perfectDrawEnabled={false}
                  />
                )}
                <Circle
                  radius={6.8 * invScale}
                  fill={tr.color}
                  stroke="#ffffff"
                  strokeWidth={2.2 * invScale}
                  perfectDrawEnabled={false}
                />
                <Rect
                  x={-18 * invScale}
                  y={-21 * invScale}
                  width={36 * invScale}
                  height={12 * invScale}
                  cornerRadius={6 * invScale}
                  fill={tr.status === 'yielding' ? '#059669' : tr.color}
                  opacity={0.94}
                  perfectDrawEnabled={false}
                />
                <KonvaText
                  x={-18 * invScale}
                  y={-19 * invScale}
                  width={36 * invScale}
                  align="center"
                  text={tr.status === 'yielding' ? '待避' : tr.badgeCode.slice(0, 2)}
                  fontSize={8.5 * invScale}
                  fontStyle="bold"
                  fill="#ffffff"
                  perfectDrawEnabled={false}
                />
              </Group>
            );
          })}
        </Group>
      )}
    </Layer>
  );
};

export default ProCanvasOverlay;
