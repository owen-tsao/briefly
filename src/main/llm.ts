import OpenAI from 'openai'
import { getLlmConfig } from './settings'

function getClient(): { client: OpenAI; model: string } {
  const { baseUrl, model, apiKey } = getLlmConfig()
  if (!apiKey) {
    throw new Error('No API key set. Add your Groq API key in Settings (free at console.groq.com).')
  }
  return { client: new OpenAI({ apiKey, baseURL: baseUrl, timeout: 90_000, maxRetries: 1 }), model }
}

export async function complete(system: string, user: string): Promise<string> {
  const { client, model } = getClient()
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  })
  return response.choices[0]?.message?.content?.trim() ?? ''
}

const NON_CHAT_PATTERNS = /whisper|orpheus|guard|tts|safeguard|embed/i

/** Live chat-capable model IDs available to the configured key. */
export async function listModels(): Promise<string[]> {
  const { client } = getClient()
  const models = await client.models.list()
  return models.data
    .map((m) => m.id)
    .filter((id) => !NON_CHAT_PATTERNS.test(id))
    .sort()
}

/** Ask for JSON and parse it, tolerating markdown fences and leading prose. */
export async function completeJson<T>(system: string, user: string): Promise<T> {
  const raw = await complete(system, user)
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
    throw new Error(`Model returned invalid JSON. First 300 chars:\n${raw.slice(0, 300)}`)
  }
}
