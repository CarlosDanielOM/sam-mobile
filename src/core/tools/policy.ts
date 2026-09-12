import type { PolicyDecision, PolicyEngine } from './types';

export class DenyAllPolicy implements PolicyEngine {
  authorize(): PolicyDecision {
    return { kind: 'deny', reason: 'No tool execution policy has been configured' };
  }
}

/** Explicit opt-in for tests/development only. Never installed implicitly. */
export class AllowAllPolicy implements PolicyEngine {
  authorize(): PolicyDecision {
    return { kind: 'allow' };
  }
}
