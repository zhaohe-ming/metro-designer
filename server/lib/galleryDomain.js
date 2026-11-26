const crypto = require('crypto');
const { normalizeMapSettings } = require('./mapSettings');
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const text = (value, max, required = false) => {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw fail('作品信息格式无效');
  return value.trim();
};
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 128;
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e8;
const xml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
const color = value => /^#[a-fA-F0-9]{6}$/.test(value) ? value : '#2563eb';
function metadata(raw) {
  if (!raw || !['real', 'fictional', 'concept'].includes(raw.category)) throw fail('请选择作品类型');
  const crop = raw.coverCrop || {};
  return { title: text(raw.title, 60, true), description: text(raw.description || '', 800), city: text(raw.city || '', 40),
    category: raw.category, allowFork: raw.allowFork === true, includeNotes: raw.includeNotes === true,
    coverCrop: { zoom: Math.max(1, Math.min(3, Number(crop.zoom) || 1)), x: Math.max(-1, Math.min(1, Number(crop.x) || 0)), y: Math.max(-1, Math.min(1, Number(crop.y) || 0)) } };
}
function snapshot(map, includeNotes) {
  if (!Array.isArray(map.lines) || !map.lines.length || map.lines.length > 80 || !Array.isArray(map.stations) || map.stations.length < 2 ||
    map.stations.length > 5000 || !Array.isArray(map.sections) || !map.sections.length || map.sections.length > 15000) throw fail('请提供完整线网，最多80条线路、5000座站点');
  const ids = list => {
    const set = new Set(); list.forEach(item => { if (!item || !validId(item.id) || set.has(item.id)) throw fail('地图存在重复或无效标识'); set.add(item.id); }); return set;
  };
  const stationIds = ids(map.stations), lineIds = ids(map.lines); ids(map.sections);
  const point = source => {
    if (!finite(source.x) || !finite(source.y)) throw fail('地图中存在无效坐标');
    const result = { x: source.x, y: source.y };
    if (Number.isFinite(source.lng) && Number.isFinite(source.lat) && Math.abs(source.lng) <= 180 && Math.abs(source.lat) <= 85.05112878) Object.assign(result, { lng: source.lng, lat: source.lat });
    return result;
  };
  const VALID_LABEL_POS = ['auto','top','right','bottom','left','top-left','top-right','bottom-left','bottom-right','hidden'];
  const stations = map.stations.map(item => ({ id: item.id, name: text(item.name, 80, true), ...point(item),
    labelPosition: VALID_LABEL_POS.includes(item.labelPosition) ? item.labelPosition : 'auto',
    ...(includeNotes && typeof item.note === 'string' ? { note: item.note.slice(0, 2000) } : {}) }));
  const cleanWaypoint = wp => {
    const base = { ...point(wp) };
    if (wp.hidden === true) base.hidden = true;
    if (typeof wp.radius === 'number' && Number.isFinite(wp.radius) && wp.radius >= 0 && wp.radius <= 2000) {
      base.radius = Math.round(wp.radius * 100) / 100;
    }
    if (wp.mode === 'corner' || wp.mode === 'arc') {
      base.mode = wp.mode;
    }
    return base;
  };
  const sections = map.sections.map(item => {
    if (!lineIds.has(item.lineId) || !stationIds.has(item.startStationId) || !stationIds.has(item.endStationId)) throw fail('地图存在缺失的线路或站点连接');
    if (item.waypoints !== undefined && (!Array.isArray(item.waypoints) || item.waypoints.length > 300)) throw fail('区间折点格式无效');
    const parallelOrder = Array.isArray(item.parallelOrder)
      ? [...new Set(item.parallelOrder.filter(id => typeof id === 'string' && lineIds.has(id)))].slice(0, 16)
      : [];
    return { id: item.id, lineId: item.lineId, startStationId: item.startStationId, endStationId: item.endStationId,
      ...(item.waypoints?.length ? { waypoints: item.waypoints.map(cleanWaypoint) } : {}),
      ...(parallelOrder.length >= 2 ? { parallelOrder } : {}) };
  });
  const lines = map.lines.map(item => {
    if (!Array.isArray(item.stationIds) || !item.stationIds.every(id => stationIds.has(id))) throw fail('线路的站点列表无效');
    const customLabel = item.labelPosition && typeof item.labelPosition === 'object' && finite(item.labelPosition.x) && finite(item.labelPosition.y)
      ? point(item.labelPosition)
      : undefined;
    return {
      id: item.id,
      name: text(item.name, 60, true),
      color: color(item.color),
      stationIds: [...item.stationIds],
      sectionIds: sections.filter(edge => edge.lineId === item.id).map(edge => edge.id),
      ...(customLabel ? { labelPosition: customLabel } : {})
    };
  });
  const mapSettings = normalizeMapSettings(map.mapSettings);
  if (mapSettings.baseMap.mode === 'amap' && [...stations, ...sections.flatMap(edge => edge.waypoints || [])].some(item => !Number.isFinite(item.lng) || !Number.isFinite(item.lat))) throw fail('高德线网含有缺少经纬度的站点或折点，请补齐后发布');
  return { lines, stations, sections, mapSettings };
}
const project = (lng, lat, zoom) => { const s = Math.sin(lat * Math.PI / 180), size = 256 * 2 ** zoom;
  return { x: (lng + 180) / 360 * size, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size }; };
