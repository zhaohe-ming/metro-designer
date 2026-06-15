import { interpretCommand, tokenize, NAMED_COLORS, CommandContext } from './commandParser';

// 固定上下文夹具：含一条非空线、一条空线、两条同名线（线路消歧）；
// 站点含两个同名站（站点消歧）。
const ctx: CommandContext = {
  lines: [
    { id: 'L1', name: '1号线', color: '#1890ff', stationIds: ['A', 'B', 'C'] },
    { id: 'L2', name: '2号线', color: '#f5222d', stationIds: [] },
    { id: 'Ldup1', name: '环线', color: '#52c41a', stationIds: ['A', 'B'] },
    { id: 'Ldup2', name: '环线', color: '#faad14', stationIds: [] }
  ],
  stations: [
    { id: 'A', name: '甲', x: 0, y: 0 },
    { id: 'B', name: '乙', x: 100, y: 0 },
    { id: 'C', name: '丙', x: 200, y: 0 },
    { id: 'D', name: '丁', x: 300, y: 0 },
    { id: 'X1', name: '重名', x: 0, y: 0 },
    { id: 'X2', name: '重名', x: 5, y: 5 }
  ],
  currentLineId: 'L1'
};

describe('tokenize', () => {
  it('区分引号名、裸词、@id、"名"@前缀、坐标', () => {
    const t = tokenize('station "西 单" at 800,450');
    expect(t[0]).toMatchObject({ quoted: false, value: 'station' });
    expect(t[1]).toMatchObject({ quoted: true, value: '西 单' }); // 引号内含空格
    expect(t[2]).toMatchObject({ quoted: false, value: 'at' });
    expect(t[3]).toMatchObject({ quoted: false, value: '800,450' });

    const r = tokenize('recolor "环线"@Ldup1 blue');
    expect(r[1]).toMatchObject({ quoted: true, value: '环线', idHint: 'Ldup1' });

    const ref = tokenize('delete station @X2');
    expect(ref[2]).toMatchObject({ isRef: true, idHint: 'X2' });
  });
});

describe('NAMED_COLORS', () => {
  it('8 个命名色对齐 LINE_COLORS', () => {
    expect(Object.keys(NAMED_COLORS)).toHaveLength(8);
    expect(NAMED_COLORS.blue).toBe('#1890ff');
    expect(NAMED_COLORS.orange).toBe('#fa8c16');
  });
});

