/**
 * 集中配置 —— 时间、经济、就业、城市、摄像机、人物、行情、贷款、存档参数。
 * 业务代码不得内联这些数字；替换配置不应改动任何业务规则。
 */

import type { CalendarConfig } from '../core/calendar';

/**
 * 品牌与城市官方名称 —— 游戏运行时所有可见名称都从这里派生。
 *
 * 只集中「显示用」的名称：存档 format、IndexedDB 名称、公司/账户/股票代码、
 * 交互 ID 与资源路径都不属于这里，改这些会让旧进度丢失。
 */
export const BRANDING = {
  /** 游戏品牌：标题栏、启动页、暂停菜单、文档。 */
  gameTitle: '塔科夫之狼',
  gameSubtitle: '现代城市财富模拟',
  /** 城市官方名称。 */
  cityName: '塔科夫市',
  /** 城市名词干，用于派生「塔科夫银行」「塔科夫实业大厦」等官方设施名。 */
  cityStem: '塔科夫',
  /** 市民称呼。 */
  citizenName: '塔科夫市民',
} as const;

/* ------------------------------------------------------------------ 时间 */

export const CALENDAR: CalendarConfig = {
  daysPerMonth: 30,
  minutesPerDay: 1440,
  start: { year: 2026, month: 1, day: 1, minuteOfDay: 8 * 60 },
};

export const TIME = {
  calendar: CALENDAR,
  /**
   * 连续流逝：正常速度下现实 1 秒 = 游戏 2.4 分钟（600 秒 = 24 小时，10 分钟 = 1 天）。
   * 与人物是否移动、是否打开面板完全无关。
   */
  minutesPerRealSecond: 2.4,
  /** 可选倍率。倍率同时作用于时间与行情，不影响人物移动与动画速度。 */
  speedOptions: [1, 2, 4] as readonly number[],
  /**
   * 模拟时钟单帧最多采信的真实时间。只用于防止长时间冻结后瞬间跳跃，
   * 不参与常规帧，因此正常帧波动不会持续丢时间。
   */
  maxSimDeltaMs: 1000,
  /** 人物位移的单帧上限，仅用于避免掉帧穿墙；不得用于模拟时钟。 */
  maxMoveDeltaMs: 100,
  /** 睡觉目标时刻（次日 08:00）。 */
  wakeMinuteOfDay: 8 * 60,
  /** 休息预设。住宅面板与 HUD 共用，长档位用于快速验证跨月结算。 */
  restPresets: [
    { minutes: 60, label: '1 小时' },
    { minutes: 180, label: '3 小时' },
    { minutes: 1440, label: '1 天' },
    { minutes: 10080, label: '7 天' },
  ] as readonly { readonly minutes: number; readonly label: string }[],
} as const;

/* ---------------------------------------------------------------- 经济参数 */

export const ECONOMY = {
  /** 初始现金（分）：2,000 元。 */
  initialCash: 200_000,
  /** 初始银行存款（分）：8,000 元。 */
  initialSavings: 800_000,
  /** 每月房租（分）：3,500 元。 */
  rentCents: 350_000,
  /**
   * 每月基本生活费（分）：1,200 元。
   * 这是房租之外的固定生活开支（水电、日用品等），**不包含**本轮新增的食品饮料购买；
   * 便利店补给作为独立的「生活补给」个人支出流水入账。
   */
  livingCostCents: 120_000,
  /** 单笔存取款下限（分）：1 元。 */
  minimumTransferCents: 100,
  /** 单笔存取款上限（分）：100,000 元。 */
  maximumTransferCents: 10_000_000,
} as const;

/* ------------------------------------------------------------------ 生活补给 */

/** 便利店显示名与稳定标识：建筑、岗位与商品目录共用同一来源。 */
export const CONVENIENCE_STORE_NAME = '晴川便利店';
export const CONVENIENCE_SHOP_ID = 'convenience-store';
/** 便利店岗位 id（入职/班次与行政岗位共用同一套 employment 实现）。 */
export const CONVENIENCE_JOB_ID = 'shop-clerk';

