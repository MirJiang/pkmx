/** 本地时区的 YYYY-MM-DD */
export function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function dateOffset(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}

export const TODAY = dateOffset(0);

/** 最近 n 天（含今天）的日期数组，旧→新 */
export function lastNDays(n: number): string[] {
  return Array.from({ length: n }, (_, i) => dateOffset(i - (n - 1)));
}

/** 本周周一到周日的日期数组 */
export function currentWeek(): string[] {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7; // 周一=0
  const monday = new Date(now);
  monday.setDate(now.getDate() - dow);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return fmtDate(d);
  });
}

export function todayCN(): string {
  const d = new Date();
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  return `${TODAY} · 周${week}`;
}
