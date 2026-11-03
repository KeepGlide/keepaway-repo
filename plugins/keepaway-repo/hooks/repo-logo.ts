// The repo logo of a session row (SPEC section 11): the pure rules. register.tsx reads the checkout's folders and GitHub's contents
// answers; this module picks the file, checks it and builds the one SVG document the desktop's Svg element draws. Raster only: a PNG or
// a JPEG, sniffed by its magic bytes and closed by its trailer, so a truncated download is no logo. No I/O here, and no colour or emoji
// (the look gate).

// The folders a logo may sit in, the checkout root first ('.'), then the rest in priority order.
const LOGO_FOLDER_NAMES: readonly string[] = ['.', 'assets', '.github', 'docs', 'images']
// The raster extensions a logo may carry, in priority order within a folder.
const LOGO_EXTENSIONS: readonly string[] = ['png', 'jpg', 'jpeg']

// The logo files, in priority order: folder by folder (the root first), extension by extension within a folder. A path's folder is its
// directory ('.' is the checkout root); its basename matches case-insensitively.
export const LOGO_PATHS: readonly string[] = LOGO_FOLDER_NAMES.flatMap(folder =>
  LOGO_EXTENSIONS.map(extension => (folder === '.' ? `logo.${extension}` : `${folder}/logo.${extension}`)),
)

// GitHub is asked for at most this many paths per lookup, in LOGO_PATHS order, and stops at the first logo. The checkout is read first,
// so GitHub only answers for a logo the local branch does not have.
export const GITHUB_LOGO_CALLS = 3

// A logo file the pane reads at most this large, in bytes (raw, before base64).
export const LOGO_MAX_BYTES = 64 * 1024
// The Svg element takes at most this many characters of markup (the engine's limit).
const SVG_SOURCE_MAX_CHARS = 131072

const HOUR_MS = 60 * 60 * 1000
// A found logo, and a repo that has none, are kept this long; a failed lookup is retried after LOGO_RETRY_MS.
export const LOGO_TTL_MS = 24 * HOUR_MS
export const LOGO_RETRY_MS = HOUR_MS
// The cross-window lock of a lookup: a marker younger than this is another window's lookup, which this window does not repeat.
export const LOGO_LOCK_MS = 2 * 60 * 1000
// The most repo logos the store keeps; past it the oldest expired-or-not entries not shown by this window are dropped.
export const LOGO_STORE_MAX = 20
const STORE_PREFIX = 'logo:'
export const LOGO_LOCK_PREFIX = 'logo-lock:'

// What the store keeps per repo: the drawable SVG (null for none), when it was looked up, and whether the lookup failed.
export type StoredLogo = { source: string | null; at: number; failed: boolean }
// One entry of a folder listing, the fields the logo choice reads (the engine's FsEntry carries them). A link is never a logo.
export type LogoEntry = { name: string; kind: string; size: number; isLink: boolean }

const folderOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.')
const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1)
// Every folder LOGO_PATHS reads, the checkout root first among them.
export const LOGO_FOLDERS: readonly string[] = [...new Set(LOGO_PATHS.map(folderOf))]

// The first logo path the checkout holds, given the entries of each folder (listings by folder, '.' the root): a regular file (not a
// link) whose basename matches case-insensitively and that fits LOGO_MAX_BYTES. The path is returned as the checkout has it; null when
// none is.
export function logoPathIn(listings: ReadonlyMap<string, readonly LogoEntry[]>): string | null {
  for (const path of LOGO_PATHS) {
    const folder = folderOf(path)
    const wanted = nameOf(path).toLowerCase()
    const hit = (listings.get(folder) ?? []).find(
      entry =>
        entry.kind === 'file' && !entry.isLink && entry.name.toLowerCase() === wanted && entry.size <= LOGO_MAX_BYTES,
    )
    if (hit !== undefined) return folder === '.' ? hit.name : `${folder}/${hit.name}`
  }
  return null
}

// The raster types a logo may be: the bytes that open the file, and the bytes that close it (a truncated file lacks the close).
type RasterFormat = { mime: 'image/png' | 'image/jpeg'; head: readonly number[]; tail: readonly number[] }
const RASTER_FORMATS: readonly RasterFormat[] = [
  // The PNG signature, and the IEND chunk (its type and CRC) that ends every PNG file.
  { mime: 'image/png', head: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], tail: [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82] },
  { mime: 'image/jpeg', head: [0xff, 0xd8, 0xff], tail: [0xff, 0xd9] },
]
const DATA_BODY = /^[A-Za-z0-9+/]+={0,2}$/

// The base64 text without its whitespace (GitHub wraps its base64 lines) and its bytes; null when it is not base64 or is over the cap.
function decodedOf(base64: string): { compact: string; bytes: Uint8Array } | null {
  const compact = base64.replace(/\s+/g, '')
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(compact), char => char.charCodeAt(0))
  } catch {
    return null
  }
  return bytes.byteLength > LOGO_MAX_BYTES ? null : { compact, bytes }
}

