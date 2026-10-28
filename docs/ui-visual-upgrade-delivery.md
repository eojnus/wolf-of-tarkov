# HUD / TAB / ESC 石墨视觉升级与暂停修复 · 交付说明

本文件是 `feature/ui-visual-upgrade` 的交付记录，供 GPT Work 验收。范围严格限定在
`docs/ui-visual-upgrade-review.md` 与本轮任务书内：HUD 重组、TAB 标题栏时间工具区、
ESC 暂停专用表现、移动端菜单可达性，以及菜单暂停与手动暂停分离。未合并主分支、未推送远程。

## 1. 基线与环境

| 项目 | 值 |
| --- | --- |
| 仓库 | `C:\Coding\wolf-ui-visual-upgrade` |
| 分支 | `feature/ui-visual-upgrade` |
| 基线提交 | `dea681b74d8fed03551b8f731fb4827354f354c6` |
| 交接文档提交 | `37679d0`（本分支既有文档提交，未被 reset，保留原样） |
| 代码提交 | `c4fd9e1` `feat(ui): graphite HUD with TAB time tools and pause-mode menu` |
| 返修代码提交 | `324b9d3` `fix(ui): enlarge ESC actions and keep touch windows inside the viewport` |
| 文档与截图提交 | `a55cda3`（初版交付说明）与本文件所在的返修 docs 提交（见 `git log --oneline -4`） |
| 构建工具 | Node 24.20.0 / npm 11.19.0 / vite 8.3.5 / TypeScript 5.9.3 |

## 2. 实际改动文件

代码（`c4fd9e1`）：

| 文件 | 改动性质 |
| --- | --- |
| `src/ui/styles.css` | 石墨令牌、按钮尺寸与焦点环、统计卡降装饰、HUD 触屏入口、ESC 全屏表现、图层顺序、深色滚动条与浅色残留修正、启动页可读性覆盖、触屏/矮视口媒体查询；返修（`324b9d3`）再加 ESC 大按钮网格、粗指针 44px 热区、窄屏/矮视口窗口高度与安全区约束、ESC `max-height: none` |
| `src/ui/hud.ts` | 删除速度/暂停/休息/睡觉与右下角「个人」「菜单」；新增顶部触屏「界面」入口；`setMenuMode`；`setPanelOpen` 收起触屏菜单 |
| `src/ui/game-window.ts` | 新增 `[data-gw-tools]` 标题栏插槽与 `setTools()`；`setPresentation('window' \| 'pause')`，暂停模式禁用拖动/双击放大并隐藏放大按钮 |
| `src/ui/panels.ts` | `onTogglePause` / `onSetSpeed` 回调；`ensureTimeTools` 时间工具组；`syncTimeTools`（public）；`data-time-action` 事件委托；ESC 走暂停表现；`renderAbout` 文案同步 |
| `src/app/game.ts` | 四处 `setPaused` 写操作移除；`resetFrameBaseline()`；面板打开时 Space 直接返回；`coarsePointer`；`syncClockUi` 改调 `panels.syncTimeTools`；HUD 回调精简；`setMenuMode` 接入 |
| `src/ui/life-panels.ts` | ESC「保存与菜单」里的「重新开始」改用新增 `.btn-danger`，动作与确认流程不变 |

文档与证据：

- `docs/ui-visual-upgrade-delivery.md`（本文件）
- `docs/visuals/hud-desktop.png`、`tab-desktop.png`、`tab-paused.png`、`esc-desktop.png`
- `docs/visuals/hud-touch-landscape.png`、`esc-touch-landscape.png`
- `docs/visuals/verification-log.json`（验证脚本输出的原始记录）
- 返修补测：`esc-desktop-rework.png`、`tab-desktop-rework.png`、
  `tab-touch-844x390.png` / `-bottom.png`、`esc-touch-844x390.png`、
  `tab-touch-740x360.png` / `-bottom.png`、`esc-touch-740x360.png`、
  `rework-geometry.json`（真实 `getBoundingClientRect` 读数）
- `docs/architecture.md` 15.1、`docs/contracts.md` 暂停与界面契约、`docs/decisions.md` D9

