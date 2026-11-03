// Tests of the repo logo rules (hooks/repo-logo.ts): the raster path choice in a checkout (an SVG, a link and an oversized file are not
// logos), the PNG and JPEG frames with their trailers (a truncated download is no logo), the GitHub contents answer, the store and lock
// keys, the stored entry and its age, the avatar sources and the pinned fetch script. Pure: no engine, no host.
import { expect, test } from 'claude-code/testing'
import { logoKeyOf } from '../hooks/model'
import {
  AVATAR_SIZE_PX,
  LOGO_LOCK_MS,
  LOGO_MAX_BYTES,
  LOGO_PATHS,
  LOGO_RETRY_MS,
  LOGO_TTL_MS,
  AVATAR_FETCH_SCRIPT,
  avatarUrlOf,
  contentsLogoOf,
  isLogoFresh,
  isLogoLockLive,
  isLogoStoreKey,
  logoLockKeyOf,
  logoPathIn,
  logoStoreKeyOf,
  pictureDocumentOf,
  projectAvatarUrlOf,
  readStoredLogo,
  repoLabelOf,
} from '../hooks/repo-logo'

// Base64 of bytes, with btoa, since the test runtime has no Node Buffer.
const base64Of = (bytes: ArrayLike<number>): string => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))

// A PNG: its signature, a middle, and the IEND chunk that closes it. A JPEG: its start, a middle, and its end marker.
const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]
const JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]
const pngBase64 = base64Of(PNG_BYTES)
const jpegBase64 = base64Of(JPEG_BYTES)
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>'
const svgBase64 = base64Of(new TextEncoder().encode(SVG))
const file = (name: string, size = 100) => ({ name, kind: 'file', size, isLink: false })

test('the logo paths are raster only, the checkout root first, png before jpg before jpeg in each folder', () => {
  expect(LOGO_PATHS.every(path => /\.(png|jpe?g)$/.test(path))).toBe(true)
  expect(LOGO_PATHS.slice(0, 3)).toEqual(['logo.png', 'logo.jpg', 'logo.jpeg'])
  expect(LOGO_PATHS).toContain('.github/logo.png')
  expect(LOGO_PATHS.some(path => path.endsWith('.svg'))).toBe(false)
})

test('the first logo path in priority order wins, the root before its folders, png before jpeg', () => {
  const listings = new Map([
    ['.', [file('README.md')]],
    ['assets', [file('logo.png')]],
    ['.github', [file('logo.png')]],
  ])
  expect(logoPathIn(listings)).toBe('assets/logo.png')
  expect(logoPathIn(new Map([['.', [file('logo.jpeg'), file('logo.png')]]]))).toBe('logo.png')
})

test('the basename matches case-insensitively and the checkout name is returned as it is', () => {
  expect(logoPathIn(new Map([['docs', [file('Logo.JPG')]]]))).toBe('docs/Logo.JPG')
  expect(logoPathIn(new Map([['.', [file('mark.png')]]]))).toBeNull()
})

test('an SVG logo is ignored, and so is a link, a folder or a file over the size cap', () => {
  expect(logoPathIn(new Map([['.', [file('logo.svg')]]]))).toBeNull()
  expect(logoPathIn(new Map([['.', [{ name: 'logo.png', kind: 'dir', size: 0, isLink: false }]]]))).toBeNull()
  expect(logoPathIn(new Map([['.', [{ name: 'logo.png', kind: 'file', size: 100, isLink: true }]]]))).toBeNull()
  const listings = new Map([
    ['.', [file('logo.png', LOGO_MAX_BYTES + 1)]],
    ['images', [file('logo.jpg')]],
  ])
  expect(logoPathIn(listings)).toBe('images/logo.jpg')
})

test('a PNG or a JPEG file becomes an SVG frame around its data URI; an SVG draws nothing', () => {
  expect(pictureDocumentOf(pngBase64)).toContain(`<image href="data:image/png;base64,${pngBase64}"`)
  expect(pictureDocumentOf(pngBase64)?.startsWith('<svg')).toBe(true)
  expect(pictureDocumentOf(jpegBase64)).toContain(`<image href="data:image/jpeg;base64,${jpegBase64}"`)
  expect(pictureDocumentOf(svgBase64)).toBeNull()
})

test('a truncated PNG or JPEG is rejected: the trailer is what closes a complete file', () => {
  expect(pictureDocumentOf(base64Of(PNG_BYTES.slice(0, -4)))).toBeNull()
  expect(pictureDocumentOf(base64Of(PNG_BYTES.slice(0, 12)))).toBeNull()
  expect(pictureDocumentOf(base64Of(JPEG_BYTES.slice(0, -2)))).toBeNull()
  expect(pictureDocumentOf(base64Of([0xff, 0xd8, 0xff]))).toBeNull()
})

test('a picture over the byte cap or with wrapped base64 lines follows the same rules', () => {
  const big = base64Of(new Uint8Array(LOGO_MAX_BYTES + 1).fill(0x20))
  expect(pictureDocumentOf(big)).toBeNull()
  const wrapped = `${pngBase64.slice(0, 8)}\n${pngBase64.slice(8)}`
  expect(pictureDocumentOf(wrapped)).toContain(`base64,${pngBase64}"`)
  expect(pictureDocumentOf('not base64!')).toBeNull()
})

