// 轻城市（Light City）参数化架空地貌生成器与跨端矢量渲染引擎
// 设计原则：参考 Mini Metro 的「纸感浅灰」克制制图美学，仅保留城区/绿地、水系/洲岛、骨干干道、片区水印四层要素，
// 生成结果即为标准可编辑矢量实体列表，同时原生支持 Konva 实时画布、SVG 印刷级矢量导出与 MP4 动态视频导出。

import {
  LightCityArchetype,
  LightCityFeature,
  LightCityPoint,
  LightCityRoadKind,
  LightCitySettings,
  Station
} from '../types';
import { LONDON_LIGHT_CITY_DATA, PackedRealCityLightCityData } from './londonLightCityData';
import { TOKYO_LIGHT_CITY_DATA } from './tokyoLightCityData';
import { PARIS_LIGHT_CITY_DATA } from './parisLightCityData';
import { NEWYORK_LIGHT_CITY_DATA } from './newyorkLightCityData';
import { SHANGHAI_LIGHT_CITY_DATA } from './shanghaiLightCityData';

const REAL_CITY_PACKS: Partial<Record<LightCityArchetype, PackedRealCityLightCityData>> = {
  london: LONDON_LIGHT_CITY_DATA,
  tokyo: TOKYO_LIGHT_CITY_DATA,
  paris: PARIS_LIGHT_CITY_DATA,
  newyork: NEWYORK_LIGHT_CITY_DATA,
  shanghai: SHANGHAI_LIGHT_CITY_DATA
};

export interface LightCityPalette {
  canvasBg: string;
  gridDot: string;
  urbanFill: string;
  urbanStroke: string;
  parkFill: string;
  parkStroke: string;
  waterFill: string;
  waterBank: string;
  islandFill: string;
  islandStroke: string;
  roadExpressOuter: string;
  roadExpressInner: string;
  roadArterialOuter: string;
  roadArterialInner: string;
  roadStreetOuter: string;
  roadStreetInner: string;
  labelDistrict: string;
  labelSubdistrict: string;
  labelWater: string;
}

export function getLightCityPalette(isDark = false): LightCityPalette {
  if (isDark) {
    return {
      canvasBg: '#0b1220',
      gridDot: 'rgba(148, 163, 184, 0.08)',
      urbanFill: '#131e32',
      urbanStroke: '#1c2b45',
      parkFill: '#102420',
      parkStroke: '#183630',
      waterFill: '#0e2c48',
      waterBank: '#174066',
      islandFill: '#0b1220',
      islandStroke: '#174066',
      roadExpressOuter: '#1c2b44',
      roadExpressInner: '#263a5c',
      roadArterialOuter: '#162339',
      roadArterialInner: '#1f314e',
      roadStreetOuter: '#132034',
      roadStreetInner: '#192841',
      labelDistrict: 'rgba(148, 163, 184, 0.44)',
      labelSubdistrict: 'rgba(148, 163, 184, 0.34)',
      labelWater: 'rgba(125, 211, 252, 0.48)'
    };
  }
  return {
    canvasBg: '#f6f7f9',
    gridDot: 'rgba(100, 116, 139, 0.11)',
    urbanFill: '#ebeff4',
    urbanStroke: '#e1e6ef',
    parkFill: '#dcece1',
    parkStroke: '#cce0d4',
    waterFill: '#c4dff3',
    waterBank: '#b0d0ea',
    islandFill: '#f6f7f9',
    islandStroke: '#b0d0ea',
    roadExpressOuter: '#c5d1e1',
    roadExpressInner: '#ffffff',
    roadArterialOuter: '#cfd9e7',
    roadArterialInner: '#ffffff',
    roadStreetOuter: '#dae2ee',
    roadStreetInner: '#fcfdff',
    labelDistrict: 'rgba(100, 116, 139, 0.56)',
    labelSubdistrict: 'rgba(100, 116, 139, 0.45)',
    labelWater: 'rgba(56, 128, 182, 0.62)'
  };
}

/**
 * 实景精细轻地图（伦敦/东京/巴黎/纽约/上海）采用无底框纸面融合 + 外圈 360° 径向羽化渐隐，不绘制人工大椭圆底色块
 */
export function shouldFeatherLightCityEdges(lightCity: Pick<LightCitySettings, 'archetype'> | undefined): boolean {
  return Boolean(lightCity && REAL_CITY_PACKS[lightCity.archetype]);
}

export function resolveLightCityPolygonIterations(points: LightCityPoint[]): number {
  return points.length >= 8 ? 1 : 3;
}

export function resolveLightCitySplineSegments(points: LightCityPoint[]): number {
  return points.length >= 16 ? 4 : 10;
}

export function resolveLightCityRoadMetrics(
  kind: LightCityRoadKind,
  pointCount: number,
  pal: LightCityPalette
): {
  outerW: number;
  innerW: number;
  cornerRadius: number;
  outerColor: string;
  innerColor: string;
} {
  if (kind === 'express') {
    return {
      outerW: pointCount > 8 ? 9.2 : 11,
      innerW: pointCount > 8 ? 5.6 : 7,
      cornerRadius: pointCount > 8 ? 18 : 36,
      outerColor: pal.roadExpressOuter,
      innerColor: pal.roadExpressInner
    };
  }
  if (kind === 'street') {
    return {
      outerW: 3.2,
      innerW: 1.85,
      cornerRadius: 7,
      outerColor: pal.roadStreetOuter,
      innerColor: pal.roadStreetInner
    };
  }
  return {
    outerW: pointCount > 8 ? 5.8 : 7,
    innerW: pointCount > 8 ? 3.5 : 4.2,
    cornerRadius: pointCount > 8 ? 12 : 34,
    outerColor: pal.roadArterialOuter,
    innerColor: pal.roadArterialInner
  };
}

export interface LightCityArchetypeMeta {
  id: LightCityArchetype;
  zh: string;
  en: string;
  hintZh: string;
  hintEn: string;
}

export const LIGHT_CITY_ARCHETYPES: LightCityArchetypeMeta[] = [
  {
    id: 'london',
    zh: '伦敦实景（精细街网）',
    en: 'London (Detailed Grid)',
    hintZh: '真实泰晤士河曲流 + 金丝雀船坞 + 皇家公园群 + 三级实景街网',
    hintEn: 'Real River Thames, Canary Wharf docks, Royal Parks & 3-tier street grid'
  },
  {
    id: 'tokyo',
    zh: '东京实景（精细街网）',
    en: 'Tokyo (Detailed Grid)',
    hintZh: '真实东京湾与台场丰洲群岛 + 皇居护城河与隅田川 + 首都高山手三级街网',
    hintEn: 'Tokyo Bay, Odaiba & Toyosu islands, Imperial moat, Sumida & 3-tier grid'
  },
  {
    id: 'paris',
    zh: '巴黎实景（精细街网）',
    en: 'Paris (Detailed Grid)',
    hintZh: '真实塞纳河大曲流与西岱岛 + 布洛涅/文森森林 + 奥斯曼星形放射街网',
    hintEn: 'La Seine loop, Île de la Cité, twin royal woods & Haussmannian boulevards'
  },
  {
    id: 'newyork',
    zh: '纽约实景（精细街网）',
    en: 'New York (Detailed Grid)',
    hintZh: '真实哈德逊与东河港湾 + 曼哈顿中央公园 + 大道街格与跨河桥隧',
    hintEn: 'Hudson & East Rivers, Manhattan grid, Central Park & harbor islands'
  },
  {
    id: 'shanghai',
    zh: '上海实景（精细街网）',
    en: 'Shanghai (Detailed Grid)',
    hintZh: '真实黄浦江陆家嘴大弯 + 苏州河百转汇流 + 内环高架与浦江两岸街网',
    hintEn: 'Huangpu Lujiazui bend, Suzhou Creek, Fuxing Island & Puxi-Pudong grid'
  },
  {
    id: 'river',
    zh: '穿城大江',
    en: 'Grand River',
    hintZh: '蜿蜒主江 + 江心洲 + 两岸城区与跨江干道',
    hintEn: 'Meandering river, mid-stream island & twin banks'
  },
  {
    id: 'confluence',
    zh: '两江交汇',
    en: 'Twin Confluence',
    hintZh: 'Y 字双水系汇流，天然三镇半岛格局',
    hintEn: 'Y-shaped river confluence forming three boroughs'
  },
  {
    id: 'bay',
    zh: '海湾半岛',
    en: 'Harbor & Bay',
    hintZh: '曲折海岸线 + 主城半岛 + 对岸新城与空港岛',
    hintEn: 'Peninsula core, across-strait city & offshore island'
  },
  {
    id: 'ring',
    zh: '平原环城',
    en: 'Ring Metropolis',
    hintZh: '中轴对称 + 多重环路放射干道 + 护城水系',
    hintEn: 'Concentric ring expressways & radial boulevards'
  },
  {
    id: 'delta',
    zh: '水网三角洲',
    en: 'River Delta',
    hintZh: '多支流分叉入海与冲积沙洲 + 多组团中心',
    hintEn: 'Braided estuary channels & alluvial islands'
  },
  {
    id: 'lake',
    zh: '依山环湖',
    en: 'Lakeside Greenbelt',
    hintZh: '中心大湖 + 湖心岛 + 生态山体绿廊与环湖城',
    hintEn: 'Central lake, scenic hills & crescent urban belt'
  },
  {
    id: 'custom',
    zh: '空白造景',
    en: 'Blank Sculpt',
    hintZh: '清空预设，完全用地形画笔手绘专属城市',
    hintEn: 'Start clean and hand-craft rivers, parks & roads'
  }
];