/* ------------------------------------------------------------------ 就业 */

export interface JobConfig {
  readonly id: string;
  readonly title: string;
  readonly employer: string;
  readonly description: string;
  /** 时薪（分）。设为 60 的整数倍可保证按分钟计薪无余额误差。 */
  readonly hourlyWageCents: number;
  readonly shiftMinutes: number;
  readonly minShiftMinutes: number;
  readonly maxMinutesPerDay: number;
  readonly workWindowStart: number;
  readonly workWindowEnd: number;
}

export const JOBS: readonly JobConfig[] = [
  {
    id: 'office-clerk',
    title: '行政专员',
    employer: `${BRANDING.cityStem}实业`,
    description: '处理文件、会议与日常行政事务。每日最多 8 小时，班次 4 小时起。',
    hourlyWageCents: 6_000,
    shiftMinutes: 240,
    minShiftMinutes: 60,
    maxMinutesPerDay: 480,
    workWindowStart: 9 * 60,
    workWindowEnd: 18 * 60,
  },
  {
    id: 'shop-clerk',
    title: '便利店店员',
    employer: CONVENIENCE_STORE_NAME,
    description: '收银、理货与补货。每日最多 8 小时，班次 4 小时起，最短 1 小时。',
    hourlyWageCents: 4_500,
    shiftMinutes: 240,
    minShiftMinutes: 60,
    maxMinutesPerDay: 480,
    workWindowStart: 9 * 60,
    workWindowEnd: 18 * 60,
  },
];

export function findJob(jobId: string | null): JobConfig | null {
  if (!jobId) return null;
  return JOBS.find((job) => job.id === jobId) ?? null;
}

/* ------------------------------------------------------------------ 城市 */

export type BuildingKind = 'home' | 'bank' | 'office' | 'securities' | 'government' | 'shop';

export interface BuildingConfig {
  readonly id: string;
  readonly name: string;
  readonly kind: BuildingKind;
  readonly subtitle: string;
  /** 建筑中心（世界坐标，y 为地面高度）。 */
  readonly position: { readonly x: number; readonly z: number };
  /** 尺寸（米）：宽 x 高 x 深。模型加载后会按实际包围盒修正碰撞体。 */
  readonly size: { readonly width: number; readonly height: number; readonly depth: number };
  /** 入口点，只用于建筑正面与入口广场等视觉表现，不参与交互距离判定。 */
  readonly entrance: { readonly x: number; readonly z: number };
  /** 交互距离（米）：人物碰撞盒到建筑碰撞体表面的距离阈值，四边与转角均可交互。 */
  readonly interactionDistance: number;
  readonly interactionId: string;
  /** 商店类建筑对应的稳定 shopId（商品目录与购买上下文校验用）。 */
  readonly shopId?: string;
  readonly color: number;
  readonly model?: string;
  readonly available: boolean;
}

