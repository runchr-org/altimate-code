import z from "zod"
import { Tool } from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { abortAfterAny } from "../util/abort"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes
// altimate_change start — branding: honest bot UA
const HONEST_UA = "altimate-code/1.0 (+https://github.com/AltimateAI/altimate-code)"
// altimate_change end
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
// Status codes that warrant a retry with a different User-Agent
const RETRYABLE_STATUSES = new Set([403, 406])

// altimate_change start — session-level URL failure cache (#471)
// Prevents repeated fetches to URLs that already returned 404/410 in this session.
//
// 2026-05-22 follow-up to telemetry-2026-05-21 (486 residual webfetch 404s,
// down from March's 2,222 but still meaningful):
//   - Extended TTL from 5 min to 30 min. URLs that 404 rarely self-heal
//     within a session, and many sessions run longer than 5 min so the
//     short window was letting agents re-hit the same dead URL multiple
//     times in one session.
//   - Cache key is the URL with tracking-only params (utm_*, ref, fbclid,
//     gclid, mc_*, _ga, _gl, igshid, mibextid, __cf_chl_*) stripped, so
//     LLM-generated tracking variations of a known-bad URL all hit cache.
//     Functional query params (page, id, q, etc.) are preserved.
const failedUrls = new Map<string, { status: number; timestamp: number }>()
const FAILURE_CACHE_TTL = 30 * 60 * 1000 // 30 minutes

/**
 * Param names that are universally tracking-only — stripping them never
 * changes the document the URL points to. Conservative list; favoured over
 * a regex sweep because false positives (e.g. stripping `?page=2`) would
 * cause real fetches to incorrectly hit the cache.
 */
// Notable exclusions (do NOT add these to TRACKING_PARAMS):
//   - `ref` / `ref_src` / `ref_url`: functional on GitHub raw URLs and
//     git-hosting APIs (`?ref=main` vs `?ref=v2.0` selects a different
//     branch/tag). Stripping `ref` would suppress legitimate fetches of
//     different refs against the same path — a coding agent fetches GitHub
//     heavily, so this is a real false-positive risk.
//   - `referrer` (full word) is tracking-only and IS in the list; the
//     abbreviated `ref` is not.
//
// The utm_* family is enumerated explicitly here AND covered by the
// `isTrackingParamPrefix` check below. The duplication is intentional —
// the explicit list documents the named params we know about, the prefix
// check catches any future utm_* variant we haven't enumerated.
// Cloudflare challenge tokens (`__cf_chl_*`) are handled by the prefix
// check exclusively; no explicit entries needed.
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "referrer",
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "yclid",
  "twclid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "igshid",
  "mibextid",
  "vero_conv",
  "vero_id",
  // HubSpot
  "_hsenc",
  "_hsmi",
  "hsCtaTracking",
  // Marketo
  "mkt_tok",
  // Adobe Analytics / SiteCatalyst
  "s_cid",
  "s_kwcid",
  // Piwik / Matomo
  "pk_campaign",
  "pk_kwd",
  "pk_source",
  "pk_medium",
  "pk_content",
  "piwik_campaign",
  "piwik_keyword",
])

function isTrackingParamPrefix(name: string): boolean {
  return name.startsWith("__cf_chl_") || name.startsWith("utm_")
}

/**
 * Normalize a URL for cache lookup. Strips tracking-only query params, sorts
 * the remaining params for stable ordering, and lowercases the host. Returns
 * the input unchanged if URL parsing fails.
 */
export function normalizeUrlForCache(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hostname = parsed.hostname.toLowerCase()
    // Strip userinfo (basic-auth `user:pass@`) — it doesn't change the
    // resource the URL points to, and leaving it in lets the same logical
    // URL with/without credentials occupy two cache slots. Also a minor
    // hygiene win for cache keys that get logged in telemetry.
    parsed.username = ""
    parsed.password = ""
    const kept: [string, string][] = []
    for (const [k, v] of parsed.searchParams) {
      if (TRACKING_PARAMS.has(k) || isTrackingParamPrefix(k)) continue
      kept.push([k, v])
    }
    // Sort by (key, value) so duplicate-key params produce a stable order:
    // `?a=1&a=2` and `?a=2&a=1` normalize to the same string. Sorting by key
    // alone leaked the original insertion order between same-key entries.
    kept.sort(([ak, av], [bk, bv]) => {
      if (ak !== bk) return ak < bk ? -1 : 1
      return av < bv ? -1 : av > bv ? 1 : 0
    })
    parsed.search = ""
    for (const [k, v] of kept) parsed.searchParams.append(k, v)
    // Also strip fragment — fragments don't change the fetched resource.
    parsed.hash = ""
    return parsed.toString()
  } catch {
    return url
  }
}

