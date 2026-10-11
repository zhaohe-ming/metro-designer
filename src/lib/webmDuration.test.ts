import { webmDurationPatch } from './webmDuration';

const prefix = [0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
test('流式 WebM 的 Duration 使用 TimestampScale，保留后续视频数据', () => {
  const scale = [0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40];
  const bytes = new Uint8Array([...prefix, 0x15, 0x49, 0xa9, 0x66, 0x87, ...scale, 0x1f, 0x43, 0xb6, 0x75]);
  const patch = webmDurationPatch(bytes, 3000)!;
  expect(patch.start).toBe(12);
  expect(patch.end).toBe(24);
  expect(Array.from(patch.content)).toEqual(scale);
  expect(new DataView(patch.duration.buffer).getFloat64(3, false)).toBe(3000);
});

test('不重写有索引、已有时长或损坏的 WebM', () => {
  expect(webmDurationPatch(new Uint8Array([...prefix, 0x11, 0x4d, 0x9b, 0x74, 0x80]), 1000)).toBeNull();
  expect(webmDurationPatch(new Uint8Array([...prefix, 0x15, 0x49, 0xa9, 0x66, 0x84, 0x44, 0x89, 0x81, 0x01]), 1000)).toBeNull();
  expect(webmDurationPatch(new Uint8Array([0]), 1000)).toBeNull();
});
