import OpenAI from 'openai'
import { getBedrockConfig, getBedrockCredentials, getLlmConfig, getLlmProvider } from './settings'
import { converse, listInferenceProfiles, type ConverseDocument } from './bedrock'
import { LlmConfigError } from './llmErrors'

/**
 * Every LLM call in the app comes through here, so the provider switch lives here too. Callers
 * see one `complete(system, user)`; whether that is an OpenAI-compatible endpoint (Groq, Google
 * AI Studio, …) or Amazon Bedrock is a Settings choice.
 */

function getOpenAiClient(): { client: OpenAI; model: string } {
  const { baseUrl, model, apiKey } = getLlmConfig()
  if (!apiKey) {
    throw new LlmConfigError('No API key set. Add one in Settings (Groq and Google AI Studio both have free tiers).')
  }
  return { client: new OpenAI({ apiKey, baseURL: baseUrl, timeout: 90_000, maxRetries: 1 }), model }
}

async function completeOpenAi(system: string, user: string): Promise<string> {
  const { client, model } = getOpenAiClient()
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  })
  return response.choices[0]?.message?.content?.trim() ?? ''
}

async function completeBedrock(system: string, user: string, documents?: ConverseDocument[]): Promise<string> {
  const credentials = getBedrockCredentials()
  if (!credentials) throw new LlmConfigError('No AWS credentials set. Add an access key pair under Settings → AWS Bedrock.')
  const { region, model } = getBedrockConfig()
  const r = await converse({ region, model, system, user, credentials, documents })
  return r.text
}

export async function complete(system: string, user: string): Promise<string> {
  return getLlmProvider() === 'bedrock' ? completeBedrock(system, user) : completeOpenAi(system, user)
}

/**
 * Like `complete`, with a file attached. Only Bedrock (Claude) reads documents natively; on the
 * OpenAI-compatible path the caller should fall back to pasted text.
 */
export async function completeWithDocument(system: string, user: string, document: ConverseDocument): Promise<string> {
  if (getLlmProvider() !== 'bedrock') {
    throw new LlmConfigError('Reading a PDF needs AWS Bedrock as the AI provider. Paste the syllabus text instead, or switch provider in Settings.')
  }
  return completeBedrock(system, user, [document])
}

const NON_CHAT_PATTERNS = /whisper|orpheus|guard|tts|safeguard|embed/i

/** Live chat-capable model IDs available to the configured provider. */
export async function listModels(): Promise<string[]> {
  if (getLlmProvider() === 'bedrock') {
    const credentials = getBedrockCredentials()
    if (!credentials) throw new LlmConfigError('No AWS credentials set.')
    return listInferenceProfiles(getBedrockConfig().region, credentials)
  }
  const { client } = getOpenAiClient()
  const models = await client.models.list()
  return models.data
    .map((m) => m.id)
    .filter((id) => !NON_CHAT_PATTERNS.test(id))
    .sort()
}

/** Ask for JSON and parse it, tolerating markdown fences and leading prose. */
export async function completeJson<T>(system: string, user: string): Promise<T> {
  return parseJsonReply<T>(await complete(system, user))
}

export async function completeJsonWithDocument<T>(system: string, user: string, document: ConverseDocument): Promise<T> {
  return parseJsonReply<T>(await completeWithDocument(system, user, document))
}

function parseJsonReply<T>(raw: string): T {
  let text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
  // Some models prepend commentary; slice from the first { or [ to be safe.
  const start = Math.min(
    ...['{', '['].map((c) => {
      const i = text.indexOf(c)
      return i === -1 ? Number.MAX_SAFE_INTEGER : i
    })
  )
  if (start !== Number.MAX_SAFE_INTEGER && start > 0) text = text.slice(start)
  try {
    return JSON.parse(text) as T
  } catch {
    // …or append notes after it ("Note: I left c null because…"). Cut at the last closing bracket.
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'))
    if (end > 0) {
      try {
        return JSON.parse(text.slice(0, end + 1)) as T
      } catch {
        /* fall through to the original error */
      }
    }
    throw new Error(`Model returned invalid JSON. First 300 chars:\n${raw.slice(0, 300)}`)
  }
}

/** Exported for scripts that call the model through their own transport. */
export const parseModelJson = parseJsonReply
