import { Line, Section, Station } from '../types';
import { MapGraph } from '../lib/graphOps';
import { measureSectionDistance } from './distance';
import { ServiceKinematicsResult, solveServiceKinematics } from './kinematics';
import { decomposeLineIntoSubCorridors, LineSubCorridor } from './reconcile';
import {
  cloneProOpsDocument,
  DEFAULT_PRO_TIMETABLE_CONFIG,
  makeCanonicalLinePairKey,
  ProOpsDocument,
  ProRouteStep,
  ProServiceCategory,
  ProServicePattern,
  ProServiceValidation
} from './types';

export interface TrainVisitSchedule {
  visitIndex: number;
  stationId: string;
  stationName: string;
  lineId: string;
  switchedToLineId?: string;
  isStop: boolean;
  cumulativeMeters: number;
  arrivalSec: number;
  departureSec: number;
  baseDwellSec: number;
  /** 因在越行站让行快车而自动追加的待避秒数 */
  overtakeHoldSec: number;
  passSpeedKmh: number;
}

export interface ScheduledTrainRun {
  trainId: string;
  trainCode: string;
  patternId: string;
  patternName: string;
  badgeCode: string;
  color: string;
  category: ProServiceCategory;
  direction: 'up' | 'down';
  autoOvertake: boolean;
  routeSteps: ProRouteStep[];
  /** 每个 routeStep 到达的 visits 下标（与 kinematics.segments[stepIdx].toVisitIndex 一致） */
  stepToVisitIndices: Array<{ fromVisitIdx: number; toVisitIdx: number }>;
  visits: TrainVisitSchedule[];
}

export interface ProOvertakeEvent {
  id: string;
  stationId: string;
  stationName: string;
  lineId: string;
  timeSec: number;
  fastTrainId: string;
  fastTrainCode: string;
  slowTrainId: string;
  slowTrainCode: string;
  holdAddedSec: number;
}

export interface ProHeadwayConflict {
  id: string;
  sectionId: string;
  lineId: string;
  fromStationId: string;
  toStationId: string;
  stationId: string;
  stationName: string;
  timeSec: number;
  leadingTrainId: string;
  leadingTrainCode: string;
  trailingTrainId: string;
  trailingTrainCode: string;
  actualGapSec: number;
  requiredGapSec: number;
  isInSectionOvertake: boolean;
  /** 若前序车站尚未设越行线，给出可一键设为越行站的推荐车站 */
  suggestedPassingStationId?: string;
  suggestedPassingStationName?: string;
}

export interface SectionCapacityStat {
  sectionId: string;
  lineId: string;
  fromStationId: string;
  toStationId: string;
  totalTph: number;
  signalMaxTph: number;
  totalPphpd: number;
  overSignalCapacity: boolean;
}

export interface ProConflictBottleneck {
  key: string;
  kind: 'missing_passing_track' | 'tight_headway';
  lineId: string;
  stationId: string;
  stationName: string;
  suggestedPassingStationId?: string;
  suggestedPassingStationName?: string;
  affectedTrainPairs: number;
  sampleGapSec: number;
  requiredGapSec: number;
  summary: string;
}

export interface TimetableSolveResult {
  windowStartSec: number;
  windowEndSec: number;
  trains: ScheduledTrainRun[];
  overtakes: ProOvertakeEvent[];
  conflicts: ProHeadwayConflict[];
  /** 将周期性重复的车次对冲突归并为直观的「结构性瓶颈点」（解释为什么只加一条快车会出现十几处红点） */
  bottlenecks: ProConflictBottleneck[];
  sectionCapacity: SectionCapacityStat[];
  peakSectionTph: number;
  peakSectionPphpd: number;
}

export interface LiveTrainSnapshot {
  trainId: string;
  trainCode: string;
  patternId: string;
  color: string;
  badgeCode: string;
  direction: 'up' | 'down';
  status: 'running' | 'dwelling' | 'yielding';
  /** 若在区间运行：所在 section 或异站联络线端点与进度 [0, 1] */
  sectionId?: string;
  fromStationId: string;
  toStationId: string;
  progress: number;
}

const pairKey = (a: string, b: string) => (a < b ? `${a}::${b}` : `${b}::${a}`);

export function createSharedTrackChecker(sharedTrackLinePairs?: string[]) {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let cur = x;
    while (parent.has(cur) && parent.get(cur) !== cur) {
      cur = parent.get(cur)!;
    }
    return cur;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  (sharedTrackLinePairs || []).forEach((raw) => {
    const [a, b] = raw.split('::');
    if (a && b && a !== b) {
      if (!parent.has(a)) parent.set(a, a);
      if (!parent.has(b)) parent.set(b, b);
      union(a, b);
    }
  });

  return {
    getRoot: (lineId: string) => find(lineId),
    areShared: (lineAId: string, lineBId: string) => {
      if (!lineAId || !lineBId) return false;
      if (lineAId === lineBId) return true;
      return find(lineAId) === find(lineBId);
    },
    hasDirectPair: (lineAId: string, lineBId: string) =>
      Boolean(sharedTrackLinePairs?.includes(makeCanonicalLinePairKey(lineAId, lineBId)))
  };
}

export function formatClockSec(totalSec: number, withSeconds = false): string {
  const safe = Math.max(0, Math.round(totalSec));
  const hh = Math.floor(safe / 3600) % 24;
  const mm = Math.floor((safe % 3600) / 60);
  const ss = safe % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return withSeconds ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : `${pad(hh)}:${pad(mm)}`;
}