function mulberry32(seed: number): () => number {
  let a = (seed >>> 0) || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function rotatePt(pt: LightCityPoint, cx: number, cy: number, rad: number): LightCityPoint {
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = pt.x - cx;
  const dy = pt.y - cy;
  return {
    x: r1(cx + dx * cos - dy * sin),
    y: r1(cy + dx * sin + dy * cos)
  };
}

function makeOrganicBlob(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotRad: number,
  rand: () => number,
  vertexCount = 10,
  wobble = 0.16
): LightCityPoint[] {
  const pts: LightCityPoint[] = [];
  const phase1 = rand() * Math.PI * 2;
  const phase2 = rand() * Math.PI * 2;
  for (let i = 0; i < vertexCount; i += 1) {
    const theta = (i / vertexCount) * Math.PI * 2;
    const mod =
      1 +
      wobble * Math.sin(theta * 2 + phase1) +
      wobble * 0.55 * Math.cos(theta * 3 + phase2) +
      (rand() - 0.5) * wobble * 0.6;
    const local = {
      x: cx + Math.cos(theta) * rx * mod,
      y: cy + Math.sin(theta) * ry * mod
    };
    pts.push(rotatePt(local, cx, cy, rotRad));
  }
  return pts;
}

/**
 * 将控制点采样为平滑开放 Catmull-Rom 样条曲线（返回扁平坐标数组 [x0, y0, x1, y1, ...]）
 */
export function sampleSmoothOpenSpline(points: LightCityPoint[], segmentsPerSpan = 10): number[] {
  if (points.length === 0) return [];
  if (points.length === 1) return [points[0].x, points[0].y];
  if (points.length === 2) return [points[0].x, points[0].y, points[1].x, points[1].y];

  const out: number[] = [points[0].x, points[0].y];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    for (let s = 1; s <= segmentsPerSpan; s += 1) {
      const t = s / segmentsPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y =
        0.5 *
        (2 * p1.y +
          (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push(r1(x), r1(y));
    }
  }
  return out;
}

/**
 * 将闭合多边形控制点做 Chaikin 圆角平滑迭代，得到自然圆润的有机区域/水体轮廓
 */
export function sampleSmoothClosedPolygon(points: LightCityPoint[], iterations = 3): number[] {
  if (points.length < 3) {
    return points.flatMap((p) => [p.x, p.y]);
  }
  let curr = points.slice();
  for (let iter = 0; iter < iterations; iter += 1) {
    const next: LightCityPoint[] = [];
    const n = curr.length;
    for (let i = 0; i < n; i += 1) {
      const a = curr[i];
      const b = curr[(i + 1) % n];
      next.push({
        x: r1(0.75 * a.x + 0.25 * b.x),
        y: r1(0.75 * a.y + 0.25 * b.y)
      });
      next.push({
        x: r1(0.25 * a.x + 0.75 * b.x),
        y: r1(0.25 * a.y + 0.75 * b.y)
      });
    }
    curr = next;
  }
  return curr.flatMap((p) => [p.x, p.y]);
}

/**
 * 将主干道折线拐角做圆角导角采样（支持开放干道与闭合环路）
 */
export function sampleRoundedRoadPolyline(
  points: LightCityPoint[],
  closed = false,
  cornerRadius = 36
): number[] {
  if (points.length < 2) return points.flatMap((p) => [p.x, p.y]);
  if (points.length === 2 && !closed) {
    return [points[0].x, points[0].y, points[1].x, points[1].y];
  }

  const out: number[] = [];
  const n = points.length;
  const count = closed ? n : n;

  for (let i = 0; i < count; i += 1) {
    if (!closed && (i === 0 || i === n - 1)) {
      out.push(points[i].x, points[i].y);
      continue;
    }
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    const v1x = prev.x - curr.x;
    const v1y = prev.y - curr.y;
    const v2x = next.x - curr.x;
    const v2y = next.y - curr.y;
    const len1 = Math.hypot(v1x, v1y);
    const len2 = Math.hypot(v2x, v2y);
    if (len1 < 2 || len2 < 2) {
      out.push(curr.x, curr.y);
      continue;
    }
    const cut = Math.min(cornerRadius, len1 * 0.42, len2 * 0.42);
    const startX = curr.x + (v1x / len1) * cut;
    const startY = curr.y + (v1y / len1) * cut;
    const endX = curr.x + (v2x / len2) * cut;
    const endY = curr.y + (v2y / len2) * cut;
    const steps = 5;
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const mt = 1 - t;
      const qx = mt * mt * startX + 2 * mt * t * curr.x + t * t * endX;
      const qy = mt * mt * startY + 2 * mt * t * curr.y + t * t * endY;
      out.push(r1(qx), r1(qy));
    }
  }
  return out;
}

const CORE_NAMES_ZH = ['老城中心', '中枢区', '鼓楼区', '人民广场', '万象城芯', '内城区'];
const NEW_TOWN_NAMES_ZH = ['滨江新区', '科学城', '金融湾', '空港新城', '东湖高新', '海湾新区', '南岸新城', '北辰新区'];
const SUB_NAMES_ZH = ['大学城', '高铁商务区', '西苑片区', '望江坊', '云谷科技园', '国际会展湾', '青林片区'];
const PARK_NAMES_ZH = ['中央绿洲', '翠微山公园', '滨水森林公园', '白鹭洲湿地', '西山植物园'];
const RIVER_NAMES_ZH = ['清澜江', '云川河', '沧澜江', '玉带河', '澄江', '星澜河'];
const BAY_NAMES_ZH = ['东澜湾', '镜湖', '星海湾', '云梦泽', '晴川湾'];

function pickFrom<T>(arr: T[], rand: () => number, used?: Set<T>): T {
  for (let tries = 0; tries < 8; tries += 1) {
    const item = arr[Math.floor(rand() * arr.length) % arr.length];
    if (!used || !used.has(item)) {
      used?.add(item);
      return item;
    }
  }
  return arr[Math.floor(rand() * arr.length) % arr.length];
}

export function inferNetworkViewportFrame(stations: Station[]): { cx: number; cy: number; span: number } {
  if (stations.length >= 2) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    stations.forEach((s) => {
      minX = Math.min(minX, s.x);
      minY = Math.min(minY, s.y);
      maxX = Math.max(maxX, s.x);
      maxY = Math.max(maxY, s.y);
    });
    const w = maxX - minX;
    const h = maxY - minY;
    return {
      cx: r1((minX + maxX) / 2),
      cy: r1((minY + maxY) / 2),
      span: Math.max(1200, Math.min(4200, Math.max(w, h) * 1.45))
    };
  }
  if (stations.length === 1) {
    return { cx: r1(stations[0].x), cy: r1(stations[0].y), span: 1600 };
  }
  return { cx: 760, cy: 470, span: 1600 };
}

/**
 * 基于原型与随机种子生成完整架空轻城市要素列表
 */
