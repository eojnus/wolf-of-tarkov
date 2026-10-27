/**
 * 环境模块 —— 天气状态、天气调度与昼夜/天气的表现采样（纯计算）。
 *
 * 职责边界：
 *  - 只认识自己的切片与 `content/config` 的 `ENVIRONMENT`，不读 `GameState`、
 *    不碰 Three.js / DOM / 浏览器存储 / 经济数据；
 *  - 时间只由调用方以「游戏分钟」传入，本模块不持有时钟、不由渲染帧驱动；
 *  - 天气只在游戏分钟推进时求解目标状态：跳时直接得到目标天气，不逐帧重播历史，
 *    也不产生无界追赶循环；
 *  - 计算分两层：先按 `minuteOfDay` 求昼夜基准，再用天气修饰量在基准上混合，
 *    不复制「时间 × 天气」的预设矩阵。
 *
 * 太阳方向采用余弦高度角模型（日出 06:00、日落 18:00、正午最高）：
 * 它在午夜处连续，不存在 23:59 → 00:00 的跳变，也不需要第二套日历。
 */

import { CALENDAR, ENVIRONMENT, type WeatherKind } from '../../content/config';
import { BusinessError } from '../../core/errors';
import type { DeepReadonly } from '../../core/readonly';

/** 首版四种天气。抽签与校验都以它为准，不再另立清单。 */
const WEATHER_KINDS: readonly WeatherKind[] = ['clear', 'cloudy', 'rain', 'fog'];

/** 天气种类守卫：读档校验用它拒绝非法值，不用类型断言。 */
export function isWeatherKind(value: string): value is WeatherKind {
  return value === 'clear' || value === 'cloudy' || value === 'rain' || value === 'fog';
}

/**
 * 环境切片的全部持久字段。
 *
 * 只保存**不能由游戏时间可靠推导**的内容：当前天气、过渡起点、下次调度时刻与
 * 天气专用随机游标。太阳位置、天空颜色、雾距离、环境光强度都是时间的函数，
 * 不进存档。
 */
export interface EnvironmentState {
  /** 当前（目标）天气。 */
  weather: WeatherKind;
  /** 本次过渡的来源天气；与 `weather` 相同时表示没有过渡。 */
  previousWeather: WeatherKind;
  /** 当前天气开始的游戏分钟，也是过渡起点。 */
  changedAtMinute: number;
  /** 下一次天气调度的游戏分钟。 */
  endsAtMinute: number;
  /** 天气随机游标（mulberry32 状态），与经济随机完全隔离。 */
  randomState: number;
}

export type ReadonlyEnvironmentState = DeepReadonly<EnvironmentState>;

/**
 * 一帧的表现采样结果（普通数字，不含 Three.js 对象）。
 *
 * 由调用方持有一份并反复传入，`sampleEnvironment` 原地写入，
 * 因此渲染循环里不产生每帧分配。
 */
export interface EnvironmentSample {
  /** 采样用的表现分钟（权威整数分钟 + 不足一分钟的余量）。 */
  minute: number;
  minuteOfDay: number;
  weather: WeatherKind;
  previousWeather: WeatherKind;
  /** 天气过渡进度 0..1；1 表示已完全进入当前天气。 */
  weatherBlend: number;
  /** 太阳方向的单位向量（世界坐标：+X 东、+Z 南、+Y 上）。 */
  sunDirectionX: number;
  sunDirectionY: number;
  sunDirectionZ: number;
  /** 太阳高度角（弧度，可为负）。 */
  sunElevation: number;
  /** 太阳可见度 0..1：地平线附近淡出，日盘与直接光共用。 */
  sunVisibility: number;
  sunColor: number;
  sunIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  ambientIntensity: number;
  skyTop: number;
  skyHorizon: number;
  skyGround: number;
  fogColor: number;
  /** 相对城市边界推导出的基础雾距离的倍率。 */
  fogNearScale: number;
  fogFarScale: number;
  starOpacity: number;
  /** 雨量 0..1，同时决定粒子数量与不透明度。 */
  rainAmount: number;
}