export const CITY = {
  groundSize: 110,
  roadWidth: 12,
  /**
   * 人行道宽度（米）。
   *
   * 只向车行道**两侧**外扩，不沿道路末端延伸：旧实现按 `depth + 4` 同时外扩末端，
   * 会把南北路的人行道压进便利店占地 2 m。
   */
  sidewalkWidth: 3,
  /** 路缘石条宽度（米）：视觉分界，可行走面统一在 y = 0，不产生必须跨越的高差。 */
  curbStripWidth: 0.4,
  /**
   * 铺装面顶标高（米）。三个值都远小于可感知尺度（≤ 16 mm），
   * 人物不做垂直采样，因此不会陷入或悬空；分层只为让相邻铺装不共面。
   */
  surfaceTop: { road: 0.01, paving: 0.012, marking: 0.016 },
  /** 行道树间距（米）：树位由沿街长度推导，不使用固定点表。 */
  treeSpacing: 6,
  spawn: { x: 0, z: 6 },
  buildings: [
    {
      id: 'home',
      name: '晴川公寓',
      kind: 'home',
      subtitle: '住宅 · 休息与住房费用',
      position: { x: -21, z: -19 },
      size: { width: 11, height: 12, depth: 10 },
      entrance: { x: -15.2, z: -19 },
      interactionDistance: 2,
      interactionId: 'home',
      color: 0xb98a72,
      model: 'assets/models/low-detail-building-a.glb',
      available: true,
    },
    {
      id: 'bank',
      name: `${BRANDING.cityStem}银行`,
      kind: 'bank',
      subtitle: '存取款 · 个人贷款',
      position: { x: 21, z: -19 },
      size: { width: 13, height: 8, depth: 10 },
      entrance: { x: 14.2, z: -19 },
      interactionDistance: 2,
      interactionId: 'bank',
      color: 0xd9d2c2,
      model: 'assets/models/building-a.glb',
      available: true,
    },
    {
      id: 'office',
      name: `${BRANDING.cityStem}实业大厦`,
      kind: 'office',
      subtitle: '求职 · 工作',
      position: { x: -21, z: 21 },
      size: { width: 13, height: 16, depth: 11 },
      entrance: { x: -14.2, z: 21 },
      interactionDistance: 2,
      interactionId: 'office',
      color: 0x6f8ea6,
      model: 'assets/models/building-skyscraper-a.glb',
      available: true,
    },
    {
      id: 'securities',
      name: `${BRANDING.cityStem}证券中心`,
      kind: 'securities',
      subtitle: '股票交易 · 多只标的',
      position: { x: 21, z: 21 },
      size: { width: 11, height: 9, depth: 10 },
      entrance: { x: 15.2, z: 21 },
      interactionDistance: 2,
      interactionId: 'securities',
      color: 0x5c7f74,
      model: 'assets/models/building-c.glb',
      available: true,
    },
    {
      id: 'government',
      name: `${BRANDING.cityStem}管理式民主政府`,
      kind: 'government',
      subtitle: '人口 · 政治 · 选举与赞助',
      position: { x: 0, z: -44 },
      size: { width: 20, height: 9, depth: 10 },
      entrance: { x: 0, z: -38.7 },
      interactionDistance: 2,
      interactionId: 'government',
      color: 0xc6c9cc,
      model: 'assets/models/low-detail-building-wide-a.glb',
      available: true,
    },
    {
      id: 'convenience',
      name: CONVENIENCE_STORE_NAME,
      kind: 'shop',
      subtitle: '生活补给 · 便利店岗位',
      position: { x: 0, z: 46 },
      size: { width: 16, height: 6.4, depth: 12 },
      entrance: { x: 0, z: 39.8 },
      interactionDistance: 2.5,
      interactionId: 'shop',
      shopId: CONVENIENCE_SHOP_ID,
      color: 0xd8d2c4,
      available: true,
    },
  ] as readonly BuildingConfig[],
} as const;

export function findBuilding(id: string): BuildingConfig | null {
  return CITY.buildings.find((building) => building.id === id) ?? null;
}

/* ---------------------------------------------------------------- 摄像机 */

export const CAMERA = {
  fov: 52,
  near: 0.1,
  far: 260,
  /** 跟随距离（米）与滚轮可调范围。 */
  distance: { default: 5.4, min: 2.6, max: 9.5 },
  /** 俯仰角（弧度）。正值表示摄像机在目标上方。 */
  pitch: { default: 0.38, min: -0.12, max: 1.16 },
  /** 鼠标灵敏度（弧度/像素）。 */
  sensitivity: 0.0026,
  /** 位置与距离的平滑速率（1/秒），按时间指数插值，与帧率无关。 */
  followLambda: 14,
  distanceLambda: 9,
  /** 滚轮每一格的缩放系数。 */
  zoomStep: 0.88,
  /** 注视点高度（米）。 */
  targetHeight: 1.4,
  /** 摄像机离地最小高度，避免切入地面。 */
  minHeight: 0.5,
  /** 遮挡收缩时与被遮挡面保留的间隙。 */
  collisionPadding: 0.4,
  /**
   * 遮挡后的硬下限：贴墙时允许摄像机拉到很近，但不得为 0。
   * 避障结果优先于正常跟随距离，不能用舒适距离覆盖它。
   */
  hardMinDistance: 0.32,
} as const;

