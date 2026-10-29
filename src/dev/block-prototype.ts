/**
 * 街区开发预览 —— 只用于开发期看几何与材质，**不进生产构建**。
 *
 * 与正式场景走**同一条代码路径**：
 *   `createBaseLayout()`（与正式地图同源的基础布局）
 *   → `buildCityScene()`（地面 + 路网，含真实路口求交）
 *   → `planCityBlocks()`（只读规划，含全部避让断言）
 *   → `CityBlocks.sync()`（装修街区：楼体走同一个建筑工厂）
 *
 * 因此这里的画面与游戏内一致，差别只在相机与灯光（正式场景的昼夜由 EnvironmentRig 控制）。
 *
 * 用法：`/block-prototype.html?view=aerial|alley|street|court`
 */

import * as THREE from 'three';
import { BLOCK_TEMPLATES } from '../content/city-blocks';
import { addDistrict, createBaseLayout } from '../features/city-layout';
import { resolveBuildingPlan } from '../world/buildings/plan';
import { BuildingVisualFactory, projectBuildingVisualRequest, visualFingerprint } from '../world/buildings';
import { CityBlocks } from '../world/blocks/scene';
import { planCityBlocks } from '../world/blocks/plan';
import { buildCityScene } from '../world/scene';
import { SceneryAssetLibrary } from '../world/scenery/assets';

const VIEWS: Record<string, { eye: [number, number, number]; target: [number, number, number] }> = {
  // 斜俯视：一眼看到街墙、小巷、庭院与储备地块
  aerial: { eye: [16, 34, -2], target: [38, 3, 32] },
  // 街面：站在人行道上看沿街墙与门头
  street: { eye: [18, 1.7, 12], target: [44, 6, 22] },
  // 巷口：从人行道望向小巷深处
  alley: { eye: [28, 1.7, 8.5], target: [28, 2.6, 38] },
  // 庭院：从庭院看四周立面与树
  court: { eye: [30.4, 1.7, 40], target: [36, 4, 30] },
};

const params = new URLSearchParams(location.search);
// `?cam=x,y,z&look=x,y,z`：临时机位，用于局部核查（路口、转角等固定视角看不到的地方）
const custom = (value: string | null): [number, number, number] | null => {
  if (!value) return null;
  const parts = value.split(',').map(Number);
  return parts.length === 3 && parts.every((item) => Number.isFinite(item))
    ? [parts[0], parts[1], parts[2]]
    : null;
};
const customEye = custom(params.get('cam'));
const customLook = custom(params.get('look'));
const view =
  customEye && customLook
    ? { eye: customEye, target: customLook }
    : (VIEWS[params.get('view') ?? 'aerial'] ?? VIEWS.aerial);

const hideHud = params.get('hud') === '0';
const container = document.getElementById('block-root') as HTMLDivElement;
const reportBox = document.getElementById('block-report') as HTMLDivElement;
if (hideHud) reportBox.style.display = 'none';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const camera = new THREE.PerspectiveCamera(52, container.clientWidth / container.clientHeight, 0.1, 400);
camera.position.set(...view.eye);
camera.lookAt(new THREE.Vector3(...view.target));

