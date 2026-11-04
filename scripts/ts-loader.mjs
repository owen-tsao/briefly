/**
 * Resolve extensionless imports to .ts so Node's test runner can load the same
 * modules electron-vite bundles. Type stripping is enabled by the node flag.
 */
export async function resolve(specifier, context, nextResolve) {
  if (
    (specifier.startsWith('.') || specifier.startsWith('/')) &&
    !/\.(ts|js|mjs|cjs|json|node)$/.test(specifier)
  ) {
    try {
      return await nextResolve(specifier + '.ts', context)
    } catch {
      /* fall through to the default error */
    }
  }
  return nextResolve(specifier, context)
}
