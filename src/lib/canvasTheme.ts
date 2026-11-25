// 画布与导出表面（Konva / SVG / 动态预览）共用的主题对比度与徽标配色工具

function parseColorRgb(raw: string | undefined): [number, number, number] | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const hex6 = trimmed.match(/^#([0-9a-fA-F]{6})$/);
  if (hex6) {
    const h = hex6[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const hex3 = trimmed.match(/^#([0-9a-fA-F]{3})$/);
  if (hex3) {
    const h = hex3[1];
    return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)];
  }
  const rgb = trimmed.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (rgb) {
    return [
      Math.min(255, Number(rgb[1])),
      Math.min(255, Number(rgb[2])),
      Math.min(255, Number(rgb[3]))
    ];
  }
  return null;
}

export function computeRelativeLuminance(color: string | undefined): number | null {
  const rgb = parseColorRgb(color);
  if (!rgb) return null;
  const toLinear = (channel: number) => {
    const s = channel / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = rgb;
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/**
 * 解析在浅色/深色画布上可读的站名文字颜色：
 * - 深色画布下，若 dotLabelStyle.color 为默认深墨色 (#0f172a) 或过暗颜色（亮度 < 0.24），自动切换为浅色站名；
 *   若用户主动设置了高亮度自定义色（如琥珀金 #fbbf24、冰蓝 #93c5fd），则予以保留。
 * - 浅色画布下，若残留了纯白/极浅站名色（亮度 > 0.88），自动回退为深色站名以防隐形。
 */
export function resolveReadableStationLabelColor(
  configuredColor: string | undefined,
  isDarkSurface: boolean,
  fallbackLight = '#0f172a',
  fallbackDark = '#f8fafc'
): string {
  const trimmed = configuredColor?.trim() || '';
  if (!trimmed) {
    return isDarkSurface ? fallbackDark : fallbackLight;
  }
  const lum = computeRelativeLuminance(trimmed);
  if (isDarkSurface) {
    if (lum !== null && lum < 0.24) {
      return fallbackDark;
    }
    return trimmed;
  }
  if (lum !== null && lum > 0.88) {
    return fallbackLight;
  }
  return trimmed;
}

export function resolveLineBadgeColors(
  presetFill: string,
  presetText: string,
  isDarkSurface: boolean
): { fill: string; text: string } {
  if (!isDarkSurface) {
    return { fill: presetFill, text: presetText };
  }
  return {
    fill: '#0f172a',
    text: '#f8fafc'
  };
}
