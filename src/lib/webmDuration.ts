// MediaRecorder 的 WebM 通常没有 Duration，播放器会显示无限时长。
// 只补写无索引、未知 Segment 长度的流式文件；已有完整元数据的文件原样保留。
// Duration 单位见 https://www.matroska.org/technical/elements.html
function readElement(bytes: Uint8Array, offset: number) {
  const readVint = (at: number, keepMarker: boolean) => {
    let length = 1;
    let marker = 0x80;
    while (length <= 8 && !(bytes[at] & marker)) { length += 1; marker >>= 1; }
    if (length > 8 || at + length > bytes.length) return null;
    let value = keepMarker ? bytes[at] : bytes[at] & (marker - 1);
    let unknown = !keepMarker && value === marker - 1;
    for (let index = 1; index < length; index += 1) {
      value = value * 256 + bytes[at + index];
      unknown = unknown && bytes[at + index] === 255;
    }
    return { value, length, unknown };
  };
  const id = readVint(offset, true);
  if (!id) return null;
  const size = readVint(offset + id.length, false);
  if (!size) return null;
  const dataStart = offset + id.length + size.length;
  return { id: id.value, size: size.value, unknown: size.unknown, dataStart, end: dataStart + size.value };
}

export function webmDurationPatch(bytes: Uint8Array, durationMs: number) {
  if (!(durationMs > 0)) return null;
  let offset = 0;
  let segmentFound = false;
  while (offset < bytes.length) {
    const element = readElement(bytes, offset);
    if (!element) return null;
    if (element.id === 0x18538067) {
      if (!element.unknown) return null;
      segmentFound = true;
      offset = element.dataStart;
      continue;
    }
    // 插入字节会改变索引位置；有索引的文件不在此处重写。
    if (element.id === 0x114d9b74 || element.id === 0x1c53bb6b || element.id === 0x1f43b675) return null;
    if (segmentFound && element.id === 0x1549a966) {
      if (element.unknown || element.end > bytes.length) return null;
      let timestampScale = 1_000_000;
      let childOffset = element.dataStart;
      while (childOffset < element.end) {
        const child = readElement(bytes, childOffset);
        if (!child || child.unknown || child.end > element.end) return null;
        if (child.id === 0x4489 || child.id === 0xbf) return null; // 已有时长或 CRC
        if (child.id === 0x2ad7b1) {
          timestampScale = 0;
          for (let index = child.dataStart; index < child.end; index += 1) timestampScale = timestampScale * 256 + bytes[index];
        }
        childOffset = child.end;
      }
      if (!(timestampScale > 0)) return null;
      const duration = new Uint8Array(11);
      duration.set([0x44, 0x89, 0x88]);
      new DataView(duration.buffer).setFloat64(3, durationMs * 1_000_000 / timestampScale, false);
      const size = element.size + duration.length;
      let sizeLength = 1;
      while (size >= Math.pow(2, sizeLength * 7) - 1) sizeLength += 1;
      const header = new Uint8Array(4 + sizeLength);
      header.set([0x15, 0x49, 0xa9, 0x66]);
      let remaining = size;
      for (let index = sizeLength - 1; index >= 0; index -= 1) {
        header[4 + index] = remaining % 256;
        remaining = Math.floor(remaining / 256);
      }
      header[4] |= 1 << (8 - sizeLength);
      return { start: offset, end: element.end, header, duration, content: bytes.slice(element.dataStart, element.end) };
    }
    if (element.unknown || element.end > bytes.length) return null;
    offset = element.end;
  }
  return null;
}

export async function addWebmDuration(blob: Blob, durationMs: number) {
  if (!blob.type.startsWith('video/webm') || blob.size < 12 || typeof blob.arrayBuffer !== 'function') return blob;
  const bytes = new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer());
  const patch = webmDurationPatch(bytes, durationMs);
  if (!patch) return blob;
  return new Blob([blob.slice(0, patch.start), patch.header, patch.content, patch.duration, blob.slice(patch.end)], { type: blob.type });
}
