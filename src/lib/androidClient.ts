export const androidVersion =
  navigator.userAgent.match(/(?:TransitCanvasAndroid|MetroDesignerAndroid)\/(\d+\.\d+\.\d+)/)?.[1] || null;
export const isAndroidClient = androidVersion !== null;
export const isAndroidDevice = /Android/i.test(navigator.userAgent);

type NativeBridge = {
  postMessage: (data: string) => void;
  onmessage: ((event: { data: string }) => void) | null;
};
declare global { interface Window { MetroAndroid?: NativeBridge } }

let saving = false;
const CHUNK_BYTES = 65536;

// Stream generated documents to Android's system save picker, without storage permissions.
export async function saveAndroidExport(blob: Blob, name: string): Promise<boolean> {
  const bridge = window.MetroAndroid;
  if (!bridge) throw new Error('请先更新 Android System WebView，再使用文件导出。');
  if (saving) throw new Error('请先完成当前文件的保存。');
  if (!blob.size || blob.size > 512 * 1024 * 1024) throw new Error('请选择大小在 512 MB 以内的导出文件。');
  const id = crypto.randomUUID?.() || `export-${Array.from(crypto.getRandomValues(new Uint8Array(12)), value => value.toString(16).padStart(2, '0')).join('')}`;
  saving = true;
  const previous = bridge.onmessage;
  let waiter: { resolve: (status: string) => void; reject: (error: Error) => void; timer: number } | null = null;
  let finished = false;
  bridge.onmessage = event => {
    try {
      const response = JSON.parse(event.data);
      if (response.id !== id || !waiter) return;
      window.clearTimeout(waiter.timer);
      const current = waiter; waiter = null;
      if (response.status === 'error') current.reject(new Error('文件保存失败，请重试并检查可用空间。'));
      else current.resolve(response.status);
    } catch { /* Ignore messages unrelated to this export. */ }
  };
  const send = (payload: object, timeout = 15000) => new Promise<string>((resolve, reject) => {
    const timer = window.setTimeout(() => { waiter = null; reject(new Error('保存等待超时，请重新导出。')); }, timeout);
    waiter = { resolve, reject, timer };
    try { bridge.postMessage(JSON.stringify({ ...payload, id })); }
    catch (error) { window.clearTimeout(timer); waiter = null; reject(error); }
  });
  try {
    if (await send({ type: 'begin', name, mime: blob.type.split(';')[0], size: blob.size }) !== 'ready')
      throw new Error('文件保存接口暂未就绪。');
    for (let offset = 0; offset < blob.size; offset += CHUNK_BYTES) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
      let binary = '';
      for (let index = 0; index < bytes.length; index += 8192)
        binary += String.fromCharCode(...Array.from(bytes.subarray(index, index + 8192)));
      if (await send({ type: 'chunk', data: btoa(binary) }) !== 'chunk') throw new Error('导出文件传输中断，请重试。');
    }
    const status = await send({ type: 'finish' }, 300000);
    if (status !== 'saved' && status !== 'cancelled') throw new Error('保存状态确认失败，请重试。');
    finished = true;
    return status === 'saved';
  } finally {
    if (!finished) {
      try { bridge.postMessage(JSON.stringify({ type: 'cancel', id })); } catch { /* Activity may be closing. */ }
    }
    bridge.onmessage = previous;
    saving = false;
  }
}
