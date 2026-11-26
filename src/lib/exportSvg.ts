// 无损印刷级矢量图（SVG）导出引擎：
// 直接复用画布底层的平行偏移（offsetPath）、单点圆角/过点圆弧（roundedPath）、城市预设（stylePresets）
// 与换乘站符号规划（interchange），输出完全独立、可无限放大不失真的标准 SVG 文档。

import { Line, MapSettings, Section, Station } from '../types';
import { getCityStylePreset } from '../stylePresets';
import { buildCurvedArrowPath, planInterchange } from './interchange';
import { buildSectionRenderGeometry, computeNetworkParallelLayout } from './offsetPath';
import { deriveLineTopology } from './graphOps';
import { buildLightCitySvgLayer, getLightCityPalette } from './lightCity';
import { resolveLineBadgeColors, resolveReadableStationLabelColor } from './canvasTheme';

function escapeXml(raw: string): string {
  return String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fmt(n: number): string {
  return Math.round(n * 100) / 100 + '';
}

function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (let i = 0; i < text.length; i += 1) {
    width += text.charCodeAt(i) > 255 ? fontSize : fontSize * 0.58;
  }
  return width;
}

function arcSectorPath(cx: number, cy: number, innerR: number, outerR: number, startDeg: number, sweepDeg: number): string {
  const sRad = (startDeg * Math.PI) / 180;
  const eRad = ((startDeg + sweepDeg) * Math.PI) / 180;
  const largeArc = sweepDeg > 180 ? 1 : 0;
  const ox1 = cx + outerR * Math.cos(sRad);
  const oy1 = cy + outerR * Math.sin(sRad);
  const ox2 = cx + outerR * Math.cos(eRad);
  const oy2 = cy + outerR * Math.sin(eRad);
  const ix2 = cx + innerR * Math.cos(eRad);
  const iy2 = cy + innerR * Math.sin(eRad);
  const ix1 = cx + innerR * Math.cos(sRad);
  const iy1 = cy + innerR * Math.sin(sRad);
  return [
    `M ${fmt(ox1)} ${fmt(oy1)}`,
    `A ${fmt(outerR)} ${fmt(outerR)} 0 ${largeArc} 1 ${fmt(ox2)} ${fmt(oy2)}`,
    `L ${fmt(ix2)} ${fmt(iy2)}`,
    `A ${fmt(innerR)} ${fmt(innerR)} 0 ${largeArc} 0 ${fmt(ix1)} ${fmt(iy1)}`,
    'Z'
  ].join(' ');
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function buildMetroSvg(params: {
  lines: Line[];
  stations: Station[];
  sections: Section[];
  mapSettings: MapSettings;
  backgroundColor?: string;
}): string {
  const { lines, stations, sections, mapSettings } = params;
  const isDark = mapSettings.canvasTheme === 'dark';
  const isLightCity = mapSettings.baseMap.mode === 'light-city';
  const bg =
    params.backgroundColor ||
    (isLightCity
      ? getLightCityPalette(isDark).canvasBg
      : isDark
        ? '#0b1220'
        : '#f8fafc');
  const stylePreset = getCityStylePreset(mapSettings);
  const stationStrokeBg = isDark ? '#0f172a' : '#ffffff';
  const labelHalo = isDark ? '#0b1220' : '#ffffff';
  const labelColor = resolveReadableStationLabelColor(mapSettings.dotLabelStyle.color, isDark, '#0f172a', '#f1f5f9');
  const lineBadgeColors = resolveLineBadgeColors(stylePreset.lineLabelFill, stylePreset.lineLabelText, isDark);
  const darkOutline = isDark ? '#f8fafc' : '#0f172a';

  const stationById = new Map<string, Station>();
  stations.forEach((s) => stationById.set(s.id, s));

  const lineOrderMap = new Map<string, number>();
  const lineById = new Map<string, Line>();
  lines.forEach((l, idx) => {
    lineOrderMap.set(l.id, idx);
    lineById.set(l.id, l);
  });

  // 计算画布包围盒（同时计入站点和途经点，避免大圆弧被裁切）
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  stations.forEach((s) => {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x);
    maxY = Math.max(maxY, s.y);
  });
  sections.forEach((sec) => {
    (sec.waypoints || []).forEach((wp) => {
      minX = Math.min(minX, wp.x);
      minY = Math.min(minY, wp.y);
      maxX = Math.max(maxX, wp.x);
      maxY = Math.max(maxY, wp.y);
    });
  });

  if (!Number.isFinite(minX) && isLightCity && mapSettings.baseMap.lightCity?.features.length) {
    mapSettings.baseMap.lightCity.features.forEach((f) => {
      if (f.type === 'label') {
        minX = Math.min(minX, f.x);
        minY = Math.min(minY, f.y);
        maxX = Math.max(maxX, f.x);
        maxY = Math.max(maxY, f.y);
      } else {
        f.points.forEach((p) => {
          minX = Math.min(minX, p.x);
          minY = Math.min(minY, p.y);
          maxX = Math.max(maxX, p.x);
          maxY = Math.max(maxY, p.y);
        });
      }
    });
  }

  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 800;
    maxY = 600;
  }

  const padding = 140;
  const viewX = Math.floor(minX - padding);
  const viewY = Math.floor(minY - padding);
  const viewW = Math.max(640, Math.ceil(maxX - minX + padding * 2));
  const viewH = Math.max(480, Math.ceil(maxY - minY + padding * 2));

  // 统计站点经过线路
  const stationToLines = new Map<string, Line[]>();
  lines.forEach((line) => {
    line.stationIds.forEach((sid) => {
      const arr = stationToLines.get(sid);
      if (arr) {
        if (!arr.includes(line)) arr.push(line);
      } else {
        stationToLines.set(sid, [line]);
      }
    });
  });
  const stationLineCounts: Record<string, number> = {};
  stations.forEach((st) => {
    stationLineCounts[st.id] = stationToLines.get(st.id)?.length || 0;
  });

  // 统一共线走廊与跨区间快线并行布局
  const validSections = sections.filter(
    (s) => lineById.has(s.lineId) && stationById.has(s.startStationId) && stationById.has(s.endStationId)
  );
  const parallelGap = Math.max(8.8, stylePreset.lineWidth + 4);
  const fallbackCornerR = Math.max(0, mapSettings.cornerRadius || 0);
  const parallelLayout = computeNetworkParallelLayout({
    sections: validSections.map((sec) => {
      const start = stationById.get(sec.startStationId)!;
      const end = stationById.get(sec.endStationId)!;
      return {
        id: sec.id,
        lineId: sec.lineId,
        startStationId: sec.startStationId,
        endStationId: sec.endStationId,
        points: [
          { x: start.x, y: start.y },
          ...(sec.waypoints || []).map((wp) => ({ x: wp.x, y: wp.y })),
          { x: end.x, y: end.y }
        ],
        parallelOrder: sec.parallelOrder
      };
    }),
    lineOrderMap,
    gap: parallelGap,
    stationLineCounts
  });

  const lineSvgElements: string[] = [];
  validSections.forEach((sec) => {
    const line = lineById.get(sec.lineId)!;
    const start = stationById.get(sec.startStationId)!;
    const end = stationById.get(sec.endStationId)!;
    const directedOffset = parallelLayout.bySectionId.get(sec.id)?.directedOffset || 0;

    const controlPoints = [
      { x: start.x, y: start.y },
      ...(sec.waypoints || []).map((wp) => ({
        x: wp.x,
        y: wp.y,
        ...(typeof wp.radius === 'number' ? { radius: wp.radius } : {}),
        ...(wp.mode ? { mode: wp.mode } : {})
      })),
      { x: end.x, y: end.y }
    ];
    const { renderPoints } = buildSectionRenderGeometry(controlPoints, directedOffset, fallbackCornerR);
    if (renderPoints.length < 2) return;
    const d = renderPoints.map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${fmt(pt.x)} ${fmt(pt.y)}`).join(' ');
    lineSvgElements.push(
      `  <path d="${d}" fill="none" stroke="${escapeXml(line.color)}" stroke-width="${fmt(stylePreset.lineWidth)}" stroke-linecap="round" stroke-linejoin="round" />`
    );
  });

  // 站名排版与站点符号渲染
  const occupiedBoxes: Box[] = stations.map((st) => ({
    x: st.x - stylePreset.interchangeRadius - 3,
    y: st.y - stylePreset.interchangeRadius - 3,
    width: (stylePreset.interchangeRadius + 3) * 2,
    height: (stylePreset.interchangeRadius + 3) * 2
  }));

  const stationSvgElements: string[] = [];
  const labelSvgElements: string[] = [];
  const fontSize = mapSettings.dotLabelStyle.fontSize || 13;
  const fontWeight = mapSettings.dotLabelStyle.fontWeight || 700;

  stations.forEach((station) => {
    const passing = stationToLines.get(station.id) || [];
    const isInterchange = passing.length > 1;
    const primaryColor = passing[0]?.color || '#64748b';

    if (isInterchange) {
      const r = stylePreset.interchangeRadius;
      const plan = planInterchange(
        stylePreset.interchangeShape,
        stylePreset.interchangeOuterStroke,
        passing.map((l) => l.color)
      );
      const outerStroke =
        plan.outerStroke === 'dark'
          ? darkOutline
          : plan.outerStroke === 'lineColor'
            ? primaryColor
            : 'none';

      if (plan.shape === 'curvedArrows') {
        stationSvgElements.push(
          `  <circle cx="${fmt(station.x)}" cy="${fmt(station.y)}" r="${fmt(r)}" fill="${stationStrokeBg}" stroke="${outerStroke}" stroke-width="${fmt(stylePreset.interchangeStrokeWidth)}" />`
        );
        plan.curvedArrows.forEach((arrow) => {
          const pathData = buildCurvedArrowPath(station.x, station.y, r * 0.42, r * 0.72, arrow);
          stationSvgElements.push(`  <path d="${pathData}" fill="${escapeXml(arrow.color)}" />`);
        });
      } else if (plan.shape === 'lineColorArcs') {
        stationSvgElements.push(
          `  <circle cx="${fmt(station.x)}" cy="${fmt(station.y)}" r="${fmt(r)}" fill="${stationStrokeBg}" />`
        );
        const innerR = Math.max(0, r - stylePreset.interchangeStrokeWidth);
        plan.sectors.forEach((sec) => {
          const d = arcSectorPath(station.x, station.y, innerR, r, sec.startDeg, sec.sweepDeg);
          stationSvgElements.push(`  <path d="${d}" fill="${escapeXml(sec.color)}" />`);
        });
      } else {
        stationSvgElements.push(
          `  <circle cx="${fmt(station.x)}" cy="${fmt(station.y)}" r="${fmt(r)}" fill="${stationStrokeBg}" stroke="${darkOutline}" stroke-width="${fmt(stylePreset.interchangeStrokeWidth)}" />`,
          `  <circle cx="${fmt(station.x)}" cy="${fmt(station.y)}" r="${fmt(stylePreset.interchangeInnerRadius)}" fill="none" stroke="${darkOutline}" stroke-width="${fmt(stylePreset.interchangeStrokeWidth * 0.5)}" />`
        );
      }
    } else {
      const r = stylePreset.normalStationRadius;
      const fill = stylePreset.stationShape === 'ring' ? stationStrokeBg : primaryColor;
      const stroke = stylePreset.stationShape === 'ring' ? primaryColor : stationStrokeBg;
      const nudge = parallelLayout.stationTrackNudges.get(station.id);
      const cx = nudge ? station.x + nudge.dx : station.x;
      const cy = nudge ? station.y + nudge.dy : station.y;
      stationSvgElements.push(
        `  <circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${fmt(stylePreset.normalStationStrokeWidth)}" />`
      );
    }

    if (station.labelPosition === 'hidden') return;
    if (mapSettings.labelDensity === 'key' && !isInterchange && passing.length === 1) {
      const line = passing[0];
      if (line.stationIds[0] !== station.id && line.stationIds[line.stationIds.length - 1] !== station.id) {
        return;
      }
    }

    const w = Math.max(36, Math.ceil(estimateTextWidth(station.name, fontSize) + 10));
    const h = Math.max(20, fontSize + 8);
    const gap = (isInterchange ? stylePreset.interchangeRadius : stylePreset.normalStationRadius) + 6;
    const candidates = [
      { key: 'right', x: station.x + gap, y: station.y - h / 2 },
      { key: 'left', x: station.x - w - gap, y: station.y - h / 2 },
      { key: 'top', x: station.x - w / 2, y: station.y - h - gap },
      { key: 'bottom', x: station.x - w / 2, y: station.y + gap },
      { key: 'top-right', x: station.x + gap, y: station.y - h - gap },
      { key: 'bottom-right', x: station.x + gap, y: station.y + gap },
      { key: 'top-left', x: station.x - w - gap, y: station.y - h - gap },
      { key: 'bottom-left', x: station.x - w - gap, y: station.y + gap }
    ].filter((c) => !station.labelPosition || station.labelPosition === 'auto' || c.key === station.labelPosition);

    let chosen = candidates[0];
    for (let i = 0; i < candidates.length; i += 1) {
      const box = { x: candidates[i].x, y: candidates[i].y, width: w, height: h };
      if (!occupiedBoxes.some((other) => overlaps(box, other))) {
        chosen = candidates[i];
        break;
      }
    }
    if (chosen) {
      occupiedBoxes.push({ x: chosen.x, y: chosen.y, width: w, height: h });
      const tx = chosen.x + w / 2;
      const ty = chosen.y + h / 2 + fontSize * 0.34;
      labelSvgElements.push(
        `  <text x="${fmt(tx)}" y="${fmt(ty)}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif" font-size="${fmt(fontSize)}" font-weight="${fontWeight}" fill="${escapeXml(labelColor)}" stroke="${escapeXml(labelHalo)}" stroke-width="3" paint-order="stroke fill">${escapeXml(station.name)}</text>`
      );
    }
  });

  // 终端线路名胶囊（环线则在起始站外侧放置一枚环线徽标）
  const pillSvgElements: string[] = [];
  if (mapSettings.showLineNameLabels) {
    lines.forEach((line) => {
      const lineSecs = validSections.filter((s) => s.lineId === line.id);
      const topo = deriveLineTopology(line, lineSecs);
      const ordered = topo.stationIds.map((id) => stationById.get(id)).filter(Boolean) as Station[];
      if (ordered.length < 2) return;

      const labelText = topo.isLoop && !/环/.test(line.name) ? `${line.name}·环线` : line.name;
      const pFont = stylePreset.lineLabelFontSize;
      const pw = Math.max(48, Math.ceil(estimateTextWidth(labelText, pFont) + stylePreset.lineLabelPaddingX * 2));
      const ph = pFont + stylePreset.lineLabelPaddingY * 2 + 2;

      const terminal = ordered[0];
      const neighbor = ordered[1];
      const dx = terminal.x - neighbor.x;
      const dy = terminal.y - neighbor.y;
      const len = Math.hypot(dx, dy) || 1;
      const ox = topo.isLoop ? -dy / len : dx / len;
      const oy = topo.isLoop ? dx / len : dy / len;
      const dist = stylePreset.interchangeRadius + 16;
      const hasCustomPos =
        line.labelPosition &&
        Number.isFinite(line.labelPosition.x) &&
        Number.isFinite(line.labelPosition.y);
      const cx = hasCustomPos ? line.labelPosition!.x : terminal.x + ox * (dist + pw / 2);
      const cy = hasCustomPos ? line.labelPosition!.y : terminal.y + oy * (dist + ph / 2);
      const rx = cx - pw / 2;
      const ry = cy - ph / 2;

      pillSvgElements.push(
        `  <g>`,
        `    <rect x="${fmt(rx)}" y="${fmt(ry)}" width="${fmt(pw)}" height="${fmt(ph)}" rx="${fmt(ph / 2)}" fill="${escapeXml(lineBadgeColors.fill)}" stroke="${escapeXml(line.color)}" stroke-width="${fmt(stylePreset.lineLabelStrokeWidth)}" />`,
        `    <text x="${fmt(cx)}" y="${fmt(cy + pFont * 0.35)}" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif" font-size="${fmt(pFont)}" font-weight="${stylePreset.lineLabelFontWeight}" fill="${escapeXml(lineBadgeColors.text)}">${escapeXml(labelText)}</text>`,
        `  </g>`
      );
    });
  }

  const lightCitySvg = isLightCity ? buildLightCitySvgLayer(mapSettings.baseMap.lightCity, isDark) : '';

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewX} ${viewY} ${viewW} ${viewH}" width="${viewW}" height="${viewH}">`,
    `  <rect x="${viewX}" y="${viewY}" width="${viewW}" height="${viewH}" fill="${escapeXml(bg)}" />`,
    ...(lightCitySvg ? [`  ${lightCitySvg}`] : []),
    ...lineSvgElements,
    ...pillSvgElements,
    ...stationSvgElements,
    ...labelSvgElements,
    `</svg>`
  ].join('\n');
}
