import React, { useLayoutEffect, useRef } from 'react';

export interface ElasticCapsuleOption<T extends string | number> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
  ariaLabel?: string;
}

export interface ElasticCapsuleTabsProps<T extends string | number> {
  options: ReadonlyArray<ElasticCapsuleOption<T>>;
  value: T;
  onChange: (value: T) => void;
  size?: 'sm' | 'md' | 'lg';
  block?: boolean;
  ariaLabel?: string;
  className?: string;
}

interface SlotMetric {
  left: number;
  width: number;
  rectLeft: number;
  rectRight: number;
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

/**
 * 复用主画布五工具岛的物理阻尼弹簧 + 按住横向拖拽扫选 + 边缘橡皮筋回弹与按压弹性形变。
 * - 支持任意数量选项及不同文字宽度的自适应胶囊（滑块位置与宽度同步平滑插值）。
 * - 静止时无任何 requestAnimationFrame 循环（0 CPU 占用）；拖拽全程仅改写 CSS 变量，不触发 React 重渲染。
 */
export function ElasticCapsuleTabs<T extends string | number>({
  options,
  value,
  onChange,
  size = 'md',
  block = false,
  ariaLabel,
  className
}: ElasticCapsuleTabsProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rawIndex = options.findIndex((opt) => opt.value === value);
  const selectedIndex = rawIndex >= 0 ? rawIndex : 0;
  const count = options.length;

  const latestRef = useRef({ selectedIndex, options, onChange });
  useLayoutEffect(() => {
    latestRef.current = { selectedIndex, options, onChange };
  });

  const syncSelectedRef = useRef<((nextIdx: number) => void) | null>(null);

  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element || count < 1) return;

    const motionQuery =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    let reduced = Boolean(motionQuery?.matches);

    let metrics: SlotMetric[] = [];
    let boundaries: number[] = [];
    let measured = false;

    let position = latestRef.current.selectedIndex;
    let target = position;
    let velocity = 0;
    let press = 0;
    let pressVelocity = 0;
    let frame = 0;
    let lastFrame = 0;
    let suppressClickUntil = 0;
    let canceledPointerId: number | null = null;
    let previewDomIndex: number | null = null;

    let pointer: {
      id: number;
      startX: number;
      moved: boolean;
      rectBoundaries: number[];
    } | null = null;

    const getButtons = () =>
      Array.from(element.children).filter(
        (node): node is HTMLButtonElement =>
          node instanceof HTMLButtonElement && node.classList.contains('metro-elastic-tabs__btn')
      );

    const setPreviewHighlight = (idx: number | null) => {
      if (previewDomIndex === idx) return;
      const buttons = getButtons();
      if (previewDomIndex !== null && buttons[previewDomIndex]) {
        delete buttons[previewDomIndex].dataset.previewActive;
      }
      previewDomIndex = idx;
      if (idx !== null && buttons[idx]) {
        buttons[idx].dataset.previewActive = 'true';
        element.dataset.hasPreview = 'true';
      } else {
        delete element.dataset.hasPreview;
      }
    };

    const interpolateGeometry = (pos: number): { x: number; w: number } => {
      const n = metrics.length;
      if (n === 0) return { x: 0, w: 0 };
      if (n === 1) return { x: metrics[0].left, w: metrics[0].width };

      const clamped = clamp(pos, 0, n - 1);
      const overshoot = pos - clamped;
      const i = Math.min(Math.floor(clamped), n - 2);
      const t = clamped - i;
      const baseLeft = metrics[i].left + (metrics[i + 1].left - metrics[i].left) * t;
      const baseWidth = metrics[i].width + (metrics[i + 1].width - metrics[i].width) * t;
      const edgeWidth = pos < 0 ? metrics[0].width : metrics[n - 1].width;
      return {
        x: baseLeft + overshoot * edgeWidth * 0.3,
        w: baseWidth
      };
    };

    const paint = () => {
      if (!measured || metrics.length === 0) return;
      const n = metrics.length;
      const pressure = reduced ? 0 : clamp(press, 0, 1.1);
      const speed = reduced ? 0 : Math.min(Math.abs(velocity) / 20, 1);
      const overshoot = position - clamp(position, 0, n - 1);
      const edgeWidth = position < 0 ? metrics[0].width : metrics[n - 1].width;
      const { x, w } = interpolateGeometry(position);

      element.style.setProperty('--capsule-x', `${x.toFixed(2)}px`);
      element.style.setProperty('--capsule-w', `${w.toFixed(2)}px`);
      element.style.setProperty(
        '--capsule-shell-x',
        `${reduced ? 0 : clamp(overshoot * edgeWidth * 0.2, -4, 4).toFixed(2)}px`
      );
      element.style.setProperty('--capsule-shell-sx', `${(1 + pressure * 0.012 + speed * 0.008).toFixed(4)}`);
      element.style.setProperty('--capsule-shell-sy', `${(1 + pressure * 0.03 - speed * 0.008).toFixed(4)}`);
      element.style.setProperty('--capsule-lens-sx', `${(1 + pressure * 0.03 + speed * 0.035).toFixed(4)}`);
      element.style.setProperty('--capsule-lens-sy', `${(1 + pressure * 0.03).toFixed(4)}`);

      if (pointer) {
        setPreviewHighlight(clamp(Math.round(position), 0, n - 1));
      } else {
        setPreviewHighlight(null);
      }
    };

