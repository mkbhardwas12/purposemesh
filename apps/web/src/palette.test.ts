import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");

function hueFor(red: number, green: number, blue: number): number {
  const [r, g, b] = [red, green, blue].map((value) => value / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (delta === 0) return 0;
  const raw = max === r
    ? ((g - b) / delta) % 6
    : max === g
      ? (b - r) / delta + 2
      : (r - g) / delta + 4;
  return (raw * 60 + 360) % 360;
}

function saturationFor(red: number, green: number, blue: number): number {
  const [r, g, b] = [red, green, blue].map((value) => value / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const delta = max - min;
  return delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
}

describe("PurposeMesh palette", () => {
  it("contains no named purple-family colors", () => {
    expect(stylesheet).not.toMatch(/\b(?:purple|violet|magenta|lavender|indigo|orchid|plum|fuchsia)\b/i);
  });

  it("contains no saturated purple-family color literals", () => {
    const colors: Array<{ token: string; rgb: [number, number, number] }> = [];
    for (const match of stylesheet.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)) {
      const expanded = match[1].length === 3
        ? [...match[1]].map((digit) => digit + digit).join("")
        : match[1];
      colors.push({
        token: match[0],
        rgb: [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16)) as [number, number, number],
      });
    }
    for (const match of stylesheet.matchAll(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/gi)) {
      colors.push({
        token: match[0],
        rgb: [Number(match[1]), Number(match[2]), Number(match[3])],
      });
    }

    const purple = colors.filter(({ rgb }) => {
      const hue = hueFor(...rgb);
      return hue >= 250 && hue <= 330 && saturationFor(...rgb) >= 0.18;
    });
    expect(purple.map(({ token }) => token)).toEqual([]);
  });
});
