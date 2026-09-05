import { posix } from "node:path"

export const RUNTIME_PREVIEW_ARTIFACT_PATH_V1 = ".siteagent-preview.html"

export type StaticPreviewFileV1 = {
  path: string
  bytes: Buffer
}

export type SelfContainedPreviewErrorCodeV1 =
  | "external_resource"
  | "invalid_resource_path"
  | "invalid_utf8"
  | "missing_resource"
  | "preview_too_large"
  | "unsupported_css_import"

export class SelfContainedPreviewErrorV1 extends Error {
  readonly code: SelfContainedPreviewErrorCodeV1

  constructor(code: SelfContainedPreviewErrorCodeV1) {
    super(code)
    this.code = code
  }
}

const MEDIA_TYPES_V1: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".css": "text/css",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".mjs": "text/javascript",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

function decodeUtf8V1(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new SelfContainedPreviewErrorV1("invalid_utf8")
  }
}

function attributeValueV1(tag: string, name: string): string | null {
  const pattern = new RegExp(
    `\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "iu",
  )
  const match = pattern.exec(tag)
  return match ? (match[1] ?? match[2] ?? match[3] ?? "") : null
}

function hasAttributeV1(tag: string, name: string): boolean {
  return new RegExp(`\\s${name}(?:\\s|=|/?>)`, "iu").test(tag)
}

function replaceAttributeV1(
  tag: string,
  name: string,
  transform: (value: string) => string,
): string {
  const pattern = new RegExp(
    `(\\s${name}\\s*=\\s*)(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    "giu",
  )
  return tag.replace(pattern, (_match, prefix: string, double: string, single: string, bare: string) => {
    const value = double ?? single ?? bare ?? ""
    return `${prefix}"${transform(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`
  })
}

function removeAttributeV1(tag: string, name: string): string {
  const pattern = new RegExp(
    `\\s${name}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`,
    "giu",
  )
  return tag.replace(pattern, "")
}

function resourceExtensionV1(path: string): string {
  const name = posix.basename(path)
  const dot = name.lastIndexOf(".")
  return dot < 0 ? "" : name.slice(dot).toLowerCase()
}

function isEmbeddedUrlV1(value: string): boolean {
  return /^data:/iu.test(value.trim()) || value.trim().startsWith("#")
}

function resolveResourcePathV1(
  rawValue: string,
  ownerPath: string,
): { path: string; fragment: string } {
  const value = rawValue.trim()
  if (
    !value ||
    value.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
  ) {
    throw new SelfContainedPreviewErrorV1("external_resource")
  }

  const fragmentAt = value.indexOf("#")
  const queryAt = value.indexOf("?")
  const boundaryCandidates = [fragmentAt, queryAt].filter((index) => index >= 0)
  const boundary = boundaryCandidates.length > 0 ? Math.min(...boundaryCandidates) : value.length
  const encodedPath = value.slice(0, boundary)
  const fragment = fragmentAt >= 0 ? value.slice(fragmentAt) : ""
  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(encodedPath)
  } catch {
    throw new SelfContainedPreviewErrorV1("invalid_resource_path")
  }
  if (!decodedPath || decodedPath.includes("\\") || decodedPath.includes("\u0000")) {
    throw new SelfContainedPreviewErrorV1("invalid_resource_path")
  }

  const path = decodedPath.startsWith("/")
    ? posix.normalize(decodedPath.slice(1))
    : posix.normalize(posix.join(posix.dirname(ownerPath), decodedPath))
  if (
    !path ||
    path === "." ||
    path === ".." ||
    path.startsWith("../") ||
    posix.isAbsolute(path)
  ) {
    throw new SelfContainedPreviewErrorV1("invalid_resource_path")
  }
  return { path, fragment }
}

function dataUriV1(file: StaticPreviewFileV1, fragment = ""): string {
  const mediaType = MEDIA_TYPES_V1[resourceExtensionV1(file.path)] || "application/octet-stream"
  return `data:${mediaType};base64,${file.bytes.toString("base64")}${fragment}`
}

function parseSrcsetCandidatesV1(value: string): Array<{ url: string; descriptor: string }> {
  const candidates: Array<{ url: string; descriptor: string }> = []
  let cursor = 0
  while (cursor < value.length) {
    while (cursor < value.length && /[\s,]/u.test(value[cursor] || "")) cursor += 1
    if (cursor >= value.length) break

    const urlStart = cursor
    while (cursor < value.length && !/\s/u.test(value[cursor] || "")) cursor += 1
    let url = value.slice(urlStart, cursor)
    let endedWithComma = false
    while (url.endsWith(",")) {
      endedWithComma = true
      url = url.slice(0, -1)
    }
    if (!url) throw new SelfContainedPreviewErrorV1("invalid_resource_path")

    let descriptor = ""
    if (!endedWithComma) {
      while (cursor < value.length && /\s/u.test(value[cursor] || "")) cursor += 1
      const descriptorStart = cursor
      let parentheses = 0
      while (cursor < value.length) {
        const character = value[cursor] || ""
        if (character === "(") parentheses += 1
        if (character === ")" && parentheses > 0) parentheses -= 1
        if (character === "," && parentheses === 0) break
        cursor += 1
      }
      descriptor = value.slice(descriptorStart, cursor).trim()
      if (cursor < value.length && value[cursor] === ",") cursor += 1
    }
    candidates.push({ url, descriptor })
  }
  if (candidates.length === 0) {
    throw new SelfContainedPreviewErrorV1("invalid_resource_path")
  }
  return candidates
}

