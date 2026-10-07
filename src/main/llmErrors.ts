/**
 * An LLM failure that retrying will not fix: missing or rejected credentials, a model the
 * account can't use, a bad region. Loops that process many items should stop on one of these
 * rather than burn their budget re-trying every item against the same broken setup.
 */
export class LlmConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LlmConfigError'
  }
}

export function isLlmConfigError(err: unknown): boolean {
  return err instanceof LlmConfigError || (err instanceof Error && err.name === 'LlmConfigError')
}
