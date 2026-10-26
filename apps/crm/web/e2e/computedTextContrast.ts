import type { Locator } from '@playwright/test';

/** Measure actual computed text/background colors, including transparent ancestor layers.
 * Fail rather than guess when images, opacity, filters or blending obscure the WCAG calculation.
 */
export async function computedTextContrast(locator: Locator) {
  return locator.evaluate(element => {
    type Rgb = [number, number, number];
    type Rgba = [number, number, number, number];
    const parseColor = (value: string): Rgba => {
      const match = /^rgba?\(([^)]+)\)$/.exec(value);
      if (!match) throw new Error(`Cannot measure computed color: ${value}`);
      const values = match[1]!.trim().split(/[\s,/]+/).map(Number);
      if (![3, 4].includes(values.length) || values.some(v => !Number.isFinite(v))
        || values.slice(0, 3).some(v => v < 0 || v > 255) || values[3] !== undefined && (values[3] < 0 || values[3] > 1)) {
        throw new Error(`Cannot measure computed color: ${value}`);
      }
      return [values[0]!, values[1]!, values[2]!, values[3] ?? 1];
    };
    const composite = (foreground: Rgba, background: Rgb): Rgb => [
      foreground[0] * foreground[3] + background[0] * (1 - foreground[3]),
      foreground[1] * foreground[3] + background[1] * (1 - foreground[3]),
      foreground[2] * foreground[3] + background[2] * (1 - foreground[3]),
    ];
    const backgrounds: Rgba[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.backgroundImage !== 'none' || Number(style.opacity) !== 1 || style.filter !== 'none'
        || style.mixBlendMode !== 'normal' || style.textShadow !== 'none') {
        throw new Error('Computed text contrast needs an unfiltered, unblended solid background.');
      }
      backgrounds.push(parseColor(style.backgroundColor));
    }
    if (!backgrounds.some(color => color[3] === 1)) throw new Error('Computed text contrast has no known opaque background.');
    let background: Rgb = [0, 0, 0];
    for (const layer of backgrounds.reverse()) background = composite(layer, background);
    const foreground = composite(parseColor(getComputedStyle(element).color), background);
    const luminance = (color: Rgb) => color.map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index]!, 0);
    const light = luminance(foreground); const dark = luminance(background);
    return { foreground, background, ratio: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05) };
  });
}