/* ------------------------------------------------------------------ 人物 */

export const PLAYER = {
  /** 行走速度（米/秒），不受经济时间倍率影响。 */
  speed: 5.4,
  /** 疾跑倍率：疾跑速度 = speed × sprintMultiplier = 10.8 米/秒。 */
  sprintMultiplier: 2,
  radius: 0.42,
  /** 转身平滑速率（1/秒）。 */
  turnLambda: 13,
  model: {
    /** Quaternius「Ultimate Animated Characters」的休闲男性角色，CC0，单文件无外部纹理。 */
    url: 'assets/models/character/Casual_Male.glb',
    /** 归一化后的身高（米），脚底贴地。 */
    height: 1.78,
    /** 模型自身朝向与 +Z 的偏差（弧度）。 */
    yawOffset: 0,
    idleClip: 'Idle',
    walkClip: 'Walk',
    runClip: 'Run',
    /** 行走动画的自然参考速度（米/秒），用于按实际速度匹配播放速率。 */
    walkReferenceSpeed: 1.55,
    /** 跑步动画的自然参考速度（米/秒）。 */
    runReferenceSpeed: 3.1,
    /** 待机与行走之间的交叉淡化时长（秒）。 */
    fadeSeconds: 0.24,
    /** 播放速率上下限，避免极端速度导致动作失真。 */
    minTimeScale: 0.65,
    maxTimeScale: 2.0,
  },
} as const;

/* ------------------------------------------------------------------ 环境 */

/**
 * 天气种类 —— 首版只有四种：晴、阴、雨、大雾。
 *
 * 枚举放在 content（与 `BuildingKind` 同处）而不是业务模块里，配置表与读档校验
 * 都以它为准，不出现第二份种类清单。
 */
export type WeatherKind = 'clear' | 'cloudy' | 'rain' | 'fog';

/** 阴影质量档：关闭 / 低 / 中 / 高。全局一份，不提供设置界面。 */
export type ShadowQuality = 'off' | 'low' | 'medium' | 'high';

/**
 * 昼夜颜色关键帧（按 `minuteOfDay` 线性插值）。
 *
 * 关键帧只描述「这段时间看起来是什么颜色、直接光多强」，太阳高度与方向由游戏分钟
 * 单独解算；`at: 0` 与 `at: 1440` 必须给出相同数值以闭合一天的循环。
 */
export interface SkyKeyframe {
  readonly at: number;
  readonly skyTop: number;
  readonly skyHorizon: number;
  readonly skyGround: number;
  readonly sunColor: number;
  readonly sunIntensity: number;
  readonly hemiSky: number;
  readonly hemiGround: number;
  readonly hemiIntensity: number;
  readonly ambientIntensity: number;
  readonly fogColor: number;
  readonly starOpacity: number;
}

/** 单个天气对昼夜基准的修饰量；天气不复制整套光照预设。 */
export interface WeatherProfile {
  /** 0 = 保持昼夜基准色，1 = 完全变成阴天灰调。 */
  readonly greyness: number;
  readonly sunMultiplier: number;
  readonly rainAmount: number;
  readonly hemiMultiplier: number;
  readonly ambientBonus: number;
  readonly starMultiplier: number;
  readonly fogNearScale: number;
  readonly fogFarScale: number;
}

/**
 * 环境系统参数 —— 昼夜曲线、天气调度、阴影预算与雨量上限。
 *
 * **世界坐标方位约定（全项目唯一，新增环境逻辑不得另立一套）**：
 * `+X = 东`、`−X = 西`、`+Z = 南`、`−Z = 北`。
 * 太阳从 +X 升起、正午在 +Z 一侧的高处、从 −X 落下；阴影因此朝 −Z（北）与东西两侧拉长。
 * 基础城区沿用既有坐标（住宅在西北、市政厅在北、便利店在南），不需要改任何布局。
 *
 * 昼夜是**连续插值**而不是开关：太阳高度由游戏分钟解算（日出 06:00 / 日落 18:00，
 * 由余弦曲线对称给出），颜色与强度由 `skyKeyframes` 插值；天气只在昼夜基准上做修饰。
 */
