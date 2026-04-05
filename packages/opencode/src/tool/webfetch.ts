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
const failedUrls = new Map<string, { status: number; timestamp: number }>()
const FAILURE_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

function isUrlCachedFailure(url: string): { status: number } | null {
  const entry = failedUrls.get(url)
  if (!entry) return null
  if (Date.now() - entry.timestamp > FAILURE_CACHE_TTL) {
    failedUrls.delete(url)
    return null
  }
  return { status: entry.status }
}

const MAX_CACHED_URLS = 500

function cacheUrlFailure(url: string, status: number): void {
  if (status === 404 || status === 410 || status === 451) {
    if (failedUrls.size >= MAX_CACHED_URLS) {
      // Evict oldest entry (Map preserves insertion order)
      const oldest = failedUrls.keys().next().value
      if (oldest) failedUrls.delete(oldest)
    }
    failedUrls.set(url, { status, timestamp: Date.now() })
  }
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
