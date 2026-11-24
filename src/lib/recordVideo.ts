import { videoFrameAtTime } from './videoModel';
import { addWebmDuration } from './webmDuration';
import { EncodedAvcSample, muxAvcToMp4 } from './mp4Muxer';

export interface VideoExportProgress {
  phase: 'preparing' | 'recording' | 'paused' | 'finalizing';
  percent: number;
  elapsedSec: number;
  totalSec: number;
  detail?: string;
  mode?: 'webcodecs-mp4' | 'mediarecorder';
  renderedFrames?: number;
  totalFrames?: number;
  etaSec?: number;
}

function hasWebCodecsApi(): boolean {
  const g = globalThis as any;
  return typeof g.VideoEncoder === 'function' && typeof g.VideoFrame === 'function';
}

export function checkVideoRecordingSupport() {
  if (hasWebCodecsApi()) {
    return 'video/mp4';
  }
  if (typeof MediaRecorder === 'undefined' || typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    throw new Error('此浏览器不支持视频导出，请使用最新版 Chrome 或 Edge');
  }
  const mimeType = [
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ].find((type) => MediaRecorder.isTypeSupported(type));
  if (!mimeType) throw new Error('此浏览器没有可用的视频编码器，请使用最新版 Chrome 或 Edge');
  return mimeType;
}

export function throwIfVideoAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('已取消视频导出', 'AbortError');
}

function yieldFastMacrotask(): Promise<void> {
  if (typeof MessageChannel !== 'undefined') {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.onmessage = null;
        resolve();
      };
      ch.port2.postMessage(null);
    });
  }
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function tryRecordWithWebCodecsMp4(options: {
  canvas: HTMLCanvasElement;
  fps: number;
  totalFrames: number;
  drawFrame: (frame: number) => void;
  signal?: AbortSignal;
  onProgress?: (progress: VideoExportProgress) => void;
}): Promise<Blob | null> {
  if (!hasWebCodecsApi()) return null;
  const { canvas, fps, totalFrames, drawFrame, signal, onProgress } = options;
  const VideoEncoderCtor = (globalThis as any).VideoEncoder;
  const VideoFrameCtor = (globalThis as any).VideoFrame;

  const width = canvas.width;
  const height = canvas.height;
  if (width < 2 || height < 2 || typeof VideoEncoderCtor.isConfigSupported !== 'function') {
    return null;
  }

  const candidateCodecs = [
    'avc1.64002a', // High Profile Level 4.2 (1080p60)
    'avc1.640028', // High Profile Level 4.0 (1080p30)
    'avc1.4d002a', // Main Profile Level 4.2
    'avc1.4d0028', // Main Profile Level 4.0
    'avc1.420028', // Baseline Profile Level 4.0
    'avc1.42001f'  // Baseline Profile Level 3.1
  ];

  const bitrate = fps >= 60 ? 10_000_000 : 8_000_000;
  let chosenConfig: any = null;

  for (let i = 0; i < candidateCodecs.length; i += 1) {
    throwIfVideoAborted(signal);
    const cfg = {
      codec: candidateCodecs[i],
      width,
      height,
      bitrate,
      framerate: fps,
      latencyMode: 'realtime',
      avc: { format: 'avc' }
    };
    try {
      const support = await VideoEncoderCtor.isConfigSupported(cfg);
      if (support && support.supported) {
        chosenConfig = support.config || cfg;
        break;
      }
    } catch {
      /* try next profile */
    }
  }

  if (!chosenConfig) return null;

  const samples: EncodedAvcSample[] = [];
  let decoderDescription: Uint8Array | undefined;
  let encodeError: unknown = null;

  const encoder = new VideoEncoderCtor({
    output: (chunk: any, meta?: any) => {
      const desc = meta?.decoderConfig?.description;
      if (desc && !decoderDescription) {
        decoderDescription =
          desc instanceof ArrayBuffer
            ? new Uint8Array(desc.slice(0))
            : ArrayBuffer.isView(desc)
              ? new Uint8Array(desc.buffer.slice(desc.byteOffset, desc.byteOffset + desc.byteLength))
              : undefined;
      }
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      samples.push({
        data: bytes,
        isKeyframe: chunk.type === 'key'
      });
    },
    error: (err: unknown) => {
      if (!encodeError) encodeError = err;
    }
  });

  const onAbort = () => {
    try {
      if (encoder.state !== 'closed') encoder.close();
    } catch {
      /* ignore */
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    try {
      encoder.configure(chosenConfig);
    } catch {
      // 硬件初始化不支持时平滑回退 MediaRecorder
      return null;
    }

    const totalSec = totalFrames / fps;
    const startWallMs = performance.now();
    const keyframeInterval = Math.max(fps, fps * 2);

    onProgress?.({
      phase: 'recording',
      percent: 1,
      elapsedSec: 0,
      totalSec,
      mode: 'webcodecs-mp4',
      renderedFrames: 0,
      totalFrames,
      detail: '正在编码 MP4 视频…'
    });

    for (let frame = 0; frame < totalFrames; frame += 1) {
      throwIfVideoAborted(signal);
      if (encodeError) {
        throw encodeError instanceof Error ? encodeError : new Error('硬件视频编码器异常');
      }

      drawFrame(frame);

      const timestampUs = Math.round((frame * 1_000_000) / fps);
      const durationUs = Math.round(1_000_000 / fps);
      const videoFrame = new VideoFrameCtor(canvas, { timestamp: timestampUs, duration: durationUs });
      try {
        encoder.encode(videoFrame, { keyFrame: frame === 0 || frame % keyframeInterval === 0 });
      } finally {
        videoFrame.close();
      }

      if (encoder.encodeQueueSize > 10) {
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            encoder.ondequeue = null;
            signal?.removeEventListener('abort', finish);
            resolve();
          };
          encoder.ondequeue = finish;
          signal?.addEventListener('abort', finish, { once: true });
          setTimeout(finish, 40);
        });
      } else if (frame % 12 === 11) {
        await yieldFastMacrotask();
      }

      if (frame % 6 === 0 || frame === totalFrames - 1) {
        const doneCount = frame + 1;
        const ratio = doneCount / totalFrames;
        const wallSec = (performance.now() - startWallMs) / 1000;
        const etaSec = ratio > 0.03 ? Math.max(0, ((1 - ratio) / ratio) * wallSec) : undefined;
        onProgress?.({
          phase: 'recording',
          percent: Math.min(97, Math.max(1, Math.round(ratio * 96))),
          elapsedSec: (doneCount / fps),
          totalSec,
          mode: 'webcodecs-mp4',
          renderedFrames: doneCount,
          totalFrames,
          etaSec,
          detail: `正在编码 MP4（${doneCount} / ${totalFrames} 帧）`
        });
      }
    }

    throwIfVideoAborted(signal);
    onProgress?.({
      phase: 'finalizing',
      percent: 98,
      elapsedSec: totalSec,
      totalSec,
      mode: 'webcodecs-mp4',
      renderedFrames: totalFrames,
      totalFrames,
      detail: '正在封装 MP4 文件头…'
    });

    await encoder.flush();
    if (encodeError) {
      throw encodeError instanceof Error ? encodeError : new Error('视频编码器冲刷失败');
    }
    throwIfVideoAborted(signal);

    if (!samples.length) {
      return null;
    }

    return muxAvcToMp4({
      width,
      height,
      fps,
      samples,
      decoderDescription
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try {
      if (encoder.state !== 'closed') encoder.close();
    } catch {
      /* ignore */
    }
  }
}