describe('interpretCommand — 线路', () => {
  it('create line → effect create_empty_line（命名色解析）', () => {
    const r = interpretCommand('create line "8号线" blue', ctx);
    expect(r.kind).toBe('effect');
    if (r.kind === 'effect' && r.effect.type === 'create_empty_line') {
      expect(r.effect.name).toBe('8号线');
      expect(r.effect.color).toBe('#1890ff');
    }
  });

  it('颜色支持序号与 hex，非法色报错', () => {
    const idx = interpretCommand('create line "x" 2', ctx);
    expect(idx.kind === 'effect' && idx.effect.type === 'create_empty_line' && idx.effect.color).toBe('#f5222d');
    const hex = interpretCommand('create line "x" #abcdef', ctx);
    expect(hex.kind === 'effect' && hex.effect.type === 'create_empty_line' && hex.effect.color).toBe('#abcdef');
    expect(interpretCommand('create line "x" mauve', ctx).kind).toBe('error');
  });

  it('line connect 空线 → effect connect 全部站', () => {
    const r = interpretCommand('line "2号线" connect "甲" "乙"', ctx);
    expect(r.kind).toBe('effect');
    if (r.kind === 'effect' && r.effect.type === 'connect') {
      expect(r.effect.lineId).toBe('L2');
      expect(r.effect.stationIds).toEqual(['A', 'B']);
    }
  });

  it('line connect 非空线：首站非端点报错；首站是端点放行', () => {
    expect(interpretCommand('line "1号线" connect "乙" "丁"', ctx).kind).toBe('error'); // 乙=B 非端点
    const ok = interpretCommand('line "1号线" connect "甲" "丁"', ctx); // 甲=A 是端点
    expect(ok.kind).toBe('effect');
  });

  it('connect（省略线名）作用于当前线路；无当前线路报错', () => {
    const r = interpretCommand('connect "甲" "丁"', ctx);
    expect(r.kind).toBe('effect');
    if (r.kind === 'effect' && r.effect.type === 'connect') expect(r.effect.lineId).toBe('L1');
    expect(interpretCommand('connect "甲" "乙"', { ...ctx, currentLineId: null }).kind).toBe('error');
  });

  it('connect 少于 2 站报错', () => {
    expect(interpretCommand('line "2号线" connect "甲"', ctx).kind).toBe('error');
  });

  it('extend → create_station_at_line_end；线路 <2 站报错', () => {
    const r = interpretCommand('extend "1号线" end "戊" "己"', ctx);
    expect(r.kind).toBe('ops');
    if (r.kind === 'ops' && r.ops[0].type === 'create_station_at_line_end') {
      expect(r.ops[0]).toMatchObject({ lineId: 'L1', position: 'end', names: ['戊', '己'] });
    }
    expect(interpretCommand('extend "2号线" end "戊"', ctx).kind).toBe('error'); // L2 空
  });

  it('recolor / rename line / delete line → ops', () => {
    expect(interpretCommand('recolor "1号线" red', ctx)).toMatchObject({ kind: 'ops' });
    expect(interpretCommand('rename line "1号线" "一线"', ctx)).toMatchObject({ kind: 'ops' });
    expect(interpretCommand('delete line "1号线"', ctx)).toMatchObject({ kind: 'ops' });
  });

  it('select → action（非撤销）', () => {
    const r = interpretCommand('select "2号线"', ctx);
    expect(r).toMatchObject({ kind: 'action', undoable: false });
    if (r.kind === 'action' && r.action.type === 'select_line') expect(r.action.lineId).toBe('L2');
  });
});

describe('interpretCommand — 站点', () => {
  it('station at → 绝对坐标；坐标缺一维报错', () => {
    const r = interpretCommand('station "西单" at 800,450', ctx);
    expect(r.kind).toBe('effect');
    if (r.kind === 'effect' && r.effect.type === 'add_station') {
      expect(r.effect).toMatchObject({ name: '西单', x: 800, y: 450 });
    }
    expect(interpretCommand('station "西单" at 800', ctx).kind).toBe('error');
  });

  it('station 相对 → 锚站 + 方向距离（up=−y、可叠加）', () => {
    const r = interpretCommand('station "新" right 300 up 100 from "甲"', ctx);
    expect(r.kind).toBe('effect');
    if (r.kind === 'effect' && r.effect.type === 'add_station') {
      expect(r.effect).toMatchObject({ name: '新', x: 300, y: -100 });
    }
  });

  it('相对放置缺 from / 缺方向报错', () => {
    expect(interpretCommand('station "新" right 300 "甲"', ctx).kind).toBe('error');
    expect(interpretCommand('station "新" from "甲"', ctx).kind).toBe('error');
  });

  it('insert → create_station_between', () => {
    const r = interpretCommand('insert "1号线" between "甲" "乙" "新1" "新2"', ctx);
    expect(r.kind).toBe('ops');
    if (r.kind === 'ops' && r.ops[0].type === 'create_station_between') {
      expect(r.ops[0]).toMatchObject({ lineId: 'L1', afterStationId: 'A', beforeStationId: 'B', names: ['新1', '新2'] });
    }
  });

  it('delete station → ops', () => {
    expect(interpretCommand('delete station "甲"', ctx)).toMatchObject({ kind: 'ops' });
  });
});

