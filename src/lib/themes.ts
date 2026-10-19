/**
 * 主题色板库：每套主题一组完整 CSS 变量，运行时注入 <html> 行内样式，
 * 覆盖 index.css 的昼白（:root）/ 夜墨（.dark）基底。
 * 昼白 / 夜墨本身就是基底，vars 留空。
 */

export interface ThemeDef {
  id: string;
  name: string;
  kind: "light" | "dark";
  /** 设置页下拉里的色块颜色 */
  dot: string;
  vars: Record<string, string>;
}

/** 由紧凑色板生成全套变量映射（亮暗通用，颜色值决定明暗） */
function palette(o: {
  bg: string; card: string; sunken: string; raised: string; accent: string; border: string;
  fg: string; sub: string; faint: string;
  primary: string; onPrimary: string; onAccent: string;
  red: string; onRed: string; green: string; yellow: string; purple: string; wikilink: string;
}): Record<string, string> {
  return {
    "background": o.bg, "foreground": o.fg,
    "card": o.card, "card-foreground": o.fg,
    "popover": o.card, "popover-foreground": o.fg,
    "primary": o.primary, "primary-foreground": o.onPrimary,
    "secondary": o.sunken, "secondary-foreground": o.sub,
    "muted": o.raised, "muted-foreground": o.faint,
    "accent": o.accent, "accent-foreground": o.onAccent,
    "destructive": o.red, "destructive-foreground": o.onRed,
    "border": o.border, "input": o.border, "ring": o.primary,
    "sidebar": o.sunken, "sidebar-foreground": o.fg,
    "sidebar-accent": o.accent, "sidebar-accent-foreground": o.onAccent,
    "st-todo": o.faint, "st-doing": o.primary, "st-blocked": o.red, "st-done": o.green, "st-wont": o.sub,
    "wikilink": o.wikilink, "seal": o.red, "daily": o.purple, "warn": o.yellow, "over": o.red,
  };
}

