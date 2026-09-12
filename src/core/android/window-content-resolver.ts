export function createWarmWindowContentResolver<TRequest, TRoot>(
  relaunch: (request: TRequest) => TRoot | null | undefined,
): (request: TRequest) => TRoot | null | undefined {
  let resolvedOnce = false;
  return (request) => {
    if (!resolvedOnce) {
      resolvedOnce = true;
      return undefined;
    }
    return relaunch(request) ?? null;
  };
}
