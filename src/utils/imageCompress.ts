// 头像 dataURL 压缩 / 缩放工具。
// - compressImageDataUrl: 拿任意 dataURL 或 URL 跑一次 <canvas> 重采样 + JPEG 编码，
//   返回新的 dataURL；用于上传前和历史存量迁移。
// - 目标：max 边 192px、JPEG q=0.82，足够当头像但体积可控（一般 < 30KB）。

export interface CompressOptions {
  maxEdge?: number;
  quality?: number;
  mimeType?: string;
}

export async function compressImageDataUrl(
  source: string,
  options: CompressOptions = {}
): Promise<string> {
  const maxEdge = options.maxEdge ?? 192;
  const quality = options.quality ?? 0.82;
  const mimeType = options.mimeType ?? 'image/jpeg';

  const image = await loadImage(source);
  const { naturalWidth, naturalHeight } = image;
  if (!naturalWidth || !naturalHeight) {
    throw new Error('图片解码失败');
  }

  const scale = Math.min(1, maxEdge / Math.max(naturalWidth, naturalHeight));
  const targetWidth = Math.max(1, Math.round(naturalWidth * scale));
  const targetHeight = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('当前浏览器不支持 canvas 绘制');
  }
  // 用平滑缩放，质量 = high；多数现代浏览器实现是 bicubic
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
  return canvas.toDataURL(mimeType, quality);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    // 允许跨域 URL 通过 crossOrigin 走 CORS（如果远端拒，会触发 onerror，使用方再降级）
    if (!src.startsWith('data:')) {
      image.crossOrigin = 'anonymous';
    }
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片加载失败'));
    image.src = src;
  });
}