describe('interpretCommand — 途经点', () => {
  it('waypoint set → effect set_waypoints（多点）', () => {
    const r = interpretCommand('waypoint "1号线" between "甲" "乙" at 820,300 at 900,260', ctx);
    expect(r.kind).toBe('effect');
    if (r.kind === 'effect' && r.effect.type === 'set_waypoints') {
      expect(r.effect.points).toEqual([{ x: 820, y: 300 }, { x: 900, y: 260 }]);
    }
  });
  it('waypoint clear → effect clear_waypoints', () => {
    const r = interpretCommand('waypoint clear "1号线" between "甲" "乙"', ctx);
    expect(r).toMatchObject({ kind: 'effect' });
    if (r.kind === 'effect') expect(r.effect.type).toBe('clear_waypoints');
  });
});

describe('interpretCommand — 视图/设置/文件', () => {
  it('zoom 绝对/in/out；非法报错', () => {
    expect(interpretCommand('zoom 1.5', ctx)).toMatchObject({ kind: 'action' });
    const z = interpretCommand('zoom 1.5', ctx);
    if (z.kind === 'action' && z.action.type === 'zoom') expect(z.action.value).toBe(1.5);
    expect(interpretCommand('zoom in', ctx)).toMatchObject({ kind: 'action' });
    expect(interpretCommand('zoom 0', ctx).kind).toBe('error');
  });
  it('style/theme/corner → 可撤销 action；非法报错', () => {
    expect(interpretCommand('style dot', ctx)).toMatchObject({ kind: 'action', undoable: true });
    expect(interpretCommand('theme dark', ctx)).toMatchObject({ kind: 'action', undoable: true });
    expect(interpretCommand('corner 12', ctx)).toMatchObject({ kind: 'action', undoable: true });
    expect(interpretCommand('corner 99', ctx).kind).toBe('error');
    expect(interpretCommand('style foo', ctx).kind).toBe('error');
  });
  it('undo/redo/save/new/fit/reset → action', () => {
    for (const cmd of ['undo', 'redo', 'save', 'new', 'fit', 'reset']) {
      expect(interpretCommand(cmd, ctx)).toMatchObject({ kind: 'action' });
    }
  });
});

describe('interpretCommand — 引用消歧 & 错误', () => {
  it('重名线路报错并列候选；@前缀可消歧', () => {
    expect(interpretCommand('recolor "环线" blue', ctx).kind).toBe('error');
    const ok = interpretCommand('recolor "环线"@Ldup1 blue', ctx);
    expect(ok.kind).toBe('ops');
  });
  it('重名站点：报错；@前缀 / 裸@id 可消歧', () => {
    expect(interpretCommand('delete station "重名"', ctx).kind).toBe('error');
    expect(interpretCommand('delete station "重名"@X1', ctx).kind).toBe('ops');
    const byId = interpretCommand('delete station @X2', ctx);
    expect(byId.kind).toBe('ops');
    if (byId.kind === 'ops' && byId.ops[0].type === 'delete_station') expect(byId.ops[0].stationId).toBe('X2');
  });
  it('名字不加引号 → 报错（强制引号规则）', () => {
    expect(interpretCommand('recolor 1号线 blue', ctx).kind).toBe('error');
  });
  it('不存在的线/站 → 报错', () => {
    expect(interpretCommand('recolor "99号线" blue', ctx).kind).toBe('error');
    expect(interpretCommand('delete station "不存在"', ctx).kind).toBe('error');
  });
  it('help → guide；未知命令 → error', () => {
    expect(interpretCommand('help', ctx)).toMatchObject({ kind: 'guide' });
    const colors = interpretCommand('help colors', ctx);
    expect(colors).toMatchObject({ kind: 'guide' });
    if (colors.kind === 'guide') expect(colors.topic).toBe('colors');
    expect(interpretCommand('frobnicate', ctx).kind).toBe('error');
    expect(interpretCommand('', ctx).kind).toBe('error');
  });
});
