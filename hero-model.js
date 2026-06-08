import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const canvas = document.querySelector("#heroModel");
const cover = canvas?.closest(".hero-cover");

if (canvas && cover) {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });

  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  scene.add(new THREE.HemisphereLight(0xcffbff, 0x25152f, 2.4));

  const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
  keyLight.position.set(4, 6, 5);
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0x67e8f9, 2.6);
  rimLight.position.set(-5, 2, -3);
  scene.add(rimLight);

  const fillLight = new THREE.PointLight(0xfb7185, 2.2, 8);
  fillLight.position.set(-2.5, -1, 3);
  scene.add(fillLight);

  let model;
  let mixer;
  const clock = new THREE.Clock();
  let frameId = 0;

  const resize = () => {
    const { width, height } = cover.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const fitModel = (object) => {
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxAxis = Math.max(size.x, size.y, size.z) || 1;

    object.position.sub(center);
    object.scale.setScalar(2.72 / maxAxis);
    object.position.x -= 0.12;
    object.position.y -= 0.24;
    object.rotation.set(-0.04, -0.18, 0.04);

    camera.position.set(0.04, 0.1, 4.35);
    camera.lookAt(-0.06, -0.1, 0);
  };

  const animate = () => {
    frameId = requestAnimationFrame(animate);
    const delta = clock.getDelta();
    if (mixer) mixer.update(delta);
    if (model) {
      model.rotation.z = 0.04 + Math.sin(performance.now() * 0.0012) * 0.015;
    }
    renderer.render(scene, camera);
  };

  const loader = new GLTFLoader();
  loader.load(
    "model/source/Guitar%20(1).glb",
    (gltf) => {
      model = gltf.scene;
      model.traverse((node) => {
        if (!node.isMesh) return;
        node.castShadow = true;
        node.receiveShadow = true;
        if (node.material) {
          node.material.envMapIntensity = 1.1;
          node.material.needsUpdate = true;
        }
      });
      fitModel(model);
      if (gltf.animations.length) {
        const clip = gltf.animations.reduce((longest, candidate) => (candidate.duration > longest.duration ? candidate : longest), gltf.animations[0]);
        mixer = new THREE.AnimationMixer(model);
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat);
        action.play();
      }
      scene.add(model);
      resize();
      animate();
    },
    undefined,
    () => {
      cover.classList.add("model-error");
    },
  );

  const observer = new ResizeObserver(resize);
  observer.observe(cover);
  window.addEventListener("beforeunload", () => {
    cancelAnimationFrame(frameId);
    observer.disconnect();
    renderer.dispose();
  });
}
