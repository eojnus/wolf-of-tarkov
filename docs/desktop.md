# Windows 桌面版（Electron）

本文描述《塔科夫之狼》的桌面壳：职责、依赖方向、安全边界、加载方式、数据位置与构建交付。
游戏规则、经济系统、存档格式与迁移链没有因桌面化而改变。

## 1. 目标与范围

- 玩家安装后通过桌面或开始菜单快捷方式启动，不依赖浏览器、Node.js、npm 或 Vite 服务。
- 渲染进程仍是现有 Vite + Three.js 游戏；Electron 自带 Chromium，主进程只提供窗口与受限资源服务。
- 保留 `npm run dev` 的浏览器开发方式和 `npm run build` 的 Web 构建。
- 本次只交付 Windows x64；不包含 macOS/Linux、自动更新、录屏、直播或编辑器。

## 2. 目录与依赖方向

新增文件：

```
desktop/
  main.cjs          主进程：窗口、生命周期、app:// 协议、CSP、菜单、关闭协调
  preload.cjs       沙箱 preload：只暴露关闭前等待能力
scripts/
  electron-dev.mjs  固定端口启动 Vite → 校验页面 → 启动 Electron → 退出时清理进程树
src/platform/
  desktop.ts        渲染进程平台适配层（类型 + 浏览器降级）
electron-builder.yml
build/icon.png
```

依赖方向：

```
游戏 / UI → src/platform/desktop.ts（平台能力接口）
          → window.wolfDesktop（preload 暴露的受限桥）
          → desktop:before-close / desktop:close-ready（两条固定 IPC）
          → desktop/main.cjs
```

- `src/core`、`src/features`、`src/app` 不导入 Electron 或 Node.js。
- 渲染进程没有 `require`、`process` 全量对象、`ipcRenderer`、任意 `send/invoke`、文件读写或 shell。
- 浏览器中不存在 `window.wolfDesktop`，`registerDesktopCloseHandler` 返回 `false`，原有行为不变。

## 3. 主进程、preload、renderer 职责

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| 主进程 `desktop/main.cjs` | 窗口与生命周期、单实例、`app://game/` 静态资源、CSP、权限拒绝、菜单/全屏、About、关闭协调、错误日志 | 游戏规则、存档读写、业务状态 |
| preload `desktop/preload.cjs` | 暴露 `window.wolfDesktop.onBeforeClose(handler)`；转发固定关闭事件 | 通用 IPC、文件系统、shell、Node.js |
| renderer | 现有游戏、UI、IndexedDB 存档；注册关闭前等待回调 | 直接访问 Electron / Node.js |
| `src/platform/desktop.ts` | 类型化桥接口与浏览器降级 | 具体窗口或 IPC 实现 |

## 4. 开发加载

```bash
npm run desktop:dev
```

- 启动器只使用 `http://127.0.0.1:5173/`，并用 `--strictPort` 启动 Vite。
- 端口已被占用时直接失败；即使端口上有服务，也必须响应本项目 `index.html` 的特征（包含 `/src/main.ts`）才会启动 Electron，不会静默连接未知服务。
- Electron 通过 `WOLF_DEV_SERVER_URL` 接收地址；主进程再次校验协议、主机、端口和路径，只接受固定地址。
- Electron 退出或脚本被 Ctrl+C 中断时，用 `taskkill /T` 结束本次启动的 Vite 进程树，不遗留后台进程。
- `npm run dev` 仍然是纯浏览器开发，不使用 Electron。

开发数据目录与生产隔离：

```
%APPDATA%\WolfOfTarkov-dev
```

## 5. 生产加载与协议

生产入口固定为：

```
app://game/
```

