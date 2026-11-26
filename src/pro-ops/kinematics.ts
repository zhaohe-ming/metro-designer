import { Section, Station } from '../types';
import { MapGraph } from '../lib/graphOps';
import { measureSectionDistance } from './distance';
import {
  createDefaultLineSpec,
  ProLineSpec,
  ProOpsDocument,
  ProServicePattern,
  ProServiceValidation,
  ProTrackConnection
} from './types';

export interface StationVisitTiming {
  visitIndex: number;
  stationId: string;
  stationName: string;
  lineId: string;
  lineName: string;
  lineColor: string;
  /** 若在此站经过同站跨线道岔切入新线路，记录切换后的线路信息 */
  switchedToLineId?: string;
  switchedToLineName?: string;
  isStop: boolean;
  /** 距离始发站的累计里程（米） */
  cumulativeMeters: number;
  /** 到达（或越行通过中心线）时刻（秒，始发发车前到达计为 0） */
  arrivalSec: number;
  /** 发车（或越行通过中心线）时刻（秒） */
  departureSec: number;
  /** 停站时间（秒；越站为 0） */
  dwellSec: number;
  /** 越站通过瞬时速度（km/h；停靠站为 0） */
  passSpeedKmh: number;
  isTransferStation: boolean;
  hasTurnback: boolean;
  hasPassingTrack: boolean;
}

export interface SegmentTimingDetail {
  stepIndex: number;
  fromVisitIndex: number;
  toVisitIndex: number;
  lengthMeters: number;
  speedLimitKmh: number;
  entrySpeedKmh: number;
  peakSpeedKmh: number;
  exitSpeedKmh: number;
  runSec: number;
}

export interface ServiceKinematicsResult {
  patternId: string;
  status: 'valid' | 'broken';
  totalDistanceMeters: number;
  totalDistanceKm: number;
  /** 单程纯区间运行时分（不含中间停站，秒） */
  pureRunSec: number;
  /** 单程中途停站总时分（不含始发与终到折返，秒） */
  totalIntermediateDwellSec: number;
  /** 单程总旅行时间（始发发车 -> 终到到达，秒） */
  oneWayTravelSec: number;
  /** 单程旅行速度（km/h，含中途停站） */
  commercialSpeedKmh: number;
  /** 技术速度（km/h，不含中途停站） */
  technicalSpeedKmh: number;
  /** 全周转时间（秒；双向开行时含上下行及两端折返） */
  cycleTimeSec: number;
  /** 高峰小时发车对数（tph） */
  frequencyTph: number;
  /** 运用车数（列） */
  activeTrains: number;
  /** 单向小时额定断面运能（人/小时） */
  hourlyCapacityPphpd: number;
  stopCount: number;
  passCount: number;
  visits: StationVisitTiming[];
  segments: SegmentTimingDetail[];
}

interface PhysicalSegmentInput {
  stepIndex: number;
  lengthMeters: number;
  maxSpeedMps: number;
  accelMps2: number;
  decelMps2: number;
  fromVisitIndex: number;
  toVisitIndex: number;
}

/**
 * 给定初速度 v0、末速度 v1、限速 V、长度 L 与加减速度 (a+, a-)，
 * 精确求解单段恒定限速区间的运行时间与峰值速度（连续速度曲线核心算子）。
 */