**未改动**：时钟核心（`core/clock`、`app/timeAdvance`）、经济结算、月结、存档格式与版本号、
`ENTRY_SECTIONS` / `SECTIONS` / `GROUPS` 的栏目集合与现场权限、任何业务视图字段。

## 3. 菜单与字段保留检查

| 检查项 | 结果 |
| --- | --- |
| ESC 路由 | 仍为 `pause` 入口，`ENTRY_SECTIONS.pause = ['sys.menu', 'sys.about']`，两栏目：保存与菜单 / 游戏信息 |
| ESC 动作 | 继续、保存、读取、导出、导入、重新开始、当前进度、游戏信息与说明全部保留；未新增设置、退出游戏等不存在的功能 |
| 层级 | 两栏目、各分组、动作顺序未拍平、未重排；仅「重新开始」由幽灵按钮改为危险色语义（`.btn-danger`） |
| TAB 栏目 | 个人 5 + 我的公司 7 = 12 栏，与改动前一致（验证记录 `tabSections: 12`） |
| 现场权限 | `ENTRY_SECTIONS`、`SECTIONS`、`requires` / `onsite` 未改动；银行、证券、市政厅、便利店、办公楼、晴川公寓仍只显示各自现场栏目 |
| 业务视图 | 未改任何视图字段、金额精度、排序、分页、筛选、预览确认、表单草稿、结构指纹与原地更新路径 |
| 输入保护 | `PanelManager.refresh` 的两条延迟规则（输入框聚焦、鼠标按住）保持；时间工具区只做文本/类名同步，不重建 DOM |
| 调试接口 | 未加入任何永久调试接口、全局变量或测试专用门控绕过 |

## 4. Skill 实际加载来源

按要求先实际读取 MengTo 的 `design-first-ui-prompting`：

- 尝试路径：Skill 选择器未提供该技能；GitHub 直连 `raw.githubusercontent.com` 失败（DNS / 连接重置）。
- 实际来源：`https://cdn.jsdelivr.net/gh/MengTo/Skills@main/agent-skills/ui/design-first-ui-prompting/SKILL.md`
- 读取结果：完整 3090 字节 / 3055 字符 / 109 行，内容为「先定约束再写界面」的提示词流程
  （Constraints → Structure → Visual → Interaction → Deliverable）。
- 未调用其他设计技能；本轮只把该流程用于确定下方设计规格，未引入其示例组件或外部资源。

## 5. 设计规格

```
FONT     Segoe UI / PingFang SC（仅系统字体）
STYLE    GRAPHITE MINIMAL
MODE     DARK
ACCENT   #4FB3C4（唯一强调色）
RADIUS   14 / 10 / 8 / 999
SPACING  4pt 栅格，8pt 节奏
MOTION   120ms hover，180ms 面板
BLUR     HUD 10px，菜单 0，窗口 0
```

- **五级石墨**：`--paper #151b21`、`--paper-2 #10151a`、`--card #1b222a`、
  `--line #252e38`、`--line-2 #33404c`；文字 `#e8eef3 / #b3c0cb / #8b99a6 / #64717d`。
- **唯一强调色**只用于选中、焦点环与主操作；涨跌与危险语义色保留（涨 `#e07363`、跌/正 `#4fb08a`、
  警告 `#c9a04a`、危险 `#e08078`），并且始终与数字或文字同时出现，不单靠颜色表意。
- **可执行控件**：`.btn` 最小高度 34px、`.btn-sm` 28px、触屏入口 44px；统一 `:focus-visible` 焦点环；
  禁用态透明度 0.4。返修后 ESC 的 `.gw.is-pause .btn` 为 48px、主按钮 52px，粗指针下必要控件
  实际热区 44px —— 普通信息页仍沿用上面的紧凑尺寸。
- **降装饰**：统计卡去阴影、`gap` 10→8、数值 18→16；HUD 卡片改为 90% 石墨 + 10px 模糊；
  仅菜单遮罩与 HUD 使用透明/模糊，管理窗口本身保持不透明。
