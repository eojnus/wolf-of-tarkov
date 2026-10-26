/**
 * 日历与时间换算 —— 纯函数，无业务知识。
 *
 * 游戏时间的唯一表示是「整数游戏分钟」：totalMinute，从游戏起点（默认第 1 年 1 月 1 日 08:00）起算。
 * 首版采用每月固定 30 天的简化日历，不模拟真实月份长度与节假日。
 */

export interface CalendarConfig {
  /** 每月固定天数（首版 30）。 */
  readonly daysPerMonth: number;
  /** 每天分钟数（固定 1440）。 */
  readonly minutesPerDay: number;
  readonly start: {
    readonly year: number;
    readonly month: number;
    readonly day: number;
    /** 当天第几分钟（08:00 = 480）。 */
    readonly minuteOfDay: number;
  };
}

export interface GameDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 从游戏起点月份起算的月序号（0 起）。 */
  readonly monthIndex: number;
  /** 月份稳定标识，如 "2026-01"。 */
  readonly monthKey: string;
  /** 日期稳定标识，如 "2026-01-01"。 */
  readonly dayKey: string;
  /** 当天第几分钟。 */
  readonly minuteOfDay: number;
}

/** 一个月包含的分钟数。 */
export function monthLength(cfg: CalendarConfig): number {
  return cfg.daysPerMonth * cfg.minutesPerDay;
}

/** 第 0 月月初（第 1 年 1 月 1 日 00:00）对应的 totalMinute，通常为负数。 */
function monthZeroOrigin(cfg: CalendarConfig): number {
  return -((cfg.start.day - 1) * cfg.minutesPerDay + cfg.start.minuteOfDay);
}

/** totalMinute 所属月份序号（0 起）。 */
export function monthIndexAtMinute(totalMinute: number, cfg: CalendarConfig): number {
  return Math.floor((totalMinute - monthZeroOrigin(cfg)) / monthLength(cfg));
}

/** 指定月份的月初 totalMinute。 */
export function monthStartMinute(monthIndex: number, cfg: CalendarConfig): number {
  return monthZeroOrigin(cfg) + monthIndex * monthLength(cfg);
}

/** 指定月份结束后的那一刻（即下月月初），也是该月的结算边界。 */
export function monthEndBoundaryMinute(monthIndex: number, cfg: CalendarConfig): number {
  return monthStartMinute(monthIndex + 1, cfg);
}

/** 月份序号 → 稳定月份标识 "YYYY-MM"。 */
export function monthKeyOfIndex(monthIndex: number, cfg: CalendarConfig): string {
  const absolute = cfg.start.month - 1 + monthIndex;
  const year = cfg.start.year + Math.floor(absolute / 12);
  const month = (((absolute % 12) + 12) % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** 稳定月份标识 → 月份序号；格式非法返回 null。 */
export function monthIndexFromKey(monthKey: string, cfg: CalendarConfig): number | null {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return (year - cfg.start.year) * 12 + (month - 1) - (cfg.start.month - 1);
}

/** totalMinute → 结构化日期。 */
export function dateAtMinute(totalMinute: number, cfg: CalendarConfig): GameDate {
  const monthIndex = monthIndexAtMinute(totalMinute, cfg);
  const intoMonth = totalMinute - monthStartMinute(monthIndex, cfg);
  const dayIndex = Math.floor(intoMonth / cfg.minutesPerDay);
  const minuteOfDay = intoMonth - dayIndex * cfg.minutesPerDay;
  const absolute = cfg.start.month - 1 + monthIndex;
  const year = cfg.start.year + Math.floor(absolute / 12);
  const month = (((absolute % 12) + 12) % 12) + 1;
  const day = dayIndex + 1;
  return {
    year,
    month,
    day,
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
    monthIndex,
    monthKey: `${year}-${String(month).padStart(2, '0')}`,
    dayKey: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    minuteOfDay,
  };
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 从游戏起点月份起算的「日序号」（0 起）：monthIndex × daysPerMonth + (day − 1)。
 *
 * 它是日历自身的编号，与「累计分钟 ÷ 1440」无关——游戏从 08:00 起算，
 * 后者在午夜会差 8 小时。所有按天计数的周期（提案检查、日销量记录、
 * 冷却）都必须用这个序号，避免各写一套日界判断。
 */
export function daySerialAtMinute(totalMinute: number, cfg: CalendarConfig): number {
  const monthIndex = monthIndexAtMinute(totalMinute, cfg);
  const intoMonth = totalMinute - monthStartMinute(monthIndex, cfg);
  const dayIndex = Math.floor(intoMonth / cfg.minutesPerDay);
  return monthIndex * cfg.daysPerMonth + dayIndex;
}

/** "2026年1月1日 08:00"。 */
export function formatGameDate(date: GameDate): string {
  return `${date.year}年${date.month}月${date.day}日 ${pad2(date.hour)}:${pad2(date.minute)}`;
}

/** "08:00"。 */
export function formatClock(date: GameDate): string {
  return `${pad2(date.hour)}:${pad2(date.minute)}`;
}

/** 分钟数 → "4小时30分" / "25分钟"。 */
export function formatDuration(minutes: number): string {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const rest = safe % 60;
  if (hours === 0) return `${rest}分钟`;
  if (rest === 0) return `${hours}小时`;
  return `${hours}小时${rest}分`;
}
