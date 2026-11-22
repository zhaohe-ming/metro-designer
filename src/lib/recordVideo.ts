import { videoFrameAtTime } from './videoModel';
import { addWebmDuration } from './webmDuration';

export interface VideoExportProgress {
  phase: 'preparing' | 'recording' | 'paused' | 'finalizing';
  percent: number;
  elapsedSec: number;
  totalSec: number;
  detail?: string;
}

export function checkVideoRecordingSupport() {
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    throw new Error('此浏览器不支持视频导出，请使用最新版 Chrome 或 Edge');
  }
  const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
    .find(type => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('此浏览器没有可用的视频编码器，请使用最新版 Chrome 或 Edge');
  return mimeType;
}

export function throwIfVideoAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('已取消视频导出', 'AbortError');
}

export async function recordVideoCanvas(options: {
  canvas: HTMLCanvasElement; fps: number; totalFrames: number;
  drawFrame: (frame: number) => void; signal?: AbortSignal;
  onProgress?: (progress: VideoExportProgress) => void;
}) {
  const { canvas, fps, totalFrames, drawFrame, signal, onProgress } = options;
  const mimeType = checkVideoRecordingSupport();
  throwIfVideoAborted(signal);
  drawFrame(0);
  // requestFrame 可用时手动采帧，避免自动采样再叠加手动采样。
  const manualCapture = typeof CanvasCaptureMediaStreamTrack !== 'undefined' &&
    typeof CanvasCaptureMediaStreamTrack.prototype.requestFrame === 'function';
  const stream = canvas.captureStream(manualCapture ? 0 : fps);
  try {
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    if (!track) throw new Error('无法获取画布视频流');
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    const chunks: BlobPart[] = [];
    let recordedDurationMs = totalFrames * 1000 / fps;
    const blob = await new Promise<Blob>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let startupTimer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let stopping = false;
      let started = false;
      let startedAt = performance.now();
      let recorderStartedAt = startedAt;
      let startupMs = 0;
      let elapsedBeforePause = 0;
      let paused = false;
      let lastFrame = -1;
      let lastProgressAt = -Infinity;
      const totalMs = totalFrames * 1000 / fps;
      const elapsed = () => elapsedBeforePause + (paused ? 0 : performance.now() - startedAt);
      const report = (phase: VideoExportProgress['phase'], ms: number) => onProgress?.({
        phase, percent: Math.min(99, Math.floor((ms + startupMs) / recordedDurationMs * 100)),
        elapsedSec: (Math.min(totalMs, ms) + startupMs) / 1000, totalSec: recordedDurationMs / 1000
      });
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(startupTimer);
        signal?.removeEventListener('abort', abort);
        document.removeEventListener('visibilitychange', visibilityChanged);
        track.removeEventListener('ended', trackEnded);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
        if (recorder.state !== 'inactive') recorder.stop();
      };
      const abort = () => fail(new DOMException('已取消视频导出', 'AbortError'));
      const trackEnded = () => fail(new Error('视频流意外中断，请重新导出'));
      const tick = () => {
        if (settled || stopping || paused) return;
        try {
          const ms = elapsed();
          const { frame, done } = videoFrameAtTime(ms, fps, totalFrames);
          if (frame !== lastFrame) {
            // 只画当前时刻的一帧；禁止按刷新率提前推进或瞬间补画多帧。
            drawFrame(frame);
            if (manualCapture) track.requestFrame();
            lastFrame = frame;
          }
          if (done) {
            stopping = true;
            report('finalizing', totalMs);
            timer = setTimeout(() => fail(new Error('视频编码器未完成保存，请重新导出')), 10_000);
            recorder.stop();
          } else {
            if (ms - lastProgressAt >= 250) {
              report('recording', ms);
              lastProgressAt = ms;
            }
            timer = setTimeout(tick, Math.max(1, (frame + 1) * 1000 / fps - ms));
          }
        } catch (error) { fail(error); }
      };
      const visibilityChanged = () => {
        if (settled || stopping || !started) return;
        try {
          if (document.hidden && !paused) {
            elapsedBeforePause = elapsed();
            paused = true;
            clearTimeout(timer);
            recorder.pause();
            report('paused', elapsedBeforePause);
          } else if (!document.hidden && paused) {
            startedAt = performance.now();
            paused = false;
            recorder.resume();
            report('recording', elapsedBeforePause);
            tick();
          }
        } catch (error) { fail(error); }
      };
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      recorder.onstart = () => {
        if (settled) return;
        clearTimeout(timer);
        clearTimeout(startupTimer);
        started = true;
        startedAt = performance.now();
        startupMs = startedAt - recorderStartedAt;
        // 启动预热的画面也在容器中，时长必须覆盖它，不能截掉片尾。
        recordedDurationMs = totalMs + startupMs;
        if (document.hidden) visibilityChanged();
        else tick();
      };
      recorder.onerror = () => fail(new Error('浏览器视频编码失败，请降低画布复杂度后重试'));
      recorder.onstop = () => {
        if (settled) return;
        if (!stopping) { fail(new Error('视频录制意外停止，请重新导出')); return; }
        settled = true;
        cleanup();
        const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
        if (!blob.size) reject(new Error('视频生成失败：浏览器没有录制到有效画面'));
        else resolve(blob);
      };
      signal?.addEventListener('abort', abort, { once: true });
      document.addEventListener('visibilitychange', visibilityChanged);
      track.addEventListener('ended', trackEnded);
      try {
        throwIfVideoAborted(signal);
        report('preparing', 0);
        startupTimer = setTimeout(() => fail(new Error('视频编码器启动超时，请重新导出')), 10_000);
        recorderStartedAt = performance.now();
        recorder.start(250);
        // 先送入初始画面唤醒编码器；onstart 之后才推进动画，避免吞掉短片头。
        const warmup = () => {
          if (settled || started) return;
          try {
            drawFrame(0);
            if (manualCapture) track.requestFrame();
            timer = setTimeout(warmup, 1000 / fps);
          } catch (error) { fail(error); }
        };
        warmup();
      } catch (error) { fail(error); }
    });
    throwIfVideoAborted(signal);
    const result = await addWebmDuration(blob, recordedDurationMs);
    throwIfVideoAborted(signal);
    return result;
  } finally {
    stream.getTracks().forEach(track => track.stop());
  }
}