- **ESC 全屏表现**：`.gw.is-pause` 占满视口，左侧不透明、右侧渐变到透明把城市留给背景；
  HUD 整体淡出（`#hud-layer.is-menu`）；导航 208px，正文最大 640px；禁用拖动与双击放大。
- **图层顺序**：`#hud-layer` 1 / `#panel-layer` 2 / `#toast-layer` 3，修复 HUD 局部 `z-index`
  压过模态窗口的问题。
- **触屏入口**：`@media (pointer: coarse)` 才显示顶部 44px「界面」按钮，展开后两个入口
  「个人界面」「暂停菜单」；同时隐藏对触屏无意义的鼠标锁定遮罩与键鼠提示。
- **启动页**：`#boot-screen` 保持原浅色外观，只补显式深色文字/浅色按钮覆盖，
  避免令牌整体反转后出现浅底浅字。

## 6. 暂停语义（本轮核心）

- 有效暂停 = **手动暂停** ∨ **暂停菜单打开** ∨ **页面隐藏**。
  `clock.paused` 只表示运行中的手动暂停；保存仍走既有 `buildCurrentSnapshot`，
  它克隆状态时把 `clock.paused` 清零，所以写进存档的是「未暂停」，读档从运行态开始。
  本轮未修改该保存策略，此前的交付说明把这句写错了，已在本节更正。
- 菜单暂停只由 `activePanel === 'pause'` 表达。`openPanel` / `closePanel` / `resumeFromPause`
  不再写 `clock.paused`，因此关掉 ESC 不会顺手解除玩家的手动暂停。
- `openPanel` 改为**先挂面板再 `exitPointerLock`**，解锁回调看到面板已打开，不会二次打开菜单；
  重复打开与解锁回调都不会导致多次恢复或重开菜单。
- 进出菜单与关闭任何面板都调用 `resetFrameBaseline()`（仅 `lastFrameMs = 0`），
  暂停期间不积累模拟 dt，恢复后不补算停留时间；未改动 `advanceGameTime`、时钟核心与经济结算。
- 面板打开时 Space 先 `preventDefault` 再直接返回，ESC 内的空格与时间动作都不会改变底层手动暂停状态。
- 速度档位沿用 `TIME.speedOptions` 与既有 `setSpeed` 语义（选择速度会解除手动暂停），
  休息/睡觉仍复用 `TIME.restPresets` 与既有命令。

## 7. 构建结果

```
npm run build   (tsc --noEmit && vite build)   [返修后，324b9d3]
exit 0
dist/index.html                    1.12 kB │ gzip:   0.56 kB
dist/bundle/index-CD0G8hQ1.css    39.83 kB │ gzip:   8.21 kB
dist/bundle/index-D-y5yJV6.js  1,324.05 kB │ gzip: 372.88 kB
```

初版构建（`c4fd9e1`）为 CSS 37.95 kB / JS 1,324.05 kB；返修只增加样式，JS 未变。
`tsc --noEmit` 通过。唯一告警是 vite 的「chunk 大于 500 kB」提示，属既有体积，不是本轮引入，
未做代码分割等无关优化。

## 8. 真实暂停证据

用无头 Edge（CDP）驱动真实页面，从启动页点「开始新游戏」，全程用真实键盘/鼠标事件与
DOM 点击操作；未替换定时器、未注入假时钟、未强制隐藏锁定遮罩
（`lockOverlayForcedHiddenForScreenshot: false`）。无头环境下需要 `Page.bringToFront` +
`Emulation.setFocusEmulationEnabled` 才能让 `document.hidden = false`，否则时钟不动会得到假冻结结论；
脚本已显式处理并记录了 `page.hidden: {"hidden":false,"vis":"visible"}`。

`docs/visuals/verification-log.json` 关键行：

