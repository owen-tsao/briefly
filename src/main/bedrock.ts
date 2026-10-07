import { signRequest, type AwsCredentials } from './aws/sigv4'
import { LlmConfigError } from './llmErrors'

/**
 * Amazon Bedrock over plain HTTPS: the Converse API for completions and the control-plane
 * inference-profile list for the model picker. No AWS SDK; requests are signed in-process.
 *
 * The credentials passed in are used for one request and dropped. Errors are rewritten before
 * they leave this module so that neither the signature nor the request body can end up in a
 * log line or an IPC reply.
 */

/** AWS region IDs look like `us-east-1`; anything else is refused before it can become a hostname. */
const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/

const DEFAULT_REGION = 'us-east-1'
const TIMEOUT_MS = 90_000

export function validRegion(region: string): boolean {
  return REGION_RE.test(region)
}

function regionOrThrow(region: string): string {
  const r = (region || DEFAULT_REGION).trim()
  if (!validRegion(r)) throw new LlmConfigError('Bedrock region must look like us-east-1.')
  return r
}

async function signedFetch(opts: {
  method: 'GET' | 'POST'
  url: URL
  region: string
  service: 'bedrock'
  body: string
  credentials: AwsCredentials
}): Promise<Response> {
  const headers = signRequest({
    method: opts.method,
    url: opts.url,
    region: opts.region,
    service: opts.service,
    headers: { accept: 'application/json', ...(opts.body ? { 'content-type': 'application/json' } : {}) },
    body: opts.body,
    credentials: opts.credentials
  })
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    return await fetch(opts.url, { method: opts.method, headers, body: opts.body || undefined, signal: controller.signal })
  } catch (err) {
    throw new Error(`Could not reach Bedrock in ${opts.region}: ${err instanceof Error && err.name === 'AbortError' ? 'timed out' : 'network error'}`)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Turn an AWS error reply into something safe and useful to show. AWS bodies are short JSON
 * (`{"message": "..."}`); they never echo the request, but we still cap and classify them.
 * Setup problems (credentials, permissions, model, region, clock) come back as LlmConfigError so
 * batch loops stop instead of retrying; throttling, 5xx and odd 400s stay plain errors.
 */
async function describeFailure(res: Response, model?: string): Promise<Error> {
  let message = ''
  try {
    const j = (await res.json()) as { message?: string; Message?: string }
    message = (j.message ?? j.Message ?? '').slice(0, 240)
  } catch {
    /* non-JSON body: fall through to the status */
  }
  const low = message.toLowerCase()
  if (res.status === 403) {
    if (/not authorized to perform/.test(low)) {
      // IAM's message names the user ARN (with account ID); keep only the action it lacks.
      const action = message.match(/bedrock:[A-Za-z]+/)?.[0] ?? 'a Bedrock action'
      return new LlmConfigError(`This key isn't allowed to call ${action}. Ask for a policy that permits it.`)
    }
    if (/expired|not yet current|skew|too far/.test(low)) {
      const serverDate = res.headers.get('date')
      const off = serverDate ? Math.round(Math.abs(Date.parse(serverDate) - Date.now()) / 60_000) : null
      return new LlmConfigError(
        `This Mac's clock is ${off ? `about ${off} min` : 'more than 5 min'} off from AWS; fix Date & Time and try again.`
      )
    }
    if (/not available for this account|access denied|use case/.test(low)) {
      return new LlmConfigError(`Model access isn't enabled for ${model ?? 'this model'} in this AWS account.`)
    }
    return new LlmConfigError('Bedrock rejected the access key or secret. Check both values (and that the key is active).')
  }
  if (res.status === 400 && /on-demand throughput/.test(low)) {
    return new LlmConfigError(`${model ?? 'This model'} needs its inference-profile ID (usually prefixed "us." or "global.").`)
  }
  if (res.status === 404 || /could not resolve the foundation model|does not exist|model identifier is invalid/.test(low)) {
    return new LlmConfigError(`Bedrock doesn't know the model "${model ?? ''}" in this region.`)
  }
  if (res.status === 429) return new Error('Bedrock is throttling requests; try again in a moment.')
  return new Error(`Bedrock returned HTTP ${res.status}${message ? `: ${message}` : ''}`)
}

export interface ConverseDocument {
  /** Shown to the model; letters, digits, spaces, hyphens only (Bedrock's rule). */
  name: string
  format: 'pdf' | 'txt' | 'md' | 'html'
  bytes: Buffer
}

/** Bedrock's per-document cap is 4.5 MB; stay under it with a little room. */
export const MAX_DOCUMENT_BYTES = 4_400_000

export interface ConverseInput {
  region: string
  model: string
  system: string
  user: string
  maxTokens?: number
  temperature?: number
  credentials: AwsCredentials
  /** Attached to the user turn ahead of the text; lets Claude read PDFs natively. */
  documents?: ConverseDocument[]
}

interface ConverseReply {
  output?: { message?: { content?: { text?: string }[] } }
  usage?: { inputTokens?: number; outputTokens?: number }
  stopReason?: string
}

/** One system + one user turn in, the assistant text out. */
export async function converse(input: ConverseInput): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const region = regionOrThrow(input.region)
  const model = input.model.trim()
  if (!model || !/^[\w.:/-]+$/.test(model)) throw new LlmConfigError('Bedrock model ID is missing or malformed.')
  const url = new URL(`https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`)
  const docBlocks = (input.documents ?? []).map((d) => {
    if (d.bytes.byteLength > MAX_DOCUMENT_BYTES) throw new LlmConfigError(`${d.name} is too large for Bedrock (max 4.5 MB).`)
    return {
      document: {
        name: d.name.replace(/[^A-Za-z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'document',
        format: d.format,
        source: { bytes: d.bytes.toString('base64') }
      }
    }
  })
  const body = JSON.stringify({
    system: [{ text: input.system }],
    messages: [{ role: 'user', content: [...docBlocks, { text: input.user }] }],
    inferenceConfig: { maxTokens: input.maxTokens ?? 8192, temperature: input.temperature ?? 0.2 }
  })
  const res = await signedFetch({ method: 'POST', url, region, service: 'bedrock', body, credentials: input.credentials })
  if (!res.ok) throw await describeFailure(res, model)
  const reply = (await res.json()) as ConverseReply
  const text = (reply.output?.message?.content ?? []).map((c) => c.text ?? '').join('').trim()
  if (!text) throw new Error(`Bedrock returned an empty reply (stop reason: ${reply.stopReason ?? 'unknown'}).`)
  return { text, inputTokens: reply.usage?.inputTokens ?? 0, outputTokens: reply.usage?.outputTokens ?? 0 }
}

interface ProfilesReply {
  inferenceProfileSummaries?: { inferenceProfileId?: string; inferenceProfileName?: string; status?: string }[]
}

/**
 * Inference profiles are the IDs on-demand Converse accepts for current Anthropic models
 * (`us.anthropic.claude-…`). Lists every active profile the key can see; text-capable
 * filtering happens by name since the list API doesn't carry modalities.
 */
export async function listInferenceProfiles(region: string, credentials: AwsCredentials): Promise<string[]> {
  const r = regionOrThrow(region)
  // Query strings are outside the signer's scope, so this takes the first page only. A region
  // has a few dozen profiles today, well under the page size.
  const url = new URL(`https://bedrock.${r}.amazonaws.com/inference-profiles`)
  const res = await signedFetch({ method: 'GET', url, region: r, service: 'bedrock', body: '', credentials })
  if (!res.ok) throw await describeFailure(res)
  const reply = (await res.json()) as ProfilesReply
  const ids = (reply.inferenceProfileSummaries ?? [])
    .filter((p) => p.inferenceProfileId && p.status !== 'INACTIVE')
    .map((p) => p.inferenceProfileId as string)
    .filter((id) => !/embed|rerank|image|video|tts|canvas|nova-sonic|nova-reel/i.test(id))
  return [...new Set(ids)].sort()
}

/** Cheapest possible round trip for the Settings "Test" button. */
export async function testConnection(region: string, model: string, credentials: AwsCredentials): Promise<{ ms: number; tokens: number }> {
  const t0 = Date.now()
  const r = await converse({ region, model, system: 'Reply with the single word: ok', user: 'ok?', maxTokens: 5, temperature: 0, credentials })
  return { ms: Date.now() - t0, tokens: r.inputTokens + r.outputTokens }
}
