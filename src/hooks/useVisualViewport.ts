import { useEffect, useState } from 'react';

export interface VisualViewportState {
  keyboardOpen: boolean;
  keyboardInsetBottom: number;
  viewportHeight: number;
}

/**
 * 监听移动端虚拟键盘（IME）弹起导致的 window.visualViewport 收缩，
 * 同步注入全局 CSS 变量 `--metro-kb-inset`，供行内改名框、地名输入框与搜索浮层贴合键盘上方显示。
 */
export function useVisualViewport(): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>(() => ({
    keyboardOpen: false,
    keyboardInsetBottom: 0,
    viewportHeight: typeof window !== 'undefined' ? window.innerHeight : 800
  }));

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const vv = window.visualViewport;
    const root = document.documentElement;

    const sync = () => {
      const layoutH = window.innerHeight || 0;
      const visualH = vv ? vv.height : layoutH;
      const offsetTop = vv ? vv.offsetTop : 0;
      const rawInset = Math.max(0, Math.round(layoutH - visualH - offsetTop));
      const keyboardOpen = rawInset > 90;
      const inset = keyboardOpen ? rawInset : 0;
      root.style.setProperty('--metro-kb-inset', `${inset}px`);
      setState((prev) =>
        prev.keyboardOpen === keyboardOpen &&
        prev.keyboardInsetBottom === inset &&
        Math.abs(prev.viewportHeight - visualH) < 2
          ? prev
          : { keyboardOpen, keyboardInsetBottom: inset, viewportHeight: Math.round(visualH) }
      );
    };

    sync();
    vv?.addEventListener('resize', sync);
    vv?.addEventListener('scroll', sync);
    window.addEventListener('resize', sync);
    return () => {
      vv?.removeEventListener('resize', sync);
      vv?.removeEventListener('scroll', sync);
      window.removeEventListener('resize', sync);
      root.style.setProperty('--metro-kb-inset', '0px');
    };
  }, []);

  return state;
}
