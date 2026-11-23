// 六份真实可编辑的架空城市线网，封面与预览均由同一份几何生成。
const palette = ['#2563eb', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#06b6d4', '#ef4444', '#84cc16'];
const names = ['青石路', '文昌街', '湖畔', '北苑', '南园', '星光路', '大学城', '科技园', '博物馆', '体育中心', '东岸', '西园', '滨江', '书院', '文化宫', '会展中心', '云桥', '新城', '春晓', '秋实', '松林', '海棠', '白鹭', '花港'];
function network(id, title, description, routes, landmarks = {}, dark = false) {
  const stations = [], sections = [], pointMap = new Map();
  const station = (x, y) => {
    const key = `${Math.round(x)},${Math.round(y)}`;
    if (!pointMap.has(key)) {
      const index = stations.length;
      const item = { id: `${id}-s${index}`, x: Math.round(x), y: Math.round(y),
        name: landmarks[key] || `${names[index % names.length]}${index >= names.length ? Math.floor(index / names.length) + 1 : ''}`, labelPosition: 'auto' };
      stations.push(item); pointMap.set(key, item.id);
    }
    return pointMap.get(key);
  };
  const lines = routes.map((anchors, index) => {
    const stationIds = [];
    for (let i = 0; i < anchors.length; i++) {
      const [x, y] = anchors[i];
      if (!i) { stationIds.push(station(x, y)); continue; }
      const [px, py] = anchors[i - 1];
      const count = Math.max(1, Math.round(Math.hypot(x - px, y - py) / 85));
      for (let step = 1; step <= count; step++) {
        const next = station(px + (x - px) * step / count, py + (y - py) * step / count);
        if (stationIds[stationIds.length - 1] !== next) stationIds.push(next);
      }
    }
    const lineId = `${id}-l${index + 1}`;
    const sectionIds = stationIds.slice(1).map((end, n) => {
      const sectionId = `${lineId}-e${n}`;
      sections.push({ id: sectionId, lineId, startStationId: stationIds[n], endStationId: end });
      return sectionId;
    });
    return { id: lineId, name: index === routes.length - 1 && anchors[0][0] === anchors[anchors.length - 1][0] && anchors[0][1] === anchors[anchors.length - 1][1] ? '环线' : `${index + 1}号线`,
      color: palette[index % palette.length], stationIds, sectionIds };
  });
  return { id: `example-${id}`, title, description: `${description}\n这是可自由复制的架空设计示例，线路和站名均为虚构。`, category: 'fictional', coverCrop: { zoom: 1.22, x: 0, y: 0 }, city: '',
    author: { name: 'Metro Designer 示例', avatar: '', official: true }, allowFork: true, includeNotes: false, featured: true, example: true,
    snapshot: { lines, stations, sections, mapSettings: { mapStyle: 'dot-label', canvasTheme: dark ? 'dark' : 'light', cityStyle: 'standard',
      showLineNameLabels: true, dotLabelStyle: { fontSize: 13, fontWeight: 700, color: dark ? '#f8fafc' : '#0f172a' },
      labelDensity: 'key', cornerRadius: 16, baseMap: { mode: 'plain', amap: { center: [116.397428, 39.90923], zoom: 11, style: 'normal' } } } } };
}
const cloud = [
  [[80,440],[360,440],[520,440],[760,440],[920,280],[1160,280]],
  [[520,80],[520,280],[520,440],[520,680],[360,840]],
  [[120,280],[360,280],[520,440],[760,440],[920,600],[1160,600]],
  [[280,80],[280,200],[360,280],[360,440],[360,680],[520,840]],
  [[80,680],[360,680],[520,680],[760,680],[920,840]],
  [[760,80],[760,280],[760,440],[760,680],[760,840]],
  [[80,120],[200,120],[360,280],[520,280],[760,280],[920,120],[1160,120]],
  [[160,840],[360,680],[360,440],[360,280],[520,120],[760,120],[920,280],[920,600],[760,760],[520,760],[360,680]]
];
const ring = [
  [[360,200],[760,200],[920,360],[920,600],[760,760],[360,760],[200,600],[200,360],[360,200]],
  [[80,440],[200,440],[520,440],[920,440],[1160,440]],
  [[520,80],[520,200],[520,440],[520,760],[520,880]],
  [[120,120],[360,360],[520,440],[760,680],[960,880]],
  [[1040,80],[760,360],[520,440],[280,680],[80,880]],
  [[120,600],[200,600],[520,600],[920,600],[1120,800]],
  [[360,80],[360,200],[360,440],[360,760],[360,880]]
];
module.exports = [
  network('yunchuan', '云川轨道交通线网', '八条线路串起老城、新城与两岸生活。放射与环线结合，体验多层次的换乘组织。', cloud,
    { '520,440': '云川站', '520,280': '中央公园', '760,280': '云川大学', '360,680': '南客站', '760,680': '新城', '520,80': '云川北站' }),
  network('huanwan', '环湾都市圈', '围绕城市中心构建一条完整环线，让放射线路在外围形成更多连接。', ring,
    { '520,440': '湾心广场', '520,200': '北城', '920,440': '东湾', '360,760': '南港' }, true),
  network('shanhai', '山海市轨道交通', '以两条横向主轴连接山前组团和沿海新城，斜向线路补上跨组团联系。',
    [...cloud.slice(0, 6), [[80,840],[360,680],[520,440],[760,280],[920,120]], [[200,80],[360,280],[520,280],[760,440],[920,600],[1160,840]], ring[0]],
    { '520,440': '山海中心', '920,600': '东港', '360,280': '山前', '760,280': '滨海广场' }),
  network('chenghu', '澄湖轨道 · 极简版', '五条清晰的线路，围绕主要节点组织换乘，适合作为自己的第一份线网模板。',
    [cloud[0], cloud[1], cloud[2], cloud[5], cloud[4]], { '520,440': '澄湖中心', '760,440': '湖东', '360,680': '大学城' }),
  network('xinggang', '星港轨道 · 夜间图', '在深色图面上强调线路颜色与换乘层级，适合制作夜间风格的线网展示。',
    [ring[1], ring[2], ring[3], ring[4], ring[5], cloud[6]], { '520,440': '星港站', '760,360': '中央商务区', '520,760': '南星港' }, true),
  network('linjiang', '林江都市圈 · 双核连接', '两个中心通过多条走廊联系，在中间组团形成换乘，体验双核都市圈的线网结构。',
    [cloud[0], cloud[2], cloud[6], [[280,80],[280,280],[360,440],[360,680],[360,840]], cloud[5], ring[5]],
    { '360,440': '林江站', '760,440': '江东站', '520,280': '中央公园', '520,600': '会展中心' })
];
