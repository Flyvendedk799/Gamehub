import type { Engine } from './types';

/** Display label for an engine, in the identity board's mono-chip voice
 *  ("PHASER 2D", "THREE.JS 3D"). One place so chips can't drift per surface. */
export function engineLabel(engine: Engine | string | null | undefined): string {
  switch (engine) {
    case 'phaser':
      return 'PHASER 2D';
    case 'threejs':
    case 'three':
      return 'THREE.JS 3D';
    case 'vanilla':
    case 'canvas2d':
      return 'CANVAS 2D';
    default:
      return typeof engine === 'string' && engine.length > 0 ? engine.toUpperCase() : 'UNKNOWN';
  }
}
