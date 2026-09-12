import { GenerationController } from './controller';
import type { GenerationControllerDeps } from './types';

let controller: GenerationController | null = null;
let streamSimple: GenerationControllerDeps['streamSimple'] | null = null;

export function obtainGenerationRuntime(deps: GenerationControllerDeps): GenerationController {
  streamSimple = deps.streamSimple;
  if (controller) {
    console.log('SAM-LIFECYCLE generation-runtime reuse');
    return controller;
  }
  console.log('SAM-LIFECYCLE generation-runtime create');
  controller = new GenerationController({
    ...deps,
    streamSimple: (model, context, options) => streamSimple!(model, context, options),
  });
  controller.recoverOrphans();
  deps.foreground.setCancelHandler((generationId) => {
    if (generationId) controller?.cancel(generationId);
  });
  return controller;
}

export function resetGenerationRuntimeForTests(): void {
  controller = null;
  streamSimple = null;
}
