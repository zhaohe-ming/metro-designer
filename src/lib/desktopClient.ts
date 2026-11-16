export const desktopVersion = navigator.userAgent.match(/MetroDesignerDesktop\/(\d+\.\d+\.\d+)/)?.[1] || null;
export const isDesktopClient = desktopVersion !== null;

export const isNewerDesktopVersion = (latest: string, current: string): boolean => {
  if (!/^\d+\.\d+\.\d+$/.test(latest) || !/^\d+\.\d+\.\d+$/.test(current)) return false;
  const left = latest.split('.').map(Number);
  const right = current.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
};
