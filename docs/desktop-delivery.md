# 桌面化交付报告（2026-10-31）

## 1. 工作树与基线

| 项 | 值 |
| --- | --- |
| 工作树 | `C:\Users\Administrator\Documents\ChatGPT\game2\wolf-desktop` |
| 分支 | `desktop/electron` |
| 基线提交 | `511e55a66d3fc20f69b67c5a93b0843a6f6f4d76`（`feat: integrate Rapier character physics and smooth movement`） |
| 主仓库 | `C:\CODING\wolf-of-tarkov`，未修改、未合并、未推送 |
| 最终状态 | 工作树有未提交改动；没有创建提交，没有推送远程 |

开始前工作树干净，没有需要保护的用户未提交改动。

## 2. 修改文件

新增：

- `desktop/main.cjs`：主进程（窗口、单实例、`app://game/` 协议、CSP、权限白名单、菜单/全屏、About、关闭协调、日志）。
- `desktop/preload.cjs`：沙箱 preload，只暴露 `window.wolfDesktop.onBeforeClose`。
- `src/platform/desktop.ts`：渲染进程平台适配层与浏览器降级。
- `scripts/electron-dev.mjs`：固定端口启动 Vite、校验来源、启动 Electron、退出时清理进程树。
- `electron-builder.yml`：Windows NSIS 配置。
- `build/icon.png`：应用/安装包图标。
- `docs/desktop.md`：桌面架构、安全、数据、构建与迁移说明。
- `docs/desktop-delivery.md`：本报告。

修改：

- `package.json` / `package-lock.json`：版本 `0.3.3`、`productName`、`main`、桌面脚本、Electron 依赖。
- `.gitignore`：忽略 `release/`。
- `src/app/game.ts`：注册“关闭前等待自动保存链”回调（4 行）。
- `README.md`：桌面版命令、数据位置与限制。
- `docs/architecture.md`：新增第 20 节桌面壳与依赖方向。
- `docs/decisions.md`：新增 D98 桌面化决策、安全边界与代价。

没有修改 `src/core`、`src/features`、`src/world`、经济规则、存档格式或迁移链。

## 3. 新增依赖

| 依赖 | 版本 | 用途 |
| --- | --- | --- |
| `electron` | 45.2.1（devDependency） | 桌面运行时与内置 Chromium |
| `electron-builder` | 26.18.0（devDependency） | Windows NSIS 安装包 |

应用标识与产物：

- appId：`com.wolfoftarkov.desktop`
- 产品名：`塔科夫之狼`
- 可执行文件：`WolfOfTarkov.exe`
- 页面来源：`app://game`
- 用户数据：`%APPDATA%\WolfOfTarkov`；开发版 `%APPDATA%\WolfOfTarkov-dev`

## 4. 安装包

```
C:\Users\Administrator\Documents\ChatGPT\game2\wolf-desktop\release\WolfOfTarkov-Setup-0.3.3.exe
```

- 大小：139,770,379 bytes（约 133.3 MiB）
- SHA256：`B6826BFB9AC85826B21405F093681FB95EA0173EC9CF4D192CE534570263B4EC`
- 未配置代码签名证书，安装包未签名；Windows SmartScreen 可能提示。
- x64、NSIS、非 one-click、可选安装目录、创建桌面与开始菜单快捷方式。
- `release/` 已加入 `.gitignore`，构建产物未提交。

## 5. 实际执行的命令与结果

