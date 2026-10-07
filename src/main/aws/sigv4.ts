import { createHash, createHmac } from 'node:crypto'

/**
 * AWS Signature Version 4 for a single HTTPS request, implemented on node:crypto so the secret
 * key never leaves this process or enters a third-party dependency tree.
 *
 * Scope is deliberately narrow: one request, one region, one service, JSON body, no query
 * string, no session token. That is all Bedrock Converse needs. The algorithm is the one in the
 * AWS General Reference, "Create a signed AWS API request".
 */

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
}

export interface SignInput {
  method: 'GET' | 'POST'
  /** Fully-formed URL. Path segments must already be percent-encoded as they will be sent. */
  url: URL
  region: string
  service: string
  headers: Record<string, string>
  body: string
  credentials: AwsCredentials
  /** Injected for tests; defaults to now. */
  now?: Date
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/**
 * SigV4 wants each path segment encoded once per RFC 3986 and then the whole path encoded a
 * second time for the canonical URI — except for S3, which Bedrock is not. Bedrock model IDs
 * contain ':' so this matters: the request path carries `%3A` and the canonical path `%253A`.
 */
function canonicalUri(url: URL): string {
  return url.pathname
    .split('/')
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/')
}

function amzDate(d: Date): { dateTime: string; date: string } {
  const iso = d.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { dateTime: iso, date: iso.slice(0, 8) }
}

/** Returns the headers to send, including Authorization, X-Amz-Date and X-Amz-Content-Sha256. */
export function signRequest(input: SignInput): Record<string, string> {
  const { dateTime, date } = amzDate(input.now ?? new Date())
  const payloadHash = sha256Hex(input.body)

  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.headers)) headers[k.toLowerCase()] = v
  headers['host'] = input.url.host
  headers['x-amz-date'] = dateTime
  headers['x-amz-content-sha256'] = payloadHash

  const sortedNames = Object.keys(headers).sort()
  const canonicalHeaders = sortedNames.map((name) => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join('')
  const signedHeaders = sortedNames.join(';')

  const canonicalRequest = [
    input.method,
    canonicalUri(input.url),
    '', // no query string
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n')

  const scope = `${date}/${input.region}/${input.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', dateTime, scope, sha256Hex(canonicalRequest)].join('\n')

  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, date)
  const kRegion = hmac(kDate, input.region)
  const kService = hmac(kRegion, input.service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = hmac(kSigning, stringToSign).toString('hex')

  const authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  // Return only what the request needs; never the signing key or the string-to-sign. `host` is
  // set by fetch itself, so it is signed but not returned.
  const out: Record<string, string> = {}
  for (const name of sortedNames) if (name !== 'host') out[name] = headers[name]
  out['authorization'] = authorization
  return out
}
