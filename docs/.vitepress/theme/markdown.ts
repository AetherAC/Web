// Markdown rendering for CMS-authored text that reaches the browser as a plain string.
//
// The posts/artifacts/progress rows are fetched from Supabase at runtime, so VitePress's own
// build-time Markdown pipeline never sees them — `{{ row.body }}` put the raw source on the page.
// That silently broke two promises at once: /admin labels `posts.body` "正文（Markdown）" and lists
// the syntax it accepts, and every multiline textarea lost its line breaks, because HTML collapses
// newlines and only `.article-body` happened to set `white-space:pre-wrap`.
//
// markdown-it is loaded with a dynamic import, not a static one. Measured on this theme: static
// costs 49 KB gzip on the critical path of *every* page — more than the whole Vue runtime chunk —
// for text that four pages fetch asynchronously anyway. Split out, the download races the Supabase
// request that produces the text instead of delaying first paint, and /login, /admin and the docs
// pages never pay for it. `preloadMarkdown()` is what the pages call to start that race early.
import { shallowRef } from 'vue'
import type MarkdownIt from 'markdown-it'

const renderer = shallowRef<MarkdownIt | null>(null)

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = (source: string) => source.replace(/[&<>"']/g, char => ESCAPE[char])

// Shown for the few milliseconds before the chunk lands, and for the whole page load if it fails to
// arrive at all. Escaped, so it is exactly as safe as the real renderer; the only thing it gives up
// is formatting, and it keeps the line breaks that were the bug users actually reported. For
// single-line plain text it is byte-identical to `renderInline`, which is what the statically
// rendered home page contains — so hydration sees the same string either way.
const plain = (source: string) => escapeHtml(source).replace(/\r\n|\r|\n/g, '<br>\n')

const configure = (md: MarkdownIt) => {
  // markdown-it's default already rejects javascript:/vbscript:/file: and non-image data:. An explicit
  // allowlist is narrower and easier to reason about: nothing but web links, mail links, and
  // site-relative paths can ever come out of the CMS.
  const ALLOWED_SCHEME = /^(https?:|mailto:)/i
  md.validateLink = (url) => {
    const trimmed = String(url).trim()
    if (ALLOWED_SCHEME.test(trimmed)) return true
    // Relative targets (/buy, ./x, #anchor, ?a=1) carry no scheme and cannot escape the origin.
    return /^([/.#?]|$)/.test(trimmed)
  }

  // Off-site links open in a new tab; `noopener` keeps the opened page from touching window.opener.
  const defaultLinkOpen = md.renderer.rules.link_open
    ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const href = tokens[idx].attrGet('href') ?? ''
    if (/^(https?:)?\/\//i.test(href)) {
      tokens[idx].attrSet('target', '_blank')
      tokens[idx].attrSet('rel', 'noopener noreferrer')
    }
    return defaultLinkOpen(tokens, idx, options, env, self)
  }
  return md
}

let pending: Promise<void> | null = null
let attempts = 0

/**
 * Start loading the renderer. Call it alongside the fetch that produces the text — the two requests
 * then overlap, and the reader never sees the unformatted fallback. Safe to call repeatedly: the
 * import happens once. Never rejects; a failed load just leaves the fallback in place.
 */
export function preloadMarkdown(): Promise<void> {
  if (renderer.value) return Promise.resolve()
  if (!pending) {
    attempts += 1
    pending = import('markdown-it')
      .then(({ default: MarkdownItCtor }) => {
        // These strings are admin-authored, but they arrive over the network and land in v-html, so raw
        // HTML stays disabled — a stray <script> in a description is escaped rather than executed. It also
        // keeps a mistyped `<` from swallowing the rest of a paragraph.
        //
        // `breaks:true` is the important option: an author typing two lines into a textarea means two
        // lines, not CommonMark's "a single newline is a space".
        renderer.value = configure(new MarkdownItCtor({
          html: false,
          linkify: true,
          typographer: false,
          breaks: true
        }))
      })
      .catch((error) => {
        console.warn('[AetherAC] Markdown renderer unavailable, showing plain text', error)
        // Retry on a later render in case it was a transient blip, but bound it — a stale chunk hash
        // after a deploy will never resolve, and renders must not turn into a retry loop.
        if (attempts < 3) pending = null
      })
  }
  return pending
}

const render = (source: string | null | undefined, inline: boolean): string => {
  if (!source) return ''
  // Reading the ref here is what subscribes the calling component's render effect: when the chunk
  // lands, the fallback is replaced with real Markdown without anyone having to await anything.
  const md = renderer.value
  if (!md) {
    void preloadMarkdown()
    return plain(String(source))
  }
  return inline ? md.renderInline(String(source)) : md.render(String(source))
}

/** Full Markdown -> HTML, for text that owns its block: post bodies, product descriptions. */
export const renderMarkdown = (source?: string | null): string => render(source, false)

/**
 * Inline-only render, for text inside a fixed-height card. Emphasis, code and links work; headings
 * and lists are left as literal text instead of blowing out the card's layout. Both renderers are
 * driven from the same instance so a link is sanitised identically either way.
 */
export const renderMarkdownInline = (source?: string | null): string => render(source, true)

/**
 * §4 的四种正文格式，一处实现。客服消息（§4）和站内信（§9）都要它。
 *
 * bbcode 那一档带着两条协议白名单（[url] 和 [img] 只收 http(s) 和站内相对路径）。抄成两份的代价是
 * 某天只有一份被补上，而漏掉的那份不报错，只是多一个可点的 javascript: 链接——所以这里只有一份。
 */
export const escapeText = (source?: string | null): string =>
  escapeHtml(String(source ?? '')).replace(/\r\n|\r|\n/g, '<br>')

/**
 * §4.3 BBCode。先转义再替换标记：反过来的话 [b]<script>[/b] 里的标签会活下来。
 * 只认需求里列的那几个标记，认不出的原样留着——留着一个 [xyz] 比吞掉用户的文字好。
 */
export function renderBbcode(source?: string | null): string {
  let out = escapeHtml(String(source ?? ''))
  out = out.replace(/\[b\]([\s\S]*?)\[\/b\]/gi, '<b>$1</b>')
    .replace(/\[i\]([\s\S]*?)\[\/i\]/gi, '<i>$1</i>')
    .replace(/\[u\]([\s\S]*?)\[\/u\]/gi, '<u>$1</u>')
    .replace(/\[s\]([\s\S]*?)\[\/s\]/gi, '<s>$1</s>')
    .replace(/\[code\]([\s\S]*?)\[\/code\]/gi, '<code>$1</code>')
    .replace(/\[quote\]([\s\S]*?)\[\/quote\]/gi, '<blockquote>$1</blockquote>')
    .replace(/\[color=(#[0-9a-f]{3,6}|[a-z]{3,20})\]([\s\S]*?)\[\/color\]/gi, '<span style="color:$1">$2</span>')
    // url 的目标要过一遍协议白名单：[url=javascript:...] 否则是一个可点的洞。
    .replace(/\[url=(https?:\/\/[^\]\s"']+|\/[^\]\s"']*)\]([\s\S]*?)\[\/url\]/gi,
      '<a href="$1" target="_blank" rel="noopener noreferrer">$2</a>')
    .replace(/\[img\](https?:\/\/[^\]\s"']+)\[\/img\]/gi, '<img src="$1" alt="">')
  return out.replace(/\r\n|\r|\n/g, '<br>')
}

/**
 * 按 format 渲染一段正文。html 那一档原样交出去：正文在入库前已经过 shared/cs.mjs 的 sanitizeHtml
 * 白名单，而这里的 markdown-it 是 html:false 构造的，喂给它只会把标签转义成字面量。
 */
export function renderRichBody(body?: string | null, format?: string | null): string {
  if (format === 'html') return String(body ?? '')
  if (format === 'plain') return escapeText(body)
  if (format === 'bbcode') return renderBbcode(body)
  return renderMarkdown(body)
}

