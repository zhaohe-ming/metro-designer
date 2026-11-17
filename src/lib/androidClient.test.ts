import { saveAndroidExport } from './androidClient';

const fakeBlob = (data: Uint8Array): Blob => ({
  size: data.length, type: 'image/png',
  slice: (start: number, end: number) => ({ arrayBuffer: async () => data.slice(start, end).buffer })
} as unknown as Blob);

beforeAll(() => { Object.defineProperty(window, 'crypto', { configurable: true, value: { randomUUID: () => 'test-export-123' } }); });
afterEach(() => { delete window.MetroAndroid; });

test('大文件分块保存，收到系统保存成功回执后完成', async () => {
  const calls: any[] = [];
  window.MetroAndroid = { onmessage: null, postMessage: data => {
    const message = JSON.parse(data); calls.push(message);
    const status = message.type === 'begin' ? 'ready' : message.type === 'chunk' ? 'chunk' : 'saved';
    Promise.resolve().then(() => window.MetroAndroid?.onmessage?.({ data: JSON.stringify({ id: message.id, status }) }));
  } };
  expect(await saveAndroidExport(fakeBlob(new Uint8Array(65539).fill(42)), '地图.png')).toBe(true);
  expect(calls.map(call => call.type)).toEqual(['begin', 'chunk', 'chunk', 'finish']);
  expect(atob(calls[1].data).length).toBe(65536);
  expect(atob(calls[2].data).length).toBe(3);
  expect(window.MetroAndroid.onmessage).toBeNull();
});

test('用户取消系统保存返回取消状态', async () => {
  window.MetroAndroid = { onmessage: null, postMessage: data => {
    const message = JSON.parse(data);
    const status = message.type === 'begin' ? 'ready' : message.type === 'chunk' ? 'chunk' : 'cancelled';
    Promise.resolve().then(() => window.MetroAndroid?.onmessage?.({ data: JSON.stringify({ id: message.id, status }) }));
  } };
  expect(await saveAndroidExport(fakeBlob(new Uint8Array(3)), '地图.png')).toBe(false);
});

test('错误回执释放导出会话，超大文件在发送前被拦截', async () => {
  const calls: any[] = [];
  window.MetroAndroid = { onmessage: null, postMessage: data => {
    const message = JSON.parse(data); calls.push(message);
    if (message.type !== 'cancel') Promise.resolve().then(() => window.MetroAndroid?.onmessage?.({ data: JSON.stringify({ id: message.id, status: 'error' }) }));
  } };
  await expect(saveAndroidExport(fakeBlob(new Uint8Array(3)), '地图.png')).rejects.toThrow('保存失败');
  expect(calls[calls.length - 1].type).toBe('cancel');
  const size = calls.length;
  await expect(saveAndroidExport({ size: 513 * 1024 * 1024 } as Blob, '地图.png')).rejects.toThrow('512 MB');
  expect(calls.length).toBe(size);
});
