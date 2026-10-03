import type { ParamUnit } from "../types/circuit";

const PREFIXES: { suffix: string; factor: number }[] = [
  { suffix: "p", factor: 1e-12 },
  { suffix: "n", factor: 1e-9 },
  { suffix: "u", factor: 1e-6 },
  { suffix: "m", factor: 1e-3 },
  { suffix: "k", factor: 1e3 },
  { suffix: "meg", factor: 1e6 },
  { suffix: "M", factor: 1e6 },
  { suffix: "g", factor: 1e9 },
];

export const UNIT_SYMBOL: Record<ParamUnit, string> = {
  ohm: "\u03A9",
  farad: "F",
  henry: "H",
  volt: "V",
  hz: "Hz",
  none: "",
};

/** Parse strings like "4.7k", "10u", "1e-6", "100" into a plain number.
 *  Returns null if the text isn't a recognizable numeric value. */
export function parseSIValue(input: string): number | null {
  const text = input.trim();
  if (text === "") return null;

  // Plain number or scientific notation, no suffix.
  if (/^-?\d*\.?\d+(e-?\d+)?$/i.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }

  const match = text.match(/^(-?\d*\.?\d+)\s*([a-zA-Z]+)$/);
  if (!match) return null;
  const [, numPart, suffixPart] = match;
  const prefix = PREFIXES.find(
    (p) => p.suffix.toLowerCase() === suffixPart.toLowerCase()
  );
  if (!prefix) return null;
  const n = Number(numPart);
  return Number.isFinite(n) ? n * prefix.factor : null;
}

/** Format a plain number back into a compact SI string, e.g. 4700 -> "4.7k". */
export function formatSIValue(value: number, unit: ParamUnit): string {
  const symbol = UNIT_SYMBOL[unit];
  if (value === 0) return `0${symbol}`;

  const abs = Math.abs(value);
  const tiers: { suffix: string; factor: number }[] = [
    { suffix: "g", factor: 1e9 },
    { suffix: "M", factor: 1e6 },
    { suffix: "k", factor: 1e3 },
    { suffix: "", factor: 1 },
    { suffix: "m", factor: 1e-3 },
    { suffix: "u", factor: 1e-6 },
    { suffix: "n", factor: 1e-9 },
    { suffix: "p", factor: 1e-12 },
  ];
  const tier = tiers.find((t) => abs >= t.factor) ?? tiers[tiers.length - 1];
  const scaled = value / tier.factor;
  const rounded = Math.round(scaled * 1000) / 1000;
  return `${rounded}${tier.suffix}${symbol}`;
}