// Whether the bytes open with the format's head and close with its tail.
function isRasterFormat(bytes: Uint8Array, format: RasterFormat): boolean {
  const headFits = format.head.every((byte, index) => bytes[index] === byte)
  const tailAt = bytes.byteLength - format.tail.length
  return tailAt >= format.head.length && headFits && format.tail.every((byte, index) => bytes[tailAt + index] === byte)
}

// The drawable SVG document of a picture given its bytes as base64: a PNG or a JPEG that opens and closes as one, within the cap. The
// image fills a 1 by 1 viewBox, so the element's own width and height scale it, aspect kept. Null for anything else (an SVG included).
export function pictureDocumentOf(base64: string): string | null {
  const decoded = decodedOf(base64)
  if (decoded === null) return null
  const format = RASTER_FORMATS.find(candidate => isRasterFormat(decoded.bytes, candidate))
  if (format === undefined || !DATA_BODY.test(decoded.compact)) return null
  const document = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><image href="data:${format.mime};base64,${decoded.compact}" width="1" height="1"/></svg>`
  return document.length <= SVG_SOURCE_MAX_CHARS ? document : null
}

// The avatar sources (SPEC section 11): GitHub's avatars are asked at this size (the `s` parameter), and only that host serves GitHub's.
export const AVATAR_SIZE_PX = 32
export const GITHUB_AVATAR_HOST = 'avatars.githubusercontent.com'
// The fetch: curl through base64, since process.run returns text. The URL is the script's one positional argument, never part of the
// script. https only (--proto); redirects are not followed (no -L), so the URL fetched is the one checked. The same byte cap as a logo
// file. The pipe's exit status is base64's, so an empty answer is what a failed fetch looks like. `-w0` is GNU base64.
export const AVATAR_FETCH_SCRIPT = `curl -fsS --proto =https --max-time 8 --max-filesize ${LOGO_MAX_BYTES} -- "$1" | base64 -w0`

// The avatar URL a host's answer names, when it is an https URL on that host with no port and no credentials. The URL fetched is the
// normalized one that was checked; a size is set as the `s` parameter.
export function avatarUrlOf(answer: unknown, host: string, size?: number): string | null {
  if (typeof answer !== 'string') return null
  let url: URL
  try {
    url = new URL(answer)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname !== host || url.port !== '' || url.username !== '' || url.password !== '') return null
  if (size !== undefined) url.searchParams.set('s', String(size))
  return url.href
}

// The avatar URL of a GitLab project answer (`glab api projects/<owner%2Fname>`, parsed JSON), or null when it names none this module takes.
export function projectAvatarUrlOf(answer: unknown, host: string): string | null {
  if (typeof answer !== 'object' || answer === null) return null
  return avatarUrlOf((answer as Record<string, unknown>).avatar_url, host)
}

// The drawable SVG of a GitHub `contents` answer (the file's JSON), or null when it is not a base64 raster file this module draws.
export function contentsLogoOf(answer: unknown): string | null {
  if (typeof answer !== 'object' || answer === null) return null
  const { type, size, content } = answer as Record<string, unknown>
  if (type !== 'file' || typeof size !== 'number' || size > LOGO_MAX_BYTES || typeof content !== 'string') return null
  return pictureDocumentOf(content)
}

export const logoStoreKeyOf = (key: string): string => `${STORE_PREFIX}${key}`
export const logoLockKeyOf = (key: string): string => `${LOGO_LOCK_PREFIX}${key}`
export const isLogoStoreKey = (key: string): boolean => key.startsWith(STORE_PREFIX)
// The repo's owner/name, the alt text of its logo, read from its web page (https://<host>/<owner>/<name>).
export function repoLabelOf(page: string): string {
  return page.replace(/^https:\/\/[^/]+\//, '')
}

// A stored logo as the store gives it back, or undefined when the entry is not one this module wrote.
export function readStoredLogo(value: unknown): StoredLogo | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { source, at, failed } = value as Record<string, unknown>
  if (typeof at !== 'number' || typeof failed !== 'boolean') return undefined
  if (source !== null && typeof source !== 'string') return undefined
  return { source: typeof source === 'string' ? source : null, at, failed }
}

// Whether a stored logo still serves: a failed lookup for LOGO_RETRY_MS, any other for LOGO_TTL_MS.
export function isLogoFresh(stored: StoredLogo, now: number): boolean {
  return now - stored.at < (stored.failed ? LOGO_RETRY_MS : LOGO_TTL_MS)
}

// Whether a stored lock marker (`{ at }`) is another window's lookup still running: younger than LOGO_LOCK_MS.
export function isLogoLockLive(value: unknown, now: number): boolean {
  if (typeof value !== 'object' || value === null) return false
  const at = (value as Record<string, unknown>).at
  return typeof at === 'number' && now - at < LOGO_LOCK_MS
}