test('GitHub contents: a base64 raster file of the cap draws; a directory, a large file or a bad answer draws nothing', () => {
  expect(contentsLogoOf({ type: 'file', size: PNG_BYTES.length, encoding: 'base64', content: pngBase64 })).toContain(pngBase64)
  expect(contentsLogoOf({ type: 'dir', size: 0 })).toBeNull()
  expect(contentsLogoOf({ type: 'file', size: LOGO_MAX_BYTES + 1, content: pngBase64 })).toBeNull()
  expect(contentsLogoOf({ type: 'file', size: LOGO_MAX_BYTES + 1, content: base64Of(new Uint8Array(LOGO_MAX_BYTES + 1)) })).toBeNull()
  expect(contentsLogoOf([])).toBeNull()
  expect(contentsLogoOf(undefined)).toBeNull()
})

test('the logo key is the remote host, owner and name in lower case; the store and lock keys carry it', () => {
  expect(logoKeyOf({ host: 'github.com', owner: 'Acme', name: 'App' })).toBe('github.com/acme/app')
  expect(logoKeyOf({ host: 'github-work', owner: 'acme', name: 'app' })).toBe('github-work/acme/app')
  expect(logoKeyOf({ host: 'git.example.test', owner: 'acme', name: 'app' })).toBeNull()
  expect(logoKeyOf(null)).toBeNull()
  expect(logoStoreKeyOf('github.com/acme/app')).toBe('logo:github.com/acme/app')
  expect(logoLockKeyOf('github.com/acme/app')).toBe('logo-lock:github.com/acme/app')
  expect(isLogoStoreKey('logo:github.com/acme/app')).toBe(true)
  expect(isLogoStoreKey('logo-lock:github.com/acme/app')).toBe(false)
  expect(repoLabelOf('https://github.com/acme/app')).toBe('acme/app')
})

test('a stored entry is read only when its shape is one this module wrote', () => {
  expect(readStoredLogo({ source: null, at: 5, failed: false })).toEqual({ source: null, at: 5, failed: false })
  expect(readStoredLogo({ source: 'x', at: 5, failed: false })?.source).toBe('x')
  expect(readStoredLogo({ source: 3, at: 5, failed: false })).toBeUndefined()
  expect(readStoredLogo({ at: 5, failed: false })).toBeUndefined()
  expect(readStoredLogo('logo')).toBeUndefined()
})

test('a found logo or none is fresh for a day, a failed lookup for an hour', () => {
  const found = { source: 'x', at: 0, failed: false }
  expect(isLogoFresh(found, LOGO_TTL_MS - 1)).toBe(true)
  expect(isLogoFresh(found, LOGO_TTL_MS)).toBe(false)
  const failed = { source: null, at: 0, failed: true }
  expect(isLogoFresh(failed, LOGO_RETRY_MS - 1)).toBe(true)
  expect(isLogoFresh(failed, LOGO_RETRY_MS)).toBe(false)
})

test('a lock marker is live for two minutes after its time, and never for a value that is not one', () => {
  expect(isLogoLockLive({ at: 1000 }, 1000 + LOGO_LOCK_MS - 1)).toBe(true)
  expect(isLogoLockLive({ at: 1000 }, 1000 + LOGO_LOCK_MS)).toBe(false)
  expect(isLogoLockLive(undefined, 1000)).toBe(false)
  expect(isLogoLockLive({ at: 'soon' }, 1000)).toBe(false)
})

test('an avatar URL is https on its host only, with no port or credentials; the size goes in as s', () => {
  const host = 'avatars.githubusercontent.com'
  expect(avatarUrlOf('https://avatars.githubusercontent.com/u/9001?v=4', host, AVATAR_SIZE_PX)).toBe(
    'https://avatars.githubusercontent.com/u/9001?v=4&s=32',
  )
  expect(avatarUrlOf('https://avatars.githubusercontent.com/u/9001', host)).toBe('https://avatars.githubusercontent.com/u/9001')
  for (const url of [
    'http://avatars.githubusercontent.com/u/9001',
    'https://avatars.githubusercontent.com:8443/u/9001',
    'https://user@avatars.githubusercontent.com/u/9001',
    'https://evil.example.test/u/9001.png',
    'https://avatars.githubusercontent.com.evil.example.test/u/9001',
    'javascript:alert(1)',
    'not a url',
  ]) {
    expect(avatarUrlOf(url, host, AVATAR_SIZE_PX)).toBeNull()
  }
  expect(avatarUrlOf(undefined, host)).toBeNull()
})

test('the fetch script is pinned: https only, no redirects followed, the byte cap, the URL as the one argument', () => {
  expect(AVATAR_FETCH_SCRIPT).toBe(`curl -fsS --proto =https --max-time 8 --max-filesize ${LOGO_MAX_BYTES} -- "$1" | base64 -w0`)
  expect(AVATAR_FETCH_SCRIPT.split(' ')).not.toContain('-L')
})

test('a GitLab project answer names its avatar on the remote host, or nothing', () => {
  const host = 'gitlab.example.test'
  expect(projectAvatarUrlOf({ path: 'app', avatar_url: 'https://gitlab.example.test/uploads/app.png' }, host)).toBe(
    'https://gitlab.example.test/uploads/app.png',
  )
  expect(projectAvatarUrlOf({ path: 'app', avatar_url: null }, host)).toBeNull()
  expect(projectAvatarUrlOf({ path: 'app', avatar_url: 'https://evil.example.test/app.png' }, host)).toBeNull()
  expect(projectAvatarUrlOf('not an object', host)).toBeNull()
})
