/**
 * 玩家入口能力表 —— 只回答一件事：**当前打开的现场能不能提交这类玩家操作**。
 *
 * 纯数据 + 纯函数：不读 `GameState`、不写状态、不依赖 `ui` 或 `features`，
 * 只被 `app/game.ts` 在玩家操作回调（以及确认框提交前）使用，
 * 拦住「残留按钮 / 旧事件 / 切换窗口后继续办理」这类从错误入口发起的调用。
 *
 * 边界：
 *  - 这里只做**入口**判定，不替代任何业务校验：金额、股数、价格、权限仍在原命令里执行；
 *  - 页面级可见性由 `ui/panels` 的入口栏目表负责，两者都基于同一份现场概念，但不共享代码；
 *  - 权限只存在内存，不写存档、不进 `GameState`。
 */

export type PlayerEntry =
  | 'personal'
  | 'bank'
  | 'office'
  | 'home'
  | 'securities'
  | 'government'
  | 'shop'
  | 'pause';

export type EntryCapability =
  /** 存取款、个人贷款与还款（银行现场）。 */
  | 'banking'
  /** 入职、上班（实业大厦或便利店现场）。 */
  | 'employment'
  /** 证券买卖（证券中心现场）。 */
  | 'trading'
  /** 上市、外部融资、接受/拒绝报价、回购、资本宣传（证券中心）。 */
  | 'capital'
  /** 董事会提案表决、CEO 任免（自有公司在人物界面，其它持股公司在证券中心）。 */
  | 'governance'
  /** 住宅与土地的买入、挂牌、改价、撤销、报价处理（晴川公寓现场）。 */
  | 'estate'
  /** 竞选赞助（市政厅现场）。 */
  | 'sponsorship'
  /** 便利店购买（便利店现场，另有 activeShopId 第二道校验）。 */
  | 'shop';

const ALLOWED: Record<PlayerEntry, readonly EntryCapability[]> = {
  // 人物界面（Tab）：自有公司的内部治理与任免仍可办理，资本业务已移交证券中心
  personal: ['governance'],
  bank: ['banking'],
  office: ['employment'],
  home: ['estate'],
  securities: ['trading', 'capital', 'governance'],
  government: ['sponsorship'],
  shop: ['shop', 'employment'],
  pause: [],
};

const DENIED: Record<EntryCapability, string> = {
  banking: '存取款与个人贷款只能在银行现场办理',
  employment: '入职与上班只能在实业大厦或便利店现场办理',
  trading: '证券买卖只能在证券中心现场办理',
  capital: '上市、融资、回购与资本宣传只能在证券中心办理',
  governance: '股东表决与 CEO 任免只能在公司治理页或证券中心办理',
  estate: '住宅与土地的买卖、挂牌与报价处理只能在晴川公寓现场办理',
  sponsorship: '竞选赞助只能在市政厅现场办理',
  shop: '购买商品只能在便利店现场办理',
};

/** 当前入口是否具备某项玩家操作能力；`null`（没有打开任何窗口）一律不允许。 */
export function entryAllows(entry: string | null, capability: EntryCapability): boolean {
  if (!entry) return false;
  const list = ALLOWED[entry as PlayerEntry];
  return list ? list.includes(capability) : false;
}

/** 被拒绝时的提示文案：说明该去哪里办理，而不是静默失败。 */
export function entryDeniedMessage(capability: EntryCapability): string {
  return `${DENIED[capability]}：请关闭当前窗口后到对应设施重新打开。`;
}
