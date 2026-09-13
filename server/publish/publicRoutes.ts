import { isTemplatePage } from '@core/templates'
import { getLatestPublishedSiteSnapshot } from '../repositories/publish'
import { getSetupStatusCached } from '../repositories/setup'
import type { RouteHandler, ServerRuntime } from '../router'
import { renderNotFoundResponse, renderPublicResolution } from './publicRouter'

export const tryServePublicRoute: RouteHandler = async (req, runtime, url) => {
  if (req.method !== 'GET') return null
  return await renderPublicResolution(runtime.db, url, runtime.uploadsDir)
}

const LEGACY_REDIRECTS: Readonly<Record<string, string>> = {
  '/index': '/',
  '/home': '/',
  '/about-us': '/about',
  '/contact-us': '/contact',
  '/book': '/contact',
  '/book-your-place': '/contact',
  '/petrou-kyriakos': '/trainers/petrou-kyriakos',
}

function canonicalOrigin(runtime: ServerRuntime, url: URL): string {
  return (runtime.publicOrigin ?? url.origin).replace(/\/+$/, '')
}

export const tryServeCanonicalHostRedirect: RouteHandler = (req, runtime, url) => {
  if (req.method !== 'GET' || !runtime.publicOrigin) return null
  const origin = canonicalOrigin(runtime, url)
  const canonicalHost = new URL(origin).hostname.toLowerCase()
  if (url.hostname.toLowerCase() !== `www.${canonicalHost}`) return null
  return new Response(null, {
    status: 301,
    headers: {
      'cache-control': 'public, max-age=86400',
      location: `${origin}${url.pathname}${url.search}`,
    },
  })
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character] ?? character)
}

export const tryServeSeoFiles: RouteHandler = async (req, runtime, url, pathname) => {
  if (req.method !== 'GET') return null
  const origin = canonicalOrigin(runtime, url)

  if (pathname === '/robots.txt') {
    return new Response(`User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`, {
      headers: {
        'cache-control': 'public, max-age=3600',
        'content-type': 'text/plain; charset=utf-8',
      },
    })
  }

  if (pathname !== '/sitemap.xml') return null
  const snapshot = await getLatestPublishedSiteSnapshot(runtime.db)
  const pages = snapshot?.site.pages.filter((page) => !isTemplatePage(page) && page.slug !== 'home') ?? []
  const urls = pages.map((page) => {
    const path = page.slug === 'index' ? '/' : `/${page.slug}`
    return `  <url><loc>${xmlEscape(origin + path)}</loc></url>`
  }).join('\n')
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
  return new Response(body, {
    headers: {
      'cache-control': 'public, max-age=3600',
      'content-type': 'application/xml; charset=utf-8',
    },
  })
}

export const tryServeLegacyRedirect: RouteHandler = (req, _runtime, url, pathname) => {
  if (req.method !== 'GET') return null
  const normalized = pathname.replace(/\/+$/, '') || '/'
  const target = LEGACY_REDIRECTS[normalized]
  if (!target) return null
  return new Response(null, {
    status: 301,
    headers: {
      'cache-control': 'public, max-age=86400',
      location: `${target}${url.search}`,
    },
  })
}

export const trySetupRedirect: RouteHandler = async (req, runtime) => {
  if (req.method !== 'GET') return null
  const setupStatus = await getSetupStatusCached(runtime.db)
  return setupStatus.needsSetup
    ? new Response(null, { status: 302, headers: { location: '/admin' } })
    : null
}

export const tryServeNotFoundPage: RouteHandler = async (req, runtime, url) => {
  if (req.method !== 'GET') return null
  return await renderNotFoundResponse(runtime.db, url, runtime.uploadsDir)
}
