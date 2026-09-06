// when_to_use: Third-person character locomotion for Three.js.
// Thin re-export of createTpsController from fps-controller — keep a dedicated
// skill file so recommend-skills / import_skill can target TPS without pulling
// the FPS guide prose. Seed into src/engine/tps-controller.jsx and CALL it.
//
// S8 — separate TPS skill when only the combined FPS file existed.

export { createFpsController, createTpsController } from './fps-controller.jsx';
