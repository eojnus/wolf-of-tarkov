# 城市街区写实化集成与快速验收（2026-10-29）

## 合并授权与范围

用户明确要求快速验证后合并并推送 main 与 feature/city-block-realism；简单代码错误允许有限修复，其余重大问题及模型、贴图问题记录后合入，便于后续开发。此次合并不等于全量运行验收。

开发基线 dea681b；集成前 main 为 eaeaa63，已包含石墨 UI、HUD 和晴川住宅室内更新，合并必须保留这些成果。

## 本次已独立执行的快速核对

- feature 分支 npm run build 通过（包含 tsc --noEmit，145 模块）；仍有已有的大包体积提示。
- 真实源码生成基础城区及住宅、商业、科技三个条带：16 个街区、33 栋装饰楼；规划不修改输入布局。
- 三套完整模板均为 12 栋、4 个端口、perimeter=true，几何包络在 45×45 内；相同输入结果稳定，错误版本明确拒绝。
- 真实 CityBlocks 会话验证：抑制后普通同步保持 0 块；beginDisplaySession 后同步恢复 1 块。
- 已审查 app 读档/新游戏的显示会话通知；未变更经济、产权、现有业务标识或存档格式。

## 已知问题与后续工作（按用户要求记录，不作为此次合并阻塞）

1. 最新完整模板的转角采用约 1.5 m 实体搭接；主体无缝不代表基座、檐口、线脚、女儿墙和屋顶设备无穿插。最新状态未逐构件量测、未重拍截图。下轮优先检查转角错台、共面闪烁和屋顶相交，不宣称模型美术已最终通过。
2. 较早截图与最新完整模板代码不完全一致，仅作为过程记录；正式观感需要用户在真实浏览器中确认。
3. 全城推广曾记录软件渲染鸟瞰 634 draw call、约 183 万渲染三角形；街面 236 draw call、约 82 万三角形。SwiftShader 帧耗时不能代表真机 GPU 性能，最终围合修复后未再测性能。
4. 树种为 Quiver Tree 01，形态偏沙漠肉质乔木；树冠旋转后的视觉避让及局部枝叶相接仍需真实画面检查。模型及贴图瑕疵本轮仅记录。
5. 受限条带允许 clipped/row 变体，部分 row 无庭院；41 条站点因尺寸不足被跳过。完整模板已可独立调用，但没有直接替换经济扩张的 60×110 条带模板。
6. 模板只输出端口，不自行生成外围道路；调用方负责 18 m 街道走廊与连接。逻辑地图 layoutVersion=1、存档 formatVersion=19 保持不变。
7. 未开展浏览器实机行走、六类业务全流程、长时存档或跨浏览器回归。本报告不把源码核对和构建通过称为完整运行通过。

## 关键入口

- 逻辑地图只读投影：src/world/blocks/plan.ts。
- 站点枚举：src/world/blocks/sites.ts。
- 裁剪与围合生成：src/world/blocks/generate.ts。
- 完整模板入口与目录：src/world/blocks/templates.ts；端口类型：types.ts。
- 显示会话和碰撞：World.beginDisplaySession / planBlocks / resolveSceneryConflict。
- 共享街景资源：src/world/scenery/assets.ts。
- 开发预览：block-prototype.html、block-template.html，不进入生产主入口。

外部实现者交付原文另存于 docs/city-block-realism-delivery/；其验证记录与本次独立核对须区分。

## 主分支集成结果

- 合并保留 main 已有住宅室内、图形 UI、鼠标锁定及异步进入保护；app 新增显示会话通知与原有取消室内流程共存。
- 代码自动合并，无代码冲突；architecture/contracts/decisions 的追加文档冲突按保留双方内容解决。
- 合并后 npm run build 通过，包含类型检查，148 模块，保留独立的 qingchuan 室内构建分块。仅出现已有的大包提示。
- 此轮快速验证未发现需要额外有限修复的简单代码错误；不据此宣称完整运行无缺陷。
- GitHub 连接通过本机现有代理 127.0.0.1:10910 恢复，仅对本次 Git 命令临时指定，未更改永久 Git 或系统代理配置。
- 推送目标：origin 的 main 与 feature/city-block-realism；不强制推送、不删除其他分支。