| 命令 / 操作 | 结果 |
| --- | --- |
| `npm ci --no-audit --no-fund` | 通过，基线 25 个包 |
| `npm install --no-audit --no-fund`（加入 Electron 后） | 通过，279 个包；本机从 GitHub 下载 Electron 失败，使用 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 完成，未写入仓库配置 |
| `npm run typecheck` | 通过（tsc 无错误） |
| `npm run build` | 通过（Vite 8.3.5，158 模块，主 chunk 5.8MB，原有大小警告） |
| `node --check desktop/main.cjs` / `preload.cjs` / `scripts/electron-dev.mjs` | 通过 |
| `npm run desktop:dev` | 通过：Vite 5173 + Electron 窗口；游戏启动；结束 Electron 后 5173 端口释放，无残留进程 |
| 端口占用时 `desktop:dev` | 通过：5173 被非本项目服务占用时脚本退出码 1，Vite 报端口占用，未启动 Electron、未连接该服务 |
| `electron .`（等价 `npm run desktop:start`） | 通过：`app://game/index.html`，IndexedDB 可用，存档加载，Canvas 1440×900 |
| `release/win-unpacked/WolfOfTarkov.exe` | 通过：packaged=true，`app://game`，读取既有 v20 存档，无 CSP/资源错误 |
| `npm run desktop:build` | 早期构建通过；最终 F11 版本因本机 `release/` 残留锁定，改用 `electron-builder --win nsis --config.directories.output=release-final` 在新输出目录完成，再移回 `release/` |
| 安装包 `/S /D=...WolfInstall` | 退出码 0；桌面快捷方式存在；安装目录含 `WolfOfTarkov.exe` |
| 安装版启动 | 通过：读取 `%APPDATA%\WolfOfTarkov` 中的存档，Canvas 1440×900，无资源错误 |
| 卸载 `Uninstall WolfOfTarkov.exe /S` | 退出码 0；程序目录与快捷方式移除；`%APPDATA%\WolfOfTarkov\IndexedDB` 保留 |
| `npm run dev`（浏览器，Edge headless） | 通过：`window.wolfDesktop` 为 undefined，WebGL Canvas 正常，游戏启动 |
| 手动保存 → 退出 → 重启 → 读取 | 通过：快照 `format=city-wealth-sim`、`version=20`、`reason=manual`；重启后检测到存档并读取 |
| 窗口 X 关闭（WM_CLOSE） | 通过：打包版从发送关闭消息到进程退出约 260ms；无“关闭超时”日志 |
| JSON 导出 | 通过：134,340 bytes，format/version 正确，`reason=manual` |
| JSON 导入 | 通过：导入后提示“存档导入成功”；把速度改为 2 后导入并保存，IndexedDB 中的快照 `clock.speed=2` |
| 窗口缩放 | 通过：1180×700 窗口 → Canvas 1164×661 |
| 最小化 | 通过：`document.hidden=true`，游戏时间在最小化 4.5 秒内保持 09:03 不变；恢复后为 visible |
| 菜单全屏 / F11 | 通过：菜单项点击与 Electron 输入层 F11 均使 `isFullScreen=true`，页面 2560×1440；再次操作恢复 1440×900。物理 F11 键未单独按压 |
| Pointer Lock | 部分通过（窗口取得焦点、初始进入与 Esc）：修复权限白名单后，进入游戏 `document.pointerLockElement` 为真；Esc 释放并打开暂停菜单；直接请求 Canvas 成功。详见“未验证/风险” |
| 安全属性检查 | 通过：renderer 中 `require/process/module` 均 undefined；`window.wolfDesktop` 仅 `platform`、`onBeforeClose`；prefs 为 contextIsolation=true、sandbox=true、nodeIntegration=false、webSecurity=true |
| 协议边界 | 通过：`app://game/index.html` 200；GLB 返回 `model/gltf-binary`；外部引用的 `.gltf`、`.bin`、`.jpg` 分别返回 `model/gltf+json`、`application/octet-stream`、`image/jpeg`；`../`、`%2e%2e`、嵌套穿越均 404；`app://evil` 失败；POST 405 |
| CSP | 首次运行发现 GLTFLoader 读取内嵌贴图被 `connect-src` 拦截；加入 `blob:` 后不再出现贴图/CSP 错误 |

## 6. 验收项状态

| 验收项 | 状态 |
| --- | --- |
| TypeScript 类型检查 | 通过 |
| Vite 生产构建 | 通过 |
| Electron 开发模式 | 通过 |
| Electron 生产构建启动（win-unpacked） | 通过 |
| Three.js 场景、代表性模型/纹理、控制台资源错误 | 通过：场景、角色、道路/建筑贴图渲染；CSP 修复后无资源错误；保留的“街区跳过”是原有调试告警 |
| 键盘 | 部分通过：Shift 使 HUD 在“行走/疾跑”间切换；完整 WASD 位移手感未做人工验收 |
| 鼠标 / Pointer Lock | 部分通过：窗口取得焦点时进入游戏即锁定；Esc 释放并打开暂停菜单；直接请求 Canvas 成功。自动化下“继续游戏”后重新锁定未保持，界面会显示“进入游戏”遮罩，需人工确认 |
| 失焦 / 恢复 / 最小化 | 通过：最小化时隐藏并暂停，恢复不补算；失焦行为沿用现有实现 |
| 窗口缩放 | 通过 |
| 全屏 | 通过：菜单动作与 Electron 输入层的 F11 均验证进入/退出原生全屏；页面从 1440×900 变为 2560×1440 并恢复。物理 F11 键仍建议人工复核 |
| 保存 / 退出 / 重启 / 读取 | 通过 |
| JSON 导入导出 | 通过 |
| Windows 安装包构建 | 通过 |
| 安装、快捷方式启动、卸载、存档保留 | 通过（静默安装/卸载；安装向导 UI 未逐屏人工点击） |
| 原有浏览器开发流程 | 通过（Edge headless + 共享 Vite 服务） |
| 性能对照 | 仅观察，见下 |

