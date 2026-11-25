import {
  interpretCommand,
  tokenize,
  splitCommandStatements,
  getCommandCompletions,
  NAMED_COLORS,
  CommandContext
} from './commandParser';

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

describe('tokenize & splitCommandStatements', () => {
  it('区分引号名、全角中文引号、裸词、@id、裸写@前缀、坐标', () => {
    const t = tokenize('station "西 单" at 800,450');
    expect(t[0]).toMatchObject({ quoted: false, value: 'station' });
    expect(t[1]).toMatchObject({ quoted: true, value: '西 单' });
    expect(t[2]).toMatchObject({ quoted: false, value: 'at' });
    expect(t[3]).toMatchObject({ quoted: false, value: '800,450' });

    const zhQuote = tokenize('recolor “环线”@Ldup1 蓝');
    expect(zhQuote[1]).toMatchObject({ quoted: true, value: '环线', idHint: 'Ldup1' });

    const bareHint = tokenize('recolor 环线@Ldup1 blue');
    expect(bareHint[1]).toMatchObject({ quoted: false, value: '环线', idHint: 'Ldup1' });

    const ref = tokenize('delete station @X2');
    expect(ref[2]).toMatchObject({ isRef: true, idHint: 'X2' });
  });

  it('splitCommandStatements 按分号或换行拆分多命令，保留引号内分号', () => {
    const parts = splitCommandStatements('line 1号线 red 西站 东站；loop 4号线 purple A B C; rename station A "甲;站"');
    expect(parts).toEqual([
      'line 1号线 red 西站 东站',
      'loop 4号线 purple A B C',
      'rename station A "甲;站"'
    ]);
  });
});

describe('NAMED_COLORS', () => {
  it('8 个命名色对齐 LINE_COLORS', () => {
    expect(Object.keys(NAMED_COLORS)).toHaveLength(8);
    expect(NAMED_COLORS.blue).toBe('#1890ff');
    expect(NAMED_COLORS.orange).toBe('#fa8c16');
  });
});

describe('interpretCommand — 线路与 2.0 快捷建网', () => {
  it('create line → 空线路或带站一键建线', () => {
    const r = interpretCommand('create line "8号线" blue', ctx);
    expect(r.kind).toBe('effect');
    if (r.kind === 'effect' && r.effect.type === 'create_empty_line') {
      expect(r.effect.name).toBe('8号线');
      expect(r.effect.color).toBe('#1890ff');
    }
  });

  it('2.0 免引号一行建干线、建环线、拉支线、闭环、合站', () => {
    // 一行建干线（免引号 + 中文色名）
    const oneShot = interpretCommand('line 3号线 红 西站 市民中心 人民广场 东站', ctx);
    expect(oneShot.kind).toBe('ops');
    if (oneShot.kind === 'ops' && oneShot.ops[0].type === 'create_new_line_with_stations') {
      expect(oneShot.ops[0]).toMatchObject({
        name: '3号线',
        color: '#f5222d',
        stationNames: ['西站', '市民中心', '人民广场', '东站']
      });
    }

    // 一行建环线
    const loopCmd = interpretCommand('loop 4号线 purple 金融城 会展中心 体育馆 北站', ctx);
    expect(loopCmd.kind).toBe('ops');
    if (loopCmd.kind === 'ops' && loopCmd.ops[0].type === 'create_loop_line') {
      expect(loopCmd.ops[0].stationNames).toEqual(['金融城', '会展中心', '体育馆', '北站']);
    }

    // 一行拉支线
    const branchCmd = interpretCommand('branch 1号线 from 乙 软件园 空港', ctx);
    expect(branchCmd.kind).toBe('ops');
    if (branchCmd.kind === 'ops' && branchCmd.ops[0].type === 'create_branch_line') {
      expect(branchCmd.ops[0]).toMatchObject({
        lineId: 'L1',
        branchFromStationId: 'B',
        newStationNames: ['软件园', '空港']
      });
    }

    // 首尾闭环
    const closeCmd = interpretCommand('close 1号线', ctx);
    expect(closeCmd).toMatchObject({ kind: 'ops', ops: [{ type: 'close_line_loop', lineId: 'L1' }] });

    // 两站合并换乘
    const mergeCmd = interpretCommand('merge 重名@X1 重名@X2', ctx);
    expect(mergeCmd).toMatchObject({
      kind: 'ops',
      ops: [{ type: 'merge_stations', sourceStationId: 'X1', targetStationId: 'X2' }]
    });
  });

  it('颜色支持序号、#rgb、#rrggbb 与中文色名，非法色报错', () => {
    const idx = interpretCommand('create line x 2', ctx);
    expect(idx.kind === 'effect' && idx.effect.type === 'create_empty_line' && idx.effect.color).toBe('#f5222d');
    const hex = interpretCommand('create line x #abcdef', ctx);
    expect(hex.kind === 'effect' && hex.effect.type === 'create_empty_line' && hex.effect.color).toBe('#abcdef');
    expect(interpretCommand('create line x mauve', ctx).kind).toBe('error');
  });

  it('line connect 空线与非空线校验', () => {
    const r = interpretCommand('line 2号线 connect 甲 乙', ctx);
    expect(r.kind).toBe('effect');
    if (r.kind === 'effect' && r.effect.type === 'connect') {
      expect(r.effect.lineId).toBe('L2');
      expect(r.effect.stationIds).toEqual(['A', 'B']);
    }
    expect(interpretCommand('line "1号线" connect "乙" "丁"', ctx).kind).toBe('error');
    expect(interpretCommand('line "1号线" connect "甲" "丁"', ctx).kind).toBe('effect');
  });

  it('extend / recolor / rename / delete / select 免引号与引号双兼容', () => {
    const ext = interpretCommand('extend 1号线 end 戊 己', ctx);
    expect(ext.kind).toBe('ops');
    expect(interpretCommand('recolor 1号线 blue', ctx)).toMatchObject({ kind: 'ops' });
    expect(interpretCommand('recolor “1号线” 绿', ctx)).toMatchObject({ kind: 'ops' });
    expect(interpretCommand('rename line 1号线 一线', ctx)).toMatchObject({ kind: 'ops' });
    expect(interpretCommand('delete line 1号线', ctx)).toMatchObject({ kind: 'ops' });
    expect(interpretCommand('select 2号线', ctx)).toMatchObject({ kind: 'action', undoable: false });
  });
});