/** 跳时最多重放多少个天气周期；超过后直接落到目标时刻重新抽签。 */
const MAX_SCHEDULE_STEPS = 512;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  if (edge1 <= edge0) return value >= edge1 ? 1 : 0;
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** 两个 0xRRGGBB 颜色按 t 混合；只做表现插值，不参与任何业务判断。 */
function mixHex(from: number, to: number, t: number): number {
  const k = clamp01(t);
  const fr = (from >> 16) & 0xff;
  const fg = (from >> 8) & 0xff;
  const fb = from & 0xff;
  const tr = (to >> 16) & 0xff;
  const tg = (to >> 8) & 0xff;
  const tb = to & 0xff;
  const r = Math.round(lerp(fr, tr, k));
  const g = Math.round(lerp(fg, tg, k));
  const b = Math.round(lerp(fb, tb, k));
  return (r << 16) | (g << 8) | b;
}

/** mulberry32：状态是一个 32 位整数，可完整进存档；与行情共用同一类算法但各自独立。 */
function nextRandom(state: { randomState: number }): number {
  let t = (state.randomState = (state.randomState + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** 当天的第几分钟（0..1440，可为小数，用于帧内平滑）。 */
function minuteOfDayOf(minute: number): number {
  const raw = minute + CALENDAR.start.minuteOfDay;
  const perDay = CALENDAR.minutesPerDay;
  const wrapped = ((raw % perDay) + perDay) % perDay;
  return wrapped;
}

/** 当前天气的持续时长（按配置范围抽签，消耗一次天气随机）。 */
function durationFor(state: { randomState: number }, weather: WeatherKind): number {
  const range = ENVIRONMENT.weather.duration[weather];
  const span = range.max - range.min;
  return range.min + Math.floor(nextRandom(state) * (span + 1));
}

/** 按转移概率抽下一种天气。 */
function pickNextWeather(state: { randomState: number }, current: WeatherKind): WeatherKind {
  const table = ENVIRONMENT.weather.transitions[current];
  const roll = nextRandom(state);
  let cumulative = 0;
  for (const kind of WEATHER_KINDS) {
    cumulative += table[kind];
    if (roll < cumulative) return kind;
  }
  // 浮点累加可能略小于 1：落到表内最后一个正权重项，保证永远返回合法天气
  let fallback: WeatherKind = current;
  for (const kind of WEATHER_KINDS) {
    if (table[kind] > 0) fallback = kind;
  }
  return fallback;
}

/**
 * 新游戏与旧档迁移的初始环境。
 *
 * 完全由 `nowMinute` 与配置种子决定（可复现）：开局直接落在 `initial` 天气上，
 * 不做淡入；下一次调度时刻由配置时长范围抽签得出。
 */
export function createEnvironmentState(nowMinute: number): EnvironmentState {
  const now = Number.isSafeInteger(nowMinute) ? Math.max(0, nowMinute) : 0;
  const state: EnvironmentState = {
    weather: ENVIRONMENT.weather.initial,
    previousWeather: ENVIRONMENT.weather.initial,
    changedAtMinute: Math.max(0, now - ENVIRONMENT.weather.transitionMinutes),
    endsAtMinute: now,
    randomState: ENVIRONMENT.weather.seed >>> 0,
  };
  state.endsAtMinute = now + durationFor(state, state.weather);
  return state;
}

/**
 * 把天气调度推进到 `nowMinute`。
 *
 * 只在 `nowMinute ≥ endsAtMinute` 时逐周期推进，每个周期消耗一次随机；
 * 一次跨越多个周期的跳时因此直接得到目标天气，不会逐帧重播中间过程。
 * 极端跳时（周期数超过上限）直接落到目标时刻重新抽签，保证循环有界。
 */
export function advanceEnvironment(state: EnvironmentState, nowMinute: number): void {
  if (!Number.isSafeInteger(nowMinute) || nowMinute < 0) {
    throw new BusinessError('INVALID_ENVIRONMENT_TICK', '环境调度时间必须是非负整数分钟');
  }
  if (nowMinute < state.endsAtMinute) return;

  let guard = 0;
  while (nowMinute >= state.endsAtMinute) {
    guard += 1;
    if (guard > MAX_SCHEDULE_STEPS) {
      // 已经跳过太多周期：不再重放历史，直接以当前时刻重新开始一段天气
      const next = pickNextWeather(state, state.weather);
      state.previousWeather = state.weather;
      state.weather = next;
      state.changedAtMinute = Math.max(0, nowMinute - ENVIRONMENT.weather.transitionMinutes);
      state.endsAtMinute = nowMinute + durationFor(state, next);
      return;
    }
    const at = state.endsAtMinute;
    const next = pickNextWeather(state, state.weather);
    state.previousWeather = state.weather;
    state.weather = next;
    // 过渡从上一段天气结束的那一刻开始，因此连续多次切换不会出现视觉空档
    state.changedAtMinute = at;
    state.endsAtMinute = at + durationFor(state, next);
  }
}

/** 过渡进度：0 表示刚开始切换，1 表示已经完全进入当前天气。 */
function weatherBlendAt(
  state: ReadonlyEnvironmentState,
  minute: number,
): number {
  const duration = ENVIRONMENT.weather.transitionMinutes;
  if (duration <= 0) return 1;
  return clamp01((minute - state.changedAtMinute) / duration);
}

/** 新建一份空白采样（调用方持有并复用，避免每帧分配）。 */
export function createEnvironmentSample(): EnvironmentSample {
  return {
    minute: 0,
    minuteOfDay: 0,
    weather: 'clear',
    previousWeather: 'clear',
    weatherBlend: 1,
    sunDirectionX: 0,
    sunDirectionY: 1,
    sunDirectionZ: 0,
    sunElevation: 0,
    sunVisibility: 1,
    sunColor: 0xffffff,
    sunIntensity: 1,
    hemiSky: 0xffffff,
    hemiGround: 0x808080,
    hemiIntensity: 1,
    ambientIntensity: 0.15,
    skyTop: 0x4a86c9,
    skyHorizon: 0xdae4ea,
    skyGround: 0x7b8671,
    fogColor: 0xb6c8d6,
    fogNearScale: 1,
    fogFarScale: 1,
    starOpacity: 0,
    rainAmount: 0,
  };
}

/** 关键帧区间：返回起始下标与区间内进度，避免每帧创建对象。 */
function keyframeIndexAt(minuteOfDay: number): number {
  const frames = ENVIRONMENT.skyKeyframes;
  for (let i = frames.length - 2; i >= 0; i -= 1) {
    if (minuteOfDay >= frames[i].at) return i;
  }
  return 0;
}

/**
 * 在 `minute` 处求一份表现采样，原地写入 `out`。
 *
 * `minute` 允许带小数：主循环的余量只用于视觉平滑，权威时间仍是 `clock.totalMinute`。
 */
export function sampleEnvironment(
  state: ReadonlyEnvironmentState,
  minute: number,
  out: EnvironmentSample,
): EnvironmentSample {
  const safeMinute = Number.isFinite(minute) ? Math.max(0, minute) : 0;
  const minuteOfDay = minuteOfDayOf(safeMinute);
  out.minute = safeMinute;
  out.minuteOfDay = minuteOfDay;
  out.weather = state.weather;
  out.previousWeather = state.previousWeather;

  /* ---------------------------------------------------- 1. 昼夜基准 */
  const frames = ENVIRONMENT.skyKeyframes;
  const index = keyframeIndexAt(minuteOfDay);
  const from = frames[index];
  const to = frames[Math.min(index + 1, frames.length - 1)];
  const span = to.at - from.at;
  const t = span > 0 ? clamp01((minuteOfDay - from.at) / span) : 0;

  let sunColor = mixHex(from.sunColor, to.sunColor, t);
  let sunIntensity = lerp(from.sunIntensity, to.sunIntensity, t);
  let hemiSky = mixHex(from.hemiSky, to.hemiSky, t);
  let hemiGround = mixHex(from.hemiGround, to.hemiGround, t);
  let hemiIntensity = lerp(from.hemiIntensity, to.hemiIntensity, t);
  let ambientIntensity = lerp(from.ambientIntensity, to.ambientIntensity, t);
  let skyTop = mixHex(from.skyTop, to.skyTop, t);
  let skyHorizon = mixHex(from.skyHorizon, to.skyHorizon, t);
  let skyGround = mixHex(from.skyGround, to.skyGround, t);
  let fogColor = mixHex(from.fogColor, to.fogColor, t);
  let starOpacity = lerp(from.starOpacity, to.starOpacity, t);

  /* ------------------------------------------- 2. 太阳方向（连续余弦模型） */
  const hourAngle = ((minuteOfDay - 720) / CALENDAR.minutesPerDay) * Math.PI * 2;
  const sinElevation = Math.sin(ENVIRONMENT.sun.maxElevationRad) * Math.cos(hourAngle);
  const elevation = Math.asin(Math.min(1, Math.max(-1, sinElevation)));
  const cosElevation = Math.cos(elevation);
  out.sunElevation = elevation;
  // 世界坐标：+X 东、+Z 南。日出于 +X，正午偏 +Z 高处，日落于 −X。
  out.sunDirectionX = -Math.sin(hourAngle) * cosElevation;
  out.sunDirectionY = sinElevation;
  out.sunDirectionZ = Math.cos(hourAngle) * cosElevation;
  out.sunVisibility = smoothstep(0, ENVIRONMENT.sun.horizonFadeRad, elevation);

  /* ---------------------------------------------------- 3. 天气修饰 */
  const blend = weatherBlendAt(state, safeMinute);
  const fromProfile = ENVIRONMENT.weather.profiles[state.previousWeather];
  const toProfile = ENVIRONMENT.weather.profiles[state.weather];
  const greyness = lerp(fromProfile.greyness, toProfile.greyness, blend);
  const sunMultiplier = lerp(fromProfile.sunMultiplier, toProfile.sunMultiplier, blend);
  const hemiMultiplier = lerp(fromProfile.hemiMultiplier, toProfile.hemiMultiplier, blend);
  const ambientBonus = lerp(fromProfile.ambientBonus, toProfile.ambientBonus, blend);
  const starMultiplier = lerp(fromProfile.starMultiplier, toProfile.starMultiplier, blend);
  out.fogNearScale = lerp(fromProfile.fogNearScale, toProfile.fogNearScale, blend);
  out.fogFarScale = lerp(fromProfile.fogFarScale, toProfile.fogFarScale, blend);
  out.rainAmount = clamp01(lerp(fromProfile.rainAmount, toProfile.rainAmount, blend));
  out.weatherBlend = blend;

  const overcast = ENVIRONMENT.weather.overcast;
  skyTop = mixHex(skyTop, overcast.skyTop, greyness);
  skyHorizon = mixHex(skyHorizon, overcast.skyHorizon, greyness);
  skyGround = mixHex(skyGround, overcast.skyGround, greyness);
  fogColor = mixHex(fogColor, overcast.fogColor, greyness);
  sunColor = mixHex(sunColor, overcast.sunColor, greyness);

  out.skyTop = skyTop;
  out.skyHorizon = skyHorizon;
  out.skyGround = skyGround;
  out.fogColor = fogColor;
  out.sunColor = sunColor;
  // 直接光同时受「昼夜强度」「天气遮挡」「地平线淡出」三者约束
  out.sunIntensity = sunIntensity * sunMultiplier * out.sunVisibility;
  out.hemiSky = hemiSky;
  out.hemiGround = hemiGround;
  out.hemiIntensity = hemiIntensity * hemiMultiplier;
  out.ambientIntensity = ambientIntensity + ambientBonus;
  // 阴雨天星空被云遮住；夜晚之外的白天本来就是 0
  out.starOpacity = clamp01(starOpacity * starMultiplier);

  return out;
}