    const tick = (time: number) => {
      frame = 0;
      const elapsed = lastFrame ? Math.min((time - lastFrame) / 1000, 0.032) : 1 / 60;
      lastFrame = time;
      const steps = Math.ceil(elapsed / 0.008);
      const dt = elapsed / steps;
      const pressTarget = pointer ? 1 : 0;

      for (let i = 0; i < steps; i += 1) {
        velocity += ((target - position) * 700 - velocity * 42) * dt;
        position += velocity * dt;
        pressVelocity += ((pressTarget - press) * 380 - pressVelocity * 30) * dt;
        press += pressVelocity * dt;
      }

      const settled =
        Math.abs(target - position) < 0.001 &&
        Math.abs(velocity) < 0.01 &&
        Math.abs(pressTarget - press) < 0.001 &&
        Math.abs(pressVelocity) < 0.01;

      if (settled) {
        position = target;
        velocity = 0;
        press = pressTarget;
        pressVelocity = 0;
      }

      paint();

      if (!settled) {
        frame = requestAnimationFrame(tick);
      } else {
        lastFrame = 0;
      }
    };

    const animate = () => {
      if (!measured) return;
      if (reduced) {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        lastFrame = 0;
        position = target;
        velocity = 0;
        press = 0;
        pressVelocity = 0;
        paint();
      } else if (!frame) {
        frame = requestAnimationFrame(tick);
      }
    };

    const computeBoundaries = (slots: SlotMetric[]): number[] => {
      const n = slots.length;
      if (n === 0) return [];
      const b: number[] = new Array(n + 1);
      b[0] = slots[0].rectLeft;
      for (let i = 1; i < n; i += 1) {
        b[i] = (slots[i - 1].rectRight + slots[i].rectLeft) / 2;
      }
      b[n] = slots[n - 1].rectRight;
      return b;
    };

    const clientXToRawIndex = (clientX: number, b: number[]): number => {
      const n = b.length - 1;
      if (n <= 1) return 0;
      if (clientX <= b[0]) {
        const w0 = Math.max(1, b[1] - b[0]);
        return -0.5 + (clientX - b[0]) / w0;
      }
      if (clientX >= b[n]) {
        const wn = Math.max(1, b[n] - b[n - 1]);
        return n - 0.5 + (clientX - b[n]) / wn;
      }
      for (let k = 0; k < n; k += 1) {
        if (clientX <= b[k + 1]) {
          const wk = Math.max(1, b[k + 1] - b[k]);
          return k - 0.5 + (clientX - b[k]) / wk;
        }
      }
      return n - 1;
    };

    const measure = (snapImmediately = false) => {
      const buttons = getButtons();
      if (buttons.length !== count) return;
      const nextMetrics: SlotMetric[] = [];
      for (let i = 0; i < buttons.length; i += 1) {
        const btn = buttons[i];
        const w = btn.offsetWidth;
        if (w <= 0) return;
        const rect = btn.getBoundingClientRect();
        nextMetrics.push({
          left: btn.offsetLeft,
          width: w,
          rectLeft: rect.left,
          rectRight: rect.right
        });
      }
      const wasMeasured = measured;
      metrics = nextMetrics;
      boundaries = computeBoundaries(nextMetrics);
      measured = true;
      element.dataset.capsuleMeasured = 'true';
      if (!wasMeasured || snapImmediately) {
        target = clamp(latestRef.current.selectedIndex, 0, count - 1);
        position = target;
        velocity = 0;
      }
      paint();
    };

    const releaseCapture = (id: number) => {
      try {
        if (element.hasPointerCapture?.(id)) element.releasePointerCapture(id);
      } catch {
        /* ignore */
      }
    };

    const cancel = () => {
      const prev = pointer;
      pointer = null;
      if (prev) {
        canceledPointerId = prev.id;
        suppressClickUntil = performance.now() + 450;
        releaseCapture(prev.id);
      }
      delete element.dataset.dragging;
      setPreviewHighlight(null);
      target = clamp(latestRef.current.selectedIndex, 0, count - 1);
      animate();
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || count < 2) return;
      // Refresh client-space boundaries at gesture start in case parent modal/scroll moved
      measure(false);
      if (!measured || boundaries.length < count + 1) return;
      event.stopPropagation();
      if (!event.isPrimary || pointer) {
        cancel();
        return;
      }
      canceledPointerId = null;
      const raw = clientXToRawIndex(event.clientX, boundaries);
      const nextIdx = clamp(Math.round(raw), 0, count - 1);
      if (latestRef.current.options[nextIdx]?.disabled) return;