describe('interpretCommand — 站点、途经点、轻城市与 AI 穿透', () => {
  it('station 绝对与相对放置、insert 插站', () => {
    const r = interpretCommand('station 西单 at 800,450', ctx);
    expect(r.kind).toBe('effect');
    if (r.kind === 'effect' && r.effect.type === 'add_station') {
      expect(r.effect).toMatchObject({ name: '西单', x: 800, y: 450 });
    }
    const rel = interpretCommand('station 新站 right 300 up 100 from 甲', ctx);
    if (rel.kind === 'effect' && rel.effect.type === 'add_station') {
      expect(rel.effect).toMatchObject({ name: '新站', x: 300, y: -100 });
    }
    const ins = interpretCommand('insert 1号线 between 甲 乙 新1 新2', ctx);
    expect(ins.kind).toBe('ops');
  });

  it('waypoint / waypoints / city / preset / zoom / style / theme / corner', () => {
    expect(interpretCommand('waypoint 1号线 between 甲 乙 at 820,300 at 900,260', ctx).kind).toBe('effect');
    expect(interpretCommand('waypoint clear 1号线 between 甲 乙', ctx).kind).toBe('effect');
    expect(interpretCommand('waypoints hide', ctx)).toMatchObject({
      kind: 'ops',
      ops: [{ type: 'configure_map', hideWaypoints: true }]
    });
    expect(interpretCommand('city confluence', ctx)).toMatchObject({
      kind: 'ops',
      ops: [{ type: 'configure_map', lightCityArchetype: 'confluence' }]
    });
    expect(interpretCommand('city 海湾', ctx)).toMatchObject({
      kind: 'ops',
      ops: [{ type: 'configure_map', lightCityArchetype: 'bay' }]
    });
    expect(interpretCommand('preset mtr', ctx)).toMatchObject({
      kind: 'ops',
      ops: [{ type: 'configure_map', cityStyle: 'mtr' }]
    });
    expect(interpretCommand('zoom 1.5', ctx)).toMatchObject({ kind: 'action' });
    expect(interpretCommand('theme dark', ctx)).toMatchObject({ kind: 'action', undoable: true });
    expect(interpretCommand('corner 16', ctx)).toMatchObject({ kind: 'action', undoable: true });
  });

  it('ai / ? 前缀直通 AI 规划，自然语言错敲进命令框时返回 aiPromptSuggestion', () => {
    const aiCmd = interpretCommand('ai 给所有默认站按江南水乡风格起名', ctx);
    expect(aiCmd).toMatchObject({ kind: 'ai', prompt: '给所有默认站按江南水乡风格起名' });

    const qCmd = interpretCommand('? 帮我规划一条过江环线', ctx);
    expect(qCmd).toMatchObject({ kind: 'ai', prompt: '帮我规划一条过江环线' });

    const nlFallback = interpretCommand('帮我把1号线往东延伸3站过江', ctx);
    expect(nlFallback.kind).toBe('error');
    if (nlFallback.kind === 'error') {
      expect(nlFallback.aiPromptSuggestion).toBe('帮我把1号线往东延伸3站过江');
    }
  });

  it('getCommandCompletions 根据参数位置动态补全动词、已有线路名、色值与站点名', () => {
    const verbSug = getCommandCompletions('br', ctx);
    expect(verbSug[0]?.label).toBe('branch');

    const lineSug = getCommandCompletions('extend 1', ctx);
    expect(lineSug.some((s) => s.label === '1号线' && s.swatch === '#1890ff')).toBe(true);

    const colorSug = getCommandCompletions('recolor 1号线 pu', ctx);
    expect(colorSug[0]?.label).toBe('purple');

    const stSug = getCommandCompletions('branch 1号线 from ', ctx);
    expect(stSug.some((s) => s.label === '甲')).toBe(true);
  });

  it('重名线路与重名站点消歧、未知命令报错', () => {
    expect(interpretCommand('recolor 环线 blue', ctx).kind).toBe('error');
    expect(interpretCommand('recolor 环线@Ldup1 blue', ctx).kind).toBe('ops');
    expect(interpretCommand('delete station 重名', ctx).kind).toBe('error');
    expect(interpretCommand('delete station 重名@X1', ctx).kind).toBe('ops');
    expect(interpretCommand('delete station @X2', ctx).kind).toBe('ops');
    expect(interpretCommand('help', ctx)).toMatchObject({ kind: 'guide' });
    expect(interpretCommand('frobnicate', ctx).kind).toBe('error');
  });
});