| 断言 | 读数 | 结论 |
| --- | --- | --- |
| `baseline.clockRuns` | 08:11 → 08:15 | 未暂停时时钟正常走动 |
| `manualPause.frozen` | 08:30 / 08:30 | TAB 内手动暂停生效 |
| `manualPause.toolLabel` | `继续` | 工具区按钮文本随状态切换 |
| `manualPauseSurvivesTabClose` | 08:30 / 08:30 | **关闭 TAB 后手动暂停仍在**（旧缺陷已修） |
| `escPausedClock` | 08:30 / 08:30 | ESC 菜单打开时冻结 |
| `manualPauseSurvivesEscClose` | 08:30 / 08:30 | **关闭 ESC 后手动暂停仍在** |
| `resume.clockRuns` | 08:31 → 08:35 | 手动继续后时钟恢复走动 |
| `esc.spaceDidNotChangeManualState` | 08:35 → 08:40 | ESC 内按 Space 未改变底层手动状态，退出后照常走动 |

其他矩阵结果：`tabToolsPresent: true`；`tabToolLabels: ["暂停","1×","2×","4×","休息 1 小时","睡到早上"]`；
`tabSections: 12`；`escSections: ["保存与菜单","游戏信息"]`；
`escPausePresentation: {w:1440,h:900,radius:"0px"}`（确实全屏）；
`touch.pointerCoarse: true`、`touch.entryVisible: true`、`touch.lockOverlayHidden: true`、
`touch.escOpen: true`（844×390 触屏下顶部入口可打开暂停菜单）。

## 9. 截图

桌面 1440×900：

- `docs/visuals/hud-desktop.png` — HUD：时间、生存状态、情境提示、保存；右下角已无「个人」「菜单」。
- `docs/visuals/tab-desktop.png` — TAB 12 栏 + 标题栏时间工具区。
- `docs/visuals/tab-paused.png` — 工具区显示「继续」的暂停态。
- `docs/visuals/esc-desktop.png` — ESC 全屏暂停表现，左栏菜单、右侧城市。

手机横屏 844×390（DPR 2，触屏模拟）：

- `docs/visuals/hud-touch-landscape.png` — 顶部「界面」入口展开两个菜单项。
- `docs/visuals/esc-touch-landscape.png` — 触屏打开的暂停菜单在矮视口下的排布。

返修补测（`324b9d3`，几何读数见 `docs/visuals/rework-geometry.json`）：

- `docs/visuals/esc-desktop-rework.png` — 桌面 ESC 大按钮：继续 52px，存档四项 2×2 各 48px，导航 48px。
- `docs/visuals/tab-desktop-rework.png` — 桌面 TAB 对照（普通信息页保持紧凑，工具 28px）。
- `docs/visuals/tab-touch-844x390.png` / `tab-touch-844x390-bottom.png` — 844×390 TAB 的顶部与滚到底部。
- `docs/visuals/esc-touch-844x390.png` — 844×390 ESC 全屏（`height:390`，非 374）。
- `docs/visuals/tab-touch-740x360.png` / `tab-touch-740x360-bottom.png` — 740×360 TAB，工具栏换行后仍可操作。
- `docs/visuals/esc-touch-740x360.png` — 740×360 ESC 全屏，按钮 48/52，内容在窗口内滚动。

## 10. 未验证项（需真实用户体验）

以下项目**没有**在本轮运行验证，不以构建或截图替代：

1. 真实手机/平板上的触屏手感、点击热区与横屏滚动（仅在无头浏览器里模拟了 `pointer: coarse` 与
   844×390 / 740×360 两个横屏尺寸）。
2. Firefox 与 Safari（含 iOS Safari）的实际渲染与安全区取值（本轮只在 Edge/Chromium 上验证；
   `index.html` 未设 `viewport-fit=cover`，故当前 `env(safe-area-inset-*)` 实际取值为 0）。
3. 启动页浅色卡片与深色主题整体过渡的观感（只做了可读性覆盖，未做视觉评审）。
4. 深色背景下股票 K 线与人口环形图的最终观感（绘图区配色沿用既有值，只改了外框）。
5. 长会话下工具区频繁同步的性能体感（逻辑上只改文本与类名，未做性能测量）。
6. 所有业务页在深色下的逐页视觉巡检（本轮只修了已知硬编码浅色点，未逐页截图）。
7. 软键盘弹出时横屏窗口高度的变化（未在真机触发输入法）。
8. 滚动惯性、下拉回弹与 `overscroll-behavior: contain` 在真机上的实际手感。