export function buildSelfContainedPreviewV1(
  files: readonly StaticPreviewFileV1[],
  entryPath: string,
  maxBytes: number,
): Buffer {
  const fileByPath = new Map(files.map((file) => [file.path, file]))
  const entry = fileByPath.get(entryPath)
  if (!entry) throw new SelfContainedPreviewErrorV1("missing_resource")

  const requireLocalFile = (rawValue: string, ownerPath: string): {
    file: StaticPreviewFileV1
    fragment: string
  } => {
    const resolved = resolveResourcePathV1(rawValue, ownerPath)
    const file = fileByPath.get(resolved.path)
    if (!file) throw new SelfContainedPreviewErrorV1("missing_resource")
    return { file, fragment: resolved.fragment }
  }

  const inlineUrl = (rawValue: string, ownerPath: string): string => {
    if (isEmbeddedUrlV1(rawValue)) return rawValue.trim()
    const resource = requireLocalFile(rawValue, ownerPath)
    return dataUriV1(resource.file, resource.fragment)
  }

  const bundleCss = (css: string, ownerPath: string): string => {
    if (/@import\b/iu.test(css)) {
      throw new SelfContainedPreviewErrorV1("unsupported_css_import")
    }
    return css.replace(
      /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*?))\s*\)/giu,
      (_match, double: string, single: string, bare: string) => {
        const value = (double ?? single ?? bare ?? "").trim()
        return `url("${inlineUrl(value, ownerPath)}")`
      },
    )
  }

  const deferredScripts: string[] = []
  let html = decodeUtf8V1(entry.bytes)
  html = html.replace(/<base\b[^>]*>/giu, "")
  html = html.replace(/<link\b[^>]*>/giu, (tag) => {
    const rel = (attributeValueV1(tag, "rel") || "")
      .toLowerCase()
      .split(/\s+/u)
      .filter(Boolean)
    const href = attributeValueV1(tag, "href")
    if (rel.includes("stylesheet")) {
      if (!href || isEmbeddedUrlV1(href)) {
        throw new SelfContainedPreviewErrorV1("missing_resource")
      }
      const resource = requireLocalFile(href, entryPath)
      const css = bundleCss(decodeUtf8V1(resource.file.bytes), resource.file.path)
        .replace(/<\/style/giu, "<\\/style")
      return `<style data-siteagent-inline="${resource.file.path}">${css}</style>`
    }
    if (rel.some((value) => value === "icon" || value === "apple-touch-icon")) {
      if (!href) throw new SelfContainedPreviewErrorV1("missing_resource")
      return replaceAttributeV1(tag, "href", (value) => inlineUrl(value, entryPath))
    }
    if (rel.some((value) => value === "preconnect" || value === "dns-prefetch" || value === "preload")) {
      return ""
    }
    return tag
  })

  html = html.replace(
    /<script\b(?=[^>]*\ssrc\s*=)[^>]*>[\s\S]*?<\/script\s*>/giu,
    (tag) => {
      const src = attributeValueV1(tag, "src")
      if (!src || isEmbeddedUrlV1(src)) {
        throw new SelfContainedPreviewErrorV1("missing_resource")
      }
      const resource = requireLocalFile(src, entryPath)
      const script = decodeUtf8V1(resource.file.bytes).replace(/<\/script/giu, "<\\/script")
      const openingTag = tag.slice(0, tag.indexOf(">") + 1)
      const inlineOpeningTag = removeAttributeV1(
        removeAttributeV1(
          removeAttributeV1(
            removeAttributeV1(openingTag, "src"),
            "defer",
          ),
          "async",
        ),
        "data-siteagent-inline",
      ).replace(/>$/u, ` data-siteagent-inline="${resource.file.path}">`)
      const inlineScript = `${inlineOpeningTag}${script}</script>`
      if (hasAttributeV1(tag, "defer") || hasAttributeV1(tag, "async")) {
        deferredScripts.push(inlineScript)
        return ""
      }
      return inlineScript
    },
  )

  html = html.replace(/<style\b([^>]*)>([\s\S]*?)<\/style\s*>/giu, (_tag, attributes: string, css: string) => {
    const bundled = bundleCss(css, entryPath).replace(/<\/style/giu, "<\\/style")
    return `<style${attributes}>${bundled}</style>`
  })

  html = html.replace(/<(?:img|source|video|audio|track|input)\b[^>]*>/giu, (tag) => {
    let bundled = replaceAttributeV1(tag, "src", (value) => inlineUrl(value, entryPath))
    bundled = replaceAttributeV1(bundled, "poster", (value) => inlineUrl(value, entryPath))
    bundled = replaceAttributeV1(bundled, "srcset", (value) => {
      return parseSrcsetCandidatesV1(value)
        .map(({ url, descriptor }) =>
          `${inlineUrl(url, entryPath)}${descriptor ? ` ${descriptor}` : ""}`)
        .join(", ")
    })
    return bundled
  })

  html = html.replace(/(\s)style\s*=\s*(?:"([^"]*)"|'([^']*)')/giu, (_match, whitespace: string, double: string, single: string) => {
    const css = bundleCss(double ?? single ?? "", entryPath)
    return `${whitespace}style="${css.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"`
  })

  if (deferredScripts.length > 0) {
    const scripts = `\n${deferredScripts.join("\n")}\n`
    html = /<\/body\s*>/iu.test(html)
      ? html.replace(/<\/body\s*>/iu, `${scripts}</body>`)
      : `${html}${scripts}`
  }

  if (/<script\b(?=[^>]*\ssrc\s*=)/iu.test(html)) {
    throw new SelfContainedPreviewErrorV1("missing_resource")
  }
  const bytes = Buffer.from(html, "utf8")
  if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
    throw new SelfContainedPreviewErrorV1("preview_too_large")
  }
  return bytes
}
