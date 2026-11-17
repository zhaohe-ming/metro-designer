import { useLayoutEffect, useRef } from 'react';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Pointer previews stay in this DOM layer; the drawing tool changes once, on release. */
export function useElasticToolbar(selectedIndex: number, count: number, enabled: boolean, onSelect: (index: number) => void) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ selectedIndex, onSelect });
  const sync = useRef<(() => void) | null>(null);
  useLayoutEffect(() => { latest.current = { selectedIndex, onSelect }; });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let reduced = motion.matches;
    let pitch = 58;
    let position = latest.current.selectedIndex;
    let target = position;
    let velocity = 0;
    let press = 0;
    let pressVelocity = 0;
    let frame = 0;
    let lastFrame = 0;
    let suppressClickUntil = 0;
    let canceledPointerId: number | null = null;
    let pointer: { id: number; x: number; y: number; origin: number; pitch: number; moved: boolean; raw: number } | null = null;

    const paint = () => {
      const pressure = reduced ? 0 : clamp(press, 0, 1.1);
      const speed = reduced ? 0 : Math.min(Math.abs(velocity) / 20, 1);
      const overshoot = position - clamp(position, 0, count - 1);
      element.style.setProperty('--phone-tool-position', `${position * pitch}px`);
      element.style.setProperty('--phone-shell-x', `${reduced ? 0 : clamp(overshoot * pitch * 0.24, -4, 4)}px`);
      element.style.setProperty('--phone-shell-sx', `${1 + pressure * 0.012 + speed * 0.008}`);
      element.style.setProperty('--phone-shell-sy', `${1 + pressure * 0.035 - speed * 0.008}`);
      element.style.setProperty('--phone-lens-sx', `${1 + pressure * 0.035 + speed * 0.04}`);
      element.style.setProperty('--phone-lens-sy', `${1 + pressure * 0.035}`);
      element.dataset.previewIndex = String(clamp(Math.round(position), 0, count - 1));
    };
    const tick = (time: number) => {
      frame = 0;
      // Cap and substep after backgrounding, including 30 Hz / battery-saving displays.
      const elapsed = lastFrame ? Math.min((time - lastFrame) / 1000, 0.032) : 1 / 60;
      lastFrame = time;
      const steps = Math.ceil(elapsed / 0.008);
      const dt = elapsed / steps;
      const pressTarget = pointer ? 1 : 0;
      for (let i = 0; i < steps; i++) {
        velocity += ((target - position) * 700 - velocity * 42) * dt;
        position += velocity * dt;
        pressVelocity += ((pressTarget - press) * 380 - pressVelocity * 30) * dt;
        press += pressVelocity * dt;
      }
      const settled = Math.abs(target - position) < 0.001 && Math.abs(velocity) < 0.01
        && Math.abs(pressTarget - press) < 0.001 && Math.abs(pressVelocity) < 0.01;
      if (settled) { position = target; velocity = 0; press = pressTarget; pressVelocity = 0; }
      paint();
      if (!settled) frame = requestAnimationFrame(tick);
      else lastFrame = 0;
    };
    const animate = () => {
      if (reduced) {
        cancelAnimationFrame(frame); frame = 0; lastFrame = 0;
        position = target; velocity = 0; press = 0; pressVelocity = 0; paint();
      } else if (!frame) frame = requestAnimationFrame(tick);
    };
    const releaseCapture = (id: number) => {
      if (element.hasPointerCapture?.(id)) element.releasePointerCapture(id);
    };
    const cancel = () => {
      const previous = pointer;
      pointer = null;
      if (previous) {
        canceledPointerId = previous.id;
        suppressClickUntil = performance.now() + 600; releaseCapture(previous.id);
      }
      delete element.dataset.dragging;
      target = latest.current.selectedIndex;
      animate();
    };
    const measure = () => {
      const button = element.querySelector<HTMLButtonElement>('.metro-tool-button');
      if (!button) return;
      const nextPitch = button.offsetWidth + (parseFloat(getComputedStyle(element).columnGap) || 2);
      if (nextPitch <= 2 || Math.abs(nextPitch - pitch) < 0.1) return;
      cancel(); pitch = nextPitch; position = target; velocity = 0; paint();
    };
    const down = (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      if (!event.isPrimary || pointer) { cancel(); return; }
      canceledPointerId = null;
      const buttons = element.querySelectorAll<HTMLButtonElement>('.metro-tool-button');
      if (buttons.length < 2) return;
      const first = buttons[0].getBoundingClientRect();
      const second = buttons[1].getBoundingClientRect();
      const pointerPitch = second.left - first.left;
      if (pointerPitch <= 0) return;
      const origin = first.left + first.width / 2;
      const raw = (event.clientX - origin) / pointerPitch;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, origin, pitch: pointerPitch, moved: false, raw };
      target = clamp(Math.round(raw), 0, count - 1);
      element.setPointerCapture(event.pointerId);
      animate();
    };
    const move = (event: PointerEvent) => {
      if (!pointer || event.pointerId !== pointer.id) return;
      event.stopPropagation();
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      if (!pointer.moved && Math.abs(dy) > 14 && Math.abs(dx) < 7) { cancel(); return; }
      if (!pointer.moved && Math.abs(dx) < 6) return;
      pointer.moved = true;
      event.preventDefault();
      element.dataset.dragging = 'true';
      pointer.raw = (event.clientX - pointer.origin) / pointer.pitch;
      const inside = clamp(pointer.raw, 0, count - 1);
      const outside = pointer.raw - inside;
      target = inside + Math.sign(outside) * 0.25 * (1 - Math.exp(-Math.abs(outside)));
      animate();
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId === canceledPointerId) {
        canceledPointerId = null; suppressClickUntil = performance.now() + 600; return;
      }
      if (!pointer || event.pointerId !== pointer.id) return;
      event.stopPropagation();
      const previous = pointer;
      pointer = null;
      suppressClickUntil = performance.now() + 600;
      delete element.dataset.dragging;
      target = Math.abs(event.clientY - previous.y) > 96 ? latest.current.selectedIndex
        : clamp(Math.round(previous.raw), 0, count - 1);
      releaseCapture(previous.id);
      animate();
      if (target !== latest.current.selectedIndex) latest.current.onSelect(target);
    };
    const lost = (event: PointerEvent) => { if (pointer?.id === event.pointerId) cancel(); };
    const click = (event: MouseEvent) => {
      // Preserve native keyboard / assistive activation (detail=0), consume the pointer's trailing click.
      if (event.detail > 0 && performance.now() < suppressClickUntil) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') cancel(); };
    const visibility = () => { if (document.hidden) cancel(); };
    const motionChange = () => { reduced = motion.matches; cancel(); };
    sync.current = cancel;
    element.dataset.elasticReady = 'true';
    measure(); paint();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    element.addEventListener('pointerdown', down);
    element.addEventListener('pointermove', move, { passive: false });
    element.addEventListener('pointerup', up);
    element.addEventListener('pointercancel', lost);
    element.addEventListener('lostpointercapture', lost);
    element.addEventListener('click', click, true);
    element.addEventListener('keydown', key);
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    document.addEventListener('visibilitychange', visibility);
    motion.addEventListener('change', motionChange);
    return () => {
      sync.current = null;
      const id = pointer?.id;
      pointer = null;
      if (id !== undefined) releaseCapture(id);
      cancelAnimationFrame(frame);
      observer.disconnect();
      element.removeEventListener('pointerdown', down);
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerup', up);
      element.removeEventListener('pointercancel', lost);
      element.removeEventListener('lostpointercapture', lost);
      element.removeEventListener('click', click, true);
      element.removeEventListener('keydown', key);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('resize', cancel);
      document.removeEventListener('visibilitychange', visibility);
      motion.removeEventListener('change', motionChange);
      delete element.dataset.elasticReady;
      delete element.dataset.previewIndex;
      delete element.dataset.dragging;
      ['position', 'shell-x', 'shell-sx', 'shell-sy', 'lens-sx', 'lens-sy'].forEach(name => element.style.removeProperty(`--phone-${name === 'position' ? 'tool-position' : name}`));
    };
  }, [count, enabled]);

  useLayoutEffect(() => { sync.current?.(); }, [selectedIndex]);
  return ref;
}