- 在 `app.whenReady()` 之前调用 `protocol.registerSchemesAsPrivileged`，注册为 `standard`、`secure`、`supportFetchAPI`、`corsEnabled`、`stream`。因此 IndexedDB / localStorage 有稳定来源，LevelDB 落在用户数据目录。
- `protocol.handle('app', ...)` 只服务打包目录 `dist/`：
  - 只允许 `GET` / `HEAD`；
  - 校验 `app:` 协议与 host 必须为 `game`；
  - 拒绝空字节、反斜杠、`.`/`..` 段、解码后的目录穿越与目录外路径；
  - 只返回 `dist/` 内的普通文件，目录请求不列目录；
  - 使用显式 MIME（HTML、JS、CSS、JSON、GLB、GLTF、USDZ、BIN、WASM、PNG/JPEG/WebP/SVG、KTX2、字体）；
  - 响应带 CSP、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。
- 不启动本地 HTTP 服务，不依赖外部 CDN；GLTF 的外部 `.bin`/贴图、USDZ 与其内部贴图、Three.js 模块走同一协议。已验证 `.gltf`、`.bin`、`.jpg` 的 MIME 与读取；2026-10-31 在生产构建中验证了 `.usdz → model/vnd.usdz+zip` 的角色加载（Alina 正常显示）。室内场景整体加载仍建议进入住宅人工确认。
- Rapier 使用 `@dimforge/rapier3d-compat` 的内嵌 base64 WASM，不需要额外 `.wasm` 请求。

### CSP

生产：

```
default-src 'self';
script-src 'self' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self' data:;
connect-src 'self' blob:;
media-src 'self';
worker-src 'self' blob:;
object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'
```

必要例外及原因：

- `style-src 'unsafe-inline'`：现有 UI 大量使用元素内联 `style` 与运行时样式，不属于可哈希的内联 `<style>`。
- `script-src 'wasm-unsafe-eval'`：Rapier compat 在运行时编译内嵌 WASM。
- `img-src blob:`：Three.js 为 GLB 内嵌贴图创建 Blob URL / ImageBitmap。
- `connect-src blob:`：GLTFLoader 通过 `fetch` 读取同一 Blob URL；实测缺少该项时内嵌贴图加载失败。
- 开发 CSP 额外允许 `'unsafe-inline'` 脚本与 `ws://127.0.0.1:5173`（Vite HMR）；生产不放宽。

没有关闭 `webSecurity`、`sandbox`、`contextIsolation`，也没有加入 `'unsafe-eval'`。

## 6. 安全边界

窗口配置（`webPreferences`）：

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
webSecurity: true
allowRunningInsecureContent: false
webviewTag: false
backgroundThrottling: true
```

- 禁止任意导航：`will-navigate` 只允许当前开发来源或 `app://game`。
- `setWindowOpenHandler` 一律拒绝新窗口；`will-attach-webview` 拒绝。
- 不加载不可信远程页面；生产不访问网络资源。
- 权限请求与权限检查默认拒绝（摄像头、麦克风、定位、通知、剪贴板等），并写入日志。
  唯一例外是游戏视角必需的 `pointerLock`，且只允许主窗口、且当前页面来源属于固定开发地址或 `app://game`；其余来源与权限一律拒绝。
- 菜单只提供全屏/最小化、关于与打开用户数据目录；开发模式额外提供开发者工具。没有 reload 菜单，避免误丢未保存进度。
- 菜单栏默认隐藏（`autoHideMenuBar`），Alt 可临时显示，F11 切换全屏。
- IPC 只有两条固定消息：
  - 主进程 → preload：`desktop:before-close`；
  - preload → 主进程：`desktop:close-ready`，只接受当前主窗口的 sender，且只在关闭等待状态生效。
  没有通用通道、参数透传或文件路径参数。
- 外部打开只用于固定的用户数据目录（菜单项），不接受渲染进程传入的任意路径。

## 7. 窗口、全屏与关闭