## 7. 安全配置、协议与 IPC

窗口：

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
webSecurity: true
allowRunningInsecureContent: false
webviewTag: false
backgroundThrottling: true
```

- 禁止新窗口、webview、任意导航；只允许固定开发来源或 `app://game`。
- 权限默认拒绝；唯一白名单是主窗口、固定来源的 `pointerLock`（游戏视角必需）。第一次实现曾把 pointerLock 一并拒绝，开发日志暴露后已修复并复测。
- 生产协议 `app://game` 在 ready 前注册为 standard + secure；只服务 `dist/` 内 GET/HEAD 文件，校验 host、方法、解码后的路径段与 `path.relative`，拒绝目录穿越与目录外访问。
- 响应带 CSP、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`；CSP 只放开内联样式、Rapier WASM 编译与 GLTF Blob 读取，没有 `'unsafe-eval'`，没有关闭安全机制。
- IPC 只有 `desktop:before-close`（主→preload）和 `desktop:close-ready`（preload→主）；后者校验 sender 与关闭等待状态。没有通用 `send/invoke`、文件路径参数、shell 或 Node.js 暴露。
- “打开用户数据目录”菜单只打开固定的 `app.getPath('userData')`，不接受渲染进程传参。
- 关闭窗口先等待自动保存链，最长 4 秒；超时或渲染进程崩溃仍会退出，不声称已保存超时后的写入。

## 8. 存档与数据隔离

- 继续使用现有 IndexedDB：`city-wealth-sim` / `snapshots` / `snapshot.<slot>`，格式 v20。
- 桌面生产来源 `app://game`，用户数据目录 `%APPDATA%\WolfOfTarkov`；开发来源 `http://127.0.0.1:5173/`，目录 `%APPDATA%\WolfOfTarkov-dev`。
- 浏览器存档与桌面存档不共享；迁移只通过游戏内 JSON 导出/导入，没有读取浏览器数据库。
- 备份：退出后复制整个 `%APPDATA%\WolfOfTarkov`，或使用导出 JSON。
- 安装包升级/卸载保留用户数据；已实测卸载后 IndexedDB 仍存在。
- 没有改变存档格式、版本号、迁移链、备份与读档回退语义。

## 9. 性能观察

条件：同一台 Windows 10.0.19045、屏幕 2560×1440；同一新游戏出生点；各采样 180 个 `requestAnimationFrame` 帧；窗口可见但未在前台。

| 运行方式 | Canvas | 180 帧耗时 | 观察值 |
| --- | --- | --- | --- |
| Edge headless 开发版 | 1416×807 | 639 ms | ≈281.6 fps（未受垂直同步限制） |
| Electron 打包版 | 1440×900 | 643 ms | ≈280 fps（未受垂直同步限制） |

两者不是同一渲染/垂直同步路径（headless Edge 与窗口化 Electron、SwiftShader/GPU 可能不同），只能作为同机器烟雾观察，**不能据此声称性能无退化**。未做长时间帧时间、GPU 占用或内存压测。

## 10. 已知问题、未验证项与需重点审查的决策

已记录但未顺手修复：

