/**
 * 三套标准街区模板的独立预览 —— 只用于开发期看几何，**不进生产构建**。
 *
 * 走的是正式代码路径：
 *   `generateTemplateBlock()`（与全城推广同一个 `generate.ts`）
 *   → `CityBlocks.sync()`（同一个装配与资源生命周期）
 *   → `BuildingVisualFactory`（同一个建筑工厂）
 *
 * 用法：
 *   /block-template.html              三套并排
 *   /block-template.html?t=a          只看住宅庭院街区
 *   /block-template.html?t=b&view=court 只看商业混合街区的内部广场
 *   /block-template.html?seed=2       换稳定种子（同一 seed 结果恒定）
 */

import * as THREE from 'three';
import { BuildingVisualFactory } from '../world/buildings';
import { CityBlocks } from '../world/blocks/scene';
import { generateTemplateBlock, STREET_CORRIDOR, TEMPLATE_CATALOG } from '../world/blocks/templates';
import { SceneryAssetLibrary } from '../world/scenery/assets';

const params = new URLSearchParams(location.search);
const only = params.get('t') ?? 'all';
const view = params.get('view') ?? 'overview';
const seedSuffix = params.get('seed') ?? '';

const container = document.getElementById('block-root') as HTMLDivElement;
const reportBox = document.getElementById('block-report') as HTMLDivElement;
if (params.get('hud') === '0') reportBox.style.display = 'none';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb6c8);
scene.fog = new THREE.Fog(0x9fb6c8, 160, 320);
scene.add(new THREE.HemisphereLight(0xdfe9f2, 0x5a5348, 2.1));
const sun = new THREE.DirectionalLight(0xfff2dd, 2.6);
sun.position.set(70, 120, 90);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.06;
const shadowCam = sun.shadow.camera as THREE.OrthographicCamera;
shadowCam.left = -150;
shadowCam.right = 150;
shadowCam.top = 110;
shadowCam.bottom = -110;
shadowCam.near = 1;
shadowCam.far = 400;
shadowCam.updateProjectionMatrix();
scene.add(sun, sun.target);

const factory = new BuildingVisualFactory();
const library = new SceneryAssetLibrary();
const blocks = new CityBlocks(scene, factory, library);

// 地面 + 每个模板前的一条街道铺装（只做视觉背景，不参与规划）
const ground = new THREE.Mesh(
  new THREE.BoxGeometry(420, 0.4, 260),
  new THREE.MeshStandardMaterial({ color: 0x7d8b6f, roughness: 1 }),
);
ground.position.y = -0.2;
ground.receiveShadow = true;
scene.add(ground);

// 与 templates.ts 的 STREET_CORRIDOR 同一口径：45 + 18 = 63 m
const spacing = TEMPLATE_CATALOG[0].nominalSize + STREET_CORRIDOR;
const chosen = TEMPLATE_CATALOG.filter((_, index) => only === 'all' || only === ['a', 'b', 'c'][index]);
const plans = chosen.map((item, index) => {
  const center = { x: (index - (chosen.length - 1) / 2) * spacing, z: 0 };
  const { plan } = generateTemplateBlock({
    familyId: item.id,
    templateVersion: item.version,
    center,
    seedSuffix,
  });
  const road = new THREE.Mesh(
    new THREE.BoxGeometry(item.nominalSize + 24, 0.06, 10),
    library.getSolidMaterial('soil'),
  );
  road.position.set(center.x, 0.01, -item.nominalSize / 2 - 8);
  road.receiveShadow = true;
  scene.add(road);
  return { plan, center, catalog: item };
});
blocks.sync(plans.map((item) => item.plan));

const camera = new THREE.PerspectiveCamera(50, container.clientWidth / container.clientHeight, 0.1, 600);
const focus = plans[0]?.center ?? { x: 0, z: 0 };
if (view === 'top') {
  // 围合俯视：略偏南，能同时看到四侧街墙、四个巷口与内部庭院
  camera.position.set(focus.x, 66, focus.z + 34);
  camera.lookAt(new THREE.Vector3(focus.x, 0, focus.z));
} else if (view === 'alley') {
  // 巷口：站在端口外侧，看巷道如何穿进庭院
  camera.position.set(focus.x, 1.7, focus.z - 30);
  camera.lookAt(new THREE.Vector3(focus.x, 6, focus.z - 8));
} else if (view === 'court') {
  camera.position.set(focus.x + 4, 6, 34);
  camera.lookAt(new THREE.Vector3(focus.x, 5, 4));
} else if (view === 'entrance') {
  camera.position.set(focus.x + 2, 2.0, -38);
  camera.lookAt(new THREE.Vector3(focus.x, 8, 0));
} else {
  // 从**街道一侧**（-z）斜俯视：能同时看到沿街立面、巷口和内部庭院
  const span = (chosen.length - 1) * spacing;
  if (chosen.length === 1) {
    camera.position.set(focus.x + 16, 24, -44);
    camera.lookAt(new THREE.Vector3(focus.x, 4, 2));
  } else {
    camera.position.set(0, 58, -(108 + Math.abs(span) * 0.32));
    camera.lookAt(new THREE.Vector3(0, 3, 0));
  }
}

// 街区动画/加载完成判定：街区在途 + 建筑工厂在途都为 0
(window as unknown as { __blockReady?: () => boolean }).__blockReady = () =>
  blocks.report().pendingVisuals === 0 && factory.stats().pending === 0;
(window as unknown as { __stats?: () => unknown }).__stats = () => ({
  calls: renderer.info.render.calls,
  triangles: renderer.info.render.triangles,
  textures: renderer.info.memory.textures,
});

// 报告：模板参数 + 实际覆盖
const lines = plans.map((item) => {
  const c = item.plan.coverage;
  return [
    `${item.catalog.name}（${item.catalog.id}@v${item.catalog.version}）`,
    `  标称 ${item.catalog.nominalSize}×${item.catalog.nominalSize} m，高度 ${item.catalog.heightRange.join('–')} m`,
    `  实际 ${c?.frontage ?? '?'}×${c?.depth ?? '?'} m，临街 ${c?.streetBuildings ?? 0} 栋，庭院 ${c?.courtyard ? '有' : '无'}，树 ${item.plan.trees.length}`,
    `  保留：${(c?.kept ?? []).join('；')}`,
  ].join('\n');
});
reportBox.textContent = lines.join('\n');
console.log(lines.join('\n'));

let frames = 0;
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
  if (frames > 10) {
    frameTimes.push(now - lastFrameAt);
    if (frameTimes.length > 180) frameTimes.shift();
  }
  lastFrameAt = now;
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
};
tick();

// 供自动化脚本读取帧耗时中位数（软件渲染，不代表真机）
(window as unknown as { __frameMs?: () => number }).__frameMs = () => median(frameTimes);

window.addEventListener('resize', () => {
  camera.aspect = container.clientWidth / Math.max(1, container.clientHeight);
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
});