export const ENVIRONMENT = {
  sun: {
    /** 正午太阳高度角（弧度，约 60°）。 */
    maxElevationRad: 1.05,
    /** 太阳低于该高度角时直接光完全消失（弧度），避免地平线以下仍在照射。 */
    horizonFadeRad: 0.16,
    /** 方向光相对焦点的距离（米）。阴影相机只覆盖焦点附近的有界区域。 */
    lightDistance: 90,
  },
  sky: {
    /** 天空穹顶半径（米）：必须小于 `CAMERA.far`，并大于城市可见范围。 */
    radius: 190,
    segmentsX: 32,
    segmentsY: 16,
    /** 太阳光晕贴片的世界尺寸（米）与不透明度上限。 */
    glowSize: 24,
    glowOpacity: 0.5,
    /** 顶点色重算阈值：任一通道变化小于该值时不重传颜色缓冲。 */
    colorEpsilon: 0.004,
  },
  stars: {
    count: 900,
    radius: 172,
    size: 1.7,
    color: 0xe4ecff,
  },
  /**
   * 昼夜关键帧。夜间保留足够的环境光让人物、道路与建筑可辨，
   * 但直接光为 0（不产生月光投影）。
   */
  skyKeyframes: [
    {
      at: 0,
      skyTop: 0x0a1424,
      skyHorizon: 0x18222f,
      skyGround: 0x0c1218,
      sunColor: 0x8fa8cc,
      sunIntensity: 0,
      hemiSky: 0x2b3d57,
      hemiGround: 0x161b20,
      hemiIntensity: 0.34,
      ambientIntensity: 0.17,
      fogColor: 0x141d27,
      starOpacity: 1,
    },
    {
      at: 300,
      skyTop: 0x0a1424,
      skyHorizon: 0x18222f,
      skyGround: 0x0c1218,
      sunColor: 0x8fa8cc,
      sunIntensity: 0,
      hemiSky: 0x2b3d57,
      hemiGround: 0x161b20,
      hemiIntensity: 0.34,
      ambientIntensity: 0.17,
      fogColor: 0x141d27,
      starOpacity: 1,
    },
    {
      at: 378,
      skyTop: 0x2d4463,
      skyHorizon: 0xc98a5c,
      skyGround: 0x2a2724,
      sunColor: 0xffb27a,
      sunIntensity: 0.45,
      hemiSky: 0x54607a,
      hemiGround: 0x2a2a26,
      hemiIntensity: 0.52,
      ambientIntensity: 0.16,
      fogColor: 0x7d6b60,
      starOpacity: 0.35,
    },
    {
      at: 480,
      skyTop: 0x5486bd,
      skyHorizon: 0xd3dde4,
      skyGround: 0x6e7b68,
      sunColor: 0xfff1dc,
      sunIntensity: 1.45,
      hemiSky: 0xbcd4ea,
      hemiGround: 0x6d7560,
      hemiIntensity: 1,
      ambientIntensity: 0.16,
      fogColor: 0xa9bccc,
      starOpacity: 0,
    },
    {
      at: 720,
      skyTop: 0x4a86c9,
      skyHorizon: 0xdae4ea,
      skyGround: 0x7b8671,
      sunColor: 0xfff8ec,
      sunIntensity: 1.6,
      hemiSky: 0xc6dcf0,
      hemiGround: 0x74795f,
      hemiIntensity: 1.1,
      ambientIntensity: 0.15,
      fogColor: 0xb6c8d6,
      starOpacity: 0,
    },
    {
      at: 990,
      skyTop: 0x5386bb,
      skyHorizon: 0xd6dcd8,
      skyGround: 0x767f66,
      sunColor: 0xfff2dd,
      sunIntensity: 1.4,
      hemiSky: 0xbed3e6,
      hemiGround: 0x6f7458,
      hemiIntensity: 0.95,
      ambientIntensity: 0.15,
      fogColor: 0xafc0c9,
      starOpacity: 0,
    },
    {
      at: 1095,
      skyTop: 0x36415f,
      skyHorizon: 0xe0894e,
      skyGround: 0x3b3330,
      sunColor: 0xff9a55,
      sunIntensity: 0.55,
      hemiSky: 0x6b5a63,
      hemiGround: 0x33302c,
      hemiIntensity: 0.55,
      ambientIntensity: 0.16,
      fogColor: 0x8b7266,
      starOpacity: 0.3,
    },
    {
      at: 1185,
      skyTop: 0x0a1424,
      skyHorizon: 0x18222f,
      skyGround: 0x0c1218,
      sunColor: 0x8fa8cc,
      sunIntensity: 0,
      hemiSky: 0x2b3d57,
      hemiGround: 0x161b20,
      hemiIntensity: 0.34,
      ambientIntensity: 0.17,
      fogColor: 0x141d27,
      starOpacity: 1,
    },
    {
      at: 1440,
      skyTop: 0x0a1424,
      skyHorizon: 0x18222f,
      skyGround: 0x0c1218,
      sunColor: 0x8fa8cc,
      sunIntensity: 0,
      hemiSky: 0x2b3d57,
      hemiGround: 0x161b20,
      hemiIntensity: 0.34,
      ambientIntensity: 0.17,
      fogColor: 0x141d27,
      starOpacity: 1,
    },
  ] as readonly SkyKeyframe[],
  weather: {
    /**
     * 天气切换的过渡时长（游戏分钟）；过渡期间新旧两种天气按进度插值。
     * 必须明显短于最短的天气持续时长（180 分钟），否则天气几乎到不了完全体。
     */
    transitionMinutes: 90,
    /** 开局与新档使用的天气，也是旧档迁移的默认值。 */
    initial: 'clear' as WeatherKind,
    /** 天气随机游标初值；与行情、人口等经济随机完全隔离。 */
    seed: 20260214,
    /** 每种天气的持续时长范围（游戏分钟，含端点）。 */
    duration: {
      clear: { min: 360, max: 960 },
      cloudy: { min: 240, max: 720 },
      rain: { min: 180, max: 540 },
      fog: { min: 180, max: 480 },
    } as Record<WeatherKind, { readonly min: number; readonly max: number }>,
    /** 转移概率表：每行按权重抽下一种天气，不做「每帧抽签」。 */
    transitions: {
      clear: { clear: 0.45, cloudy: 0.4, rain: 0.11, fog: 0.04 },
      cloudy: { clear: 0.34, cloudy: 0.3, rain: 0.29, fog: 0.07 },
      rain: { clear: 0.24, cloudy: 0.5, rain: 0.22, fog: 0.04 },
      fog: { clear: 0.4, cloudy: 0.44, rain: 0.12, fog: 0.04 },
    } as Record<WeatherKind, Record<WeatherKind, number>>,
    /** 天气修饰量：天空、雾、环境亮度、太阳强度、星空都从这里派生。 */
    profiles: {
      clear: {
        greyness: 0,
        sunMultiplier: 1,
        rainAmount: 0,
        hemiMultiplier: 1,
        ambientBonus: 0,
        starMultiplier: 1,
        fogNearScale: 1,
        fogFarScale: 1,
      },
      cloudy: {
        greyness: 0.55,
        sunMultiplier: 0.42,
        rainAmount: 0,
        hemiMultiplier: 0.88,
        ambientBonus: 0.05,
        starMultiplier: 0.22,
        fogNearScale: 0.82,
        fogFarScale: 0.88,
      },
      rain: {
        greyness: 0.72,
        sunMultiplier: 0.22,
        rainAmount: 1,
        hemiMultiplier: 0.74,
        ambientBonus: 0.03,
        starMultiplier: 0.06,
        fogNearScale: 0.55,
        fogFarScale: 0.52,
      },
      fog: {
        greyness: 0.88,
        sunMultiplier: 0.1,
        rainAmount: 0,
        hemiMultiplier: 0.92,
        ambientBonus: 0.14,
        starMultiplier: 0.03,
        fogNearScale: 0.3,
        fogFarScale: 0.28,
      },
    } as Record<WeatherKind, WeatherProfile>,
    /** 阴雨浓雾时天空与雾压向的冷灰色；按 `greyness` 与昼夜基准色混合。 */
    overcast: {
      skyTop: 0x5c6673,
      skyHorizon: 0x8d969e,
      skyGround: 0x77807c,
      fogColor: 0x9aa3a8,
      sunColor: 0xdbe3e8,
    },
  },
  shadow: {
    /** 默认保守档；低端设备可按下方规则自动降到低档。 */
    quality: 'medium' as ShadowQuality,
    /** 小屏或低核心设备自动降档（只影响阴影与雨量，不改玩法与判定）。 */
    autoDowngrade: { maxWidth: 900, maxHardwareConcurrency: 4, quality: 'low' as ShadowQuality },
    levels: {
      off: { mapSize: 0, extent: 0, bias: -0.0004, normalBias: 0.02 },
      low: { mapSize: 1024, extent: 38, bias: -0.0006, normalBias: 0.035 },
      medium: { mapSize: 2048, extent: 52, bias: -0.0004, normalBias: 0.025 },
      high: { mapSize: 4096, extent: 70, bias: -0.0003, normalBias: 0.02 },
    } as Record<ShadowQuality, { readonly mapSize: number; readonly extent: number; readonly bias: number; readonly normalBias: number }>,
    /** 太阳低于该高度角时关闭投影（弧度）；高于该值 0.03 以上才重新打开，避免频繁开关。 */
    disableElevationRad: 0.06,
    /** 达到该高度角时阴影为全强度，两者之间线性淡出。 */
    fullElevationRad: 0.28,
    near: 1,
    far: 220,
  },
  rain: {
    /** 高质量档的雨滴条数上限（每滴 2 个顶点）。按阴影档位缩放。 */
    maxDrops: 1400,
    qualityScale: { off: 0.35, low: 0.4, medium: 0.7, high: 1 } as Record<ShadowQuality, number>,
    /** 雨体积（米）：跟随相机的水平范围与高度，不是整个世界。 */
    width: 34,
    depth: 34,
    height: 22,
    /** 下落速度（米/表现秒）。 */
    fallSpeed: 26,
    streakLength: 0.55,
    /** 风的水平偏移，决定雨丝的倾斜方向。 */
    windX: 1.8,
    windZ: 0.6,
    color: 0xa8bccc,
    opacity: 0.42,
  },
} as const;