1. 当时 `README.md` 写“当前主分支存档格式为 v18”，实际 `SAVE.formatVersion = 20`；该 README 说明已在后续文档整理时更新。
2. `package.json` 版本从 `0.1.0` 调到 `0.3.3`，与启动页/安装包版本一致；这是交付相关变更，请架构审查确认。
3. 权限检查处理器每次启动会记录一次 `denied permission check: background-sync`；无功能影响，但日志有噪声。
4. 自动化环境中“Esc → 继续游戏”后指针锁定未保持，界面正确显示“进入游戏”遮罩；可能是 Chromium 解锁冷却或自动化焦点问题，需人工确认重新点击遮罩能否稳定锁定。
5. F11 由主进程 `before-input-event` 直接处理；已用 Electron 输入层事件验证进入/退出全屏，但本会话未单独按压物理 F11（需系统焦点，自动化环境不稳定）。
6. 安装包未签名；安装向导 UI 只做了静默安装/卸载与启动验证，未逐屏点击。
7. 首版无自动更新；未来更新必须保持 appId、产品名/可执行文件名、用户数据目录与 `app://game` 来源稳定，否则旧存档不会自动可见。
8. 本机安装 Electron 二进制需要镜像；镜像配置未写入仓库，避免改变项目依赖来源。
9. 本机在已有 `release/` 输出上重复执行 electron-builder 时曾停在 `packaging`（无子进程、CPU 很低）；删除旧输出或改用新的输出目录后一次成功。未定位到具体文件锁来源，建议构建前清理 `release/`，或直接用 `--config.directories.output=...` 指定新目录。
10. 验收过程在 `%APPDATA%\WolfOfTarkov` 与 `%APPDATA%\WolfOfTarkov-dev` 留下了测试用户数据（含一份 v20 测试存档）。需要“首次启动”空数据时请手动删除这两个目录；验收临时脚本与截图在系统临时目录，不在仓库内。

未验证（需要用户在实际桌面环境完成）：

- 鼠标视角、WASD 行走、跳跃、碰撞手感的完整人工体验。
- 原生“保存 JSON”与“打开 JSON”文件对话框未逐一手动点击；导出/导入的内容与存储结果已通过固定路径/文件输入验证。
- F11 物理按键、全屏下 Pointer Lock、Esc 与全屏的交互手感。
- 安装向导逐屏流程、SmartScreen 提示与真实用户账户下的快捷方式启动。
- 覆盖安装/升级（版本号不变或提升）未实际测试；卸载保留已实测。
- 长时间游玩下的存档写入耗时、关闭等待 4 秒是否足够、性能与内存。
- 浏览器版与桌面版之间通过 JSON 的实际人工迁移流程。

## 11. 交付状态

- 源码、安装包和文档已生成。
- 没有创建 Git 提交，没有合并到 `main`，没有推送远程，没有发布发行版。
- 工作树改动即为本次交付；`release/` 与 `node_modules/` 未纳入版本控制。

## 12. 验收修复（第二轮，2026-10-31）

### 12.1 关闭与手动存档竞争

**修复**：`src/app/game.ts` 用 `pendingSaves` 集合跟踪**所有已启动且未完成的存档操作**：

- `enqueueAutoSave()` 将当前自动保存链加入集合；
- `saveToSlot()` 从调用时刻（包括等待已有自动保存的阶段）把整个手动保存任务加入集合；
- 关闭回调改为 `waitForPendingSaves()`，循环等待集合清空；等待期间新启动的写入会被重新纳入，不是只等待某个已过期的 Promise。

没有改变存档槽位、格式、校验、备份、迁移或手动/自动保存的调用语义；没有引入调度框架或第二套存档。
关闭等待仍由主进程限制为 4 秒，超时记录 `renderer did not acknowledge close within timeout` 后关闭；写入失败继续由现有 `performSave` 显示“保存失败”，不会被描述为保存成功。

**验证方法**：在临时测试构建中用 `window.__wolfSaveDelayMs` / `__wolfSaveFail` 注入每次 `putRaw` 的延迟或失败，使用真实窗口 X 关闭（`CloseMainWindow`）并重启读取 IndexedDB；测试完成后已移除全部临时注入代码，最终源码与 asar 中均不含 `__wolfTest` / `__wolfSaveDelayMs` / `__wolfSaveFail`。

| 时序 | 注入与结果 | 结论 |
| --- | --- | --- |
| 手动保存延迟期间关闭 | 每次写入延迟 900ms；基线手动存档后再次保存并立即关闭；关闭进程耗时 1807ms；重启后 `snapshot.manual` 为新的 `savedAt`，`manual-prev` 为基线，读档成功 | 通过 |
| 自动保存延迟期间关闭 | 先建立自动存档，再延迟 900ms 写入并立即关闭；关闭耗时 1806ms；重启后 `snapshot.auto` 为新快照，读档成功 | 通过 |
| 手动保存等待已有自动保存期间关闭 | 同时启动自动保存与手动保存；关闭前 `pendingSaves=2`；关闭耗时 2747ms；重启后 `snapshot.auto` 与 `snapshot.manual` 都是本次新快照，读档成功 | 通过 |
| 写入失败 | 注入失败；HUD 显示“保存失败”，Toast 为“保存失败：测试注入的存档写入失败”；原 `snapshot.manual` 未被覆盖；关闭正常 | 通过 |
| 超过关闭等待上限 | 每次写入延迟 3000ms（手动写入超过 4 秒）；关闭在 4106ms 完成；`snapshot.manual` 保持基线未更新；日志出现关闭超时记录 | 通过 |

