import React, { useEffect, useState } from 'react';
import { gallery, PrivateMap, Metadata } from './api';

const meta: Metadata = {
  title: '私人地图预览',
  category: 'fictional',
  description: '',
  city: '',
  allowFork: false,
  includeNotes: false,
  coverCrop: { zoom: 1, x: 0, y: 0 }
};

// 会话内缓存已生成的私人地图 SVG dataURL，避免每次打开“我的地图”重复并发请求预览接口占用连接池
const thumbDataUrlCache = new Map<string, string>();

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export default function PrivateMapThumbnail({ map }: { map: PrivateMap }) {
  const cacheKey = `${map.id}:${map.updatedAt}:${map.lineCount || 0}:${map.stationCount || 0}`;
  const [url, setUrl] = useState(() => thumbDataUrlCache.get(cacheKey) || '');

  useEffect(() => {
    if (!map.lineCount || !map.stationCount) {
      setUrl('');
      return;
    }
    const cached = thumbDataUrlCache.get(cacheKey);
    if (cached) {
      setUrl(cached);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    gallery
      .preview(map.id, meta, controller.signal, true)
      .then(blobToDataUrl)
      .then((dataUrl) => {
        if (!dataUrl) return;
        if (thumbDataUrlCache.size >= 48) {
          const oldest = thumbDataUrlCache.keys().next().value;
          if (oldest) thumbDataUrlCache.delete(oldest);
        }
        thumbDataUrlCache.set(cacheKey, dataUrl);
        if (!cancelled) setUrl(dataUrl);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [cacheKey, map.id, map.lineCount, map.stationCount]);

  return (
    <div className="gallery-private-thumb">
      {url ? <img src={url} alt={`${map.name}预览`} loading="lazy" /> : <span>私人存档</span>}
    </div>
  );
}