const factory = new BuildingVisualFactory();
const library = new SceneryAssetLibrary();
const layout = createBaseLayout();
// `?districts=1`：追加三个新区条带（住房 → 商业 → 科技），用于全城推广的区域截图。
// 与正式流程同一函数，不改任何经济状态。
if (params.get('districts') === '1') {
  const stages: [string, 'housing' | 'commercial' | 'technology'][] = [
    ['district-housing', 'housing'],
    ['district-commercial', 'commercial'],
    ['district-tech', 'technology'],
  ];
  stages.forEach(([templateId, direction], stage) => {
    addDistrict(layout, {
      direction,
      stage,
      templateId,
      templateVersion: 1,
      sourceTermId: `preview-term-${stage}`,
      sourceProjectId: `preview-project-${stage}`,
      completedAtMinute: 1000 + stage,
    });
  });
}
const city = buildCityScene(layout, factory, library);
// dev 页没有 EnvironmentRig，背景与雾自己设一次
// 灯光必须加在**被渲染的那个 Scene** 上：city.scene 是独立场景，
// 加到外层不会参与它的光照收集。
city.scene.background = new THREE.Color(0x9fb6c8);
city.scene.fog = new THREE.Fog(0x9fb6c8, 80, 220);
city.scene.add(new THREE.HemisphereLight(0xdfe9f2, 0x5a5348, 2.1));
const sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
sun.position.set(70, 110, 30);
sun.target.position.set(34, 0, 30);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.06;
const shadowCam = sun.shadow.camera as THREE.OrthographicCamera;
shadowCam.left = -70;
shadowCam.right = 70;
shadowCam.top = 70;
shadowCam.bottom = -70;
shadowCam.near = 1;
shadowCam.far = 320;
shadowCam.updateProjectionMatrix();
city.scene.add(sun, sun.target);

// 业务楼也挂上模块化楼体：正式场景由 World 调度，这里用同一个工厂补一遍，
// 否则截图里它们只会是占位方块，看不出街区与既有建筑的衔接关系。
const districtVersions = new Map(layout.districts.map((d) => [d.id, d.templateVersion]));
for (const handle of city.buildings) {
  const version = districtVersions.get(handle.building.districtId);
  if (version === undefined) continue;
  const request = projectBuildingVisualRequest(handle.building, version);
  const key = visualFingerprint(request);
  void factory
    .begin(request)
    .result.then((visual) => {
      handle.placeholder.visible = false;
      handle.group.add(visual.group);
      handle.visualKey = key;
      console.log('building visual:', handle.building.id);
    })
    .catch((error: unknown) => console.warn('building visual failed', handle.building.id, error));
}

const blocks = new CityBlocks(city.scene, factory, library);
const plan = planCityBlocks(layout);
// `?blocks=0`：同机位不生成街区，用于测"有/无街区"的绘制开销差
const withBlocks = params.get('blocks') !== '0';
if (withBlocks) blocks.sync(plan.blocks);

const summary = (): void => {
  const blockReport = blocks.report();
  const lines = [
    `view: ${params.get('view') ?? 'aerial'}`,
    `blocks: ${blockReport.blocks}  props: ${blockReport.props}  trees: ${blockReport.trees}`,
    `pending: ${blockReport.pendingVisuals}  suppressed: ${blockReport.suppressed.length}`,
    `fallbacks: ${blockReport.fallbacks.join(', ') || '-'}`,
    `assets: ${factory.stats().live} live / ${factory.stats().pending} pending / ` +
      `${factory.stats().textures} tex / ${factory.stats().models} model`,
    `skipped: ${plan.skipped.map((item) => item.id).join(', ') || '-'}`,
  ];
  reportBox.textContent = lines.join('\n');
  console.log(lines.join('\n'));
  if (blockReport.errors.length > 0) console.warn('[block]', blockReport.errors);
};
summary();
setTimeout(summary, 3000);

