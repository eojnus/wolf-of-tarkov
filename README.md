# 塔科夫之狼

**一款以城市生活、创业经营和资本投资为核心的单人 3D 模拟游戏。**

玩家在塔科夫市探索、工作、管理生活和财务，创办科技公司、研发产品并参与股票投资；城市人口、政府和城区建设随游戏时间变化。

项目仍在持续开发。游戏支持 Windows Electron 桌面运行，也保留基于 Vite 的浏览器开发方式；无需游戏后端，不包含多人联机。

## 游戏内容

- **城市与生活**：第三人称探索、建筑交互、工作、饮食、背包与个人财务。
- **企业经营**：创办科技公司、招聘科研人员、研发和销售产品，管理企业账户与经营报表。
- **投资与资本**：股票交易、持仓和 K 线，企业融资、上市、股东投票与公司治理。
- **城市发展**：人口变化、政府选举、满意度、城区建设，以及住房和土地交易。
- **本地存档**：保存和读取进度，支持通过 JSON 导入、导出存档。

项目当前尚不包含战斗、车辆、多人联机或云存档；玩法与经济数值仍在完善中。

## Windows 桌面版

桌面应用基于 Electron，使用内置 Chromium 运行现有 Three.js 游戏。Windows x64 安装包可在本地构建，安装后通过桌面或开始菜单快捷方式启动，玩家无需另行安装浏览器、Node.js 或 Vite。

从源码构建需要 Node.js **20.19+（20.x）或 22.12+**、npm 和 Windows x64：

```powershell
npm ci
npm run desktop:build
```

构建完成后，NSIS 安装包位于 `release/`，文件名为 `WolfOfTarkov-Setup-<版本>.exe`。安装包未配置代码签名，当前没有自动更新。

桌面版用户数据位于 `%APPDATA%\WolfOfTarkov`，开发版位于 `%APPDATA%\WolfOfTarkov-dev`。桌面版与浏览器版存档相互独立，可通过游戏内 JSON 导出和导入迁移；卸载默认保留用户数据。

更多运行、安全和存档说明见 [Windows 桌面版文档](docs/desktop.md)。

## 开发运行

在项目根目录安装依赖：

```bash
npm ci
```

浏览器开发：

```bash
npm run dev
```

打开终端显示的本地地址，通常为 `http://localhost:5173`。Windows 用户也可以运行 `start.cmd` 启动开发服务器。

Electron 桌面开发：

```bash
npm run desktop:dev
```

其他命令：

```bash
npm run typecheck        # TypeScript 类型检查
npm run build            # 类型检查并构建 Web 资源到 dist/
npm run preview          # 本地预览 Web 构建
npm run desktop:start    # 运行未打包的桌面版；需先执行 npm run build
npm run desktop:pack     # 构建 Windows 目录版
npm run model-tool:build # 构建无头模型工具
```

`desktop:dev` 使用本地 `127.0.0.1:5173`；端口被占用时需要先释放。Web 构建需通过 HTTP 服务访问，不要直接双击 `dist/index.html`。

## 基本操作

| 操作 | 按键 |
| --- | --- |
| 移动 | W / A / S / D 或方向键 |
| 切换疾跑 | Shift |
| 跳跃 | 空格 |
| 转动视角 / 缩放 | 鼠标移动 / 滚轮 |
| 与附近建筑交互 | F |
| 打开个人管理界面 | Tab |
| 关闭窗口或打开暂停菜单 | Esc |
| 桌面版切换全屏 | F11 |

普通业务窗口打开时人物操作锁定，模拟仍继续；暂停菜单会停止模拟。

## 技术与模型工具

游戏使用 **TypeScript、Three.js、Vite 和 Rapier**，Windows 桌面壳使用 **Electron**。核心模拟、场景表现和桌面运行环境保持分层。

仓库内的 [无头模型工具](tools/model-tool/README.md) 面向 Agent 和开发者，提供模型与资源检查、截图、角色动作和碰撞诊断，以及有限的动画片段处理。它可以读取 GLB、glTF 和 USDZ；USDZ 写回、完整模型编辑及跨模型动作套用尚不支持。

## 文档与资源

- [项目架构](docs/architecture.md) · [接口契约](docs/contracts.md) · [技术决策](docs/decisions.md)
- [Windows 桌面版](docs/desktop.md) · [人物与动作](docs/character-animation-plan.md)
- [模型工具使用说明](tools/model-tool/README.md) · [模型工具架构](docs/model-tool-architecture.md)
- [Agent 开发约束](AGENTS.md) · [模型与资源来源](public/assets/SOURCES.md)

第三方模型、贴图和图标的署名与许可证以 [资源来源说明](public/assets/SOURCES.md) 及各资源附带的许可文件为准。