export function solveSegmentRunTime(
  lengthMeters: number,
  v0Mps: number,
  v1Mps: number,
  vMaxMps: number,
  accelMps2: number,
  decelMps2: number
): { runSec: number; peakSpeedMps: number } {
  const L = Math.max(1, lengthMeters);
  const aPos = Math.max(0.15, accelMps2);
  const aNeg = Math.max(0.15, decelMps2);
  const V = Math.max(1, vMaxMps, v0Mps, v1Mps);

  const dAcc = Math.max(0, (V * V - v0Mps * v0Mps) / (2 * aPos));
  const dDec = Math.max(0, (V * V - v1Mps * v1Mps) / (2 * aNeg));

  if (dAcc + dDec <= L + 1e-6) {
    const tAcc = Math.max(0, (V - v0Mps) / aPos);
    const tDec = Math.max(0, (V - v1Mps) / aNeg);
    const tCruise = Math.max(0, L - dAcc - dDec) / V;
    return {
      runSec: tAcc + tCruise + tDec,
      peakSpeedMps: V
    };
  }

  // 未达巡航上限即需制动：求三角曲线交点峰值速度 vPeak
  const numerator = 2 * L * aPos * aNeg + aNeg * v0Mps * v0Mps + aPos * v1Mps * v1Mps;
  const vPeak = Math.sqrt(Math.max(Math.max(v0Mps, v1Mps) ** 2, numerator / (aPos + aNeg)));
  const tAcc = Math.max(0, (vPeak - v0Mps) / aPos);
  const tDec = Math.max(0, (vPeak - v1Mps) / aNeg);
  return {
    runSec: tAcc + tDec,
    peakSpeedMps: vPeak
  };
}

/**
 * 连续速度包络线求解器（Forward-Backward Velocity Envelope Solver）：
 * 对两次停靠之间的所有连续越站区间（支持多段不同限速、跨线道岔限速与车站通过限速），
 * 进行前向加速包络 + 后向制动包络双遍扫描，彻底消除「把越站当成先刹停再起步」的失真误差。
 */
function solveStopToStopSpan(
  spanSegments: PhysicalSegmentInput[],
  interiorPassCapsMps: number[] // 长度 = spanSegments.length - 1
): Array<{ entryMps: number; peakMps: number; exitMps: number; runSec: number }> {
  const m = spanSegments.length;
  if (m === 0) return [];

  // 节点 0 .. m 的允许上限速度：两端停靠必为 0，中间越行节点受相邻区间限速与越站限速共同约束
  const nodeCap = new Array<number>(m + 1).fill(0);
  nodeCap[0] = 0;
  nodeCap[m] = 0;
  for (let i = 1; i < m; i += 1) {
    const passCap = interiorPassCapsMps[i - 1] ?? Number.POSITIVE_INFINITY;
    nodeCap[i] = Math.min(
      spanSegments[i - 1].maxSpeedMps,
      spanSegments[i].maxSpeedMps,
      passCap
    );
  }

  // 1) 前向加速可达包络
  const forwardU = new Array<number>(m + 1).fill(0);
  forwardU[0] = 0;
  for (let i = 1; i <= m; i += 1) {
    const seg = spanSegments[i - 1];
    const maxReachable = Math.sqrt(
      forwardU[i - 1] * forwardU[i - 1] + 2 * seg.accelMps2 * seg.lengthMeters
    );
    forwardU[i] = Math.min(nodeCap[i], maxReachable);
  }

  // 2) 后向制动安全包络
  const finalU = new Array<number>(m + 1).fill(0);
  finalU[m] = 0;
  for (let i = m - 1; i >= 0; i -= 1) {
    const seg = spanSegments[i];
    const maxBrakable = Math.sqrt(
      finalU[i + 1] * finalU[i + 1] + 2 * seg.decelMps2 * seg.lengthMeters
    );
    finalU[i] = Math.min(forwardU[i], maxBrakable);
  }

  // 3) 逐段解析求解精确运行时间
  return spanSegments.map((seg, i) => {
    const v0 = finalU[i];
    const v1 = finalU[i + 1];
    const { runSec, peakSpeedMps } = solveSegmentRunTime(
      seg.lengthMeters,
      v0,
      v1,
      seg.maxSpeedMps,
      seg.accelMps2,
      seg.decelMps2
    );
    return {
      entryMps: v0,
      peakMps: peakSpeedMps,
      exitMps: v1,
      runSec
    };
  });
}