/* ------------------------------------------------------------------ 行情 */

export const MARKET = {
  /** 每经过 24 个游戏分钟更新一次；正常速度下相当于现实每 10 秒。 */
  tickMinutes: 24,
  /** 初始价格（分/股）：100.00 元。 */
  initialPriceCents: 10_000,
  /** 单次最大涨跌幅（百分比小数），零趋势、有界。 */
  maxChangePct: 0.005,
  /** 价格历史保留条数上限。 */
  historyLimit: 120,
  /** K 线周期（游戏分钟）：每 120 分钟一根，正常速度约 5 次行情更新。 */
  candleMinutes: 120,
  /** 已收盘 K 线保留根数上限。 */
  candleLimit: 120,
  /** 伪随机初始种子；同一存档沿同一时间路径推进应得到同一行情。 */
  initialSeed: 20260101,
  symbol: 'YH-01',
  name: `${BRANDING.cityStem}控股`,
} as const;

/* ------------------------------------------------------------------ 贷款 */

export const LOAN = {
  /** 单笔额度上限（分）：10,000 元。 */
  maxPrincipalCents: 1_000_000,
  /** 最小借款额（分）：100 元。 */
  minPrincipalCents: 10_000,
  /** 期限（游戏日）。 */
  termDays: 30,
  /** 每个期限周期（termDays）的利率，按原始本金口径定义、按未偿本金计提。 */
  interestRatePerTerm: 0.01,
} as const;

