import React, { useEffect, useRef } from 'react';
import { Modal } from 'antd';
import { createGuestDraft } from '../lib/guestDraft';

const sample = createGuestDraft();

export default function GuestAnimationPreview({ open, onClose }: { open: boolean; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const start = performance.now();
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const draw = () => {
      const ctx = canvasRef.current?.getContext('2d');
      if (!ctx) { frame = requestAnimationFrame(draw); return; }
      const isDark = typeof document !== 'undefined' && document.body?.dataset?.interfaceTheme === 'dark';
      const time = reducedMotion ? 7 : ((performance.now() - start) / 1000) % 9;
      ctx.clearRect(0, 0, 640, 560);
      ctx.fillStyle = isDark ? '#0b1220' : '#f8fbff'; ctx.fillRect(0, 0, 640, 560);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      sample.lines.forEach((line, index) => {
        const points = line.stationIds.map(id => sample.stations.find(station => station.id === id)!);
        const progress = Math.max(0, Math.min(1, (time - index * 1.6) / 1.6));
        ctx.strokeStyle = line.color; ctx.lineWidth = 9;
        ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y);
        const count = (points.length - 1) * progress;
        points.slice(1).forEach((point, i) => {
          const fraction = Math.max(0, Math.min(1, count - i));
          if (fraction > 0) ctx.lineTo(points[i].x + (point.x - points[i].x) * fraction, points[i].y + (point.y - points[i].y) * fraction);
        });
        ctx.stroke();
        points.forEach((point, i) => {
          if (i > count || progress === 0) return;
          ctx.beginPath(); ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
          ctx.fillStyle = isDark ? '#0f172a' : '#fff'; ctx.fill(); ctx.lineWidth = 2; ctx.stroke();
          ctx.fillStyle = isDark ? '#f8fafc' : '#0f172a'; ctx.font = '15px sans-serif'; ctx.fillText(point.name, point.x + 10, point.y - 12);
        });
      });
      if (!reducedMotion) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return <Modal open={open} onCancel={onClose} title="动态演示示例" footer={null} width={640} destroyOnHidden>
    <canvas ref={canvasRef} width={640} height={560} style={{ width: '100%', height: 'auto', display: 'block', borderRadius: 12 }}
      role="img" aria-label="示例三条地铁线路依次展开，演示按开通顺序展示线网" />
    <p style={{ color: 'var(--color-text-soft)', marginBottom: 0 }}>示例线网按顺序展开。登录后可为自己的线网配置开通日期并导出演示视频。</p>
  </Modal>;
}
