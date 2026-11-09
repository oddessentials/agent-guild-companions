// The draw half of agent-guild's yard-piece-check.mjs inspect(), for a character; the Rust side checks its structure.
import * as THREE from './vendor/three.module.js';
import { CLIPS, SKELETON, playableClip, yardExtras } from './vendor/model.mjs';

const NAME = 'character.glb';
const IN_PLACE = 0.1;

export function characterProblem({ scene, animations }) {
  const bones = new Set(), skinned = [];
  let yard = null;
  scene.traverse((node) => {
    if (node.isBone) bones.add(node.name);
    if (node.isSkinnedMesh) skinned.push(node);
    if (node.userData?.yard) yard = node.userData.yard;
  });
  if (!skinned.length) return `${NAME} has no rigged mesh.`;
  scene.updateMatrixWorld(true);
  let stray = false;
  scene.traverse((node) => {
    const vertices = node.geometry?.attributes.position?.count, triangles = node.isMesh ? node.geometry.index?.array : null;
    if (triangles && !triangles.every((at) => at < vertices)) stray = true;
  });
  if (stray) return `${NAME} has a triangle that refers to a vertex it doesn’t have.`;
  let low = Infinity, high = -Infinity;
  for (const mesh of skinned) {
    const position = mesh.geometry.attributes.position, joints = mesh.geometry.attributes.skinIndex, weights = mesh.geometry.attributes.skinWeight;
    if (!position || !joints || !weights) return `${NAME} has a rigged mesh without positions or weights.`;
    for (let i = 0; i < joints.count; i++) for (let k = 0; k < joints.itemSize; k++) {
      if (weights.getComponent(i, k) > 0 && !(joints.getComponent(i, k) < mesh.skeleton.bones.length)) return `${NAME} weights a vertex to a joint it doesn’t have.`;
    }
    try {
      mesh.skeleton.update();
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
    } catch { return `${NAME} has a rigged mesh the Yard can’t draw.`; }
    if (!Number.isFinite(mesh.boundingSphere?.radius)) return `${NAME} has a rigged mesh the Yard can’t draw.`;
    const { min, max } = mesh.boundingBox, corner = new THREE.Vector3();
    for (const x of [min.x, max.x]) for (const y of [min.y, max.y]) for (const z of [min.z, max.z]) {
      corner.set(x, y, z).applyMatrix4(mesh.matrixWorld);
      low = Math.min(low, corner.y);
      high = Math.max(high, corner.y);
    }
  }
  const missingBone = SKELETON.character.find((bone) => !bones.has(bone));
  if (missingBone) return `${NAME} has no ${missingBone} bone.`;
  const clips = new Set(animations.map((clip) => clip.name));
  const missingClip = Object.values(CLIPS.character).flat().find((clip) => !clips.has(clip));
  if (missingClip) return `${NAME} has no ${missingClip} animation.`;
  for (const clip of animations) {
    if (!Number.isFinite(clip.duration) || clip.duration <= 0 || clip.duration > 60) return `${NAME} has an animation ${clip.name} that must last more than 0 and at most 60 seconds.`;
  }
  for (const clip of animations) if (!playableClip(clip)) return `${NAME} has an animation with values the Yard can’t play (${clip.name}).`;
  const height = high - low;
  const anchors = ['Root', 'Hips'].map((bone) => scene.getObjectByName(bone));
  const rest = anchors.map((bone) => bone.getWorldPosition(new THREE.Vector3()));
  const mixer = new THREE.AnimationMixer(scene), at = new THREE.Vector3();
  try {
    for (const clip of animations) for (let step = 0; step <= 16; step++) {
      mixer.stopAllAction();
      mixer.clipAction(clip).reset().play();
      mixer.setTime((clip.duration * step) / 16);
      scene.updateMatrixWorld(true);
      for (const [i, bone] of anchors.entries()) {
        bone.getWorldPosition(at);
        if (!(Math.hypot(at.x - rest[i].x, at.z - rest[i].z) <= IN_PLACE * height)) return `${NAME} has a clip that moves the character instead of playing in place (${clip.name}).`;
      }
    }
  } finally {
    mixer.stopAllAction();
    mixer.uncacheRoot(scene);
  }
  const { problem } = yardExtras(yard, 'character');
  return problem ? `${NAME} ${problem}` : null;
}

function resources(root, into) {
  root?.traverse((node) => {
    if (node.skeleton) into.add(node.skeleton);
    if (!node.isMesh) return;
    into.add(node.geometry);
    for (const material of [node.material].flat()) {
      into.add(material);
      for (const value of Object.values(material)) {
        if (!value?.isTexture) continue;
        into.add(value);
        const image = value.source?.data ?? value.image;
        if (typeof image?.close === 'function') into.add(image);
      }
    }
  });
  return into;
}

/** Frees what an added character's model holds, decoded images included, except what a model in `keep` still uses. */
export function release(root, keep = []) {
  const kept = new Set();
  for (const live of keep) resources(live, kept);
  for (const item of resources(root, new Set())) {
    if (kept.has(item)) continue;
    if (typeof item.dispose === 'function') item.dispose();
    else item.close();
  }
}

export async function loadCharacter(Loader, url) {
  const failed = [];
  const manager = new THREE.LoadingManager();
  manager.onError = (item) => failed.push(item);
  let gltf;
  try { gltf = await new Loader(manager).loadAsync(url); } catch { throw new Error(`${NAME} is damaged and can’t be drawn.`); }
  const problem = failed.length ? `${NAME} has an image that is incomplete or damaged.` : characterProblem(gltf);
  if (problem) {
    release(gltf.scene);
    throw new Error(problem);
  }
  return gltf;
}