## 11. 已知限制

- `.hud-time` 在普通 TAB / 现场窗口打开时仍从窗口左侧露出（窗口仍在其上层）；
  ESC 菜单已通过 `#hud-layer.is-menu` 整体隐去，普通窗口保持 HUD 可见是刻意选择。
- 窄屏下标题栏会换行：粗指针且宽度 ≤780px 时时间工具整行落到标题下方，
  740×360 下标题栏约 152px、内容区约 190px，仍可窗口内滚动。这是为保住触控热区与关闭入口可达的取舍。
- 极窄（< 约 420px）或极矮（< 约 320px）视口未验证，可能出现工具栏两行以上、内容区过短。
- `#boot-screen` 仍是浅色；本轮只保证文字与按钮可读，未做深色重设计。
- 触屏入口只解决「菜单可达性」，不提供移动、转视角或交互的触控支持。
- 时间工具区只在 TAB（`entry === 'personal'`）出现；ESC 与现场窗口没有第二套时间控制。

## 12. 与公寓分支的重叠点

对比 `feature/qingchuan-apartment-interior`（`c3d3561`）：

| 文件 | 重叠情况 | 合并建议 |
| --- | --- | --- |
| `src/app/game.ts` | 对方改 `setHint` 相关与公寓入口；本轮改 `openPanel` / `closePanel` / `resumeFromPause` / `syncClockUi` / `syncPanelPresentation` / 键盘处理 | 不同函数，可逐块合并；注意双方的 `setHint` 调用参数 |
| `src/ui/hud.ts` | 对方可能扩展提示/状态；本轮删除了 `.hud-controls` 相关字段与回调 | 以本轮结构为准，把对方的提示字段并入现有模板 |
| `src/ui/panels.ts` | 对方新增公寓栏目；本轮改时间工具区与 `renderAbout` | `SECTIONS` / `ENTRY_SECTIONS` 由对方追加，本轮未动这两个表，冲突面小 |
| `src/ui/estate-panel.ts` | 对方主改；本轮未触碰 | 无冲突 |
| `src/ui/styles.css` | 双方都会改样式 | 以石墨令牌为基线，把对方新增选择器改为引用令牌，不要回退成浅色硬编码 |

## 13. 复现验证

```powershell
cd C:\Coding\wolf-ui-visual-upgrade
npm ci
npm run build
npm run dev -- --port 5199 --strictPort
# 另开终端，用无头 Edge 打开 CDP 9333 后运行仓库外的截图/暂停矩阵脚本
```

验证脚本与截图只作为证据；仓库内没有留下任何调试接口或测试门控。

## 14. 返修记录（验收 R1 / R2 / 文档纠正）

验收结论：暂停核心矩阵、类型检查与生产构建通过；R1（ESC 与触屏按钮尺寸）、R2（手机横屏
TAB 最小窗高）与文档中「`clock.paused` 进存档」的表述未通过。返修只改 `src/ui/styles.css`
与四份文档（`contracts` / `architecture` / `decisions` / 本报告），
未触碰 `core/`、`app/timeAdvance`、`app/features`、存档格式、业务视图与解锁/暂停逻辑。

### R1 · ESC 大按钮与触屏热区

- ESC 保持原两栏目（保存与菜单 / 游戏信息）与原内部分组（存档 / 当前进度），只改动作呈现：
  `.gw.is-pause .actions` 改为两列网格，单个动作占满整行；`.gw.is-pause .btn` 48px、
  `.gw.is-pause .btn-primary` 52px；导航 `.gw-nav-item` 48px；关闭 `.gw-btn` 44px。
- 粗指针（`@media (pointer: coarse)`）下把 `.btn` / `.btn-sm` / `.field` / `.gw-nav-item` /
  `.gw-tool` / `.gw-btn` / `.hud-actions .btn` / `.sec-switch-item` / `.pp-subnav-item` 的实际
  点击高度抬到 44px；只改热区与间距，没有缩小字号或隐藏数据。