export const THEMES: ThemeDef[] = [
  { id: "daybreak", name: "昼白", kind: "light", dot: "#2b4c7e", vars: {} },
  {
    id: "purewhite", name: "洁白", kind: "light", dot: "#ffffff",
    vars: palette({
      bg: "#ffffff", card: "#ffffff", sunken: "#f6f7f9", raised: "#f1f3f5", accent: "#e9f0fa", border: "#e4e7ec",
      fg: "#181d26", sub: "#3b4353", faint: "#6b7280",
      primary: "#2b4c7e", onPrimary: "#f4f6fa", onAccent: "#1f3a61",
      red: "#be4b31", onRed: "#fdf4f0", green: "#4a7c59", yellow: "#a8763e", purple: "#7a557e", wikilink: "#35618f",
    }),
  },
  { id: "nightink", name: "夜墨", kind: "dark", dot: "#7fa3d4", vars: {} },
  {
    id: "polar", name: "极夜", kind: "dark", dot: "#58a6ff",
    vars: palette({
      bg: "#0d1117", card: "#161b22", sunken: "#10151d", raised: "#1c232c", accent: "#1f2a37", border: "#262d36",
      fg: "#e6edf3", sub: "#c9d1d9", faint: "#8b949e",
      primary: "#58a6ff", onPrimary: "#0b1220", onAccent: "#cddff5",
      red: "#f85149", onRed: "#140a09", green: "#57ab5a", yellow: "#e3b341", purple: "#d2a8ff", wikilink: "#79c0ff",
    }),
  },
  {
    id: "ocean", name: "海洋", kind: "dark", dot: "#35c4d8",
    vars: palette({
      bg: "#081820", card: "#0d2129", sunken: "#0a1c24", raised: "#12262e", accent: "#143038", border: "#1b3a44",
      fg: "#dff3f5", sub: "#bcd8dd", faint: "#7fa2a9",
      primary: "#35c4d8", onPrimary: "#04161b", onAccent: "#c2ecf2",
      red: "#ef7d68", onRed: "#190c09", green: "#55c48a", yellow: "#d8b356", purple: "#a8a2e8", wikilink: "#6ed3e0",
    }),
  },
  {
    id: "abyss", name: "深渊", kind: "dark", dot: "#8b9dff",
    vars: palette({
      bg: "#0f1626", card: "#141d31", sunken: "#121a2d", raised: "#1a2440", accent: "#1e2b4d", border: "#263252",
      fg: "#e2e6f2", sub: "#c5cbe2", faint: "#8890b0",
      primary: "#8b9dff", onPrimary: "#0b1020", onAccent: "#ccd8ff",
      red: "#e97c7c", onRed: "#180d0d", green: "#6cc08a", yellow: "#d9ae5e", purple: "#c39be0", wikilink: "#9fb3ff",
    }),
  },
  {
    id: "forest", name: "森林", kind: "dark", dot: "#71c88f",
    vars: palette({
      bg: "#0e1610", card: "#132017", sunken: "#101b14", raised: "#182820", accent: "#1d3327", border: "#24382c",
      fg: "#e3ecdf", sub: "#c4d6c6", faint: "#8aa392",
      primary: "#71c88f", onPrimary: "#0a1710", onAccent: "#cdf0d8",
      red: "#e07856", onRed: "#190d08", green: "#a3d977", yellow: "#d3b25e", purple: "#b79bd1", wikilink: "#8fd3a8",
    }),
  },
  {
    id: "violet", name: "紫罗兰", kind: "dark", dot: "#a78bfa",
    vars: palette({
      bg: "#151021", card: "#1a1528", sunken: "#181226", raised: "#201834", accent: "#271d42", border: "#2e2350",
      fg: "#eae6f5", sub: "#cfc8e4", faint: "#948bb0",
      primary: "#a78bfa", onPrimary: "#14102a", onAccent: "#ded4ff",
      red: "#e87bac", onRed: "#1c0d14", green: "#7fc9a3", yellow: "#d9b25f", purple: "#d9a06b", wikilink: "#bba8ff",
    }),
  },
  {
    id: "latte", name: "拿铁", kind: "dark", dot: "#d9a066",
    vars: palette({
      bg: "#1e1812", card: "#251e15", sunken: "#1a140e", raised: "#282019", accent: "#33281c", border: "#3a2f22",
      fg: "#f0e8dc", sub: "#ddd0bd", faint: "#a89880",
      primary: "#d9a066", onPrimary: "#1d1409", onAccent: "#f3ddb8",
      red: "#d96b52", onRed: "#1c0c07", green: "#96b877", yellow: "#cf9f4e", purple: "#b795c9", wikilink: "#e0b076",
    }),
  },
  {
    id: "dusk", name: "薄暮", kind: "dark", dot: "#e28ca3",
    vars: palette({
      bg: "#1d1319", card: "#241820", sunken: "#191017", raised: "#261a22", accent: "#352030", border: "#3c2833",
      fg: "#f1e4e8", sub: "#dcc8cf", faint: "#a68e99",
      primary: "#e28ca3", onPrimary: "#1e0d13", onAccent: "#f5cfdb",
      red: "#e26d5a", onRed: "#1c0a07", green: "#83c9a0", yellow: "#d4a95c", purple: "#b48fd9", wikilink: "#eeb0c2",
    }),
  },
  {
    id: "inkblack", name: "墨黑", kind: "dark", dot: "#a8a8b3",
    vars: palette({
      bg: "#101012", card: "#161618", sunken: "#141416", raised: "#1d1d20", accent: "#242429", border: "#2a2a2f",
      fg: "#e9e9ec", sub: "#cfcfd6", faint: "#909098",
      primary: "#a8a8b3", onPrimary: "#101013", onAccent: "#dcdce4",
      red: "#e5655e", onRed: "#170908", green: "#7fc98f", yellow: "#d4b05e", purple: "#b393d6", wikilink: "#b0b0d0",
    }),
  },
];

export function themeKind(id: string): "light" | "dark" {
  return THEMES.find((t) => t.id === id)?.kind ?? "light";
}

/** 旧版 localStorage 只存 light / dark，迁移到主题 id */
export function migrateTheme(v: string | null): string {
  if (v === "light") return "daybreak";
  if (v === "dark") return "nightink";
  return v && THEMES.some((t) => t.id === v) ? v : "daybreak";
}

let appliedVars: string[] = [];

export function applyTheme(id: string) {
  const t = THEMES.find((x) => x.id === id) ?? THEMES[0];
  const root = document.documentElement;
  for (const k of appliedVars) root.style.removeProperty(`--${k}`);
  appliedVars = Object.keys(t.vars);
  for (const [k, v] of Object.entries(t.vars)) root.style.setProperty(`--${k}`, v);
  root.classList.toggle("dark", t.kind === "dark");
}
