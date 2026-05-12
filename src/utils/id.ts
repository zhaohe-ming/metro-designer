// 简单的唯一 ID 生成器：优先用 crypto.randomUUID，老浏览器回退到 时间戳 + 随机后缀。
// 用来取代项目中曾经直接调用的 Date.now().toString() —— 后者在同一毫秒内连续创建会冲突。
export const createId = (): string => {
  if (typeof crypto !== 'undefined' && typeof (crypto as Crypto & { randomUUID?: () => string }).randomUUID === 'function') {
    return (crypto as Crypto & { randomUUID: () => string }).randomUUID();
  }
  return `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};