function isUrlCachedFailure(url: string): { status: number } | null {
  const key = normalizeUrlForCache(url)
  const entry = failedUrls.get(key)
  if (!entry) return null
  if (Date.now() - entry.timestamp > FAILURE_CACHE_TTL) {
    failedUrls.delete(key)
    return null
  }
  return { status: entry.status }
}

const MAX_CACHED_URLS = 500

function cacheUrlFailure(url: string, status: number): void {
  // 404 (permanent), 410 (gone), and 451 (legal block) get the same TTL
  // here intentionally. 410 is spec-permanent (won't lift), 404 is
  // overwhelmingly permanent in practice (typos, removed docs), and 451
  // can lift but rarely within a single session. Caching all three at
  // 30 min is a deliberate simplification — split TTLs would be marginal
  // complexity for marginal benefit.
  if (status === 404 || status === 410 || status === 451) {
    const key = normalizeUrlForCache(url)
    // Re-touch semantics: if the key is already in the cache, delete first
    // so the .set() reinserts at the tail of the FIFO. Otherwise a
    // frequently-failing URL would stay at the head and be the first
    // evicted under pressure — wrong order for an LRU-flavoured cache.
    if (failedUrls.has(key)) failedUrls.delete(key)
    if (failedUrls.size >= MAX_CACHED_URLS) {
      // Evict oldest entry (Map preserves insertion order)
      const oldest = failedUrls.keys().next().value
      if (oldest) failedUrls.delete(oldest)
    }
    failedUrls.set(key, { status, timestamp: Date.now() })
  }
}

/**
 * Reset the failure cache.
 * @internal — only used by tests; do not call from production code.
 */
export function _resetFailureCache(): void {
  failedUrls.clear()
}

/**
 * Read the current failure cache size.
 * @internal — only used by tests; do not call from production code.
 */
export function _failureCacheSize(): number {
  return failedUrls.size
}

/** Strip query string from URL to avoid leaking auth tokens in error messages. */
function sanitizeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.origin + parsed.pathname
  } catch {
    return url.split("?")[0]
  }
}

/** Build an actionable error message so the model knows whether to retry. */
function buildFetchError(url: string, status: number, headers?: Headers): string {
  const safe = sanitizeUrl(url)
  switch (status) {
    case 404:
      return `HTTP 404: ${safe} does not exist. Do NOT retry this URL — it will fail again. Try a different URL or search for the correct page.`
    case 410:
      return `HTTP 410: ${safe} has been permanently removed. Do NOT retry. Find an alternative resource.`
    case 403:
      return `HTTP 403: Access to ${safe} is forbidden. The server rejected both bot and browser User-Agents. Try a different source.`
    case 429: {
      const retryAfter = headers?.get("retry-after")
      const wait = retryAfter ? ` (retry after ${retryAfter})` : ""
      return `HTTP 429: Rate limited by ${new URL(url).hostname}${wait}. Wait before fetching from this domain again, or use a different source.`
    }
    case 451:
      return `HTTP 451: ${safe} is unavailable for legal reasons. Do NOT retry.`
    default:
      return `HTTP ${status}: Request to ${safe} failed. This may be transient — retry once if needed.`
  }
}
// altimate_change end