临时注入移除后，最终构建又做了一次正常手动保存 + 立即关闭 + 重启读取：关闭 174ms，手动快照 `savedAt` 保持并成功读档；浏览器模式保存/导出也通过（见 12.3）。

### 12.2 安装、覆盖安装与数据

- 最终安装包（见第 4 节）静默安装成功，桌面快捷方式可由资源管理器启动（窗口出现，关闭约 86ms）。
- 安装版启动后读取既有 v20 存档，手动保存产生新的 `savedAt=2026-10-31T12:06:29.865Z`、`minute=28`。
- 对同一安装目录再次执行同一安装包（覆盖安装，验证应用身份/来源/数据目录稳定性）：退出码 0；重启后 `snapshot.manual` 的 `savedAt`、`minute` 不变，存档可读取。
- 卸载：程序目录与桌面快捷方式移除；`%APPDATA%\WolfOfTarkov\IndexedDB` 保留（6 个文件）。
- 更高版本号的测试构建未单独生成；本轮用同版本覆盖安装验证了覆盖/升级共用路径，正式版本号保持 `0.3.3`。

### 12.3 浏览器导出 → 桌面导入

- Edge（浏览器模式，`window.wolfDesktop === undefined`）新游戏后保存：`version=20`，`savedAt=2026-10-31T12:00:50.012Z`。
- 浏览器内导出 JSON：133,142 bytes，`format=city-wealth-sim`、`version=20`、`reason=manual`。
- 桌面版通过真实文件输入导入该 JSON：Toast“存档导入成功”；随后的手动保存写入 `minute=14`、`version=20`，与导出快照一致。

### 12.4 桌面运行补充检查

| 项目 | 本轮结果 |
| --- | --- |
| 初始 Pointer Lock | 通过（窗口取得焦点时，进入游戏 `document.pointerLockElement` 为真） |
| Esc → 暂停菜单 | 通过（释放锁定并打开系统菜单） |
| 继续游戏后重新锁定 | 部分通过：自动化复锁不稳定，界面显示“进入游戏”遮罩；需人工点击确认 |
| F11 | 通过（Electron 输入层事件进入/退出原生全屏 2560×1440）；物理 F11 键在本会话无法可靠注入，未验证 |
| 全屏页面尺寸 | 通过（1440×900 ↔ 2560×1440） |
| 最小化/恢复 | 通过（`document.hidden=true`，游戏时间冻结；恢复不补算） |
| WASD/鼠标视角完整手感 | 未完整验证（需人工运行） |
| 性能可靠对照 | 未验证（headless/窗口化与垂直同步路径不同，不能据帧率推断无退化） |

### 12.5 本轮修改文件

- `src/app/game.ts`：`pendingSaves` 跟踪、`saveToSlot` 从调用时刻纳入等待、`waitForPendingSaves` 循环等待、关闭回调改用新方法。
- `docs/desktop.md`、`docs/architecture.md`、`docs/decisions.md`：关闭等待与失败/超时语义。
- `docs/desktop-delivery.md`：本节及安装包信息更新。
- 最终安装包重新构建；`src/infrastructure/save-database.ts` 只保留了原有实现（临时延迟/失败注入已删除）。

### 12.6 本轮结论与遗留

- 关闭期间手动存档竞争已修复；三种关闭时序与失败/超时均有实测记录。
- 仍待人工验收：物理 F11 键、全屏下 Pointer Lock/鼠标视角、继续游戏后的复锁、WASD/跳跃手感、安装向导逐屏 UI、真实升级（更高版本号）流程。
- 安装包仍未签名；无自动更新；桌面与浏览器存档仍通过 JSON 迁移。
- 测试完成后已将本轮测试用户数据从 `%APPDATA%\WolfOfTarkov` 移除并恢复验收前备份的目录；测试临时脚本/截图在系统临时目录，不在仓库。