export function generateLightCity(params: {
  archetype: LightCityArchetype;
  seed?: number;
  stations?: Station[];
  language?: 'zh-CN' | 'en-US';
}): LightCitySettings {
  const seed = params.seed ?? Math.floor(100000 + Math.random() * 899999);
  const rand = mulberry32(seed);
  const { cx, cy, span } = inferNetworkViewportFrame(params.stations || []);
  const s = span / 1600;
  const isEn = params.language === 'en-US';
  const usedNames = new Set<string>();
  const features: LightCityFeature[] = [];
  let seq = 1;
  const nextId = (prefix: string) => `${prefix}_${seed % 10000}_${seq++}`;

  const baseAngle = (rand() - 0.5) * 0.72; // 适度旋转，让每次换城走向自然不同
  const tr = (dx: number, dy: number): LightCityPoint =>
    rotatePt({ x: cx + dx * s, y: cy + dy * s }, cx, cy, baseAngle);

  if (params.archetype === 'custom') {
    return {
      theme: 'paper-grey',
      archetype: 'custom',
      seed,
      opacity: 1,
      layerVisibility: { zones: true, water: true, roads: true, labels: true },
      features: []
    };
  }

  const realPack = REAL_CITY_PACKS[params.archetype];
  if (realPack) {
    const unpackPts = (flat: number[]): LightCityPoint[] => {
      const pts: LightCityPoint[] = [];
      for (let i = 0; i < flat.length - 1; i += 2) {
        pts.push({ x: r1(cx + flat[i] * s), y: r1(cy + flat[i + 1] * s) });
      }
      return pts;
    };

    realPack.urbanZones.forEach((flat) => {
      const points = unpackPts(flat);
      if (points.length >= 3) {
        features.push({ id: nextId('zone'), type: 'zone', kind: 'urban', points });
      }
    });
    realPack.parks.forEach((flat) => {
      const points = unpackPts(flat);
      if (points.length >= 3) {
        features.push({ id: nextId('park'), type: 'zone', kind: 'park', points });
      }
    });
    realPack.waters.forEach((flat) => {
      const points = unpackPts(flat);
      if (points.length >= 3) {
        features.push({ id: nextId('water'), type: 'waterArea', points });
      }
    });
    (realPack.islands || []).forEach((flat) => {
      const points = unpackPts(flat);
      if (points.length >= 3) {
        features.push({ id: nextId('island'), type: 'zone', kind: 'island', points });
      }
    });
    realPack.rivers.forEach((rv) => {
      const points = unpackPts(rv.p);
      if (points.length >= 2) {
        features.push({
          id: nextId('river'),
          type: 'river',
          width: r1(Math.max(3.5, rv.w * s)),
          points
        });
      }
    });
    // 按 街巷 -> 主干道 -> 快速路 顺序叠置，使高等级干道在双遍交叉融合中自然处于顶层
    realPack.streets.forEach((flat) => {
      const points = unpackPts(flat);
      if (points.length >= 2) {
        features.push({ id: nextId('st'), type: 'road', kind: 'street', points });
      }
    });
    realPack.arterial.forEach((flat) => {
      const points = unpackPts(flat);
      if (points.length >= 2) {
        features.push({ id: nextId('art'), type: 'road', kind: 'arterial', points });
      }
    });
    realPack.express.forEach((flat) => {
      const points = unpackPts(flat);
      if (points.length >= 2) {
        features.push({ id: nextId('exp'), type: 'road', kind: 'express', points });
      }
    });
    realPack.labels.forEach((lbl) => {
      features.push({
        id: nextId('lbl'),
        type: 'label',
        kind: lbl.kind,
        x: r1(cx + lbl.x * s),
        y: r1(cy + lbl.y * s),
        text: isEn ? lbl.en : lbl.zh
      });
    });

    return {
      theme: 'paper-grey',
      archetype: params.archetype,
      seed,
      opacity: 1,
      layerVisibility: {
        zones: true,
        water: true,
        roads: true,
        labels: true
      },
      features
    };
  }

  if (params.archetype === 'river') {
    // 1. 两岸建成区与滨江绿地
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'urban',
      points: makeOrganicBlob(cx - 40 * s, cy - 210 * s, 460 * s, 230 * s, baseAngle, rand, 12, 0.14)
    });
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'urban',
      points: makeOrganicBlob(cx + 60 * s, cy + 215 * s, 430 * s, 210 * s, baseAngle, rand, 12, 0.15)
    });
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'park',
      points: makeOrganicBlob(cx - 340 * s, cy - 110 * s, 145 * s, 95 * s, baseAngle + 0.3, rand, 9, 0.16)
    });
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'park',
      points: makeOrganicBlob(cx + 350 * s, cy + 125 * s, 155 * s, 100 * s, baseAngle - 0.2, rand, 9, 0.16)
    });

    // 2. 蜿蜒主江 + 支流 + 江心洲
    const bendAmp = (110 + rand() * 75) * (rand() > 0.5 ? 1 : -1);
    const riverPts = [
      tr(-1050, -90 + (rand() - 0.5) * 140),
      tr(-540, -bendAmp),
      tr(-90, bendAmp * 0.45),
      tr(360, -bendAmp * 0.65),
      tr(1050, 75 + (rand() - 0.5) * 140)
    ];
    features.push({
      id: nextId('river'),
      type: 'river',
      width: Math.round((86 + rand() * 24) * s),
      points: riverPts
    });
    features.push({
      id: nextId('river'),
      type: 'river',
      width: Math.round(32 * s),
      points: [tr(-240, -680), tr(-170, -320), riverPts[2]]
    });
    // 江心洲（叠在主江宽段上）
    const midRiver = riverPts[2];
    features.push({
      id: nextId('island'),
      type: 'zone',
      kind: 'island',
      points: makeOrganicBlob(midRiver.x + 85 * s, midRiver.y - 12 * s, 86 * s, 24 * s, baseAngle - 0.15, rand, 8, 0.1)
    });

    // 3. 环城与跨江干道骨架
    const ringPts = makeOrganicBlob(cx + 10 * s, cy + 5 * s, 360 * s, 290 * s, baseAngle, rand, 8, 0.06);
    features.push({ id: nextId('road'), type: 'road', kind: 'express', closed: true, points: ringPts });
    features.push({
      id: nextId('road'),
      type: 'road',
      kind: 'express',
      points: [tr(-720, -290), tr(-210, -180), tr(190, -165), tr(720, -240)]
    });
    features.push({
      id: nextId('road'),
      type: 'road',
      kind: 'arterial',
      points: [tr(-180, -560), tr(-120, -180), tr(-60, 190), tr(-20, 560)]
    });
    features.push({
      id: nextId('road'),
      type: 'road',
      kind: 'arterial',
      points: [tr(210, -520), tr(185, -140), tr(215, 220), tr(290, 560)]
    });
    features.push({
      id: nextId('road'),
      type: 'road',
      kind: 'arterial',
      points: [tr(-680, 240), tr(-140, 210), tr(260, 225), tr(700, 310)]
    });

    // 4. 克制水印地名
    const pNorth = tr(-30, -230);
    const pSouth = tr(80, 245);
    const pWest = tr(-370, -120);
    const pEast = tr(420, -195);
    const pRiver = tr(-430, -bendAmp * 0.72);
    features.push({
      id: nextId('lbl'),
      type: 'label',
      kind: 'district',
      x: pNorth.x,
      y: pNorth.y,
      text: isEn ? 'OLD TOWN' : pickFrom(CORE_NAMES_ZH, rand, usedNames)
    });
    features.push({
      id: nextId('lbl'),
      type: 'label',
      kind: 'district',
      x: pSouth.x,
      y: pSouth.y,
      text: isEn ? 'SOUTH BANK' : pickFrom(NEW_TOWN_NAMES_ZH, rand, usedNames)
    });
    features.push({
      id: nextId('lbl'),
      type: 'label',
      kind: 'subdistrict',
      x: pWest.x,
      y: pWest.y,
      text: isEn ? 'GREEN PARK' : pickFrom(PARK_NAMES_ZH, rand, usedNames)
    });
    features.push({
      id: nextId('lbl'),
      type: 'label',
      kind: 'subdistrict',
      x: pEast.x,
      y: pEast.y,
      text: isEn ? 'TECH HUB' : pickFrom(SUB_NAMES_ZH, rand, usedNames)
    });
    features.push({
      id: nextId('lbl'),
      type: 'label',
      kind: 'water',
      x: pRiver.x,
      y: pRiver.y,
      text: isEn ? 'GRAND RIVER' : pickFrom(RIVER_NAMES_ZH, rand, usedNames)
    });
  } else if (params.archetype === 'confluence') {
    // 两江交汇（三镇格局）
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'urban',
      points: makeOrganicBlob(cx - 250 * s, cy - 170 * s, 300 * s, 210 * s, baseAngle, rand, 10, 0.14)
    });
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'urban',
      points: makeOrganicBlob(cx - 230 * s, cy + 210 * s, 280 * s, 195 * s, baseAngle, rand, 10, 0.14)
    });
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'urban',
      points: makeOrganicBlob(cx + 270 * s, cy + 15 * s, 330 * s, 280 * s, baseAngle, rand, 11, 0.14)
    });
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'park',
      points: makeOrganicBlob(cx + 430 * s, cy - 190 * s, 165 * s, 115 * s, baseAngle, rand, 9, 0.18)
    });

    const meet = tr(30, 10);
    features.push({
      id: nextId('river'),
      type: 'river',
      width: Math.round(92 * s),
      points: [tr(-920, 480), tr(-380, 210), meet, tr(460, -140), tr(980, -340)]
    });
    features.push({
      id: nextId('river'),
      type: 'river',
      width: Math.round(56 * s),
      points: [tr(-920, -410), tr(-410, -165), meet]
    });

    const ringPts = makeOrganicBlob(cx + 10 * s, cy + 10 * s, 370 * s, 300 * s, baseAngle, rand, 8, 0.05);
    features.push({ id: nextId('road'), type: 'road', kind: 'express', closed: true, points: ringPts });
    features.push({
      id: nextId('road'),
      type: 'road',
      kind: 'arterial',
      points: [tr(-620, -15), tr(-150, 0), tr(280, 25), tr(690, 65)]
    });
    features.push({
      id: nextId('road'),
      type: 'road',
      kind: 'arterial',
      points: [tr(-240, -520), tr(-210, -160), tr(-195, 220), tr(-180, 540)]
    });

    const b1 = tr(-280, -175);
    const b2 = tr(-255, 235);
    const b3 = tr(285, 45);
    const w1 = tr(390, -115);
    features.push({ id: nextId('lbl'), type: 'label', kind: 'district', x: b1.x, y: b1.y, text: isEn ? 'NORTH BOROUGH' : '江北主城' });
    features.push({ id: nextId('lbl'), type: 'label', kind: 'district', x: b2.x, y: b2.y, text: isEn ? 'WEST PENINSULA' : '西岸新镇' });
    features.push({ id: nextId('lbl'), type: 'label', kind: 'district', x: b3.x, y: b3.y, text: isEn ? 'EAST METROPOLIS' : '东岸核心区' });
    features.push({ id: nextId('lbl'), type: 'label', kind: 'water', x: w1.x, y: w1.y, text: isEn ? 'CONFLUENCE' : pickFrom(RIVER_NAMES_ZH, rand, usedNames) });
  } else if (params.archetype === 'bay') {
    // 海湾半岛 + 对岸 + 离岛
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'urban',
      points: makeOrganicBlob(cx - 210 * s, cy - 30 * s, 390 * s, 320 * s, baseAngle, rand, 12, 0.14)
    });
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'park',
      points: makeOrganicBlob(cx - 460 * s, cy - 220 * s, 170 * s, 130 * s, baseAngle, rand, 9, 0.18)
    });

    // 东侧大海湾面
    const bayPoly: LightCityPoint[] = [
      tr(190, -850),
      tr(130, -460),
      tr(40, -180),
      tr(165, 40),
      tr(-20, 260),
      tr(150, 520),
      tr(240, 850),
      tr(1180, 850),
      tr(1180, -850)
    ];
    features.push({ id: nextId('water'), type: 'waterArea', points: bayPoly });
    // 入海河流
    features.push({
      id: nextId('river'),
      type: 'river',
      width: Math.round(48 * s),
      points: [tr(-920, 95), tr(-430, 55), tr(90, 20)]
    });
    // 海湾空港离岛 + 对岸半岛陆地
    features.push({
      id: nextId('island'),
      type: 'zone',
      kind: 'island',
      points: makeOrganicBlob(tr(460, -80).x, tr(460, -80).y, 175 * s, 110 * s, baseAngle + 0.25, rand, 10, 0.13)
    });
    features.push({
      id: nextId('island'),
      type: 'zone',
      kind: 'island',
      points: makeOrganicBlob(tr(520, 270).x, tr(520, 270).y, 130 * s, 72 * s, baseAngle - 0.1, rand, 8, 0.08)
    });

    features.push({
      id: nextId('road'),
      type: 'road',
      kind: 'express',
      points: [tr(-240, -560), tr(-90, -240), tr(-40, 30), tr(-110, 310), tr(-180, 560)]
    });
    features.push({
      id: nextId('road'),
      type: 'road',
      kind: 'express',
      points: [tr(-640, -60), tr(-210, -45), tr(90, -55), tr(455, -80)]
    });
    features.push({
      id: nextId('road'),
      type: 'road',
      kind: 'arterial',
      points: [tr(455, -80), tr(495, 110), tr(520, 270)]
    });

    const pMain = tr(-240, -85);
    const pIsl1 = tr(460, -80);
    const pIsl2 = tr(520, 270);
    const pBay = tr(285, 135);
    features.push({ id: nextId('lbl'), type: 'label', kind: 'district', x: pMain.x, y: pMain.y, text: isEn ? 'HARBOR CORE' : '海湾主城' });
    features.push({ id: nextId('lbl'), type: 'label', kind: 'district', x: pIsl1.x, y: pIsl1.y, text: isEn ? 'EAST ISLAND' : '东屿新城' });
    features.push({ id: nextId('lbl'), type: 'label', kind: 'subdistrict', x: pIsl2.x, y: pIsl2.y, text: isEn ? 'AIRPORT ISL.' : '空港人工岛' });
    features.push({ id: nextId('lbl'), type: 'label', kind: 'water', x: pBay.x, y: pBay.y, text: isEn ? 'AZURE BAY' : pickFrom(BAY_NAMES_ZH, rand, usedNames) });
  } else if (params.archetype === 'ring') {
    // 平原环城（多重环线 + 中轴放射）
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'urban',
      points: makeOrganicBlob(cx, cy, 480 * s, 410 * s, 0, rand, 14, 0.08)
    });
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'park',
      points: makeOrganicBlob(cx, cy - 55 * s, 110 * s, 85 * s, 0, rand, 8, 0.09)
    });
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'park',
      points: makeOrganicBlob(cx - 330 * s, cy - 290 * s, 150 * s, 105 * s, 0.2, rand, 9, 0.14)
    });

    features.push({
      id: nextId('river'),
      type: 'river',
      width: Math.round(34 * s),
      points: [
        { x: r1(cx - 940 * s), y: r1(cy - 310 * s) },
        { x: r1(cx - 340 * s), y: r1(cy - 190 * s) },
        { x: r1(cx + 180 * s), y: r1(cy + 210 * s) },
        { x: r1(cx + 940 * s), y: r1(cy + 340 * s) }
      ]
    });

    // 二环、三环、四环
    [
      { rx: 165 * s, ry: 145 * s, kind: 'arterial' as const },
      { rx: 315 * s, ry: 270 * s, kind: 'express' as const },
      { rx: 495 * s, ry: 415 * s, kind: 'express' as const }
    ].forEach(({ rx, ry, kind }) => {
      const pts: LightCityPoint[] = [];
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        pts.push({ x: r1(cx + Math.cos(a) * rx), y: r1(cy + Math.sin(a) * ry) });
      }
      features.push({ id: nextId('road'), type: 'road', kind, closed: true, points: pts });
    });

    // 中轴十字与对角放射干道
    features.push({
      id: nextId('road'),
      type: 'road',
      kind: 'express',
      points: [
        { x: cx, y: r1(cy - 620 * s) },
        { x: cx, y: r1(cy + 620 * s) }
      ]
    });
    features.push({
      id: nextId('road'),
      type: 'road',
      kind: 'express',
      points: [
        { x: r1(cx - 760 * s), y: cy },
        { x: r1(cx + 760 * s), y: cy }
      ]
    });

    features.push({ id: nextId('lbl'), type: 'label', kind: 'district', x: cx, y: r1(cy + 35 * s), text: isEn ? 'CENTRAL CORE' : '内城核心' });
    features.push({ id: nextId('lbl'), type: 'label', kind: 'subdistrict', x: r1(cx + 365 * s), y: r1(cy - 210 * s), text: isEn ? 'EAST SUBCENTER' : '东部副中心' });
    features.push({ id: nextId('lbl'), type: 'label', kind: 'subdistrict', x: r1(cx - 360 * s), y: r1(cy + 225 * s), text: isEn ? 'WEST HUB' : '西站枢纽区' });
  } else if (params.archetype === 'delta') {
    // 水网三角洲
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'urban',
      points: makeOrganicBlob(cx - 240 * s, cy - 40 * s, 340 * s, 290 * s, baseAngle, rand, 11, 0.15)
    });
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'urban',
      points: makeOrganicBlob(cx + 230 * s, cy - 170 * s, 260 * s, 175 * s, baseAngle, rand, 10, 0.15)
    });
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'park',
      points: makeOrganicBlob(cx + 120 * s, cy + 280 * s, 190 * s, 115 * s, baseAngle, rand, 9, 0.16)
    });

    const fork1 = tr(-260, -30);
    const fork2 = tr(80, 45);
    features.push({
      id: nextId('river'),
      type: 'river',
      width: Math.round(82 * s),
      points: [tr(-960, -140), tr(-560, -85), fork1, fork2, tr(520, 140), tr(980, 260)]
    });
    features.push({
      id: nextId('river'),
      type: 'river',
      width: Math.round(52 * s),
      points: [fork1, tr(70, -165), tr(510, -240), tr(980, -310)]
    });
    features.push({
      id: nextId('river'),
      type: 'river',
      width: Math.round(44 * s),
      points: [fork2, tr(290, 260), tr(680, 480)]
    });

    features.push({
      id: nextId('road'),
      type: 'road',
      kind: 'express',
      points: [tr(-620, -240), tr(-180, -110), tr(230, -155), tr(660, -180)]
    });
    features.push({
      id: nextId('road'),
      type: 'road',
      kind: 'express',
      points: [tr(-320, -480), tr(-240, -60), tr(-120, 260), tr(60, 520)]
    });
    features.push({
      id: nextId('road'),
      type: 'road',
      kind: 'arterial',
      points: [tr(190, -420), tr(180, -60), tr(240, 210), tr(320, 490)]
    });

    const d1 = tr(-320, -60);
    const d2 = tr(140, -65);
    const d3 = tr(260, -210);
    features.push({ id: nextId('lbl'), type: 'label', kind: 'district', x: d1.x, y: d1.y, text: isEn ? 'OLD DELTA' : '西关老城' });
    features.push({ id: nextId('lbl'), type: 'label', kind: 'subdistrict', x: d2.x, y: d2.y, text: isEn ? 'CENTRAL ISLAND' : '珠洲金融岛' });
    features.push({ id: nextId('lbl'), type: 'label', kind: 'district', x: d3.x, y: d3.y, text: isEn ? 'NORTH PORT' : '北岸科创新城' });
  } else {
    // lake: 依山环湖
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'urban',
      points: makeOrganicBlob(cx - 210 * s, cy + 20 * s, 340 * s, 350 * s, baseAngle, rand, 12, 0.14)
    });
    features.push({
      id: nextId('zone'),
      type: 'zone',
      kind: 'park',
      points: makeOrganicBlob(cx + 390 * s, cy - 150 * s, 210 * s, 260 * s, baseAngle + 0.2, rand, 11, 0.18)
    });

    const lakeCenter = tr(155, 20);
    features.push({
      id: nextId('water'),
      type: 'waterArea',
      points: makeOrganicBlob(lakeCenter.x, lakeCenter.y, 255 * s, 215 * s, baseAngle, rand, 12, 0.15)
    });
    features.push({
      id: nextId('island'),
      type: 'zone',
      kind: 'island',
      points: makeOrganicBlob(lakeCenter.x + 35 * s, lakeCenter.y - 25 * s, 52 * s, 36 * s, baseAngle, rand, 8, 0.12)
    });
    features.push({
      id: nextId('river'),
      type: 'river',
      width: Math.round(36 * s),
      points: [tr(-900, -320), tr(-420, -180), lakeCenter]
    });

    const lakeRing = makeOrganicBlob(lakeCenter.x - 40 * s, lakeCenter.y, 330 * s, 285 * s, baseAngle, rand, 10, 0.08);
    features.push({ id: nextId('road'), type: 'road', kind: 'express', closed: true, points: lakeRing });
    features.push({
      id: nextId('road'),
      type: 'road',
      kind: 'arterial',
      points: [tr(-680, 40), tr(-250, 25), tr(-95, 15)]
    });
    features.push({
      id: nextId('road'),
      type: 'road',
      kind: 'arterial',
      points: [tr(-240, -520), tr(-230, 20), tr(-210, 520)]
    });

    const lCity = tr(-265, 55);
    const lPark = tr(415, -165);
    features.push({ id: nextId('lbl'), type: 'label', kind: 'district', x: lCity.x, y: lCity.y, text: isEn ? 'LAKESIDE CORE' : '湖西主城' });
    features.push({ id: nextId('lbl'), type: 'label', kind: 'subdistrict', x: lPark.x, y: lPark.y, text: isEn ? 'SCENIC HILLS' : '东山生态绿廊' });
    features.push({ id: nextId('lbl'), type: 'label', kind: 'water', x: lakeCenter.x, y: lakeCenter.y + 40 * s, text: isEn ? 'MIRROR LAKE' : pickFrom(BAY_NAMES_ZH, rand, usedNames) });
  }

  return {
    theme: 'paper-grey',
    archetype: params.archetype,
    seed,
    opacity: 1,
    layerVisibility: {
      zones: true,
      water: true,
      roads: true,
      labels: true
    },
    features
  };
}