export function buildReversedServicePattern(
  pattern: ProServicePattern,
  stationMap: ReadonlyMap<string, Station>
): ProServicePattern {
  const n = pattern.routeSteps.length;
  const reversedSteps: ProRouteStep[] = [...pattern.routeSteps].reverse().map((step, idx) => {
    const isLast = idx === n - 1;
    const origIdx = n - 1 - idx;
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

  return {
    ...pattern,
    id: `${pattern.id}__down`,
    routeSteps: reversedSteps
  };
}

function instantiateTrainFromKinematics(params: {
  trainId: string;
  trainCode: string;
  pattern: ProServicePattern;
  direction: 'up' | 'down';
  routeSteps: ProRouteStep[];
  kin: ServiceKinematicsResult;
  departureSec: number;
}): ScheduledTrainRun {
  const { trainId, trainCode, pattern, direction, routeSteps, kin, departureSec } = params;
  const visits: TrainVisitSchedule[] = kin.visits.map((v) => ({
    visitIndex: v.visitIndex,
    stationId: v.stationId,
    stationName: v.stationName,
    lineId: v.lineId,
    ...(v.switchedToLineId ? { switchedToLineId: v.switchedToLineId } : {}),
    isStop: v.isStop,
    cumulativeMeters: v.cumulativeMeters,
    arrivalSec: Math.round((departureSec + v.arrivalSec) * 10) / 10,
    departureSec: Math.round((departureSec + v.departureSec) * 10) / 10,
    baseDwellSec: v.dwellSec,
    overtakeHoldSec: 0,
    passSpeedKmh: v.passSpeedKmh
  }));

  const stepToVisitIndices = routeSteps.map((_, idx) => {
    const seg = kin.segments.find((s) => s.stepIndex === idx);
    return {
      fromVisitIdx: seg ? seg.fromVisitIndex : Math.min(idx, visits.length - 1),
      toVisitIdx: seg ? seg.toVisitIndex : Math.min(idx + 1, visits.length - 1)
    };
  });

  const defaultAutoOvertake = pattern.category === 'local' || pattern.category === 'short_turn';

  return {
    trainId,
    trainCode,
    patternId: pattern.id,
    patternName: pattern.name,
    badgeCode: pattern.code,
    color: pattern.color,
    category: pattern.category,
    direction,
    autoOvertake: typeof pattern.autoOvertake === 'boolean' ? pattern.autoOvertake : defaultAutoOvertake,
    routeSteps,
    stepToVisitIndices,
    visits
  };
}

interface DirectedStepTraversal {
  train: ScheduledTrainRun;
  stepIdx: number;
  sectionId: string;
  lineId: string;
  fromStationId: string;
  toStationId: string;
  fromVisitIdx: number;
  toVisitIdx: number;
}

/**
 * 铺画指定时间窗内的全网运行图、执行越行站自动待避求解并扫描最小追踪间隔冲突。
 */
export function solveNetworkTimetable(params: {
  graph: MapGraph;
  proOps: ProOpsDocument;
  validations: Readonly<Record<string, ProServiceValidation>>;
  kinematicsMap: Readonly<Record<string, ServiceKinematicsResult>>;
  isGeoMode: boolean;
}): TimetableSolveResult {
  const { graph, proOps, validations, kinematicsMap, isGeoMode } = params;
  const ttCfg = proOps.timetableConfig || DEFAULT_PRO_TIMETABLE_CONFIG;
  const windowStartSec = ttCfg.windowStartMin * 60;
  const windowEndSec = (ttCfg.windowStartMin + ttCfg.windowDurationMin) * 60;
  const defaultMinHeadwaySec = ttCfg.defaultMinHeadwaySec || 120;

  const stationMap = new Map(graph.stations.map((s) => [s.id, s]));
  const sharedChecker = createSharedTrackChecker(proOps.sharedTrackLinePairs);

  // 识别两站之间是否存在被显式声明为「共线共轨」的多条物理线路区间
  const sectionsByStationPair = new Map<string, Section[]>();
  graph.sections.forEach((sec) => {
    const pk = pairKey(sec.startStationId, sec.endStationId);
    const list = sectionsByStationPair.get(pk);
    if (list) list.push(sec);
    else sectionsByStationPair.set(pk, [sec]);
  });

  const getPhysicalTrackKey = (sectionId: string, lineId: string, fromStationId: string, toStationId: string): string => {
    const pk = pairKey(fromStationId, toStationId);
    const candidates = sectionsByStationPair.get(pk);
    if (
      candidates &&
      candidates.length > 1 &&
      candidates.some((other) => other.id !== sectionId && sharedChecker.areShared(lineId, other.lineId))
    ) {
      return `shared::${sharedChecker.getRoot(lineId)}::${fromStationId}->${toStationId}`;
    }
    return `sec::${sectionId}::${fromStationId}->${toStationId}`;
  };

  const getLineMinHeadway = (lineId: string): number =>
    proOps.lineSpecs[lineId]?.minHeadwaySec || defaultMinHeadwaySec;

  // 1. 周期展开全时段车次群（含窗口前已发车但在窗口内仍在途的列车）
  const trains: ScheduledTrainRun[] = [];

  proOps.servicePatterns.forEach((pattern) => {
    const val = validations[pattern.id];
    const upKin = kinematicsMap[pattern.id];
    if (!val || val.status !== 'valid' || !upKin || upKin.status !== 'valid' || upKin.visits.length < 2) {
      return;
    }

    const headway = Math.max(60, pattern.headwaySec);
    const offset = ((pattern.firstDepartureOffsetSec || 0) % headway + headway) % headway;
    const travelDur = Math.max(60, upKin.oneWayTravelSec);

    const firstK = Math.floor((windowStartSec - travelDur - offset) / headway);
    const lastK = Math.ceil((windowEndSec - offset) / headway);

    let upSeq = 1;
    for (let k = firstK; k <= lastK; k += 1) {
      const dep = k * headway + offset;
      if (dep + travelDur < windowStartSec - 30 || dep > windowEndSec + 30) continue;
      const codeNum = String(upSeq).padStart(2, '0');
      trains.push(
        instantiateTrainFromKinematics({
          trainId: `${pattern.id}_U_${k}`,
          trainCode: `${pattern.code}-U${codeNum}`,
          pattern,
          direction: 'up',
          routeSteps: pattern.routeSteps,
          kin: upKin,
          departureSec: dep
        })
      );
      upSeq += 1;
    }

    if (pattern.bidirectional) {
      const revPattern = buildReversedServicePattern(pattern, stationMap);
      const downKin = solveServiceKinematics(graph, proOps, revPattern, val, isGeoMode);
      if (downKin.status === 'valid' && downKin.visits.length >= 2) {
        const downOffset = (offset + Math.floor(headway / 2)) % headway;
        const downDur = Math.max(60, downKin.oneWayTravelSec);
        const dFirstK = Math.floor((windowStartSec - downDur - downOffset) / headway);
        const dLastK = Math.ceil((windowEndSec - downOffset) / headway);
        let downSeq = 1;
        for (let k = dFirstK; k <= dLastK; k += 1) {
          const dep = k * headway + downOffset;
          if (dep + downDur < windowStartSec - 30 || dep > windowEndSec + 30) continue;
          const codeNum = String(downSeq).padStart(2, '0');
          trains.push(
            instantiateTrainFromKinematics({
              trainId: `${pattern.id}_D_${k}`,
              trainCode: `${pattern.code}-D${codeNum}`,
              pattern,
              direction: 'down',
              routeSteps: revPattern.routeSteps,
              kin: downKin,
              departureSec: dep
            })
          );
          downSeq += 1;
        }
      }
    }
  });

  // 辅助：在某个访问站延长慢车停站待避时间，并顺延后续所有访问时刻
  const applyOvertakeHoldAtVisit = (train: ScheduledTrainRun, visitIdx: number, deltaSec: number) => {
    const rounded = Math.round(deltaSec * 10) / 10;
    if (rounded <= 0) return;
    train.visits[visitIdx].overtakeHoldSec =
      Math.round((train.visits[visitIdx].overtakeHoldSec + rounded) * 10) / 10;
    train.visits[visitIdx].departureSec =
      Math.round((train.visits[visitIdx].departureSec + rounded) * 10) / 10;
    for (let i = visitIdx + 1; i < train.visits.length; i += 1) {
      train.visits[i].arrivalSec = Math.round((train.visits[i].arrivalSec + rounded) * 10) / 10;
      train.visits[i].departureSec = Math.round((train.visits[i].departureSec + rounded) * 10) / 10;
    }
  };

  // 构建同向物理轨道遍历映射（默认按 sectionId 隔离各自独立隧道；若声明共线共轨则合并检算）
  const buildDirectedEdgeMap = (): Map<string, DirectedStepTraversal[]> => {
    const map = new Map<string, DirectedStepTraversal[]>();
    trains.forEach((train) => {
      train.routeSteps.forEach((step, sIdx) => {
        if (step.kind !== 'section') return;
        const key = getPhysicalTrackKey(step.sectionId, step.lineId, step.fromStationId, step.toStationId);
        const vMap = train.stepToVisitIndices[sIdx];
        const entry: DirectedStepTraversal = {
          train,
          stepIdx: sIdx,
          sectionId: step.sectionId,
          lineId: step.lineId,
          fromStationId: step.fromStationId,
          toStationId: step.toStationId,
          fromVisitIdx: vMap.fromVisitIdx,
          toVisitIdx: vMap.toVisitIdx
        };
        const list = map.get(key);
        if (list) list.push(entry);
        else map.set(key, [entry]);
      });
    });
    return map;
  };

  const overtakes: ProOvertakeEvent[] = [];
  const recordedOvertakePairs = new Set<string>();

  // 2. 自动越行待避求解（迭代 6 轮，支持一趟快车连续超越多趟慢车或高频错避）
  for (let iter = 0; iter < 6; iter += 1) {
    let anyAdjusted = false;
    const edgeMap = buildDirectedEdgeMap();

    edgeMap.forEach((traversals) => {
      if (traversals.length < 2) return;
      // 按进入本区间发车时刻升序排列
      traversals.sort(
        (a, b) =>
          a.train.visits[a.fromVisitIdx].departureSec -
          b.train.visits[b.fromVisitIdx].departureSec
      );

      for (let i = 0; i < traversals.length - 1; i += 1) {
        const lead = traversals[i];
        if (!lead.train.autoOvertake) continue;

        for (let j = i + 1; j <= Math.min(traversals.length - 1, i + 3); j += 1) {
          const trail = traversals[j];
          if (lead.train.trainId === trail.train.trainId) continue;
          // 同交路同速车不互相越行
          if (lead.train.patternId === trail.train.patternId) continue;

          const minH = Math.max(getLineMinHeadway(lead.lineId), getLineMinHeadway(trail.lineId));
          const leadFromV = lead.train.visits[lead.fromVisitIdx];
          const trailFromV = trail.train.visits[trail.fromVisitIdx];
          const leadToV = lead.train.visits[lead.toVisitIdx];
          const trailToV = trail.train.visits[trail.toVisitIdx];

          const leadDep = leadFromV.departureSec;
          const trailDep = trailFromV.departureSec;
          const leadArr = leadToV.arrivalSec;
          const trailArr = trailToV.arrivalSec;

          // 判断后方列车是否在本区间或到达站站台追近/超越前车
          const toHasSiding = Boolean(proOps.stationProfiles[lead.toStationId]?.hasPassingTrack);
          const leadPlatformClearSec =
            !toHasSiding && lead.toVisitIdx < lead.train.visits.length - 1
              ? leadToV.departureSec
              : leadArr;
          const catchesUp =
            trailArr < leadPlatformClearSec + minH - 1 &&
            trailArr - trailDep < leadPlatformClearSec - leadDep - 2;
          if (!catchesUp) continue;

          // 从本区间到达站（若前车先到且具备越行线）向前回溯至起点，寻找最近的越行待避站
          let chosenSlowVisitIdx = -1;
          let chosenFastVisitIdx = -1;
          // 越行站咽喉道岔进副线出清仅需约 30s（CBTC 典型标准），避免 60s 过严导致明明设了越行站却漏判
          const turnoutClearSec = Math.min(30, Math.round(minH * 0.25));

          for (let sv = lead.toVisitIdx; sv >= 1; sv -= 1) {
            const slowVisit = lead.train.visits[sv];
            if (!slowVisit.isStop || sv >= lead.train.visits.length - 1) continue;
            if (!proOps.stationProfiles[slowVisit.stationId]?.hasPassingTrack) continue;

            const fastVisit = trail.train.visits.find(
              (fv) =>
                fv.stationId === slowVisit.stationId &&
                fv.arrivalSec >= slowVisit.arrivalSec + turnoutClearSec - 1 &&
                fv.departureSec <= slowVisit.departureSec + 600
            );
            if (fastVisit) {
              chosenSlowVisitIdx = sv;
              chosenFastVisitIdx = fastVisit.visitIndex;
              break;
            }
          }

          if (chosenSlowVisitIdx < 0 || chosenFastVisitIdx < 0) continue;

          const slowPassVisit = lead.train.visits[chosenSlowVisitIdx];
          const fastPassVisit = trail.train.visits[chosenFastVisitIdx];
          const targetSlowDep = fastPassVisit.departureSec + minH;
          const delta = targetSlowDep - slowPassVisit.departureSec;

          if (delta > 1 && delta <= 660) {
            applyOvertakeHoldAtVisit(lead.train, chosenSlowVisitIdx, delta);
            anyAdjusted = true;

            const pairId = `${lead.train.trainId}::${trail.train.trainId}::${slowPassVisit.stationId}`;
            if (
              !recordedOvertakePairs.has(pairId) &&
              fastPassVisit.arrivalSec >= windowStartSec &&
              fastPassVisit.arrivalSec <= windowEndSec
            ) {
              recordedOvertakePairs.add(pairId);
              overtakes.push({
                id: pairId,
                stationId: slowPassVisit.stationId,
                stationName: slowPassVisit.stationName,
                lineId: slowPassVisit.lineId,
                timeSec: Math.round(fastPassVisit.arrivalSec),
                fastTrainId: trail.train.trainId,
                fastTrainCode: trail.train.trainCode,
                slowTrainId: lead.train.trainId,
                slowTrainCode: lead.train.trainCode,
                holdAddedSec: Math.round(delta)
              });
            }
            break;
          }
        }
        if (anyAdjusted) break;
      }
    });

    if (!anyAdjusted) break;
  }

  // 3. 扫描最终剩余的追踪间隔冲突（每对列车仅报告首次发生冲突的瓶颈点，避免连续刷屏）
  const rawConflicts: ProHeadwayConflict[] = [];
  const finalEdgeMap = buildDirectedEdgeMap();

  finalEdgeMap.forEach((traversals) => {
    if (traversals.length < 2) return;
    traversals.sort(
      (a, b) =>
        a.train.visits[a.fromVisitIdx].departureSec -
        b.train.visits[b.fromVisitIdx].departureSec
    );

    for (let i = 0; i < traversals.length - 1; i += 1) {
      const lead = traversals[i];
      const trail = traversals[i + 1];
      if (lead.train.trainId === trail.train.trainId) continue;

      const minH = getLineMinHeadway(lead.lineId);
      const leadFromV = lead.train.visits[lead.fromVisitIdx];
      const trailFromV = trail.train.visits[trail.fromVisitIdx];
      const leadToV = lead.train.visits[lead.toVisitIdx];
      const trailToV = trail.train.visits[trail.toVisitIdx];

      const leadDep = leadFromV.departureSec;
      const trailDep = trailFromV.departureSec;
      const leadArr = leadToV.arrivalSec;
      const trailArr = trailToV.arrivalSec;

      const depGap = trailDep - leadDep;
      // 若到达站具备越行配线且前车进副线停靠、后车走正线越行，咽喉道岔仅需半追踪间隔（≤60s）；否则需按正线/站台出清计算
      const toHasSiding = Boolean(proOps.stationProfiles[lead.toStationId]?.hasPassingTrack);
      const isActiveSidingSplit =
        toHasSiding && leadToV.isStop !== trailToV.isStop;

      const requiredArrGap = isActiveSidingSplit
        ? Math.min(60, Math.round(minH * 0.5))
        : minH;
      const effectiveLeadClearAtEnd =
        !toHasSiding && lead.toVisitIdx < lead.train.visits.length - 1 && !trailToV.isStop
          ? leadToV.departureSec
          : leadArr;
      const arrGap = trailArr - effectiveLeadClearAtEnd;

      const depViolation = depGap < minH - 1;
      const arrViolation = arrGap < requiredArrGap - 1;
      if (!depViolation && !arrViolation) continue;

      const conflictAtEnd = arrViolation && (!depViolation || arrGap - requiredArrGap <= depGap - minH);
      const worstGap = conflictAtEnd ? arrGap : depGap;
      const conflictTime = conflictAtEnd ? Math.max(leadArr, trailArr) : trailDep;
      if (conflictTime < windowStartSec || conflictTime > windowEndSec) continue;

      const conflictStationId = conflictAtEnd ? lead.toStationId : lead.fromStationId;
      const conflictStationName = stationMap.get(conflictStationId)?.name || conflictStationId;

      // 寻找最适合增设越行线的中间停靠站（含当前到达站及前序停靠站）作为一键修复建议
      let suggestedId: string | undefined;
      let suggestedName: string | undefined;
      for (let sv = lead.toVisitIdx; sv >= 1; sv -= 1) {
        if (sv >= lead.train.visits.length - 1) continue;
        const v = lead.train.visits[sv];
        if (v.isStop && !proOps.stationProfiles[v.stationId]?.hasPassingTrack) {
          suggestedId = v.stationId;
          suggestedName = v.stationName;
          break;
        }
      }

      rawConflicts.push({
        id: `${lead.train.trainId}_${trail.train.trainId}_${lead.sectionId}`,
        sectionId: lead.sectionId,
        lineId: lead.lineId,
        fromStationId: lead.fromStationId,
        toStationId: lead.toStationId,
        stationId: conflictStationId,
        stationName: conflictStationName,
        timeSec: Math.round(conflictTime),
        leadingTrainId: lead.train.trainId,
        leadingTrainCode: lead.train.trainCode,
        trailingTrainId: trail.train.trainId,
        trailingTrainCode: trail.train.trainCode,
        actualGapSec: Math.round(worstGap),
        requiredGapSec: minH,
        isInSectionOvertake: arrGap < 0,
        ...(suggestedId ? { suggestedPassingStationId: suggestedId } : {}),
        ...(suggestedName ? { suggestedPassingStationName: suggestedName } : {})
      });
    }
  });

  rawConflicts.sort((a, b) => a.timeSec - b.timeSec);
  const seenConflictTrainPair = new Set<string>();
  const conflicts: ProHeadwayConflict[] = [];
  rawConflicts.forEach((c) => {
    const pairKeyStr = `${c.leadingTrainId}->${c.trailingTrainId}`;
    if (seenConflictTrainPair.has(pairKeyStr)) return;
    seenConflictTrainPair.add(pairKeyStr);
    conflicts.push(c);
  });

  // 3.5 将周期性车次对冲突聚类为直观的「结构性瓶颈原因」（避免用户疑惑为什么 1 条快车产生 20 处冲突）
  const bottleneckMap = new Map<string, ProConflictBottleneck>();
  conflicts.forEach((c) => {
    const isMissingSiding = Boolean(c.suggestedPassingStationId) || c.isInSectionOvertake;
    const bnKey = isMissingSiding
      ? `pass::${sharedChecker.getRoot(c.lineId)}::${c.suggestedPassingStationId || c.stationId}`
      : `headway::${sharedChecker.getRoot(c.lineId)}::${c.stationId}`;
    const existing = bottleneckMap.get(bnKey);
    if (existing) {
      existing.affectedTrainPairs += 1;
      if (c.actualGapSec < existing.sampleGapSec) existing.sampleGapSec = c.actualGapSec;
      existing.summary =
        existing.kind === 'missing_passing_track'
          ? existing.suggestedPassingStationName
            ? `快车在「${existing.stationName}」一带追上普通车（1小时内双向重复 ${existing.affectedTrainPairs} 车次），需在「${existing.suggestedPassingStationName}」设越行副线让行`
            : `快车在「${existing.stationName}」追越前车（重复 ${existing.affectedTrainPairs} 车次），沿途缺少可停靠待避的越行站`
          : `在「${existing.stationName}」相邻车次间隔仅 ${Math.max(0, existing.sampleGapSec)}s（要求 ≥${existing.requiredGapSec}s，重复 ${existing.affectedTrainPairs} 车次），需错峰发车相位`;
      return;
    }
    const kind: ProConflictBottleneck['kind'] = isMissingSiding ? 'missing_passing_track' : 'tight_headway';
    const summary =
      kind === 'missing_passing_track'
        ? c.suggestedPassingStationName
          ? `快车在「${c.stationName}」一带追上普通车，需在「${c.suggestedPassingStationName}」启用越行副线让行`
          : `快车在「${c.stationName}」追越前车，沿途缺少可停靠待避的越行站`
        : `在「${c.stationName}」相邻车次间隔仅 ${Math.max(0, c.actualGapSec)}s（要求 ≥${c.requiredGapSec}s），需错峰发车相位`;

    bottleneckMap.set(bnKey, {
      key: bnKey,
      kind,
      lineId: c.lineId,
      stationId: c.stationId,
      stationName: c.stationName,
      ...(c.suggestedPassingStationId ? { suggestedPassingStationId: c.suggestedPassingStationId } : {}),
      ...(c.suggestedPassingStationName ? { suggestedPassingStationName: c.suggestedPassingStationName } : {}),
      affectedTrainPairs: 1,
      sampleGapSec: c.actualGapSec,
      requiredGapSec: c.requiredGapSec,
      summary
    });
  });

  const bottlenecks = Array.from(bottleneckMap.values()).sort(
    (a, b) => b.affectedTrainPairs - a.affectedTrainPairs
  );

  // 4. 核算全网各物理区间的单向合并小时发车对数（tph）与断面额定小时运能（pphpd）
  const sectionStatsMap = new Map<string, { tph: number; pphpd: number; sec: Section }>();
  graph.sections.forEach((sec) => {
    sectionStatsMap.set(sec.id, { tph: 0, pphpd: 0, sec });
  });

  proOps.servicePatterns.forEach((pattern) => {
    const val = validations[pattern.id];
    const kin = kinematicsMap[pattern.id];
    if (!val || val.status !== 'valid' || !kin || kin.status !== 'valid') return;
    const tph = 3600 / Math.max(60, pattern.headwaySec);
    const pphpd = kin.hourlyCapacityPphpd;

    const visitedSectionIds = new Set<string>();
    pattern.routeSteps.forEach((step) => {
      if (step.kind !== 'section') return;
      visitedSectionIds.add(step.sectionId);
      // 若与其他线路区间设为「共线共轨」，合并计入共轨区段发车密度与运能
      const pk = pairKey(step.fromStationId, step.toStationId);
      (sectionsByStationPair.get(pk) || []).forEach((otherSec) => {
        if (otherSec.id !== step.sectionId && sharedChecker.areShared(step.lineId, otherSec.lineId)) {
          visitedSectionIds.add(otherSec.id);
        }
      });
    });
    visitedSectionIds.forEach((secId) => {
      const cur = sectionStatsMap.get(secId);
      if (cur) {
        cur.tph += tph;
        cur.pphpd += pphpd;
      }
    });
  });

  let peakSectionTph = 0;
  let peakSectionPphpd = 0;
  const sectionCapacity: SectionCapacityStat[] = [];

  sectionStatsMap.forEach(({ tph, pphpd, sec }) => {
    const minH = getLineMinHeadway(sec.lineId);
    const signalMaxTph = Math.floor((3600 / minH) * 10) / 10;
    const roundedTph = Math.round(tph * 10) / 10;
    const roundedPphpd = Math.round(pphpd);
    if (roundedTph > peakSectionTph) peakSectionTph = roundedTph;
    if (roundedPphpd > peakSectionPphpd) peakSectionPphpd = roundedPphpd;
    sectionCapacity.push({
      sectionId: sec.id,
      lineId: sec.lineId,
      fromStationId: sec.startStationId,
      toStationId: sec.endStationId,
      totalTph: roundedTph,
      signalMaxTph,
      totalPphpd: roundedPphpd,
      overSignalCapacity: roundedTph > signalMaxTph + 1e-3
    });
  });

  return {
    windowStartSec,
    windowEndSec,
    trains,
    overtakes,
    conflicts,
    bottlenecks,
    sectionCapacity,
    peakSectionTph,
    peakSectionPphpd
  };
}

/**
 * 为目标交路搜索最优首班发车错峰偏移秒数（最小化追踪冲突数与慢车总待避延时）。
 */
export function recommendOptimalPhaseOffset(params: {
  graph: MapGraph;
  proOps: ProOpsDocument;
  validations: Readonly<Record<string, ProServiceValidation>>;
  kinematicsMap: Readonly<Record<string, ServiceKinematicsResult>>;
  targetPatternId: string;
  isGeoMode: boolean;
}): { bestOffsetSec: number; conflictCount: number; totalHoldSec: number } {
  const { graph, proOps, validations, kinematicsMap, targetPatternId, isGeoMode } = params;
  const target = proOps.servicePatterns.find((p) => p.id === targetPatternId);
  if (!target) return { bestOffsetSec: 0, conflictCount: 0, totalHoldSec: 0 };

  const headway = Math.max(60, target.headwaySec);
  const stepSec = headway <= 300 ? 10 : 15;

  let bestOffsetSec = target.firstDepartureOffsetSec || 0;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestConflicts = 0;
  let bestHold = 0;

  for (let cand = 0; cand < headway; cand += stepSec) {
    const trialDoc: ProOpsDocument = {
      ...proOps,
      servicePatterns: proOps.servicePatterns.map((p) =>
        p.id === targetPatternId ? { ...p, firstDepartureOffsetSec: cand } : p
      )
    };
    const res = solveNetworkTimetable({
      graph,
      proOps: trialDoc,
      validations,
      kinematicsMap,
      isGeoMode
    });
    const totalHold = res.overtakes.reduce((acc, o) => acc + o.holdAddedSec, 0);
    const score = res.conflicts.length * 100000 + totalHold;
    if (score < bestScore) {
      bestScore = score;
      bestOffsetSec = cand;
      bestConflicts = res.conflicts.length;
      bestHold = totalHold;
      if (score === 0) break;
    }
  }

  return {
    bestOffsetSec,
    conflictCount: bestConflicts,
    totalHoldSec: bestHold
  };
}

/**
 * 一键自动消解走廊冲突（按需自动启用推荐越行待避站 + 对快车/跨线/小交路执行最优发车错峰相位搜索）。
 */
export function autoResolveCorridorConflicts(params: {
  graph: MapGraph;
  proOps: ProOpsDocument;
  validations: Readonly<Record<string, ProServiceValidation>>;
  kinematicsMap: Readonly<Record<string, ServiceKinematicsResult>>;
  targetLineId?: string | null;
  isGeoMode: boolean;
}): {
  nextProOps: ProOpsDocument;
  addedPassingStationNames: string[];
  adjustedPatternNames: string[];
  remainingConflicts: number;
} {
  const { graph, proOps, validations, kinematicsMap, targetLineId, isGeoMode } = params;
  let working = cloneProOpsDocument(proOps);
  const sharedChecker = createSharedTrackChecker(working.sharedTrackLinePairs);
  const stationMap = new Map(graph.stations.map((s) => [s.id, s]));
  const addedPassingStationNames: string[] = [];
  const adjustedPatternSet = new Set<string>();

  const filterRelevantConflicts = (res: TimetableSolveResult) =>
    targetLineId
      ? res.conflicts.filter((c) => sharedChecker.areShared(c.lineId, targetLineId))
      : res.conflicts;

  // 第一阶段：按结构性瓶颈最多自动启用 3 座关键越行配线站
  for (let round = 0; round < 3; round += 1) {
    const solved = solveNetworkTimetable({
      graph,
      proOps: working,
      validations,
      kinematicsMap,
      isGeoMode
    });
    const relBns = targetLineId
      ? solved.bottlenecks.filter((b) => sharedChecker.areShared(b.lineId, targetLineId))
      : solved.bottlenecks;
    const passCandidate = relBns.find(
      (b) => b.suggestedPassingStationId && !working.stationProfiles[b.suggestedPassingStationId]?.hasPassingTrack
    );
    if (!passCandidate || !passCandidate.suggestedPassingStationId) break;
    const sid = passCandidate.suggestedPassingStationId;
    working = {
      ...working,
      stationProfiles: {
        ...working.stationProfiles,
        [sid]: {
          ...working.stationProfiles[sid],
          hasPassingTrack: true
        }
      }
    };
    addedPassingStationNames.push(stationMap.get(sid)?.name || passCandidate.suggestedPassingStationName || sid);
  }

  // 第二阶段：对涉及该走廊的非基准交路（快车/跨线/小交路或第2条起交路）自动搜索错峰相位
  const relevantPatterns = working.servicePatterns.filter((p) => {
    if (validations[p.id]?.status !== 'valid') return false;
    if (!targetLineId) return true;
    return p.routeSteps.some(
      (s) => s.kind === 'section' && sharedChecker.areShared(s.lineId, targetLineId)
    );
  });

  relevantPatterns.forEach((pat, idx) => {
    // 保留第 1 条基准普通车作为相位 0 锚点，对其余交路逐一对齐最优错峰秒数
    if (idx === 0 && pat.category === 'local') return;
    const currentSolved = solveNetworkTimetable({
      graph,
      proOps: working,
      validations,
      kinematicsMap,
      isGeoMode
    });
    if (filterRelevantConflicts(currentSolved).length === 0 && currentSolved.overtakes.length === 0) return;

    const rec = recommendOptimalPhaseOffset({
      graph,
      proOps: working,
      validations,
      kinematicsMap,
      targetPatternId: pat.id,
      isGeoMode
    });
    if (rec.bestOffsetSec !== (pat.firstDepartureOffsetSec || 0)) {
      working = {
        ...working,
        servicePatterns: working.servicePatterns.map((item) =>
          item.id === pat.id ? { ...item, firstDepartureOffsetSec: rec.bestOffsetSec } : item
        )
      };
      adjustedPatternSet.add(pat.name);
    }
  });

  const finalRes = solveNetworkTimetable({
    graph,
    proOps: working,
    validations,
    kinematicsMap,
    isGeoMode
  });

  return {
    nextProOps: working,
    addedPassingStationNames,
    adjustedPatternNames: Array.from(adjustedPatternSet),
    remainingConflicts: filterRelevantConflicts(finalRes).length
  };
}

/**
 * 计算任意仿真时刻 simTimeSec 下全网所有在线运行列车的位置快照（用于画布 60fps 动态回放）。
 */
export function computeLiveTrainSnapshots(
  trains: ReadonlyArray<ScheduledTrainRun>,
  simTimeSec: number
): LiveTrainSnapshot[] {
  const active: LiveTrainSnapshot[] = [];

  for (let i = 0; i < trains.length; i += 1) {
    const train = trains[i];
    const visits = train.visits;
    if (visits.length < 2) continue;
    const firstDep = visits[0].departureSec;
    const lastArr = visits[visits.length - 1].arrivalSec;
    if (simTimeSec < firstDep || simTimeSec > lastArr) continue;

    // 1. 检查是否正停靠在某座车站（含越行待避）
    let matchedStationSnap: LiveTrainSnapshot | null = null;
    for (let vIdx = 0; vIdx < visits.length; vIdx += 1) {
      const v = visits[vIdx];
      if (v.isStop && simTimeSec >= v.arrivalSec && simTimeSec <= v.departureSec) {
        const isYielding = v.overtakeHoldSec > 0 && simTimeSec > v.arrivalSec + v.baseDwellSec;
        const nextV = visits[Math.min(visits.length - 1, vIdx + 1)];
        matchedStationSnap = {
          trainId: train.trainId,
          trainCode: train.trainCode,
          patternId: train.patternId,
          color: train.color,
          badgeCode: train.badgeCode,
          direction: train.direction,
          status: isYielding ? 'yielding' : 'dwelling',
          fromStationId: v.stationId,
          toStationId: nextV.stationId,
          progress: 0
        };
        break;
      }
    }
    if (matchedStationSnap) {
      active.push(matchedStationSnap);
      continue;
    }

    // 2. 检查正处于哪一步区间运行中
    for (let sIdx = 0; sIdx < train.routeSteps.length; sIdx += 1) {
      const step = train.routeSteps[sIdx];
      const { fromVisitIdx, toVisitIdx } = train.stepToVisitIndices[sIdx];
      if (fromVisitIdx === toVisitIdx) continue;
      const vFrom = visits[fromVisitIdx];
      const vTo = visits[toVisitIdx];
      const t0 = vFrom.departureSec;
      const t1 = vTo.arrivalSec;
      if (simTimeSec >= t0 && simTimeSec <= t1 && t1 > t0) {
        const rawP = (simTimeSec - t0) / (t1 - t0);
        // 若两端均为停车状态，施加轻微平滑起停过渡；若越站高速通过则保持线性匀速观感
        let p = Math.max(0, Math.min(1, rawP));
        if (vFrom.isStop && vTo.isStop) {
          p = p * p * (3 - 2 * p);
        }
        active.push({
          trainId: train.trainId,
          trainCode: train.trainCode,
          patternId: train.patternId,
          color: train.color,
          badgeCode: train.badgeCode,
          direction: train.direction,
          status: 'running',
          ...(step.kind === 'section' ? { sectionId: step.sectionId } : {}),
          fromStationId: step.fromStationId,
          toStationId: step.toStationId,
          progress: p
        });
        break;
      }
    }
  }

  return active;
}

// ==================== 斜线运行图（Marey Chart）投影与 SVG 导出 ====================

export interface MareyAxisStation {
  index: number;
  stationId: string;
  stationName: string;
  cumulativeKm: number;
  /** 归一化纵向坐标 [0, 1]（兼顾真实里程比例与最小站名可读间距） */
  yRatio: number;
  hasTurnback: boolean;
  hasPassingTrack: boolean;
}

export interface MareyThreadPoint {
  timeSec: number;
  yRatio: number;
  stationId: string;
  isStop: boolean;
  isOvertakeHold?: boolean;
}

export interface MareyTrainThread {
  id: string;
  trainId: string;
  trainCode: string;
  patternId: string;
  color: string;
  direction: 'up' | 'down';
  slicedIn: boolean;
  slicedOut: boolean;
  points: MareyThreadPoint[];
}

export interface MareyMarker {
  id: string;
  kind: 'overtake' | 'conflict';
  timeSec: number;
  yRatio: number;
  stationId: string;
  stationName: string;
  label: string;
  suggestedPassingStationId?: string;
  suggestedPassingStationName?: string;
}

export interface MareyDiagramModel {
  title: string;
  subtitle: string;
  line: Line | null;
  subCorridors: LineSubCorridor[];
  activeSubCorridorId: string;
  isClosedLoop: boolean;
  windowStartSec: number;
  windowEndSec: number;
  stations: MareyAxisStation[];
  threads: MareyTrainThread[];
  markers: MareyMarker[];
  bottlenecks: ProConflictBottleneck[];
}

export function buildMareyDiagramModel(params: {
  graph: MapGraph;
  proOps: ProOpsDocument;
  timetable: TimetableSolveResult;
  isGeoMode: boolean;
  targetLineId?: string | null;
  targetSubCorridorId?: string | null;
  directionFilter: 'both' | 'up' | 'down';
}): MareyDiagramModel {
  const {
    graph,
    proOps,
    timetable,
    isGeoMode,
    targetLineId,
    targetSubCorridorId,
    directionFilter
  } = params;

  const line =
    (targetLineId ? graph.lines.find((l) => l.id === targetLineId) : undefined) ||
    graph.lines[0] ||
    null;

  if (!line) {
    return {
      title: '暂无运行图走廊',
      subtitle: '请先创建线路与运行交路',
      line: null,
      subCorridors: [],
      activeSubCorridorId: '',
      isClosedLoop: false,
      windowStartSec: timetable.windowStartSec,
      windowEndSec: timetable.windowEndSec,
      stations: [],
      threads: [],
      markers: [],
      bottlenecks: []
    };
  }

  const subCorridors = decomposeLineIntoSubCorridors(graph, line.id).filter(
    (sc) => sc.steps.length > 0
  );
  const activeSub =
    (targetSubCorridorId ? subCorridors.find((s) => s.id === targetSubCorridorId) : undefined) ||
    subCorridors[0];

  if (!activeSub || activeSub.stationIds.length < 2) {
    return {
      title: `${line.name} · 斜线运行图`,
      subtitle: '该线路尚无有效连接区间',
      line,
      subCorridors,
      activeSubCorridorId: activeSub?.id || '',
      isClosedLoop: false,
      windowStartSec: timetable.windowStartSec,
      windowEndSec: timetable.windowEndSec,
      stations: [],
      threads: [],
      markers: [],
      bottlenecks: []
    };
  }

  const stationMap = new Map(graph.stations.map((s) => [s.id, s]));
  const sectionMap = new Map(graph.sections.map((s) => [s.id, s]));
  const sharedChecker = createSharedTrackChecker(proOps.sharedTrackLinePairs);

  // 计算纵轴累计里程与混合可读归一化位置（70% 真实比例 + 30% 等距保底，防止极短区间站名重叠）
  const rawMeters: number[] = [0];
  let cumM = 0;
  activeSub.steps.forEach((step) => {
    if (step.kind === 'section') {
      const sec = sectionMap.get(step.sectionId);
      if (sec) {
        cumM += measureSectionDistance(
          sec,
          stationMap,
          proOps.scaleConfig,
          proOps.sectionOverrides,
          isGeoMode
        ).meters;
      }
    }
    rawMeters.push(cumM);
  });

  const totalM = Math.max(1, cumM);
  const count = activeSub.stationIds.length;
  const axisStations: MareyAxisStation[] = activeSub.stationIds.map((sid, idx) => {
    const st = stationMap.get(sid);
    const prof = proOps.stationProfiles[sid];
    const distRatio = rawMeters[idx] / totalM;
    const uniformRatio = count > 1 ? idx / (count - 1) : 0;
    const yRatio = count > 1 ? 0.68 * distRatio + 0.32 * uniformRatio : 0;
    const isClosure = Boolean(activeSub.isClosedLoop && idx === count - 1);
    return {
      index: idx,
      stationId: sid,
      stationName: isClosure ? `${st?.name || sid} ↻` : st?.name || sid,
      cumulativeKm: Math.round((rawMeters[idx] / 1000) * 100) / 100,
      yRatio,
      hasTurnback: Boolean(prof?.hasTurnback),
      hasPassingTrack: Boolean(prof?.hasPassingTrack)
    };
  });

  // 相邻走廊物理区间边索引：pairKey(u, v) -> Array<{ topIdx, bottomIdx, sectionId }>
  const corridorEdges = new Map<string, Array<{ topIdx: number; bottomIdx: number; sectionId?: string }>>();
  const corridorSectionIds = new Set<string>();
  for (let i = 0; i < axisStations.length - 1; i += 1) {
    const subStep = activeSub.steps[i];
    const secId = subStep && subStep.kind === 'section' ? subStep.sectionId : undefined;
    if (secId) corridorSectionIds.add(secId);
    const pk = pairKey(axisStations[i].stationId, axisStations[i + 1].stationId);
    const list = corridorEdges.get(pk) || [];
    list.push({
      topIdx: i,
      bottomIdx: i + 1,
      sectionId: secId
    });
    corridorEdges.set(pk, list);
  }

  const threads: MareyTrainThread[] = [];

  timetable.trains.forEach((train) => {
    if (directionFilter !== 'both' && train.direction !== directionFilter) return;

    // 扫描该车次在当前子走廊上的连续物理轨道运行片段（严格隔离独立双隧并行线！）
    let currentPts: MareyThreadPoint[] = [];
    let currentStartVisit = -1;
    let lastAxisIdx = -1;

    const flushSegment = (endVisitIdx: number) => {
      if (currentPts.length >= 2) {
        threads.push({
          id: `${train.trainId}_seg_${threads.length}`,
          trainId: train.trainId,
          trainCode: train.trainCode,
          patternId: train.patternId,
          color: train.color,
          direction: train.direction,
          slicedIn: currentStartVisit > 0,
          slicedOut: endVisitIdx < train.visits.length - 1,
          points: currentPts
        });
      }
      currentPts = [];
      currentStartVisit = -1;
      lastAxisIdx = -1;
    };

    const appendVisitToThread = (v: TrainVisitSchedule, axisIdx: number, isFirstInSeg: boolean) => {
      const yRatio = axisStations[axisIdx].yRatio;
      if (isFirstInSeg) {
        if (v.visitIndex > 0 && v.isStop && v.departureSec > v.arrivalSec) {
          currentPts.push({ timeSec: v.arrivalSec, yRatio, stationId: v.stationId, isStop: true });
        }
        currentPts.push({
          timeSec: v.departureSec,
          yRatio,
          stationId: v.stationId,
          isStop: v.isStop,
          ...(v.overtakeHoldSec > 0 ? { isOvertakeHold: true } : {})
        });
        return;
      }

      currentPts.push({
        timeSec: v.arrivalSec,
        yRatio,
        stationId: v.stationId,
        isStop: v.isStop
      });
      if (v.visitIndex < train.visits.length - 1 && v.isStop && v.departureSec > v.arrivalSec) {
        currentPts.push({
          timeSec: v.departureSec,
          yRatio,
          stationId: v.stationId,
          isStop: true,
          ...(v.overtakeHoldSec > 0 ? { isOvertakeHold: true } : {})
        });
      }
    };

    for (let sIdx = 0; sIdx < train.routeSteps.length; sIdx += 1) {
      const step = train.routeSteps[sIdx];
      const vMap = train.stepToVisitIndices[sIdx];
      if (!vMap || vMap.fromVisitIdx === vMap.toVisitIdx) continue;
      if (step.kind !== 'section') {
        if (currentPts.length > 0) flushSegment(vMap.fromVisitIdx);
        continue;
      }

      const vA = train.visits[vMap.fromVisitIdx];
      const vB = train.visits[vMap.toVisitIdx];
      const rawEdges = corridorEdges.get(pairKey(vA.stationId, vB.stationId));
      // 关键过滤：只有本线物理区间（含经道岔跨入本线的直通车）或被显式标为「共线共轨」的区间才铺画到本运行图！
      const matchedEdges = (rawEdges || []).filter(
        (ce) =>
          (ce.sectionId && ce.sectionId === step.sectionId) ||
          sharedChecker.areShared(step.lineId, line.id)
      );

      if (matchedEdges.length === 0) {
        if (currentPts.length > 0) flushSegment(vMap.fromVisitIdx);
        continue;
      }

      // 闭合环线首末同站时，优先衔接 lastAxisIdx 相邻的纵轴索引，确保逆向（外环）运行线连续贯通！
      const edge =
        matchedEdges.find((ce) => {
          const candA = axisStations[ce.topIdx].stationId === vA.stationId ? ce.topIdx : ce.bottomIdx;
          return lastAxisIdx >= 0 && candA === lastAxisIdx;
        }) || matchedEdges[0];

      let aIdx: number;
      let bIdx: number;
      if (axisStations[edge.topIdx].stationId === vA.stationId && axisStations[edge.bottomIdx].stationId === vB.stationId) {
        aIdx = edge.topIdx;
        bIdx = edge.bottomIdx;
      } else {
        aIdx = edge.bottomIdx;
        bIdx = edge.topIdx;
      }

      if (currentPts.length === 0) {
        currentStartVisit = vMap.fromVisitIdx;
        appendVisitToThread(vA, aIdx, true);
        appendVisitToThread(vB, bIdx, false);
        lastAxisIdx = bIdx;
      } else if (lastAxisIdx === aIdx) {
        appendVisitToThread(vB, bIdx, false);
        lastAxisIdx = bIdx;
      } else {
        flushSegment(vMap.fromVisitIdx);
        currentStartVisit = vMap.fromVisitIdx;
        appendVisitToThread(vA, aIdx, true);
        appendVisitToThread(vB, bIdx, false);
        lastAxisIdx = bIdx;
      }
    }

    if (currentPts.length > 0) {
      flushSegment(train.visits.length - 1);
    }
  });

  // 投影越行与冲突标记到纵轴车站（同样严格过滤掉独立双隧并行线的事件）
  const stationToAxis = new Map<string, MareyAxisStation>();
  axisStations.forEach((as) => {
    if (!stationToAxis.has(as.stationId)) stationToAxis.set(as.stationId, as);
  });

  const markers: MareyMarker[] = [];

  timetable.overtakes.forEach((ov) => {
    if (!sharedChecker.areShared(ov.lineId, line.id)) return;
    const ax = stationToAxis.get(ov.stationId);
    if (!ax) return;
    markers.push({
      id: `ov_${ov.id}`,
      kind: 'overtake',
      timeSec: ov.timeSec,
      yRatio: ax.yRatio,
      stationId: ov.stationId,
      stationName: ov.stationName,
      label: `${formatClockSec(ov.timeSec)} ${ov.fastTrainCode} 在「${ov.stationName}」越行超越 ${ov.slowTrainCode}（待避 +${ov.holdAddedSec}s）`
    });
  });

  timetable.conflicts.forEach((cf) => {
    if (!corridorSectionIds.has(cf.sectionId) && !sharedChecker.areShared(cf.lineId, line.id)) return;
    const ax = stationToAxis.get(cf.stationId);
    if (!ax) return;
    markers.push({
      id: `cf_${cf.id}`,
      kind: 'conflict',
      timeSec: cf.timeSec,
      yRatio: ax.yRatio,
      stationId: cf.stationId,
      stationName: cf.stationName,
      label: cf.isInSectionOvertake
        ? `${formatClockSec(cf.timeSec)} 区间追越冲突：${cf.trailingTrainCode} 在无越行线区段追上 ${cf.leadingTrainCode}`
        : `${formatClockSec(cf.timeSec)} 追踪间隔不足：${cf.trailingTrainCode} 距 ${cf.leadingTrainCode} 仅 ${cf.actualGapSec}s（要求 ≥${cf.requiredGapSec}s）`,
      ...(cf.suggestedPassingStationId
        ? {
            suggestedPassingStationId: cf.suggestedPassingStationId,
            suggestedPassingStationName: cf.suggestedPassingStationName
          }
        : {})
    });
  });

  const corridorBottlenecks = timetable.bottlenecks.filter(
    (b) => sharedChecker.areShared(b.lineId, line.id) && stationToAxis.has(b.stationId)
  );

  const totalKm = axisStations[axisStations.length - 1]?.cumulativeKm || 0;
  const title = `${line.name}${subCorridors.length > 1 ? ` · ${activeSub.label}` : ''} · 铺画斜线运行图`;
  const subtitle = `${formatClockSec(timetable.windowStartSec)}–${formatClockSec(
    timetable.windowEndSec
  )} · 走廊 ${totalKm} km · 共铺画 ${threads.length} 条运行线`;

  return {
    title,
    subtitle,
    line,
    subCorridors,
    activeSubCorridorId: activeSub.id,
    isClosedLoop: Boolean(activeSub.isClosedLoop || activeSub.kind === 'loop'),
    windowStartSec: timetable.windowStartSec,
    windowEndSec: timetable.windowEndSec,
    stations: axisStations,
    threads,
    markers,
    bottlenecks: corridorBottlenecks
  };
}

const escapeXml = (s: string): string =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * 将斜线运行图（Marey Chart）渲染为出版级独立矢量 SVG（可用于交互展示或直接高清导出 SVG / PNG）。
 */
export function buildMareyDiagramSvg(
  model: MareyDiagramModel,
  options?: {
    theme?: 'light' | 'dark';
    zoomX?: number;
    chartHeight?: number;
    playheadSec?: number | null;
  }
): string {
  const isDark = options?.theme === 'dark';
  const zoomX = Math.max(0.8, Math.min(4, options?.zoomX || 1));
  const bg = isDark ? '#0b1220' : '#ffffff';
  const plotBg = isDark ? '#0f172a' : '#f8fafc';
  const border = isDark ? '#1e293b' : '#cbd5e1';
  const gridMajor = isDark ? 'rgba(148, 163, 184, 0.24)' : 'rgba(15, 23, 42, 0.14)';
  const gridMinor = isDark ? 'rgba(148, 163, 184, 0.10)' : 'rgba(15, 23, 42, 0.06)';
  const textMain = isDark ? '#f8fafc' : '#0f172a';
  const textSub = isDark ? '#94a3b8' : '#64748b';

  const leftLabelW = 148;
  const padRight = 34;
  const padTop = 76;
  const padBottom = 34;

  const durationMin = Math.max(15, (model.windowEndSec - model.windowStartSec) / 60);
  const plotW = Math.round(Math.max(760, durationMin * 16) * zoomX);
  const minStationH = Math.max(220, model.stations.length * 34);
  const plotH = Math.max(minStationH, options?.chartHeight || 300);

  const width = leftLabelW + plotW + padRight;
  const height = padTop + plotH + padBottom;

  const timeToX = (sec: number) =>
    leftLabelW + ((sec - model.windowStartSec) / Math.max(1, model.windowEndSec - model.windowStartSec)) * plotW;
  const ratioToY = (r: number) => padTop + 14 + r * (plotH - 28);

  const parts: string[] = [];
  parts.push(
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif">`,
    `<defs>`,
    `<clipPath id="marey-plot-clip"><rect x="${leftLabelW}" y="${padTop}" width="${plotW}" height="${plotH}"/></clipPath>`,
    `</defs>`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="${bg}" rx="14"/>`,
    `<text x="20" y="32" font-size="16" font-weight="800" fill="${textMain}">${escapeXml(model.title)}</text>`,
    `<text x="20" y="52" font-size="11.5" fill="${textSub}">${escapeXml(model.subtitle)}</text>`
  );

  // 右上角图例
  const legX = width - padRight - 320;
  if (legX > 320) {
    parts.push(
      `<g transform="translate(${legX}, 24)">`,
      `<line x1="0" y1="8" x2="24" y2="8" stroke="#2563eb" stroke-width="2.5"/>`,
      `<text x="30" y="12" font-size="11" fill="${textSub}">上行车次</text>`,
      `<line x1="88" y1="8" x2="112" y2="8" stroke="#2563eb" stroke-width="2" stroke-dasharray="5,3"/>`,
      `<text x="118" y="12" font-size="11" fill="${textSub}">下行车次</text>`,
      `<circle cx="182" cy="8" r="5" fill="#10b981"/>`,
      `<text x="191" y="12" font-size="11" fill="${textSub}">越行待避</text>`,
      `<circle cx="252" cy="8" r="5" fill="#ef4444"/>`,
      `<text x="261" y="12" font-size="11" fill="${textSub}">追踪冲突</text>`,
      `</g>`
    );
  }

  parts.push(
    `<rect x="${leftLabelW}" y="${padTop}" width="${plotW}" height="${plotH}" fill="${plotBg}" stroke="${border}" stroke-width="1"/>`
  );

  // 纵向时间网格线（每 5 分钟细线，每 10/15 分钟主线带刻度）
  const stepMin = zoomX >= 1.8 ? 2 : 5;
  const majorStepMin = zoomX >= 1.8 ? 10 : 15;
  const startMin = Math.ceil(model.windowStartSec / 60);
  const endMin = Math.floor(model.windowEndSec / 60);

  for (let m = startMin; m <= endMin; m += 1) {
    if ((m - startMin) % stepMin !== 0 && m % majorStepMin !== 0) continue;
    const x = timeToX(m * 60);
    const isMajor = m % majorStepMin === 0 || m === startMin;
    parts.push(
      `<line x1="${x.toFixed(1)}" y1="${padTop}" x2="${x.toFixed(1)}" y2="${padTop + plotH}" stroke="${
        isMajor ? gridMajor : gridMinor
      }" stroke-width="${isMajor ? 1.1 : 0.8}"/>`
    );
    if (isMajor) {
      parts.push(
        `<text x="${x.toFixed(1)}" y="${padTop - 7}" text-anchor="middle" font-size="10.5" font-weight="600" fill="${textSub}">${formatClockSec(
          m * 60
        )}</text>`
      );
    }
  }

  // 横向车站标尺线与左侧站名
  model.stations.forEach((st) => {
    const y = ratioToY(st.yRatio);
    parts.push(
      `<line x1="${leftLabelW}" y1="${y.toFixed(1)}" x2="${leftLabelW + plotW}" y2="${y.toFixed(
        1
      )}" stroke="${st.hasPassingTrack ? gridMajor : gridMinor}" stroke-width="${
        st.hasPassingTrack ? 1.2 : 0.9
      }" ${st.hasPassingTrack ? 'stroke-dasharray="4,3"' : ''}/>`,
      `<text x="${leftLabelW - 10}" y="${(y + 4).toFixed(
        1
      )}" text-anchor="end" font-size="11.5" font-weight="700" fill="${textMain}">${escapeXml(
        st.stationName.slice(0, 8)
      )}${st.hasPassingTrack ? ' [越]' : ''}</text>`,
      `<text x="12" y="${(y + 4).toFixed(1)}" font-size="9.5" fill="${textSub}">${st.cumulativeKm.toFixed(
        1
      )}km</text>`
    );
  });

  // 裁剪区内的列车斜线与冲突/越行标记
  parts.push(`<g clip-path="url(#marey-plot-clip)">`);

  model.threads.forEach((th) => {
    if (th.points.length < 2) return;
    const d = th.points
      .map((pt, idx) => `${idx === 0 ? 'M' : 'L'}${timeToX(pt.timeSec).toFixed(1)},${ratioToY(pt.yRatio).toFixed(1)}`)
      .join(' ');
    const isDown = th.direction === 'down';
    parts.push(
      `<path d="${d}" fill="none" stroke="${escapeXml(th.color)}" stroke-width="${
        isDown ? 1.8 : 2.3
      }" stroke-linecap="round" stroke-linejoin="round" ${
        isDown ? 'stroke-dasharray="6,4" opacity="0.72"' : 'opacity="0.95"'
      }><title>${escapeXml(th.trainCode)}</title></path>`
    );

    // 高亮待避水平加粗段
    for (let i = 1; i < th.points.length; i += 1) {
      const prev = th.points[i - 1];
      const curr = th.points[i];
      if (curr.isOvertakeHold && Math.abs(curr.yRatio - prev.yRatio) < 1e-4) {
        parts.push(
          `<line x1="${timeToX(prev.timeSec).toFixed(1)}" y1="${ratioToY(prev.yRatio).toFixed(
            1
          )}" x2="${timeToX(curr.timeSec).toFixed(1)}" y2="${ratioToY(curr.yRatio).toFixed(
            1
          )}" stroke="#10b981" stroke-width="4.2" stroke-linecap="round"/>`
        );
      }
    }
  });

  model.markers.forEach((mk) => {
    const cx = timeToX(mk.timeSec);
    const cy = ratioToY(mk.yRatio);
    if (mk.kind === 'overtake') {
      parts.push(
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="5" fill="#10b981" stroke="${bg}" stroke-width="1.8"><title>${escapeXml(
          mk.label
        )}</title></circle>`
      );
    } else {
      parts.push(
        `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6.5" fill="#ef4444" stroke="#ffffff" stroke-width="2"><title>${escapeXml(
          mk.label
        )}</title></circle>`
      );
    }
  });

  if (
    typeof options?.playheadSec === 'number' &&
    options.playheadSec >= model.windowStartSec &&
    options.playheadSec <= model.windowEndSec
  ) {
    const px = timeToX(options.playheadSec);
    parts.push(
      `<line x1="${px.toFixed(1)}" y1="${padTop}" x2="${px.toFixed(1)}" y2="${
        padTop + plotH
      }" stroke="#f59e0b" stroke-width="2" stroke-dasharray="4,2"/>`
    );
  }

  parts.push(`</g>`);
  parts.push(
    `<text x="${width - padRight}" y="${height - 10}" text-anchor="end" font-size="10" fill="${textSub}">Generated by Metro Designer · Marey Train Diagram</text>`,
    `</svg>`
  );

  return parts.join('\n');
}
