import {
  buildApiHistory,
  createEmptyAISession,
  deriveSessionTitle,
  loadAISessions,
  migrateDraftAISessions,
  saveAISessions
} from './aiSessionStore';

describe('aiSessionStore', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  test('persists, reloads, strips unfinished streaming placeholders, and migrates draft sessions', () => {
    const s1 = createEmptyAISession('draft', '未命名方案');
    s1.title = deriveSessionTitle('帮我创建一条红色的 1 号线并设 5 个站');
    s1.messages = [
      { role: 'user', id: 'u1', content: '帮我创建一条红色的 1 号线并设 5 个站', createdAt: 1000 },
      {
        role: 'assistant',
        id: 'a1',
        content: '已为你规划 1 号线。',
        createdAt: 1005,
        operations: [{ type: 'create_new_line_with_stations', name: '1号线', color: '#e11d48', stationNames: ['西站', '中心站'] }],
        summaries: ['新建线路「1号线」（#e11d48），含 2 站'],
        skippedCount: 0,
        applied: true,
        discarded: false
      },
      {
        role: 'assistant',
        id: 'a_dangling',
        content: '',
        createdAt: 1010,
        operations: [],
        summaries: [],
        skippedCount: 0,
        streaming: true,
        applied: false,
        discarded: false
      }
    ];
    saveAISessions('user_1', [s1]);

    const loaded = loadAISessions('user_1');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].messages).toHaveLength(2);
    expect(loaded[0].mapKey).toBe('draft');

    migrateDraftAISessions('user_1', 'draft', 'map_99', '天津地铁规划');
    const migrated = loadAISessions('user_1');
    expect(migrated[0].mapKey).toBe('map_99');
    expect(migrated[0].mapName).toBe('天津地铁规划');
  });

  test('buildApiHistory injects applied operation summaries and keeps clean user/assistant alternation', () => {
    const history = buildApiHistory(
      [
        { role: 'user', id: 'u1', content: '新建 1 号线', createdAt: 1 },
        {
          role: 'assistant',
          id: 'a1',
          content: '好的。',
          createdAt: 2,
          operations: [],
          summaries: ['新建线路「1号线」（#ef4444）'],
          skippedCount: 0,
          applied: true,
          discarded: false
        },
        { role: 'user', id: 'u_failed', content: '上次断网失败的提问', createdAt: 3 }
      ],
      '把刚刚那条线改成蓝色'
    );

    expect(history).toHaveLength(3);
    expect(history[0].role).toBe('user');
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toContain('用户已应用到画布');
    expect(history[1].content).toContain('新建线路「1号线」');
    expect(history[2]).toEqual({ role: 'user', content: '把刚刚那条线改成蓝色' });
  });
});