function flatToSvgPath(flat: number[], closed = false): string {
  if (flat.length < 4) return '';
  const parts: string[] = [`M ${r1(flat[0])} ${r1(flat[1])}`];
  for (let i = 2; i < flat.length; i += 2) {
    parts.push(`L ${r1(flat[i])} ${r1(flat[i + 1])}`);
  }
  if (closed) parts.push('Z');
  return parts.join(' ');
}

function escapeXml(raw: string): string {
  return String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface LightCityBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
}

interface RoadBatchGroup {
  outerW: number;
  innerW: number;
  outerColor: string;
  innerColor: string;
  path2d: Path2D | null;
  flats: Array<{ flat: number[]; closed: boolean }>;
}

interface RiverBatchGroup {
  width: number;
  bankAdd: number;
  path2d: Path2D | null;
  flats: number[][];
}

interface PrecomputedLightCityBundle {
  bounds: LightCityBounds;
  sampledById: Map<string, number[]>;
  urbanPath2d: Path2D | null;
  urbanFlats: number[][];
  parkPath2d: Path2D | null;
  parkFlats: number[][];
  islandPath2d: Path2D | null;
  islandFlats: number[][];
  waterAreaPath2d: Path2D | null;
  waterAreaFlats: number[][];
  riverGroups: RiverBatchGroup[];
  roadGroupsDark: RoadBatchGroup[];
  roadGroupsLight: RoadBatchGroup[];
}