/* ------------------------------------------------------------------ 存档 */

export const SAVE = {
  /**
   * 快照格式版本。
   * v2：行情、持仓、贷款；v3：人口、企业、科技、人才、AI；
   * v4：企业费用检查点（营销/运营余量）、分类应付；
   * v5：行情新增已收盘与未收盘 K 线；
   * v6：多证券、股权、融资、治理、宣传与真实资金主体账户；
   * v7：无偿配股审计字段（`sponsorGrantShares`）、按报价记账的资金预留、
   *     外部股东提案（origin/deadline/playerVote）、报价股份基数快照、
   *     证券与持仓的终止标记（清算后不再计市值）；
   * v8：报价 id 全局化（申请 + 投资者 + 股数）、失效报价与孤立 `legacy` 预留的规范化、
   *     已保存 v7 里缺失股权簿的旧玩家公司补建（都是持久数据变化，不是纯校验调整）；
   * v9：做市愿售比例（`MarketState.forSaleRatio`）、产品首发股价影响
   *     （`releaseImpactPct`）、产品日销量窗口（`dailySales` / `daySnapshotUnits`）。
   * v10：产品日销量观察起点（`dailyObservationStartMinute`）——只有覆盖完整游戏日的
   *     区间才允许写入日销量样本；迁移时只重建这段派生窗口。
   * v11：动态人口（经济阶层人数、增长锚点、月度记录与观察样本）、
   *     政治群体与满意度、竞选状态机与选举结果、政府机构与任职记录；
   *     另含研发政策快照（`researchGrowthMultiplier`）与销售成本余量
   *     （`salesCostRemainder`）两个真实持久字段。
   * v12：证券观察窗口的机械调整由绝对价差 `mechanicalOffset` 改为乘法参考因子
   *     `referenceFactor`（旧档无法无损换算时把剩余不完整观察月降级为中性）；
   *     修正 v11 首届竞选的基础资源与首次投票日程（只改尚未投票的首届）。
   * v13：累计分红现金随机械价差换算到当前价格尺度（修复「分红 + 增发」的虚假收益）。
   *     旧档无法判断分红与机械事件的先后顺序时，将该不完整观察月降级为中性，
   *     下个完整月恢复；历史已结算摘要不重算。
   * v14：人物生存（饱食度/水分内部单位）、背包物品数量与购买/使用去重记录；
   *     工资余数分母由 60 改为 6000（加入 0～100 的工作效率百分比），旧余数精确 ×100。
   * v15：补给请求去重协议（持久化 operationEpoch + 单调 nextOperationSeq + 最多 64 条收据）；
   *     旧随机 UUID 请求保留为 legacy 收据但不授权重放。
   * v16：城市统计与城区扩张——基础 GDP 快照、累计经营产出与游标、连续全市场指数与观察窗口、
   *     月份统计快照、12 个交叉政治群体的满意度与提前选举监测、任期方向与政策效果快照
   *     （政府职位数据表达）、逻辑地图（边界/道路/地块/建筑）、建设阶段预留与永久建设历史、
   *     科技新区招商槽位。旧档在迁移时建立以上切片并接入前任期（不补做建设判断）。
   * v17：房地产与宏观住房——产权/入住/挂牌/土地报价/成交记录（`realEstate`）、
   *     收入群组家庭数/居住分配/购房意愿/月度住房指标（`housing`）、
   *     `finance` 新增 `household` 主体账户与 6 个新流水类别。
   *     旧档在迁移时按迁移时刻的人口建立群组、一次性注入卖方与 AI 资金、
   *     建立晴川公寓 100 套与 4 块储备土地，并为已完成住房新区补齐住宅单元（幂等）。
   * v18：为每处房产增加持久挂牌版本高水位，旧档继承当前挂牌版本。
   * v19：环境系统——天气种类、当前天气的起点与下次调度时刻、天气独立随机游标
   *     （`environment` 切片）。太阳方向、天空颜色、雾与环境光都由游戏时间与天气推导，
   *     不重复保存。
   *     纯校验调整（例如宣传强度按小数校验、行情调度校验）不占版本号。
   */
  formatVersion: 19,
  formatTag: 'city-wealth-sim',
  dbName: 'city-wealth-sim',
  dbVersion: 1,
  objectStore: 'snapshots',
} as const;