- 默认内容尺寸 1440×900，最小 1024×640，可缩放、最小化、最大化、恢复。
- 标题使用项目品牌 `塔科夫之狼`；可执行文件 `WolfOfTarkov.exe`，安装快捷方式名 `塔科夫之狼`。
- F11 进入/退出全屏；主进程在 `before-input-event` 中直接处理并阻止页面收到该键，不依赖菜单栏可见或窗口焦点路径；菜单项提供同等操作。Esc 仍由游戏处理为关闭面板/打开暂停菜单，不强制退出全屏。Pointer Lock 与全屏互不替代，均由 Chromium 原生能力提供。
- 页面隐藏/窗口最小化沿用现有行为：`document.hidden` 暂停模拟，恢复后不补算后台时间；实现没有改时间语义。
- 关闭窗口时先向渲染进程发送一次关闭请求，等待**所有已启动且尚未完成的存档写入（手动保存与自动保存）**，最长 4 秒；确认后关闭。等待期间新启动的写入也会被纳入，而不是只等待某一个已过期的 Promise。
- 超时、渲染进程崩溃或没有注册回调时直接关闭；超时会在 `desktop.log` 记录。关闭不会额外生成一份新存档，也不会声称已保存未完成的写入；写入失败仍由游戏内 HUD/Toast 显示“保存失败”。游戏内「保存游戏」仍是显式保存入口。

## 8. 用户数据与存档

| 内容 | 位置 |
| --- | --- |
| 桌面版用户数据 | `%APPDATA%\WolfOfTarkov` |
| 开发版用户数据 | `%APPDATA%\WolfOfTarkov-dev` |
| 主进程日志 | `%APPDATA%\WolfOfTarkov\desktop.log` |
| IndexedDB | `%APPDATA%\WolfOfTarkov\IndexedDB\app_game_0.indexeddb.leveldb`（由 Chromium 管理） |

- 固定应用身份：appId `com.wolfoftarkov.desktop`、产品名 `塔科夫之狼`、可执行文件 `WolfOfTarkov`、页面来源 `app://game`。
- 存档格式、`SAVE.formatVersion = 20`、IndexedDB 名称/仓库/键、快照备份、迁移链、校验与读档回退均未修改。
- 桌面版与浏览器版是不同存储（不同来源与用户数据目录），不会自动共享。迁移使用游戏内「导出 JSON」→「导入 JSON」；不会读取浏览器数据库。
- 安装程序升级与卸载默认保留 `%APPDATA%\WolfOfTarkov`（`deleteAppDataOnUninstall: false`）。需要彻底清理时手动删除该目录。
- 备份：退出游戏后复制整个 `%APPDATA%\WolfOfTarkov` 目录，或用游戏内导出 JSON。恢复：把 JSON 通过游戏内导入。

## 9. 构建与安装包

前置：Node.js 20.19+（当前开发环境 Node 26）、Windows x64。

```bash
npm ci
npm run desktop:dev     # 开发（Vite + Electron）
npm run build           # 类型检查 + Vite 生产构建
npm run desktop:start   # 用 app://game/ 启动未打包生产构建
npm run desktop:pack    # 生成 release/win-unpacked（不生成安装包）
npm run desktop:build   # 类型检查 + Vite 构建 + NSIS 安装包
```

安装包输出：

```
release/WolfOfTarkov-Setup-0.3.3.exe
```

- 安装包使用 electron-builder + NSIS，x64，非 one-click，可选择安装目录，创建桌面与开始菜单快捷方式。
- 若 Windows 文件锁导致 electron-builder 停在 `packaging`，先删除 `release/`（构建产物，可安全重建）再重试。
- 不包含 Node.js、npm、Vite 服务或浏览器；`dist/` 与 Electron 运行时在 app.asar 内。
- 首版不接入自动更新。未来更新必须保持 appId、产品名/可执行文件名、用户数据目录和 `app://game` 来源稳定；否则旧存档会不可见。
- 未提供代码签名证书，安装包未签名；Windows 可能显示 SmartScreen 提示，不能声称已通过签名或可信发布验证。

## 10. 诊断与已知边界

- 主进程启动、协议错误、权限拒绝、关闭超时写入 `desktop.log`；页面加载失败与渲染进程崩溃会弹出可复制路径的错误对话框。
- 渲染进程启动失败沿用启动页提示（WebGL/初始化错误）。
- 已知限制：只发布 Windows x64；未签名；无自动更新；桌面版与浏览器存档不互通（需 JSON 迁移）；全屏与 Pointer Lock 的实际手感仍需人工体验验收。

本次实施的实际命令、验收状态和未验证项见 [桌面化交付报告](desktop-delivery.md)。