const precomputedBundleCache = new WeakMap<LightCityFeature[], PrecomputedLightCityBundle>();

function appendFlatToPath2D(p2d: Path2D, flat: number[], closed: boolean) {
  if (flat.length < 4) return;
  p2d.moveTo(flat[0], flat[1]);
  for (let i = 2; i < flat.length; i += 2) {
    p2d.lineTo(flat[i], flat[i + 1]);
  }
  if (closed) p2d.closePath();
}

function makePath2DIfSupported(): Path2D | null {
  return typeof Path2D !== 'undefined' ? new Path2D() : null;
}

function getPrecomputedBundle(features: LightCityFeature[]): PrecomputedLightCityBundle {
  const cached = precomputedBundleCache.get(features);
  if (cached) return cached;

  const palLight = getLightCityPalette(false);
  const palDark = getLightCityPalette(true);
  const sampledById = new Map<string, number[]>();

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const expandPt = (x: number, y: number, pad = 0) => {
    if (x - pad < minX) minX = x - pad;
    if (y - pad < minY) minY = y - pad;
    if (x + pad > maxX) maxX = x + pad;
    if (y + pad > maxY) maxY = y + pad;
  };

  const urbanPath2d = makePath2DIfSupported();
  const urbanFlats: number[][] = [];
  const parkPath2d = makePath2DIfSupported();
  const parkFlats: number[][] = [];
  const islandPath2d = makePath2DIfSupported();
  const islandFlats: number[][] = [];
  const waterAreaPath2d = makePath2DIfSupported();
  const waterAreaFlats: number[][] = [];

  const riverMap = new Map<number, RiverBatchGroup>();
  const roadLightMap = new Map<string, RoadBatchGroup>();
  const roadDarkMap = new Map<string, RoadBatchGroup>();

  for (let i = 0; i < features.length; i += 1) {
    const f = features[i];
    if (f.type === 'label') {
      expandPt(f.x, f.y, 120);
      continue;
    }

    let sampled: number[];
    if (f.type === 'zone' || f.type === 'waterArea') {
      sampled = sampleSmoothClosedPolygon(f.points, resolveLightCityPolygonIterations(f.points));
    } else if (f.type === 'river') {
      sampled = sampleSmoothOpenSpline(f.points, resolveLightCitySplineSegments(f.points));
    } else {
      const m = resolveLightCityRoadMetrics(f.kind, f.points.length, palLight);
      sampled = sampleRoundedRoadPolyline(f.points, Boolean(f.closed), m.cornerRadius);
    }
    sampledById.set(f.id, sampled);

    const pad = f.type === 'river' ? f.width * 0.6 + 6 : 12;
    for (let k = 0; k < sampled.length; k += 2) {
      expandPt(sampled[k], sampled[k + 1], pad);
    }

    if (sampled.length < 4) continue;

    if (f.type === 'zone') {
      if (f.kind === 'island') {
        islandFlats.push(sampled);
        if (islandPath2d) appendFlatToPath2D(islandPath2d, sampled, true);
      } else if (f.kind === 'park') {
        parkFlats.push(sampled);
        if (parkPath2d) appendFlatToPath2D(parkPath2d, sampled, true);
      } else {
        urbanFlats.push(sampled);
        if (urbanPath2d) appendFlatToPath2D(urbanPath2d, sampled, true);
      }
    } else if (f.type === 'waterArea') {
      waterAreaFlats.push(sampled);
      if (waterAreaPath2d) appendFlatToPath2D(waterAreaPath2d, sampled, true);
    } else if (f.type === 'river') {
      const wKey = Math.round(f.width * 2) / 2;
      let grp = riverMap.get(wKey);
      if (!grp) {
        grp = {
          width: wKey,
          bankAdd: wKey < 12 ? 2 : 3,
          path2d: makePath2DIfSupported(),
          flats: []
        };
        riverMap.set(wKey, grp);
      }
      grp.flats.push(sampled);
      if (grp.path2d) appendFlatToPath2D(grp.path2d, sampled, false);
    } else if (f.type === 'road') {
      const closed = Boolean(f.closed);
      const mL = resolveLightCityRoadMetrics(f.kind, f.points.length, palLight);
      const mD = resolveLightCityRoadMetrics(f.kind, f.points.length, palDark);
      const gKey = `${f.kind}_${f.points.length > 8 ? 'long' : 'short'}`;

      let grpL = roadLightMap.get(gKey);
      if (!grpL) {
        grpL = {
          outerW: mL.outerW,
          innerW: mL.innerW,
          outerColor: mL.outerColor,
          innerColor: mL.innerColor,
          path2d: makePath2DIfSupported(),
          flats: []
        };
        roadLightMap.set(gKey, grpL);
      }
      grpL.flats.push({ flat: sampled, closed });
      if (grpL.path2d) appendFlatToPath2D(grpL.path2d, sampled, closed);

      let grpD = roadDarkMap.get(gKey);
      if (!grpD) {
        grpD = {
          outerW: mD.outerW,
          innerW: mD.innerW,
          outerColor: mD.outerColor,
          innerColor: mD.innerColor,
          path2d: makePath2DIfSupported(),
          flats: []
        };
        roadDarkMap.set(gKey, grpD);
      }
      grpD.flats.push({ flat: sampled, closed });
      if (grpD.path2d) appendFlatToPath2D(grpD.path2d, sampled, closed);
    }
  }

  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 1520;
    maxY = 940;
  }

  const bounds: LightCityBounds = {
    minX: Math.floor(minX - 24),
    minY: Math.floor(minY - 24),
    maxX: Math.ceil(maxX + 24),
    maxY: Math.ceil(maxY + 24),
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    width: Math.max(64, Math.ceil(maxX - minX + 48)),
    height: Math.max(64, Math.ceil(maxY - minY + 48))
  };

  const bundle: PrecomputedLightCityBundle = {
    bounds,
    sampledById,
    urbanPath2d,
    urbanFlats,
    parkPath2d,
    parkFlats,
    islandPath2d,
    islandFlats,
    waterAreaPath2d,
    waterAreaFlats,
    riverGroups: Array.from(riverMap.values()),
    roadGroupsLight: Array.from(roadLightMap.values()),
    roadGroupsDark: Array.from(roadDarkMap.values())
  };
  precomputedBundleCache.set(features, bundle);
  return bundle;
}

