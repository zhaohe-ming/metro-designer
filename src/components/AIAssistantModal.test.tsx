import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import AIAssistantModal from './AIAssistantModal';
import { AIOperation } from '../api';

jest.mock('./DraggableModal', () => ({ open, children, title }: any) =>
  open ? (
    <div data-testid="ai-modal">
      <div data-testid="ai-modal-title">{title}</div>
      <div data-testid="ai-modal-body">{children}</div>
    </div>
  ) : null
);

function setNativeValue(element: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto =
    element instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('AIAssistantModal', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.clear();
    window.matchMedia = jest.fn().mockImplementation(() => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {}
    }));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  test('renders restrained prompt list, hides new-chat icon when empty, carries multi-turn operation context, and switches saved sessions', async () => {
    const receivedHistories: { role: 'user' | 'assistant'; content: string }[][] = [];
    const mockOp: AIOperation = {
      type: 'create_new_line_with_stations',
      name: '1号线',
      color: '#e11d48',
      stationNames: ['西站', '人民广场', '东站'],
      direction: 'east_west'
    };

    const onAnalyzeStream = jest.fn(async (messages, onDelta) => {
      receivedHistories.push(messages);
      onDelta('正在为你规划 1 号线…');
      return {
        explanation: '已规划东西向骨干 1 号线。',
        operations: [mockOp],
        summaries: ['新建线路「1号线」（#e11d48），依次设站：西站 → 人民广场 → 东站'],
        skippedCount: 0
      };
    });

    const onApply = jest.fn(() => 1);
    const onUndo = jest.fn();

    await act(async () => {
      root.render(
        <AIAssistantModal
          open
          busy={false}
          userId="u_test"
          mapKey="map_1"
          mapName="测试线网"
          lines={[]}
          stations={[]}
          canUndo
          onUndo={onUndo}
          onAnalyzeStream={onAnalyzeStream}
          onApply={onApply}
          onCancel={() => {}}
        />
      );
    });

    // 1. 空状态：左对齐“试试”快捷指令、地图名上下文、无旧版 ant-input-data-count、空会话时不显示禁用态新对话按钮
    expect(host.textContent).toContain('测试线网');
    expect(host.textContent).toContain('0 条线路 · 0 座车站');
    expect(host.textContent).toContain('试试');
    expect(host.querySelector('.ant-input-data-count')).toBeNull();
    expect(host.querySelector('button[aria-label="新对话"]')).toBeNull();

    // 2. 第一轮发送并应用到画布
    const textarea = host.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    await act(async () => {
      setNativeValue(textarea, '创建红色1号线');
    });
    expect(host.textContent).toContain('7/500');

    const sendBtn = host.querySelector('button[aria-label="发送消息"]') as HTMLButtonElement;
    await act(async () => {
      sendBtn.click();
    });

    expect(host.textContent).toContain('已规划东西向骨干 1 号线。');
    expect(host.querySelector('.metro-ai-color-chip')?.textContent).toContain('#e11d48');

    const applyBtn = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === '应用'
    ) as HTMLButtonElement;
    expect(applyBtn).toBeDefined();
    await act(async () => {
      applyBtn.click();
    });
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith([mockOp]);

    // 3. 第二轮连续追问：验证发给后端的上下文携带了第一轮已应用的操作摘要
    const textareaTurn2 = host.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      setNativeValue(textareaTurn2, '再往东延伸两站');
    });
    const sendBtnTurn2 = host.querySelector('button[aria-label="发送消息"]') as HTMLButtonElement;
    await act(async () => {
      sendBtnTurn2.click();
    });

    expect(onAnalyzeStream).toHaveBeenCalledTimes(2);
    expect(receivedHistories[1]).toHaveLength(3);
    expect(receivedHistories[1][1].role).toBe('assistant');
    expect(receivedHistories[1][1].content).toContain('用户已应用到画布');
    expect(receivedHistories[1][1].content).toContain('新建线路「1号线」');

    // 4. 点击图标按钮「新对话」开启新会话后，再从「对话记录」侧栏切回旧会话
    const newChatBtn = host.querySelector('button[aria-label="新对话"]') as HTMLButtonElement;
    expect(newChatBtn).not.toBeNull();
    await act(async () => {
      newChatBtn.click();
    });
    expect(host.textContent).toContain('试试');

    const historyBtn = host.querySelector('button[aria-label="对话记录"]') as HTMLButtonElement;
    await act(async () => {
      historyBtn.click();
    });
    const savedSessionItem = host.querySelector('.metro-ai-session-item') as HTMLElement;
    expect(savedSessionItem?.textContent).toContain('创建红色1号线');
    await act(async () => {
      savedSessionItem.click();
    });

    expect(host.textContent).toContain('再往东延伸两站');
  });
});