export function solveServiceKinematics(
  graph: MapGraph,
  proOps: ProOpsDocument,
  pattern: ProServicePattern,
  validation: ProServiceValidation,
  isGeoMode: boolean
): ServiceKinematicsResult {
  const frequencyTph = Math.round((3600 / Math.max(60, pattern.headwaySec)) * 100) / 100;

  if (validation.status === 'broken' || pattern.routeSteps.length === 0) {
    return {
      patternId: pattern.id,
      status: 'broken',
      totalDistanceMeters: 0,
      totalDistanceKm: 0,
      pureRunSec: 0,
      totalIntermediateDwellSec: 0,
      oneWayTravelSec: 0,
      commercialSpeedKmh: 0,
      technicalSpeedKmh: 0,
      cycleTimeSec: 0,
      frequencyTph,
      activeTrains: 0,
      hourlyCapacityPphpd: 0,
      stopCount: 0,
      passCount: 0,
      visits: [],
      segments: []
    };
  }

  const stationMap = new Map<string, Station>(graph.stations.map((s) => [s.id, s]));
  const lineMap = new Map(graph.lines.map((l) => [l.id, l]));
  const sectionMap = new Map<string, Section>(graph.sections.map((s) => [s.id, s]));
  const connMap = new Map<string, ProTrackConnection>(proOps.trackConnections.map((c) => [c.id, c]));

  // 统计每个车站归属多少条物理线路（用于默认停站时间 30s vs 45s 判定）
  const stationLineCount = new Map<string, number>();
  graph.lines.forEach((line) => {
    new Set(line.stationIds).forEach((sid) => {
      stationLineCount.set(sid, (stationLineCount.get(sid) || 0) + 1);
    });
  });

  const getLineSpec = (lineId: string): ProLineSpec =>
    proOps.lineSpecs[lineId] || createDefaultLineSpec('6B');

  const resolveDwellSec = (stationId: string, override?: number): number => {
    if (typeof override === 'number' && Number.isFinite(override)) return override;
    const prof = proOps.stationProfiles[stationId];
    if (prof && typeof prof.dwellSec === 'number') return prof.dwellSec;
    return (stationLineCount.get(stationId) || 1) >= 2 ? 45 : 30;
  };

  // 构建访问节点列表与物理运行分段（同站跨线道岔合入当前站点切换标识，保留真实道岔运行距离与限速）
  const firstStep = pattern.routeSteps[0];
  const firstLineId = firstStep.kind === 'section' ? firstStep.lineId : firstStep.fromLineId;
  const firstStation = stationMap.get(firstStep.fromStationId);
  const firstLine = lineMap.get(firstLineId);

  const visits: StationVisitTiming[] = [
    {
      visitIndex: 0,
      stationId: firstStep.fromStationId,
      stationName: firstStation?.name || firstStep.fromStationNameHint || firstStep.fromStationId,
      lineId: firstLineId,
      lineName: firstLine?.name || firstLineId,
      lineColor: firstLine?.color || pattern.color,
      isStop: true, // 始发端物理发车速度为 0
      cumulativeMeters: 0,
      arrivalSec: 0,
      departureSec: 0,
      dwellSec: pattern.stopAtStart ? resolveDwellSec(firstStep.fromStationId, pattern.startDwellSecOverride) : 0,
      passSpeedKmh: 0,
      isTransferStation: (stationLineCount.get(firstStep.fromStationId) || 1) >= 2,
      hasTurnback: Boolean(proOps.stationProfiles[firstStep.fromStationId]?.hasTurnback),
      hasPassingTrack: Boolean(proOps.stationProfiles[firstStep.fromStationId]?.hasPassingTrack)
    }
  ];

  // 内部物理节点序列（含同站道岔内部过渡点，确保即使在车站停靠后过道岔限速 45km/h 也能精确加速通过）
  interface InternalNode {
    stationId: string;
    isStop: boolean;
    passCapMps: number;
    visitIndex: number; // 映射到 visits 下标
  }

  const getStationPassCapMps = (stationId: string): number => {
    const capKmh = proOps.stationProfiles[stationId]?.passSpeedLimitKmh;
    return typeof capKmh === 'number' && capKmh > 0 ? capKmh / 3.6 : Number.POSITIVE_INFINITY;
  };

  const internalNodes: InternalNode[] = [
    {
      stationId: firstStep.fromStationId,
      isStop: true,
      passCapMps: 0,
      visitIndex: 0
    }
  ];
  const physicalSegments: PhysicalSegmentInput[] = [];

  let cumulativeMeters = 0;
  let minTrainCapacity = Number.POSITIVE_INFINITY;

  pattern.routeSteps.forEach((step, idx) => {
    const isLastStep = idx === pattern.routeSteps.length - 1;
    if (step.kind === 'section') {
      const sec = sectionMap.get(step.sectionId)!;
      const spec = getLineSpec(step.lineId);
      minTrainCapacity = Math.min(minTrainCapacity, spec.carCapacity);
      const dist = measureSectionDistance(
        sec,
        stationMap,
        proOps.scaleConfig,
        proOps.sectionOverrides,
        isGeoMode
      ).meters;
      const overrideSpeed = proOps.sectionOverrides[sec.id]?.speedLimitKmh;
      const speedKmh = overrideSpeed ? Math.min(spec.maxSpeedKmh, overrideSpeed) : spec.maxSpeedKmh;

      cumulativeMeters += dist;
      const endStation = stationMap.get(step.toStationId);
      const line = lineMap.get(step.lineId);
      // 终到站列车必须刹停（isLastStep => 物理速度归零），但记录真实停靠标记
      const physicalStop = isLastStep ? true : step.stopAtEnd;
      const visitIdx = visits.length;

      visits.push({
        visitIndex: visitIdx,
        stationId: step.toStationId,
        stationName: endStation?.name || step.toStationNameHint || step.toStationId,
        lineId: step.lineId,
        lineName: line?.name || step.lineId,
        lineColor: line?.color || pattern.color,
        isStop: physicalStop,
        cumulativeMeters,
        arrivalSec: 0,
        departureSec: 0,
        dwellSec: !isLastStep && step.stopAtEnd ? resolveDwellSec(step.toStationId, step.dwellSecOverride) : 0,
        passSpeedKmh: 0,
        isTransferStation: (stationLineCount.get(step.toStationId) || 1) >= 2,
        hasTurnback: Boolean(proOps.stationProfiles[step.toStationId]?.hasTurnback),
        hasPassingTrack: Boolean(proOps.stationProfiles[step.toStationId]?.hasPassingTrack)
      });

      const prevVisitIdx = internalNodes[internalNodes.length - 1].visitIndex;
      physicalSegments.push({
        stepIndex: idx,
        lengthMeters: dist,
        maxSpeedMps: speedKmh / 3.6,
        accelMps2: spec.accelMps2,
        decelMps2: spec.decelMps2,
        fromVisitIndex: prevVisitIdx,
        toVisitIndex: visitIdx
      });

      internalNodes.push({
        stationId: step.toStationId,
        isStop: physicalStop,
        passCapMps: physicalStop ? 0 : getStationPassCapMps(step.toStationId),
        visitIndex: visitIdx
      });
    } else {
      const conn = connMap.get(step.connectionId)!;
      const fromSpec = getLineSpec(step.fromLineId);
      const toSpec = getLineSpec(step.toLineId);
      minTrainCapacity = Math.min(minTrainCapacity, fromSpec.carCapacity, toSpec.carCapacity);
      const dist = Math.max(15, conn.distanceMeters);
      const speedKmh = Math.min(fromSpec.maxSpeedKmh, toSpec.maxSpeedKmh, conn.speedLimitKmh);
      cumulativeMeters += dist;

      const isSameStation = conn.kind === 'same_station_junction' && step.fromStationId === step.toStationId;
      const toLine = lineMap.get(step.toLineId);

      if (isSameStation) {
        // 同站道岔：不新增面向乘客的重复站名列，在当前访问站标记切入新线，物理上走完道岔限速段
        const currentVisit = visits[visits.length - 1];
        currentVisit.switchedToLineId = step.toLineId;
        currentVisit.switchedToLineName = toLine?.name || step.toLineId;
        currentVisit.cumulativeMeters = cumulativeMeters;

        const prevVisitIdx = internalNodes[internalNodes.length - 1].visitIndex;
        const physicalStop = isLastStep;
        physicalSegments.push({
          stepIndex: idx,
          lengthMeters: dist,
          maxSpeedMps: speedKmh / 3.6,
          accelMps2: Math.min(fromSpec.accelMps2, toSpec.accelMps2),
          decelMps2: Math.min(fromSpec.decelMps2, toSpec.decelMps2),
          fromVisitIndex: prevVisitIdx,
          toVisitIndex: prevVisitIdx
        });
        internalNodes.push({
          stationId: step.toStationId,
          isStop: physicalStop,
          passCapMps: physicalStop ? 0 : Math.min(speedKmh / 3.6, getStationPassCapMps(step.toStationId)),
          visitIndex: prevVisitIdx
        });
      } else {
        const endStation = stationMap.get(step.toStationId);
        const physicalStop = isLastStep ? true : step.stopAtEnd;
        const visitIdx = visits.length;
        visits.push({
          visitIndex: visitIdx,
          stationId: step.toStationId,
          stationName: endStation?.name || step.toStationNameHint || step.toStationId,
          lineId: step.toLineId,
          lineName: toLine?.name || step.toLineId,
          lineColor: toLine?.color || pattern.color,
          isStop: physicalStop,
          cumulativeMeters,
          arrivalSec: 0,
          departureSec: 0,
          dwellSec: !isLastStep && step.stopAtEnd ? resolveDwellSec(step.toStationId, step.dwellSecOverride) : 0,
          passSpeedKmh: 0,
          isTransferStation: (stationLineCount.get(step.toStationId) || 1) >= 2,
          hasTurnback: Boolean(proOps.stationProfiles[step.toStationId]?.hasTurnback),
          hasPassingTrack: Boolean(proOps.stationProfiles[step.toStationId]?.hasPassingTrack)
        });

        const prevVisitIdx = internalNodes[internalNodes.length - 1].visitIndex;
        physicalSegments.push({
          stepIndex: idx,
          lengthMeters: dist,
          maxSpeedMps: speedKmh / 3.6,
          accelMps2: Math.min(fromSpec.accelMps2, toSpec.accelMps2),
          decelMps2: Math.min(fromSpec.decelMps2, toSpec.decelMps2),
          fromVisitIndex: prevVisitIdx,
          toVisitIndex: visitIdx
        });
        internalNodes.push({
          stationId: step.toStationId,
          isStop: physicalStop,
          passCapMps: physicalStop ? 0 : getStationPassCapMps(step.toStationId),
          visitIndex: visitIdx
        });
      }
    }
  });

  // 按内部停靠点（internalNodes[k].isStop === true）切分连续运行大区间并逐跨求解
  const stopIndices: number[] = [];
  internalNodes.forEach((node, idx) => {
    if (node.isStop) stopIndices.push(idx);
  });
  if (stopIndices[stopIndices.length - 1] !== internalNodes.length - 1) {
    stopIndices.push(internalNodes.length - 1);
  }

  const solvedSegments: SegmentTimingDetail[] = [];
  let pureRunSec = 0;

  for (let s = 0; s < stopIndices.length - 1; s += 1) {
    const startIdx = stopIndices[s];
    const endIdx = stopIndices[s + 1];
    const spanSegs = physicalSegments.slice(startIdx, endIdx);
    const passCaps: number[] = [];
    for (let k = startIdx + 1; k < endIdx; k += 1) {
      passCaps.push(internalNodes[k].passCapMps);
    }

    const solved = solveStopToStopSpan(spanSegs, passCaps);
    solved.forEach((res, offset) => {
      const seg = spanSegs[offset];
      pureRunSec += res.runSec;
      solvedSegments.push({
        stepIndex: seg.stepIndex,
        fromVisitIndex: seg.fromVisitIndex,
        toVisitIndex: seg.toVisitIndex,
        lengthMeters: seg.lengthMeters,
        speedLimitKmh: Math.round(seg.maxSpeedMps * 3.6 * 10) / 10,
        entrySpeedKmh: Math.round(res.entryMps * 3.6 * 10) / 10,
        peakSpeedKmh: Math.round(res.peakMps * 3.6 * 10) / 10,
        exitSpeedKmh: Math.round(res.exitMps * 3.6 * 10) / 10,
        runSec: Math.round(res.runSec * 10) / 10
      });

      const endNode = internalNodes[startIdx + offset + 1];
      if (!endNode.isStop) {
        visits[endNode.visitIndex].passSpeedKmh = Math.round(res.exitMps * 3.6 * 10) / 10;
      }
    });
  }

  // 推进全线时刻表（以始发站发车时刻 t = 0 为基准）
  let clockSec = 0;
  let totalIntermediateDwellSec = 0;
  visits[0].arrivalSec = 0;
  visits[0].departureSec = 0;

  solvedSegments.forEach((seg) => {
    clockSec += seg.runSec;
    const targetVisit = visits[seg.toVisitIndex];
    targetVisit.arrivalSec = Math.round(clockSec * 10) / 10;
    if (seg.toVisitIndex < visits.length - 1 && targetVisit.isStop && targetVisit.dwellSec > 0) {
      // 同站道岔可能两段指向同一 visitIndex，只在首次进入该停靠站时累加一次停站时间
      if (targetVisit.departureSec <= targetVisit.arrivalSec) {
        clockSec += targetVisit.dwellSec;
        totalIntermediateDwellSec += targetVisit.dwellSec;
      }
    }
    targetVisit.departureSec = Math.round(clockSec * 10) / 10;
  });

  const oneWayTravelSec = Math.round(clockSec * 10) / 10;
  const totalDistanceKm = Math.round((cumulativeMeters / 1000) * 100) / 100;
  const commercialSpeedKmh =
    oneWayTravelSec > 0 ? Math.round(((cumulativeMeters / 1000) / (oneWayTravelSec / 3600)) * 10) / 10 : 0;
  const technicalSpeedKmh =
    pureRunSec > 0 ? Math.round(((cumulativeMeters / 1000) / (pureRunSec / 3600)) * 10) / 10 : 0;

  const startTurnSec = getLineSpec(visits[0].lineId).turnbackSec;
  const endLineId = visits[visits.length - 1].switchedToLineId || visits[visits.length - 1].lineId;
  const endTurnSec = getLineSpec(endLineId).turnbackSec;

  const cycleTimeSec = pattern.bidirectional
    ? Math.round(2 * oneWayTravelSec + startTurnSec + endTurnSec)
    : Math.round(oneWayTravelSec + endTurnSec);
  const activeTrains = Math.max(1, Math.ceil(cycleTimeSec / Math.max(60, pattern.headwaySec)));
  const trainCap = Number.isFinite(minTrainCapacity) ? minTrainCapacity : 1460;
  const hourlyCapacityPphpd = Math.round((3600 / Math.max(60, pattern.headwaySec)) * trainCap);

  const stopCount = visits.filter((v) => v.isStop).length;
  const passCount = visits.length - stopCount;

  return {
    patternId: pattern.id,
    status: 'valid',
    totalDistanceMeters: cumulativeMeters,
    totalDistanceKm,
    pureRunSec: Math.round(pureRunSec * 10) / 10,
    totalIntermediateDwellSec: Math.round(totalIntermediateDwellSec * 10) / 10,
    oneWayTravelSec,
    commercialSpeedKmh,
    technicalSpeedKmh,
    cycleTimeSec,
    frequencyTph,
    activeTrains,
    hourlyCapacityPphpd,
    stopCount,
    passCount,
    visits,
    segments: solvedSegments
  };
}
