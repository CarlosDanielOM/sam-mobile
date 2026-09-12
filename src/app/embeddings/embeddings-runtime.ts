import { getEmbeddingsEnvironment } from '../../core/embeddings/android';
import { EmbeddingsLabController, type LabState } from '../../core/embeddings/lab';
import type { EmbeddingsEnvironment } from '../../core/embeddings/types';

interface EmbeddingsLabRuntime {
  environment: EmbeddingsEnvironment;
  controller: EmbeddingsLabController;
  subscribe(listener: (state: LabState) => void): () => void;
}

// Warm UI rebootstrap replaces Angular roots, not this module or its native environment.
let runtime: EmbeddingsLabRuntime | null = null;

export function obtainEmbeddingsLabRuntime(): EmbeddingsLabRuntime {
  if (runtime) return runtime;
  const environment = getEmbeddingsEnvironment();
  const listeners = new Set<(state: LabState) => void>();
  const controller = new EmbeddingsLabController(environment, state => {
    for (const listener of listeners) listener(state);
  });
  runtime = {
    environment, controller,
    subscribe(listener) {
      listener(controller.state);
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return runtime;
}