const unproject = (x, y, zoom) => { const size = 256 * 2 ** zoom; return [Number((x / size * 360 - 180).toFixed(6)), Number((Math.atan(Math.sinh(Math.PI * (1 - 2 * y / size))) * 180 / Math.PI).toFixed(6))]; };
function buildRoundedRouteSvgPath(pts, radii, defaultR) {
  if (pts.length < 2) return '';
  if (pts.length === 2) return `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)} L ${pts[1].x.toFixed(2)} ${pts[1].y.toFixed(2)}`;
  const d = [`M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`];
  for (let i = 1; i < pts.length - 1; i += 1) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    const rWanted = radii[i] !== undefined ? radii[i] : defaultR;
    const v1x = p0.x - p1.x, v1y = p0.y - p1.y;
    const v2x = p2.x - p1.x, v2y = p2.y - p1.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    if (!rWanted || rWanted <= 0.5 || l1 < 1 || l2 < 1) {
      d.push(`L ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`);
      continue;
    }
    const cosA = Math.max(-0.999, Math.min(0.999, (v1x * v2x + v1y * v2y) / (l1 * l2)));
    const halfAngle = Math.acos(cosA) / 2;
    const tanHalf = Math.tan(halfAngle);
    if (tanHalf <= 1e-3) {
      d.push(`L ${p1.x.toFixed(2)} ${p1.y.toFixed(2)}`);
      continue;
    }
    const trim = Math.min(rWanted / tanHalf, l1 * 0.48, l2 * 0.48);
    const actualR = trim * tanHalf;
    const sX = p1.x + (v1x / l1) * trim, sY = p1.y + (v1y / l1) * trim;
    const eX = p1.x + (v2x / l2) * trim, eY = p1.y + (v2y / l2) * trim;
    const cross = (-v1x) * v2y - (-v1y) * v2x;
    const sweep = cross >= 0 ? 1 : 0;
    d.push(`L ${sX.toFixed(2)} ${sY.toFixed(2)}`);
    d.push(`A ${actualR.toFixed(2)} ${actualR.toFixed(2)} 0 0 ${sweep} ${eX.toFixed(2)} ${eY.toFixed(2)}`);
  }
  const last = pts[pts.length - 1];
  d.push(`L ${last.x.toFixed(2)} ${last.y.toFixed(2)}`);
  return d.join(' ');
}
function artwork(work, baseImage, baseAttribution = '© OpenStreetMap') {
  const graph = work.snapshot, dark = graph.mapSettings.canvasTheme === 'dark';
  const geo = graph.mapSettings.baseMap.mode === 'amap';
  const points = [...graph.stations, ...graph.sections.flatMap(edge => edge.waypoints || [])];
  if (points.length > 30000) throw fail('线网折点较多，请精简至30000个节点以内');
  const projected = points.map(item => geo ? project(item.lng, item.lat, 12) : item);
  const bounds = { left: Math.min(...projected.map(p => p.x)), right: Math.max(...projected.map(p => p.x)), top: Math.min(...projected.map(p => p.y)), bottom: Math.max(...projected.map(p => p.y)) };
  const crop = work.coverCrop || { zoom: 1, x: 0, y: 0 };
  const width = 768, height = 480;
  const fitScale = Math.min(650 / Math.max(1, bounds.right - bounds.left), 360 / Math.max(1, bounds.bottom - bounds.top));
  const center = { x: (bounds.left + bounds.right) / 2 + (crop.x || 0) * (bounds.right - bounds.left) * .35,
    y: (bounds.top + bounds.bottom) / 2 + (crop.y || 0) * (bounds.bottom - bounds.top) * .35 };
  const zoom = geo ? Math.max(1, Math.min(17, 12 + Math.floor(Math.log2(fitScale * crop.zoom)))) : 12;
  const geoCenter = geo ? unproject(center.x, center.y, 12) : null;
  const actualCenter = geo ? project(...geoCenter, zoom) : center;
  const scale = geo ? 1 : fitScale * crop.zoom;
  const pos = item => { const p = geo ? project(item.lng, item.lat, zoom) : item; return { x: (p.x - actualCenter.x) * scale + width/2, y: (p.y - actualCenter.y) * scale + height/2 }; };
  const byId = new Map(graph.stations.map(station => [station.id, station]));
  const memberships = new Map(); const terminals = new Set();
  graph.lines.forEach(line => { terminals.add(line.stationIds[0]); terminals.add(line.stationIds[line.stationIds.length-1]); line.stationIds.forEach(id => { if(!memberships.has(id)) memberships.set(id,new Set());memberships.get(id).add(line.color); }); });
  const lineById = new Map(graph.lines.map(line => [line.id,line]));
  const defaultCornerR = (graph.mapSettings.cornerRadius || 0) * scale;
  const routes = graph.sections.map(edge => {
    const wps = edge.waypoints || [];
    const pts = [byId.get(edge.startStationId), ...wps, byId.get(edge.endStationId)].map(pos);
    const radii = [0, ...wps.map(wp => typeof wp.radius === 'number' ? wp.radius * scale : undefined), 0];
    const d = buildRoundedRouteSvgPath(pts, radii, defaultCornerR);
    return `<path d="${d}" fill="none" stroke="${color(lineById.get(edge.lineId).color)}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join('');
  const labels = [], occupied = [];
  const labelIds=new Set(graph.stations.filter(st=>st.labelPosition!=='hidden'&&(terminals.has(st.id)||(memberships.get(st.id)?.size||0)>1))
    .sort((a,b)=>(memberships.get(b.id)?.size||0)-(memberships.get(a.id)?.size||0)).slice(0,18).map(st=>st.id));
  const dots = graph.stations.map(station => {
    const p=pos(station), colors=[...(memberships.get(station.id) || [])], transfer=colors.length>1;
    if (labelIds.has(station.id)) {
      const labelWidth=station.name.length*17, choices=[[p.x-labelWidth/2,p.y-15],[p.x+14,p.y+6],[p.x-labelWidth/2,p.y+28]];
      const choice=choices.find(([x,y])=>x>=8&&x+labelWidth<width-8&&y>15&&y<height-14&&!occupied.some(r=>x<r.x+r.w&&x+labelWidth>r.x&&y-17<r.y+20&&y+3>r.y));
      if(choice){occupied.push({x:choice[0],y:choice[1]-17,w:labelWidth});labels.push(`<text x="${choice[0].toFixed(1)}" y="${choice[1].toFixed(1)}" font-size="17" font-weight="600" fill="${dark?'#f8fafc':'#0f172a'}" stroke="${dark?'#0b2035':'#ffffff'}" stroke-width="3" paint-order="stroke">${xml(station.name)}</text>`);}
    }
    return `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="${transfer?6:3.2}" fill="${dark?'#0b2035':'#ffffff'}" stroke="${transfer?(dark?'#ffffff':'#18344b'):color(colors[0])}" stroke-width="${transfer?1.7:1.5}"/>`;
  }).join('');
  const lc = !geo && graph.mapSettings.baseMap.mode === 'light-city' ? graph.mapSettings.baseMap.lightCity : null;
  const lcSvg = lc && Array.isArray(lc.features) ? lc.features.map(f => {
    if (f.type === 'zone' && lc.layerVisibility?.zones !== false) {
      const fill = f.kind === 'park' ? (dark ? '#132620' : '#dfece3') : f.kind === 'island' ? (dark ? '#0f172a' : '#f6f7f9') : (dark ? '#141e30' : '#eceff4');
      return `<polygon points="${f.points.map(pos).map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="${fill}"/>`;
    }
    if (f.type === 'waterArea' && lc.layerVisibility?.water !== false) {
      return `<polygon points="${f.points.map(pos).map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="${dark ? '#0f2942' : '#cbe2f4'}"/>`;
    }
    if (f.type === 'river' && lc.layerVisibility?.water !== false) {
      return `<polyline points="${f.points.map(pos).map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="${dark ? '#0f2942' : '#cbe2f4'}" stroke-width="${Math.max(2, f.width * scale).toFixed(1)}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    return '';
  }).join('') : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(work.title)}"><rect width="100%" height="100%" fill="${lc?(dark?'#0f172a':'#f6f7f9'):(dark?'#0b2035':'#f8fbfd')}"/>${baseImage?`<image href="${baseImage}" width="768" height="480"/>`:''}${lcSvg?`<g opacity="${lc.opacity??1}">${lcSvg}</g>`:''}<g font-family="Microsoft YaHei,PingFang SC,sans-serif">${routes}${dots}${labels.join('')}</g>${baseImage?`<text x="754" y="470" font-size="10" fill="#18344b" text-anchor="end">${xml(baseAttribution)}</text>`:''}</svg>`;
  return { svg, staticMap: geo ? { center: geoCenter, zoom, width, height } : null };
}
function summary(work, owner = false) {
  const data = owner ? (work.pending || work.published) : work.published;
  if (!data) return null;
  const { snapshot, cover, includeNotes, ...info } = data;
  return { ...info, id: work.id, featured: work.featured, example: work.example, visibility: work.visibility,
    ...(owner ? { sourceMapId: work.sourceMapId, hasPublished: Boolean(work.published), reviewStatus: work.reviewStatus, reviewNote: work.reviewNote || '' } : {}),
    publishedAt: work.publishedAt, updatedAt: work.updatedAt };
}
function publication(raw, graph, author, origin) {
  const meta = metadata(raw), clean = snapshot(graph, meta.includeNotes);
  return { ...meta, snapshot: clean, author, revision: crypto.randomUUID(),
    counts: { lines: clean.lines.length, stations: clean.stations.length, sections: clean.sections.length },
    baseMap: clean.mapSettings.baseMap.mode, ...(origin ? { origin } : {}) };
}
module.exports = { fail, metadata, snapshot, artwork, summary, publication };