export async function recordVideoCanvas(options: {
  canvas: HTMLCanvasElement;
  fps: number;
  totalFrames: number;
  drawFrame: (frame: number) => void;
  signal?: AbortSignal;
  onProgress?: (progress: VideoExportProgress) => void;
}) {
  const { canvas, fps, totalFrames, drawFrame, signal, onProgress } = options;
  throwIfVideoAborted(signal);

  // 优先走 WebCodecs 离线极速直出 H.264 MP4（提速 5~10 倍、切后台不暂停）；
  // 仅当环境支持 WebCodecs 时才进入异步探测，保持无 WebCodecs 时 MediaRecorder 同步初始化语义
  if (hasWebCodecsApi()) {
    const fastMp4 = await tryRecordWithWebCodecsMp4(options);
    if (fastMp4) {
      return fastMp4;
    }
  }

  // 自动回退：浏览器不支持 WebCodecs 时使用 MediaRecorder 实时录制
  const mimeType = checkVideoRecordingSupport();
  throwIfVideoAborted(signal);
  drawFrame(0);
  const manualCapture =
    typeof CanvasCaptureMediaStreamTrack !== 'undefined' &&
    typeof CanvasCaptureMediaStreamTrack.prototype.requestFrame === 'function';
  const stream = canvas.captureStream(manualCapture ? 0 : fps);
  try {
    const track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
    if (!track) throw new Error('无法获取画布视频流');
    const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
    const chunks: BlobPart[] = [];
    let recordedDurationMs = (totalFrames * 1000) / fps;
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
      const totalMs = (totalFrames * 1000) / fps;
      const elapsed = () => elapsedBeforePause + (paused ? 0 : performance.now() - startedAt);
      const report = (phase: VideoExportProgress['phase'], ms: number) =>
        onProgress?.({
          phase,
          mode: 'mediarecorder',
          percent: Math.min(99, Math.floor(((ms + startupMs) / recordedDurationMs) * 100)),
          elapsedSec: (Math.min(totalMs, ms) + startupMs) / 1000,
          totalSec: recordedDurationMs / 1000
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
            timer = setTimeout(tick, Math.max(1, ((frame + 1) * 1000) / fps - ms));
          }
        } catch (error) {
          fail(error);
        }
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
        } catch (error) {
          fail(error);
        }
      };
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onstart = () => {
        if (settled) return;
        clearTimeout(timer);
        clearTimeout(startupTimer);
        started = true;
        startedAt = performance.now();
        startupMs = startedAt - recorderStartedAt;
        recordedDurationMs = totalMs + startupMs;
        if (document.hidden) visibilityChanged();
        else tick();
      };
      recorder.onerror = () => fail(new Error('浏览器视频编码失败，请降低画布复杂度后重试'));
      recorder.onstop = () => {
        if (settled) return;
        if (!stopping) {
          fail(new Error('视频录制意外停止，请重新导出'));
          return;
        }
        settled = true;
        cleanup();
        const outBlob = new Blob(chunks, { type: recorder.mimeType || mimeType });
        if (!outBlob.size) reject(new Error('视频生成失败：浏览器没有录制到有效画面'));
        else resolve(outBlob);
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
        const warmup = () => {
          if (settled || started) return;
          try {
            drawFrame(0);
            if (manualCapture) track.requestFrame();
            timer = setTimeout(warmup, 1000 / fps);
          } catch (error) {
            fail(error);
          }
        };
        warmup();
      } catch (error) {
        fail(error);
      }
    });
    throwIfVideoAborted(signal);
    const result = blob.type.includes('webm') ? await addWebmDuration(blob, recordedDurationMs) : blob;
    throwIfVideoAborted(signal);
    return result;
  } finally {
    stream.getTracks().forEach((track) => track.stop());
  }
}