- 桌面普通信息页仍保持紧凑：TAB 时间工具 28px、导航 27px、关闭 28px，与验收建议一致。

实测（`rework-geometry.json`）：

| 位置 | 控件 | 返修前 | 返修后 |
| --- | --- | --- | --- |
| 桌面 ESC | 继续游戏 | 35.55px | **52px** |
| 桌面 ESC | 保存 / 读取 / 导出 / 导入 / 重新开始 | 35.55px | **48px** |
| 桌面 ESC | 保存与菜单 / 游戏信息 | 27px | **48px** |
| 桌面 ESC | 关闭 | 28px | **44px** |
| 844×390 TAB | 暂停与速度工具 | 28px | **44px** |
| 844×390 TAB | 栏目导航 | 27px | **44px** |
| 844×390 TAB | 关闭 / 放大 | 28px | **44px** |
| 844×390 TAB | 个人财务按钮 / 选择框 | — | **44px / 44px** |

### R2 · 手机横屏普通窗口高度

- `@media (max-width: 900px)` 解除 `min-height: 420px`，高度改由
  `100dvh - 20px - env(safe-area-inset-top/bottom)` 约束，并加 `max-height`。
- `@media (max-height: 560px)` 同样解除最小高度（16px 余量），桌面矮视口也不会再溢出。
- `.gw.is-pause` 显式 `max-height: none`，ESC 仍是 `100dvh` 全屏；此条正是返修中发现并修正的
  回归（初版补丁曾把 ESC 夹到 374/344px）。
- 粗指针下标题栏允许换行；≤780px 时工具整行落到标题下方，关闭按钮不被挤出。
- 740×360 下 ESC 左栏由 136px 调到 148px，保证「保存与菜单」不被省略号截断
  （`navLabelOverflow: [false,false]`）。

实测（`rework-geometry.json`）：

| 视口 | 窗口 | 底边 | 滚动区 | 内容 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 1440×900 TAB | 1240×812 | 848 | 716 | 716 | 无溢出 |
| 1440×900 ESC | 1440×900 | 900 | 736 | 736 | 全屏，动作全部可见 |
| 844×390 TAB | 824×374 | 374 | 278 | 592（人物总览）/ 1414（个人财务） | 窗口内滚动，滚到底最后内容 bottom=345 |
| 844×390 ESC | 844×390 | 390 | 296 | 628 | 全屏，按钮 48/52 |
| 740×360 TAB | 720×344 | 344 | 190 | 714 | 窗口内滚动，滚到底最后内容 bottom=315 |
| 740×360 ESC | 740×360 | 360 | 214 | 628 | 全屏，内容窗口内滚动 |

`overflowX/overflowY` 全为 0；两种横屏的关闭按钮均在窗口内（844：773–817；
740：669–713）。

### 文档纠正

`src/app/game.ts` 的 `buildCurrentSnapshot` 在克隆状态时执行 `state.clock.paused = false`，
这是既有保存策略，本轮未改。此前 `docs/contracts.md`、`docs/architecture.md`、
`docs/decisions.md` D9 与本报告第 6 节把它写成「进存档」，现已统一改为：
运行中的 `clock.paused` 表示手动暂停，菜单暂停不写它，存档时按既有策略清零，读档从运行态开始。

### 验证层级（避免把夹具当成真机）

| 层级 | 本轮做了什么 | 能证明什么 |
| --- | --- | --- |
| 静态差异 | `git diff` 限定在 `src/ui/styles.css` 与文档 | 未改暂停逻辑、业务字段、入口表、存档版本 |
| 完整页面（无头 Edge + CDP） | 启动页开始新游戏，真实键盘/鼠标事件打开 TAB/ESC，量 `getBoundingClientRect` 并截图 | 真实 DOM/样式下的窗口几何、按钮高度、滚动行为 |
| 布局夹具 | 未另建独立夹具；几何读数直接来自完整页面 | 无夹具与生产样式漂移问题 |
| 真实设备 | **未运行** | 触屏手感、滚动惯性、软键盘与安全区需真机确认 |
| 其他浏览器 | **未运行** | 只有 Edge 156（Chromium）结果 |