/**
 * 为无损 SVG 导出构建轻城市矢量图层节点字符串
 */
export function buildLightCitySvgLayer(lightCity: LightCitySettings | undefined, isDark = false): string {
  if (!lightCity || !lightCity.features.length) return '';
  const pal = getLightCityPalette(isDark);
  const vis = lightCity.layerVisibility;
  const feathered = shouldFeatherLightCityEdges(lightCity);
  const bundle = getPrecomputedBundle(lightCity.features);
  const zonesOut: string[] = [];
  const waterBanksOut: string[] = [];
  const waterFillsOut: string[] = [];
  const islandsOut: string[] = [];
  const roadOutersOut: string[] = [];
  const roadInnersOut: string[] = [];
  const labelsOut: string[] = [];

  lightCity.features.forEach((f) => {
    if (f.type === 'zone') {
      if (f.kind === 'island') {
        if (!vis.water && !vis.zones) return;
        const d = flatToSvgPath(bundle.sampledById.get(f.id) || [], true);
        if (d) {
          islandsOut.push(`<path d="${d}" fill="${pal.islandFill}" stroke="${pal.islandStroke}" stroke-width="1.5" stroke-linejoin="round" />`);
        }
        return;
      }
      // 伦敦等实景模式采用无底框纸面融合，跳过人工大椭圆城区底板
      if (feathered && f.kind === 'urban') return;
      if (!vis.zones) return;
      const d = flatToSvgPath(bundle.sampledById.get(f.id) || [], true);
      if (!d) return;
      const fill = f.kind === 'park' ? pal.parkFill : pal.urbanFill;
      const stroke = f.kind === 'park' ? pal.parkStroke : pal.urbanStroke;
      zonesOut.push(`<path d="${d}" fill="${fill}" stroke="${stroke}" stroke-width="1.2" stroke-linejoin="round" />`);
    } else if (f.type === 'waterArea') {
      if (!vis.water) return;
      const d = flatToSvgPath(bundle.sampledById.get(f.id) || [], true);
      if (d) {
        waterBanksOut.push(`<path d="${d}" fill="${pal.waterBank}" stroke="${pal.waterBank}" stroke-width="2.6" stroke-linejoin="round" />`);
        waterFillsOut.push(`<path d="${d}" fill="${pal.waterFill}" stroke="none" />`);
      }
    } else if (f.type === 'river') {
      if (!vis.water) return;
      const d = flatToSvgPath(bundle.sampledById.get(f.id) || [], false);
      if (d) {
        const bankAdd = f.width < 12 ? 2 : 3;
        waterBanksOut.push(
          `<path d="${d}" fill="none" stroke="${pal.waterBank}" stroke-width="${r1(f.width + bankAdd)}" stroke-linecap="round" stroke-linejoin="round" />`
        );
        waterFillsOut.push(
          `<path d="${d}" fill="none" stroke="${pal.waterFill}" stroke-width="${r1(f.width)}" stroke-linecap="round" stroke-linejoin="round" />`
        );
      }
    } else if (f.type === 'road') {
      if (!vis.roads) return;
      const d = flatToSvgPath(bundle.sampledById.get(f.id) || [], Boolean(f.closed));
      if (d) {
        const m = resolveLightCityRoadMetrics(f.kind, f.points.length, pal);
        roadOutersOut.push(
          `<path d="${d}" fill="none" stroke="${m.outerColor}" stroke-width="${m.outerW}" stroke-linecap="round" stroke-linejoin="round" />`
        );
        roadInnersOut.push(
          `<path d="${d}" fill="none" stroke="${m.innerColor}" stroke-width="${m.innerW}" stroke-linecap="round" stroke-linejoin="round" />`
        );
      }
    } else if (f.type === 'label') {
      if (!vis.labels) return;
      const fontSize = f.kind === 'district' ? 19 : f.kind === 'water' ? 14 : 14.5;
      const fill =
        f.kind === 'district'
          ? pal.labelDistrict
          : f.kind === 'water'
            ? pal.labelWater
            : pal.labelSubdistrict;
      const fontStyle = f.kind === 'water' ? ' font-style="italic"' : '';
      labelsOut.push(
        `<text x="${r1(f.x)}" y="${r1(f.y)}" text-anchor="middle" dominant-baseline="central" font-size="${fontSize}" font-weight="700" letter-spacing="2.5"${fontStyle} fill="${fill}">${escapeXml(f.text)}</text>`
      );
    }
  });

  let maskDefs = '';
  let maskAttr = '';
  if (feathered) {
    const uid = Math.abs(lightCity.seed || 1) % 100000;
    const gradId = `lc_fade_grad_${uid}`;
    const maskId = `lc_fade_mask_${uid}`;
    const { minX, minY, width, height, cx, cy } = bundle.bounds;
    const rx = r1(width * 0.445);
    const ry = r1(height * 0.445);
    maskDefs = `<defs>
      <radialGradient id="${gradId}" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="1" />
        <stop offset="52%" stop-color="#ffffff" stop-opacity="1" />
        <stop offset="70%" stop-color="#ffffff" stop-opacity="0.76" />
        <stop offset="85%" stop-color="#ffffff" stop-opacity="0.32" />
        <stop offset="95%" stop-color="#ffffff" stop-opacity="0.06" />
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0" />
      </radialGradient>
      <mask id="${maskId}" maskUnits="userSpaceOnUse" x="${minX}" y="${minY}" width="${width}" height="${height}">
        <rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="#000000" />
        <ellipse cx="${r1(cx)}" cy="${r1(cy)}" rx="${rx}" ry="${ry}" fill="url(#${gradId})" />
      </mask>
    </defs>\n    `;
    maskAttr = ` mask="url(#${maskId})"`;
  }

  return `<g id="light-city-basemap" opacity="${r1(lightCity.opacity ?? 1)}"${maskAttr}>\n    ${maskDefs}${[
    ...zonesOut,
    ...waterBanksOut,
    ...waterFillsOut,
    ...islandsOut,
    ...roadOutersOut,
    ...roadInnersOut,
    ...labelsOut
  ].join('\n    ')}\n  </g>`;
}

interface CachedLightCityRaster {
  canvas: HTMLCanvasElement;
  minX: number;
  minY: number;
  worldW: number;
  worldH: number;
  scale: number;
}

