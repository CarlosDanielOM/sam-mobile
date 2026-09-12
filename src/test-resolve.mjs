export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.startsWith('.') &&
    !specifier.endsWith('.ts') &&
    !specifier.endsWith('.js') &&
    !specifier.endsWith('.mjs') &&
    !specifier.endsWith('.json')
  ) {
    try {
      return await nextResolve(`${specifier}.ts`, context);
    } catch {
      return nextResolve(specifier, context);
    }
  }
  return nextResolve(specifier, context);
}