// `?plan=1`：用**真实** resolveBuildingPlan 打印三栋装饰楼的关键字段，
// 供交付说明引用（不是项目外复刻的算术）。
if (params.get('plan') === '1') {
  const template = BLOCK_TEMPLATES[0];
  const rows = template.buildings.map((spec) => {
    const plan = resolveBuildingPlan({
      buildingId: `${template.id}-${spec.id}`,
      kind: spec.styleId,
      width: spec.local.width,
      depth: spec.local.depth,
      height: spec.local.height,
      templateVersion: template.version,
      styleId: spec.styleId,
    });
    return {
      id: spec.id,
      style: plan.styleId,
      storeys: plan.storeys,
      body: Number(plan.body.width.toFixed(2)) + ' x ' + Number(plan.body.depth.toFixed(2)),
      insets: [plan.insets.front, plan.insets.back, plan.insets.side].join('/'),
      wallTop: Number(plan.body.wallTop.toFixed(2)),
      roofReserve: Number(plan.roofReserve.toFixed(2)),
      equipment: plan.roofEquipment.kind + ' h' + plan.roofEquipment.height,
      utilityBoxes: plan.utilityBoxes,
      balcony: plan.balcony.enabled ? `depth ${plan.balcony.depth} bays ${plan.balcony.bays.join('.')} floors ${plan.balcony.floors.length}` : 'none',
      bays: [plan.faces.front.bays, plan.faces.back.bays, plan.faces.left.bays, plan.faces.right.bays].join('/'),
      fireEscape: plan.fireEscape,
      frontmost: Number((plan.body.frontZ + Math.max(plan.balcony.depth, plan.entrance.canopyDepth)).toFixed(2)),
      halfDepth: Number((plan.envelope.depth / 2).toFixed(2)),
    };
  });
  console.log('PLAN_JSON ' + JSON.stringify(rows));
}

let frames = 0;
// 帧耗时统计（仅预览页；用于同机位短对比，不做压力测试）
const frameTimes: number[] = [];
let lastFrameAt = performance.now();
const median = (list: readonly number[]): number => {
  if (list.length === 0) return 0;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};
const tick = (): void => {
  frames += 1;
  const now = performance.now();
  // 前几帧含首帧编译与贴图上传，不计入
  if (frames > 10) {
    frameTimes.push(now - lastFrameAt);
    if (frameTimes.length > 180) frameTimes.shift();
  }
  lastFrameAt = now;
  renderer.render(city.scene, camera);
  if (frames === 120) {
    const info = renderer.info.render;
    console.log(`render: calls=${info.calls} triangles=${info.triangles}`);
    reportBox.textContent += `\ncalls: ${info.calls}  triangles: ${info.triangles}`;
  }
  requestAnimationFrame(tick);
};
tick();

window.addEventListener('resize', () => {
  camera.aspect = container.clientWidth / Math.max(1, container.clientHeight);
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
});

// 便于自动化脚本判定"已经画完"：街区在途 + 建筑工厂在途都为 0
(window as unknown as { __blockReady?: () => boolean }).__blockReady = () =>
  blocks.report().pendingVisuals === 0 && factory.stats().pending === 0;

// 供自动化脚本核对"业务楼与资产是否都已挂上"（只读诊断，仅开发页）
(window as unknown as { __diag?: () => unknown }).__diag = () => {
  let meshes = 0;
  let triangles = 0;
  city.scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes += 1;
    const geometry = mesh.geometry as THREE.BufferGeometry;
    const index = geometry.getIndex();
    const position = geometry.getAttribute('position');
    const count = index ? index.count : position ? position.count : 0;
    triangles += count / 3;
  });
  let placeholders = 0;
  city.scene.traverse((child) => {
    if (child.name.includes('-placeholder-')) placeholders += 1;
  });
  return {
    buildings: city.buildings.map((handle) => ({
      id: handle.building.id,
      visual: handle.visualKey !== null,
      placeholder: handle.placeholder.visible,
      children: handle.group.children.length,
    })),
    meshes,
    triangles: Math.round(triangles),
    decorPlaceholders: placeholders,
  };
};

// 供自动化脚本读取渲染统计（只读）
(window as unknown as { __stats?: () => unknown }).__stats = () => ({
  calls: renderer.info.render.calls,
  triangles: renderer.info.render.triangles,
  programs: renderer.info.programs?.length ?? 0,
  textures: renderer.info.memory.textures,
  geometries: renderer.info.memory.geometries,
  frameMs: Number(median(frameTimes).toFixed(2)),
  frameSamples: frameTimes.length,
});