const rasterCache = new WeakMap<LightCityFeature[], Map<string, CachedLightCityRaster>>();
let viewportScratchCanvas: HTMLCanvasElement | null = null;

function applyWorldFeatherMaskToCanvas(ctx: CanvasRenderingContext2D, bounds: LightCityBounds) {
  const rx = Math.max(40, bounds.width * 0.445);
  const ry = Math.max(40, bounds.height * 0.445);
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.translate(bounds.cx, bounds.cy);
  ctx.scale(rx, ry);
  const grad = ctx.createRadialGradient(0, 0, 0.52, 0, 0, 1.0);
  grad.addColorStop(0, 'rgba(0, 0, 0, 1)');
  grad.addColorStop(0.38, 'rgba(0, 0, 0, 0.76)');
  grad.addColorStop(0.69, 'rgba(0, 0, 0, 0.32)');
  grad.addColorStop(0.9, 'rgba(0, 0, 0, 0.06)');
  grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
  ctx.fillStyle = grad;
  // 覆盖超过 [-2, 2] 确保外圈残留像素全部乘 0 归零
  ctx.fillRect(-2.2, -2.2, 4.4, 4.4);
  ctx.restore();
}

/**
 * 在已处于世界坐标系（world units）的 Canvas2D 上下文上用 Path2D 极速合批绘制全城矢量（665 条路仅需 ~6 次 stroke）
 */
function renderVectorLightCityInWorldSpace(
  ctx: CanvasRenderingContext2D,
  lightCity: LightCitySettings,
  bundle: PrecomputedLightCityBundle,
  isDark: boolean,
  feathered: boolean,
  fontStack: string
) {
  const pal = getLightCityPalette(isDark);
  const vis = lightCity.layerVisibility;
  const roadGroups = isDark ? bundle.roadGroupsDark : bundle.roadGroupsLight;

  const strokeOrFillFlats = (flats: number[][], closed: boolean, doFill: boolean, doStroke: boolean) => {
    if (!flats.length) return;
    ctx.beginPath();
    for (let k = 0; k < flats.length; k += 1) {
      const flat = flats[k];
      if (flat.length < 4) continue;
      ctx.moveTo(flat[0], flat[1]);
      for (let i = 2; i < flat.length; i += 2) {
        ctx.lineTo(flat[i], flat[i + 1]);
      }
      if (closed) ctx.closePath();
    }
    if (doFill) ctx.fill();
    if (doStroke) ctx.stroke();
  };

  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 1. 建成区与公园绿地
  if (vis.zones) {
    if (!feathered && bundle.urbanFlats.length > 0) {
      ctx.fillStyle = pal.urbanFill;
      ctx.strokeStyle = pal.urbanStroke;
      ctx.lineWidth = 1.2;
      if (bundle.urbanPath2d) {
        ctx.fill(bundle.urbanPath2d);
        ctx.stroke(bundle.urbanPath2d);
      } else {
        strokeOrFillFlats(bundle.urbanFlats, true, true, true);
      }
    }
    if (bundle.parkFlats.length > 0) {
      ctx.fillStyle = pal.parkFill;
      ctx.strokeStyle = pal.parkStroke;
      ctx.lineWidth = 1.2;
      if (bundle.parkPath2d) {
        ctx.fill(bundle.parkPath2d);
        ctx.stroke(bundle.parkPath2d);
      } else {
        strokeOrFillFlats(bundle.parkFlats, true, true, true);
      }
    }
  }

  // 2. 水系双遍同层融合（外岸线合批 -> 内水体合批）
  if (vis.water) {
    if (bundle.waterAreaFlats.length > 0) {
      ctx.fillStyle = pal.waterBank;
      ctx.strokeStyle = pal.waterBank;
      ctx.lineWidth = 2.6;
      if (bundle.waterAreaPath2d) {
        ctx.fill(bundle.waterAreaPath2d);
        ctx.stroke(bundle.waterAreaPath2d);
      } else {
        strokeOrFillFlats(bundle.waterAreaFlats, true, true, true);
      }
    }
    for (let i = 0; i < bundle.riverGroups.length; i += 1) {
      const rg = bundle.riverGroups[i];
      ctx.strokeStyle = pal.waterBank;
      ctx.lineWidth = rg.width + rg.bankAdd;
      if (rg.path2d) ctx.stroke(rg.path2d);
      else strokeOrFillFlats(rg.flats, false, false, true);
    }

    if (bundle.waterAreaFlats.length > 0) {
      ctx.fillStyle = pal.waterFill;
      if (bundle.waterAreaPath2d) ctx.fill(bundle.waterAreaPath2d);
      else strokeOrFillFlats(bundle.waterAreaFlats, true, true, false);
    }
    for (let i = 0; i < bundle.riverGroups.length; i += 1) {
      const rg = bundle.riverGroups[i];
      ctx.strokeStyle = pal.waterFill;
      ctx.lineWidth = rg.width;
      if (rg.path2d) ctx.stroke(rg.path2d);
      else strokeOrFillFlats(rg.flats, false, false, true);
    }
  }

  // 3. 江心洲与离岛
  if ((vis.water || vis.zones) && bundle.islandFlats.length > 0) {
    ctx.fillStyle = pal.islandFill;
    ctx.strokeStyle = pal.islandStroke;
    ctx.lineWidth = 1.5;
    if (bundle.islandPath2d) {
      ctx.fill(bundle.islandPath2d);
      ctx.stroke(bundle.islandPath2d);
    } else {
      strokeOrFillFlats(bundle.islandFlats, true, true, true);
    }
  }

  // 4. 三级道路骨架（Path2D 整层合批：外描边一轮 -> 内芯一轮，665 条路仅 6 次调用）
  if (vis.roads && roadGroups.length > 0) {
    for (let i = 0; i < roadGroups.length; i += 1) {
      const grp = roadGroups[i];
      ctx.strokeStyle = grp.outerColor;
      ctx.lineWidth = grp.outerW;
      if (grp.path2d) {
        ctx.stroke(grp.path2d);
      } else {
        ctx.beginPath();
        grp.flats.forEach(({ flat, closed }) => {
          ctx.moveTo(flat[0], flat[1]);
          for (let j = 2; j < flat.length; j += 2) ctx.lineTo(flat[j], flat[j + 1]);
          if (closed) ctx.closePath();
        });
        ctx.stroke();
      }
    }
    for (let i = 0; i < roadGroups.length; i += 1) {
      const grp = roadGroups[i];
      ctx.strokeStyle = grp.innerColor;
      ctx.lineWidth = grp.innerW;
      if (grp.path2d) {
        ctx.stroke(grp.path2d);
      } else {
        ctx.beginPath();
        grp.flats.forEach(({ flat, closed }) => {
          ctx.moveTo(flat[0], flat[1]);
          for (let j = 2; j < flat.length; j += 2) ctx.lineTo(flat[j], flat[j + 1]);
          if (closed) ctx.closePath();
        });
        ctx.stroke();
      }
    }
  }

  // 5. 片区水印名
  if (vis.labels) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const feats = lightCity.features;
    for (let i = 0; i < feats.length; i += 1) {
      const f = feats[i];
      if (f.type !== 'label') continue;
      const px = f.kind === 'district' ? 19 : f.kind === 'water' ? 14 : 14.5;
      ctx.font = `${f.kind === 'water' ? 'italic ' : ''}700 ${px}px ${fontStack}`;
      ctx.fillStyle =
        f.kind === 'district'
          ? pal.labelDistrict
          : f.kind === 'water'
            ? pal.labelWater
            : pal.labelSubdistrict;
      ctx.fillText(f.text, f.x, f.y);
    }
  }
}

function getCachedLightCityRaster(
  lightCity: LightCitySettings,
  bundle: PrecomputedLightCityBundle,
  isDark: boolean,
  feathered: boolean,
  fontStack: string
): CachedLightCityRaster | null {
  if (typeof document === 'undefined') return null;
  let byKey = rasterCache.get(lightCity.features);
  if (!byKey) {
    byKey = new Map<string, CachedLightCityRaster>();
    rasterCache.set(lightCity.features, byKey);
  }
  const vis = lightCity.layerVisibility;
  const key = `${isDark ? 1 : 0}_${vis.zones ? 1 : 0}${vis.water ? 1 : 0}${vis.roads ? 1 : 0}${vis.labels ? 1 : 0}_${feathered ? 1 : 0}_${fontStack}`;
  const hit = byKey.get(key);
  if (hit) return hit;

  const { minX, minY, width: worldW, height: worldH } = bundle.bounds;
  // 最高 3840px 离屏超采样位图，覆盖全局~中景缩放（每帧仅 1 次 GPU drawImage，耗时 < 0.08ms）
  const maxDim = Math.max(worldW, worldH, 1);
  const scale = Math.min(2.2, 3840 / maxDim);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(64, Math.ceil(worldW * scale));
  canvas.height = Math.max(64, Math.ceil(worldH * scale));
  const offCtx = canvas.getContext('2d');
  if (!offCtx) return null;

  offCtx.save();
  offCtx.scale(scale, scale);
  offCtx.translate(-minX, -minY);
  renderVectorLightCityInWorldSpace(offCtx, lightCity, bundle, isDark, feathered, fontStack);
  if (feathered) {
    applyWorldFeatherMaskToCanvas(offCtx, bundle.bounds);
  }
  offCtx.restore();

  const raster: CachedLightCityRaster = { canvas, minX, minY, worldW, worldH, scale };
  byKey.set(key, raster);
  return raster;
}

