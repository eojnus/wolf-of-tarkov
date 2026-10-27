/**
 * 人物表现 —— 加载公开 glTF 角色、归一化尺寸、待机/行走/疾跑三态混合。
 *
 * 只负责「看起来怎么样」：位置由 Player 用代码控制，动画里不含根位移，
 * 因此不会与移动代码重复叠加。加载失败由调用方回退到灰盒占位。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLAYER } from '../content/config';

export interface CharacterRig {
  readonly root: THREE.Group;
  /**
   * dt 秒；moving 为「本帧是否真的产生了位移」，speed 为实际移动速度（米/秒），
   * sprinting 决定行走与跑步两套动作的目标权重。
   */
  update(dtSeconds: number, moving: boolean, speed: number, sprinting: boolean): void;
  dispose(): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export async function loadCharacterRig(): Promise<CharacterRig> {
  const loader = new GLTFLoader();
  const gltf = await loader.loadAsync(PLAYER.model.url);

  const model = gltf.scene;
  const clips = gltf.animations ?? [];
  const idleClip = THREE.AnimationClip.findByName(clips, PLAYER.model.idleClip);
  const walkClip = THREE.AnimationClip.findByName(clips, PLAYER.model.walkClip);
  const runClip = THREE.AnimationClip.findByName(clips, PLAYER.model.runClip);
  if (!idleClip || !walkClip || !runClip) {
    throw new Error(
      `人物模型缺少动画：${PLAYER.model.idleClip} / ${PLAYER.model.walkClip} / ${PLAYER.model.runClip}`,
    );
  }

  // 归一化：按身高缩放，脚底贴地，水平居中
  model.updateMatrixWorld(true);
  const rawBox = new THREE.Box3().setFromObject(model);
  const rawSize = rawBox.getSize(new THREE.Vector3());
  if (rawSize.y <= 0.001) throw new Error('人物模型尺寸异常');

  model.scale.setScalar(PLAYER.model.height / rawSize.y);
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const center = box.getCenter(new THREE.Vector3());
  model.position.x -= center.x;
  model.position.z -= center.z;
  model.position.y -= box.min.y;

  model.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      // 人物参与统一太阳阴影；脚下的贴地圆片仍保留，夜里没有太阳投影时人物不至于「浮」在地上
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
    }
  });

  const root = new THREE.Group();
  const inner = new THREE.Group();
  inner.rotation.y = PLAYER.model.yawOffset;
  inner.add(model);
  root.add(inner);

  const mixer = new THREE.AnimationMixer(model);
  const idleAction = mixer.clipAction(idleClip);
  const walkAction = mixer.clipAction(walkClip);
  const runAction = mixer.clipAction(runClip);
  // 三个动作始终播放，只靠权重混合；不做 reset，避免切换时动作跳帧
  idleAction.setEffectiveWeight(1);
  walkAction.setEffectiveWeight(0);
  runAction.setEffectiveWeight(0);
  idleAction.play();
  walkAction.play();
  runAction.play();

  let weightIdle = 1;
  let weightWalk = 0;
  let weightRun = 0;

  return {
    root,
    update(dtSeconds, moving, speed, sprinting) {
      if (dtSeconds <= 0) return;

      const targetIdle = moving ? 0 : 1;
      const targetWalk = moving && !sprinting ? 1 : 0;
      const targetRun = moving && sprinting ? 1 : 0;

      // 指数趋近，帧率无关
      const blend = 1 - Math.exp((-dtSeconds * 3.2) / Math.max(0.05, PLAYER.model.fadeSeconds));
      weightIdle += (targetIdle - weightIdle) * blend;
      weightWalk += (targetWalk - weightWalk) * blend;
      weightRun += (targetRun - weightRun) * blend;

      // 归一化，保证三者权重和始终为 1，不会出现「总权重 < 1 导致动作变慢」
      const sum = weightIdle + weightWalk + weightRun;
      const idleWeight = sum > 0.0001 ? weightIdle / sum : 1;
      const walkWeight = sum > 0.0001 ? weightWalk / sum : 0;
      const runWeight = sum > 0.0001 ? weightRun / sum : 0;

      idleAction.setEffectiveWeight(idleWeight);
      walkAction.setEffectiveWeight(walkWeight);
      runAction.setEffectiveWeight(runWeight);

      if (moving) {
        // 两套动作各按自己的参考速度换算播放倍率，避免滑步
        walkAction.setEffectiveTimeScale(
          clamp(
            speed / PLAYER.model.walkReferenceSpeed,
            PLAYER.model.minTimeScale,
            PLAYER.model.maxTimeScale,
          ),
        );
        runAction.setEffectiveTimeScale(
          clamp(
            speed / PLAYER.model.runReferenceSpeed,
            PLAYER.model.minTimeScale,
            PLAYER.model.maxTimeScale,
          ),
        );
      }

      mixer.update(dtSeconds);
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(model);
      model.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) {
          for (const item of material) item.dispose();
        } else if (material) {
          material.dispose();
        }
      });
    },
  };
}