export const WebFetchTool = Tool.define("webfetch", {
  description: DESCRIPTION,
  parameters: z.object({
    url: z.string().describe("The URL to fetch content from"),
    format: z
      .enum(["text", "markdown", "html"])
      .default("markdown")
      .describe("The format to return the content in (text, markdown, or html). Defaults to markdown."),
    timeout: z.number().describe("Optional timeout in seconds (max 120)").optional(),
  }),
  async execute(params, ctx) {
    // altimate_change start — URL validation and failure cache (#471)
    if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://")
    }
    try {
      new URL(params.url)
    } catch {
      throw new Error(`Invalid URL: "${params.url.slice(0, 200)}" is not a valid URL. Check the format and try again.`)
    }

    // Check failure cache — avoid re-fetching URLs that already returned 404/410
    const cached = isUrlCachedFailure(params.url)
    if (cached) {
      throw new Error(buildFetchError(params.url, cached.status))
    }
    // altimate_change end

    await ctx.ask({
      permission: "webfetch",
      patterns: [params.url],
      always: ["*"],
      metadata: {
        url: params.url,
        format: params.format,
        timeout: params.timeout,
      },
    })

    const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

    const { signal, clearTimeout } = abortAfterAny(timeout, ctx.abort)

    // Build Accept header based on requested format with q parameters for fallbacks
    let acceptHeader = "*/*"
    switch (params.format) {
      case "markdown":
        acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
        break
      case "text":
        acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
        break
      case "html":
        acceptHeader = "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
        break
      default:
        acceptHeader =
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
    }
    const baseHeaders = {
      Accept: acceptHeader,
      "Accept-Language": "en-US,en;q=0.9",
    }

    // Strategy: honest bot UA first, browser UA as fallback.
    // Many sites block spoofed browser UAs (TLS fingerprint mismatch) but allow known bots.
    const honestHeaders = { ...baseHeaders, "User-Agent": HONEST_UA }
    const browserHeaders = { ...baseHeaders, "User-Agent": BROWSER_UA }

    let arrayBuffer: ArrayBuffer
    let response: Response
    try {
      response = await fetch(params.url, { signal, headers: honestHeaders })

      // Retry with browser UA if the honest UA was rejected
      if (!response.ok && RETRYABLE_STATUSES.has(response.status)) {
        await response.body?.cancel().catch(() => {})
        response = await fetch(params.url, { signal, headers: browserHeaders })
      }

      // altimate_change start — actionable error messages and failure caching (#471)
      if (!response.ok) {
        cacheUrlFailure(params.url, response.status)
        throw new Error(buildFetchError(params.url, response.status, response.headers))
      }
      // altimate_change end

      // Check content length
      const contentLength = response.headers.get("content-length")
      if (contentLength && parseInt(contentLength) > MAX_RESPONSE_SIZE) {
        throw new Error("Response too large (exceeds 5MB limit)")
      }

      arrayBuffer = await response.arrayBuffer()
      if (arrayBuffer.byteLength > MAX_RESPONSE_SIZE) {
        throw new Error("Response too large (exceeds 5MB limit)")
      }
    } finally {
      clearTimeout()
    }

    const contentType = response.headers.get("content-type") || ""
    const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
    const title = `${params.url} (${contentType})`

    // Check if response is an image
    const isImage = mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"

    if (isImage) {
      const base64Content = Buffer.from(arrayBuffer).toString("base64")
      return {
        title,
        output: "Image fetched successfully",
        metadata: {},
        attachments: [
          {
            type: "file",
            mime,
            url: `data:${mime};base64,${base64Content}`,
          },
        ],
      }
    }

    const content = new TextDecoder().decode(arrayBuffer)

    // Handle content based on requested format and actual content type
    switch (params.format) {
      case "markdown":
        if (contentType.includes("text/html")) {
          const markdown = convertHTMLToMarkdown(content)
          return {
            output: markdown,
            title,
            metadata: {},
          }
        }
        return {
          output: content,
          title,
          metadata: {},
        }

      case "text":
        if (contentType.includes("text/html")) {
          const text = await extractTextFromHTML(content)
          return {
            output: text,
            title,
            metadata: {},
          }
        }
        return {
          output: content,
          title,
          metadata: {},
        }

      case "html":
        return {
          output: content,
          title,
          metadata: {},
        }

      default:
        return {
          output: content,
          title,
          metadata: {},
        }
    }
  },
})

async function extractTextFromHTML(html: string) {
  let text = ""
  let skipContent = false

  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, iframe, object, embed", {
      element() {
        skipContent = true
      },
      text() {
        // Skip text content inside these elements
      },
    })
    .on("*", {
      element(element) {
        // Reset skip flag when entering other elements
        if (!["script", "style", "noscript", "iframe", "object", "embed"].includes(element.tagName)) {
          skipContent = false
        }
      },
      text(input) {
        if (!skipContent) {
          text += input.text
        }
      },
    })
    .transform(new Response(html))

  await rewriter.text()
  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}
