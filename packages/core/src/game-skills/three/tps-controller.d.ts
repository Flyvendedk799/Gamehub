/**
 * `tps-controller` is a thin re-export of the FPS controller in third-person
 * mode. Types mirror that re-export so a `.jsx` import type-checks without
 * enabling `jsx`/`allowJs`. See `fps-controller.d.ts`.
 */
export type {
  CameraMode,
  FpsController,
  FpsControllerOptions,
  FpsState,
  FpsStepInput,
  Vec3,
} from './fps-controller.js';
export { createFpsController, createTpsController } from './fps-controller.js';