/**
 * 为 Konva 高帧率实时画布、MP4 动态视频帧或离屏位图将轻城市矢量底图绘制到 Canvas2D 上下文
 */
export function drawLightCityToCanvas2D(params: {
  ctx: CanvasRenderingContext2D;
  lightCity: LightCitySettings | undefined;
  isDark: boolean;
  worldToCanvas: (pt: LightCityPoint) => { x: number; y: number };
  worldScale: number;
  fontStack?: string;
  identityWorldTransform?: boolean;
}) {
  const { ctx, lightCity, isDark, worldToCanvas, worldScale, identityWorldTransform } = params;
  if (!lightCity || !lightCity.features.length) return;
  const fontStack = params.fontStack || '"PingFang SC", "Microsoft YaHei", sans-serif';
  const feathered = shouldFeatherLightCityEdges(lightCity);
  const bundle = getPrecomputedBundle(lightCity.features);
  const opacity = Math.max(0.2, Math.min(1, lightCity.opacity ?? 1));

  const domMat = identityWorldTransform && typeof ctx.getTransform === 'function' ? ctx.getTransform() : null;
  const pixelScale = domMat ? Math.hypot(domMat.a, domMat.b) : Math.max(0.1, worldScale);

  const raster = getCachedLightCityRaster(lightCity, bundle, isDark, feathered, fontStack);
  // 1. 常态/全景/视频帧快速通道：直接贴预渲染超采样羽化位图（单帧 1 次 drawImage，< 0.08ms）
  if (raster && pixelScale <= raster.scale * 1.25) {
    ctx.save();
    ctx.globalAlpha *= opacity;
    if (identityWorldTransform) {
      ctx.drawImage(raster.canvas, raster.minX, raster.minY, raster.worldW, raster.worldH);
    } else {
      const tl = worldToCanvas({ x: raster.minX, y: raster.minY });
      const br = worldToCanvas({ x: raster.minX + raster.worldW, y: raster.minY + raster.worldH });
      ctx.drawImage(raster.canvas, tl.x, tl.y, br.x - tl.x, br.y - tl.y);
    }
    ctx.restore();
    return;
  }

  // 2. 深度放大（> 180%~500% 街区特写）：自动无缝切换为 Path2D 纯矢量合批直绘，保持无限锐利且羽化边缘零跳变
  if (typeof document !== 'undefined' && ctx.canvas) {
    const cw = ctx.canvas.width;
    const ch = ctx.canvas.height;
    if (feathered && cw > 0 && ch > 0) {
      if (!viewportScratchCanvas) {
        viewportScratchCanvas = document.createElement('canvas');
      }
      if (viewportScratchCanvas.width !== cw || viewportScratchCanvas.height !== ch) {
        viewportScratchCanvas.width = cw;
        viewportScratchCanvas.height = ch;
      }
      const sCtx = viewportScratchCanvas.getContext('2d');
      if (sCtx) {
        sCtx.setTransform(1, 0, 0, 1, 0, 0);
        sCtx.clearRect(0, 0, cw, ch);
        if (domMat) {
          sCtx.setTransform(domMat);
        } else {
          const origin = worldToCanvas({ x: 0, y: 0 });
          sCtx.setTransform(worldScale, 0, 0, worldScale, origin.x, origin.y);
        }
        renderVectorLightCityInWorldSpace(sCtx, lightCity, bundle, isDark, feathered, fontStack);
        applyWorldFeatherMaskToCanvas(sCtx, bundle.bounds);

        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha *= opacity;
        ctx.drawImage(viewportScratchCanvas, 0, 0);
        ctx.restore();
        return;
      }
    }
  }

  // 3. 无羽化深度放大或非浏览器测试环境直接 Path2D 合批输出
  ctx.save();
  ctx.globalAlpha *= opacity;
  if (!identityWorldTransform) {
    const origin = worldToCanvas({ x: 0, y: 0 });
    ctx.translate(origin.x, origin.y);
    ctx.scale(worldScale, worldScale);
  }
  renderVectorLightCityInWorldSpace(ctx, lightCity, bundle, isDark, feathered, fontStack);
  ctx.restore();
}

export interface TerrainSnapResult {
  x: number;
  y: number;
  snapped: boolean;
  kind?: 'vertex' | 'centerline';
  featureType?: 'river' | 'waterArea' | 'road' | 'zone';
}

/**
 * 造景画笔双级磁吸计算：
 * 1) 优先吸附同类既有要素的控制顶点（屏幕距离 <= 15px），支持从第一条河流/干道的任意历史节点精准起笔或汇合；
 * 2) 次级吸附既有河流或主干道的平滑中心线（屏幕距离 <= 13px），支持在既有主河道任意弯位直接分汊或汇入。
 */
export function snapTerrainDrawPoint(params: {
  rawPoint: LightCityPoint;
  lightCity: LightCitySettings | undefined;
  tool: 'river' | 'waterArea' | 'zone' | 'road';
  viewportScale: number;
  altKey?: boolean;
}): TerrainSnapResult {
  const { rawPoint, lightCity, tool, viewportScale, altKey } = params;
  const rx = r1(rawPoint.x);
  const ry = r1(rawPoint.y);
  if (altKey || !lightCity || !lightCity.features.length) {
    return { x: rx, y: ry, snapped: false };
  }

  const safeScale = Math.max(0.2, viewportScale || 1);
  const vertexRadiusWorld = 15 / safeScale;
  const centerlineRadiusWorld = 13 / safeScale;

  const isRelevantFeature = (f: LightCityFeature) => {
    if (f.type === 'label') return false;
    if (tool === 'river' || tool === 'waterArea') {
      return f.type === 'river' || f.type === 'waterArea';
    }
    if (tool === 'road') {
      return f.type === 'road';
    }
    return f.type === 'zone';
  };

  // Pass 1: Vertex snap
  let bestVertexDist = vertexRadiusWorld;
  let bestVertex: { x: number; y: number; featureType: 'river' | 'waterArea' | 'road' | 'zone' } | null = null;
  for (const f of lightCity.features) {
    if (!isRelevantFeature(f) || f.type === 'label') continue;
    for (const pt of f.points) {
      const d = Math.hypot(rx - pt.x, ry - pt.y);
      if (d <= bestVertexDist) {
        bestVertexDist = d;
        bestVertex = { x: pt.x, y: pt.y, featureType: f.type };
      }
    }
  }
  if (bestVertex) {
    return {
      x: bestVertex.x,
      y: bestVertex.y,
      snapped: true,
      kind: 'vertex',
      featureType: bestVertex.featureType
    };
  }

  // Pass 2: Centerline projection snap (for rivers & roads)
  if (tool === 'river' || tool === 'waterArea' || tool === 'road') {
    let bestLineDist = centerlineRadiusWorld;
    let bestProj: { x: number; y: number; featureType: 'river' | 'road' } | null = null;
    for (const f of lightCity.features) {
      if (f.type !== 'river' && f.type !== 'road') continue;
      if (tool === 'road' && f.type !== 'road') continue;
      if (tool !== 'road' && f.type !== 'river') continue;
      const flat =
        f.type === 'river'
          ? sampleSmoothOpenSpline(f.points, 8)
          : sampleRoundedRoadPolyline(f.points, Boolean(f.closed), 36);
      const segPairs = flat.length / 2;
      for (let i = 0; i < segPairs - 1; i += 1) {
        const ax = flat[i * 2];
        const ay = flat[i * 2 + 1];
        const bx = flat[(i + 1) * 2];
        const by = flat[(i + 1) * 2 + 1];
        const dx = bx - ax;
        const dy = by - ay;
        const lenSq = dx * dx + dy * dy;
        const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((rx - ax) * dx + (ry - ay) * dy) / lenSq));
        const px = ax + t * dx;
        const py = ay + t * dy;
        const d = Math.hypot(rx - px, ry - py);
        if (d <= bestLineDist) {
          bestLineDist = d;
          bestProj = { x: r1(px), y: r1(py), featureType: f.type };
        }
      }
    }
    if (bestProj) {
      return {
        x: bestProj.x,
        y: bestProj.y,
        snapped: true,
        kind: 'centerline',
        featureType: bestProj.featureType
      };
    }
  }

  return { x: rx, y: ry, snapped: false };
}