      pointer = {
        id: event.pointerId,
        startX: event.clientX,
        moved: false,
        rectBoundaries: boundaries.slice()
      };
      target = nextIdx;
      try {
        element.setPointerCapture?.(event.pointerId);
      } catch {
        /* ignore */
      }
      animate();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!pointer || event.pointerId !== pointer.id) return;
      event.stopPropagation();
      const dx = event.clientX - pointer.startX;
      if (!pointer.moved && Math.abs(dx) < 5) return;
      pointer.moved = true;
      event.preventDefault();
      element.dataset.dragging = 'true';

      const raw = clientXToRawIndex(event.clientX, pointer.rectBoundaries);
      const inside = clamp(raw, 0, count - 1);
      const outside = raw - inside;
      target = inside + Math.sign(outside) * 0.24 * (1 - Math.exp(-Math.abs(outside)));
      animate();
    };

    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId === canceledPointerId) {
        canceledPointerId = null;
        suppressClickUntil = performance.now() + 450;
        return;
      }
      if (!pointer || event.pointerId !== pointer.id) return;
      event.stopPropagation();
      const prev = pointer;
      pointer = null;
      suppressClickUntil = performance.now() + 450;
      delete element.dataset.dragging;
      setPreviewHighlight(null);

      const finalIdx = clamp(Math.round(clientXToRawIndex(event.clientX, prev.rectBoundaries)), 0, count - 1);
      releaseCapture(prev.id);

      const chosen = latestRef.current.options[finalIdx];
      if (chosen && !chosen.disabled) {
        target = finalIdx;
        animate();
        if (finalIdx !== latestRef.current.selectedIndex) {
          latestRef.current.onChange(chosen.value);
        }
      } else {
        target = clamp(latestRef.current.selectedIndex, 0, count - 1);
        animate();
      }
    };

    const onPointerLost = (event: PointerEvent) => {
      if (pointer?.id === event.pointerId) cancel();
    };

    const onClickCapture = (event: MouseEvent) => {
      if (event.detail > 0 && performance.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && pointer) {
        cancel();
        return;
      }
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      const dir = event.key === 'ArrowRight' ? 1 : -1;
      const opts = latestRef.current.options;
      let cursor = latestRef.current.selectedIndex;
      for (let step = 0; step < count; step += 1) {
        cursor = (cursor + dir + count) % count;
        if (!opts[cursor]?.disabled) {
          event.preventDefault();
          const buttons = getButtons();
          buttons[cursor]?.focus();
          latestRef.current.onChange(opts[cursor].value);
          return;
        }
      }
    };

    const onVisibility = () => {
      if (document.hidden) cancel();
    };

    const onMotionChange = () => {
      reduced = Boolean(motionQuery?.matches);
      cancel();
    };

    syncSelectedRef.current = (nextIdx: number) => {
      measure(false);
      if (pointer) return;
      target = clamp(nextIdx, 0, count - 1);
      animate();
    };

    measure(true);

    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            if (!pointer) measure(false);
          })
        : null;
    if (observer) {
      observer.observe(element);
      getButtons().forEach((btn) => observer.observe(btn));
    }

    element.addEventListener('pointerdown', onPointerDown);
    element.addEventListener('pointermove', onPointerMove, { passive: false });
    element.addEventListener('pointerup', onPointerUp);
    element.addEventListener('pointercancel', onPointerLost);
    element.addEventListener('lostpointercapture', onPointerLost);
    element.addEventListener('click', onClickCapture, true);
    element.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', cancel);
    document.addEventListener('visibilitychange', onVisibility);
    motionQuery?.addEventListener?.('change', onMotionChange);

    return () => {
      syncSelectedRef.current = null;
      const activeId = pointer?.id;
      pointer = null;
      if (activeId !== undefined) releaseCapture(activeId);
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('pointermove', onPointerMove);
      element.removeEventListener('pointerup', onPointerUp);
      element.removeEventListener('pointercancel', onPointerLost);
      element.removeEventListener('lostpointercapture', onPointerLost);
      element.removeEventListener('click', onClickCapture, true);
      element.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('visibilitychange', onVisibility);
      motionQuery?.removeEventListener?.('change', onMotionChange);
      delete element.dataset.capsuleMeasured;
      delete element.dataset.dragging;
      delete element.dataset.hasPreview;
    };
  }, [count]);

  useLayoutEffect(() => {
    syncSelectedRef.current?.(selectedIndex);
  }, [selectedIndex, options]);

  const cls = [
    'metro-elastic-tabs',
    `metro-elastic-tabs--${size}`,
    block ? 'metro-elastic-tabs--block' : '',
    className || ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={containerRef} className={cls} role="tablist" aria-label={ariaLabel}>
      {options.map((opt, idx) => {
        const active = idx === selectedIndex;
        return (
          <button
            key={String(opt.value)}
            type="button"
            role="tab"
            aria-selected={active}
            aria-label={opt.ariaLabel}
            disabled={opt.disabled}
            className={`metro-elastic-tabs__btn${active ? ' is-active' : ''}`}
            onClick={() => {
              if (!opt.disabled && opt.value !== value) {
                onChange(opt.value);
              }
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export default ElasticCapsuleTabs;
