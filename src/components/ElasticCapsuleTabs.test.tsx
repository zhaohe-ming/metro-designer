import React, { act, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import ElasticCapsuleTabs from './ElasticCapsuleTabs';

const BUTTON_METRICS = [
  { left: 3, width: 48 },
  { left: 53, width: 48 },
  { left: 103, width: 92 }
];

describe('ElasticCapsuleTabs', () => {
  let host: HTMLDivElement;
  let root: Root;
  const onChangeSpy = jest.fn();

  function Harness({ initial = 'light' }: { initial?: 'light' | 'dark' | 'system' }) {
    const [val, setVal] = useState<'light' | 'dark' | 'system'>(initial);
    return (
      <ElasticCapsuleTabs
        ariaLabel="界面主题"
        value={val}
        onChange={(next) => {
          onChangeSpy(next);
          setVal(next);
        }}
        options={[
          { value: 'light', label: '浅色' },
          { value: 'dark', label: '深色' },
          { value: 'system', label: '跟随系统' }
        ]}
      />
    );
  }

  const getTray = () => host.firstElementChild as HTMLDivElement;

  const firePointer = (type: string, clientX: number, id = 1) => {
    const evt = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 16 });
    Object.defineProperties(evt, { pointerId: { value: id }, isPrimary: { value: true } });
    act(() => {
      getTray().dispatchEvent(evt);
    });
  };

  beforeEach(() => {
    jest.useFakeTimers();
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    onChangeSpy.mockClear();

    window.matchMedia = jest.fn().mockImplementation(() => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {}
    }));
    (global as any).ResizeObserver = class {
      observe() {}
      disconnect() {}
      unobserve() {}
    };

    jest.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.parentElement || !this.classList.contains('metro-elastic-tabs__btn')) return 0;
      const idx = Array.from(this.parentElement.children).indexOf(this);
      return BUTTON_METRICS[idx]?.left ?? 0;
    });
    jest.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.parentElement || !this.classList.contains('metro-elastic-tabs__btn')) return 198;
      const idx = Array.from(this.parentElement.children).indexOf(this);
      return BUTTON_METRICS[idx]?.width ?? 50;
    });
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (!this.parentElement || !this.classList.contains('metro-elastic-tabs__btn')) {
        return { left: 10, right: 208, top: 0, bottom: 36, width: 198, height: 36, x: 10, y: 0, toJSON() {} };
      }
      const idx = Array.from(this.parentElement.children).indexOf(this);
      const m = BUTTON_METRICS[idx] || { left: 0, width: 50 };
      const left = 10 + m.left;
      return { left, right: left + m.width, top: 3, bottom: 33, width: m.width, height: 30, x: left, y: 3, toJSON() {} };
    });

    HTMLElement.prototype.setPointerCapture = jest.fn();
    HTMLElement.prototype.hasPointerCapture = jest.fn(() => true);
    HTMLElement.prototype.releasePointerCapture = jest.fn();

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root.render(<Harness />);
    });
    act(() => {
      jest.advanceTimersByTime(800);
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  test('scrubs horizontally across variable-width options and settles onto wider capsule on release', () => {
    const tray = getTray();
    expect(tray.dataset.capsuleMeasured).toBe('true');
    expect(tray.style.getPropertyValue('--capsule-x')).toBe('3.00px');
    expect(tray.style.getPropertyValue('--capsule-w')).toBe('48.00px');

    // 按住第一项并横向拖到第三项「跟随系统」(rect left = 113..205)，在刚进入左边缘 x=118 处也应精准识别为第 2 项
    firePointer('pointerdown', 28);
    firePointer('pointermove', 118);
    act(() => {
      jest.advanceTimersByTime(500);
    });

    expect(onChangeSpy).not.toHaveBeenCalled();
    const buttons = tray.querySelectorAll('button');
    expect((buttons[2] as HTMLButtonElement).dataset.previewActive).toBe('true');

    firePointer('pointerup', 118);
    expect(onChangeSpy).toHaveBeenCalledTimes(1);
    expect(onChangeSpy).toHaveBeenCalledWith('system');

    // 吞掉浏览器跟随派发的合成 click，避免二次触发
    act(() => {
      buttons[2].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });
    expect(onChangeSpy).toHaveBeenCalledTimes(1);

    act(() => {
      jest.advanceTimersByTime(800);
    });
    expect(tray.style.getPropertyValue('--capsule-x')).toBe('103.00px');
    expect(tray.style.getPropertyValue('--capsule-w')).toBe('92.00px');
  });

  test('cancels drag preview on Escape and supports ArrowRight keyboard switching', () => {
    const tray = getTray();
    firePointer('pointerdown', 28);
    firePointer('pointermove', 150);
    act(() => {
      jest.advanceTimersByTime(300);
    });
    act(() => {
      tray.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    firePointer('pointerup', 150);
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(onChangeSpy).not.toHaveBeenCalled();
    expect(tray.style.getPropertyValue('--capsule-x')).toBe('3.00px');

    act(() => {
      tray.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(onChangeSpy).toHaveBeenCalledWith('dark');
  });
});
