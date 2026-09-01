import { connect as connectNet, isIP, type Socket as NetSocket } from 'node:net'
import * as tls from 'node:tls'
import type { TLSSocket } from 'node:tls'
import { lookup } from 'node:dns/promises'

const SMTP_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_MESSAGE_BYTES = 200_000
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/

type SmtpSocket = NetSocket | TLSSocket

export type SmtpMessage = {
  to: string
  from: string
  subject: string
  text: string
  html: string
}

type SmtpConfig = {
  host: string
  port: number
  tlsMode: 'implicit-tls' | 'starttls'
  username: string
  password: string
}

// Deliberately return one opaque error to the plugin. SMTP responses can
// contain provider details; those belong in host logs, never plugin-visible
// errors or public form responses.
function fail(): Error {
  return new Error('smtp_delivery_failed')
}

function privateIpv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false
  const [first, second] = parts
  return first === 0 || first === 10 || first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
}

function forbiddenAddress(address: string): boolean {
  const normalized = address.toLowerCase()
  if (isIP(normalized) === 4) return privateIpv4(normalized)
  if (isIP(normalized) === 6) {
    if (normalized === '::' || normalized === '::1' || normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') ||
        normalized.startsWith('fc') || normalized.startsWith('fd')) return true
    if (normalized.startsWith('::ffff:')) return privateIpv4(normalized.slice(7))
    return false
  }
  return true
}

async function publicAddress(host: string): Promise<{ address: string; family: 4 | 6 }> {
  const addresses = await Promise.race([
    lookup(host, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => setTimeout(() => reject(fail()), SMTP_TIMEOUT_MS)),
  ])
  const found = addresses.find((candidate) => !forbiddenAddress(candidate.address))
  if (!found || (found.family !== 4 && found.family !== 6)) throw fail()
  return { address: found.address, family: found.family }
}

export function validateSmtpConfig(settings: Record<string, unknown>): SmtpConfig {
  const host = typeof settings.smtpHost === 'string' ? settings.smtpHost.trim().toLowerCase() : ''
  const port = Number(settings.smtpPort)
  const tlsMode = settings.smtpTlsMode
  const username = typeof settings.smtpUsername === 'string' ? settings.smtpUsername : ''
  const password = typeof settings.smtpPassword === 'string' ? settings.smtpPassword : ''

  if (!host || host.length > 253 || /[\r\n]/.test(host) || host === 'localhost' || host.includes(':')) throw fail()
  if (/^\d+(?:\.\d+){3}$/.test(host)) {
    if (privateIpv4(host)) throw fail()
  } else if (!host.split('.').every((label) =>
    label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  )) throw fail()
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw fail()
  if (tlsMode !== 'implicit-tls' && tlsMode !== 'starttls') throw fail()
  if (username.length > 320 || password.length > 1_024 || /[\r\n]/.test(username)) throw fail()
  if ((username && !password) || (!username && password)) throw fail()
  return { host, port, tlsMode, username, password }
}

function validateMessage(message: SmtpMessage): void {
  for (const address of [message.to, message.from]) {
    if (typeof address !== 'string' || address.length > 320 || /[\r\n]/.test(address) || !EMAIL_PATTERN.test(address)) throw fail()
  }
  if (typeof message.subject !== 'string' || message.subject.length === 0 || message.subject.length > 200 || /[\r\n]/.test(message.subject)) throw fail()
  if (typeof message.text !== 'string' || typeof message.html !== 'string') throw fail()
}

function normalizeBody(value: string): string {
  return value.replace(/\r\n|\r|\n/g, '\r\n').replace(/^\./gm, '..')
}

export function buildMimeMessage(message: SmtpMessage): string {
  validateMessage(message)
  const boundary = `----instatic-${crypto.randomUUID()}`
  const body = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${message.subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    normalizeBody(message.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    normalizeBody(message.html),
    `--${boundary}--`,
    '',
  ].join('\r\n')
  if (Buffer.byteLength(body, 'utf8') > MAX_MESSAGE_BYTES) throw fail()
  return body
}

type Reply = { code: number; lines: string[] }

class SmtpSession {
  private socket: SmtpSocket
  private buffer = ''
  private pending: { resolve: (reply: Reply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null
  private readonly onData = (chunk: Buffer | string) => {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_RESPONSE_BYTES) {
      this.rejectPending()
      this.destroy()
      return
    }
    this.flush()
  }
  private readonly onError = () => {
    this.rejectPending()
  }

  constructor(socket: SmtpSocket) {
    this.socket = socket
    socket.on('data', this.onData)
    socket.once('error', this.onError)
  }

  private rejectPending(): void {
    if (!this.pending) return
    clearTimeout(this.pending.timer)
    const reject = this.pending.reject
    this.pending = null
    reject(fail())
  }

  private flush(): void {
    if (!this.pending) return
    const lines: string[] = []
    let code: number | null = null
    while (true) {
      const end = this.buffer.indexOf('\n')
      if (end < 0) return
      const line = this.buffer.slice(0, end).replace(/\r$/, '')
      this.buffer = this.buffer.slice(end + 1)
      const match = /^(\d{3})([ -])(.*)$/.exec(line)
      if (!match) { this.rejectPending(); return }
      const nextCode = Number(match[1])
      if (code === null) code = nextCode
      if (code !== nextCode) { this.rejectPending(); return }
      lines.push(line)
      if (match[2] === ' ') {
        clearTimeout(this.pending.timer)
        const resolve = this.pending.resolve
        this.pending = null
        resolve({ code, lines })
        return
      }
    }
  }

  response(): Promise<Reply> {
    if (this.pending) return Promise.reject(fail())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.rejectPending(), SMTP_TIMEOUT_MS)
      this.pending = { resolve, reject, timer }
      this.flush()
    })
  }

  write(line: string): void {
    if (this.socket.destroyed || !this.socket.write(`${line}\r\n`)) throw fail()
  }

  writeData(value: string): void {
    if (this.socket.destroyed || !this.socket.write(value)) throw fail()
  }

  replaceSocket(socket: SmtpSocket): void {
    this.socket.off('data', this.onData)
    this.socket.off('error', this.onError)
    this.socket = socket
    socket.on('data', this.onData)
    socket.once('error', this.onError)
  }

  destroy(): void {
    clearTimeout(this.pending?.timer)
    this.pending = null
    this.socket.destroy()
  }
}

async function connectSocket(config: SmtpConfig): Promise<SmtpSocket> {
  const destination = await publicAddress(config.host)
  return new Promise((resolve, reject) => {
    let settled = false
    const rejectOnce = () => {
      if (settled) return
      settled = true
      reject(fail())
    }
    const options = {
      host: destination.address,
      port: config.port,
      family: destination.family,
      servername: config.host,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2' as const,
      timeout: SMTP_TIMEOUT_MS,
    }
    if (config.tlsMode === 'implicit-tls') {
      const socket = tls.connect(options)
      socket.once('secureConnect', () => {
        if (!socket.authorized) return rejectOnce()
        settled = true
        resolve(socket)
      })
      socket.once('error', rejectOnce)
      socket.once('timeout', rejectOnce)
    } else {
      const socket = connectNet({ host: destination.address, port: config.port, family: destination.family, timeout: SMTP_TIMEOUT_MS })
      socket.once('connect', () => { settled = true; resolve(socket) })
      socket.once('error', rejectOnce)
      socket.once('timeout', rejectOnce)
    }
  })
}

async function startTls(session: SmtpSession, socket: NetSocket, host: string): Promise<TLSSocket> {
  session.replaceSocket(socket)
  return new Promise((resolve, reject) => {
    let settled = false
    const secureSocket = tls.connect({ socket, host, servername: host, rejectUnauthorized: true, minVersion: 'TLSv1.2', timeout: SMTP_TIMEOUT_MS })
    const rejectOnce = () => {
      if (settled) return
      settled = true
      secureSocket.destroy()
      reject(fail())
    }
    secureSocket.once('secureConnect', () => {
      if (!secureSocket.authorized) return rejectOnce()
      settled = true
      resolve(secureSocket)
    })
    secureSocket.once('error', rejectOnce)
    secureSocket.once('timeout', rejectOnce)
  })
}

function requireClass(reply: Reply, allowed: number[]): void {
  if (!allowed.includes(Math.floor(reply.code / 100))) throw fail()
}

async function command(session: SmtpSession, line: string, allowed: number[]): Promise<Reply> {
  session.write(line)
  const reply = await session.response()
  requireClass(reply, allowed)
  return reply
}

function supports(reply: Reply, name: string): boolean {
  return reply.lines.some((line) => new RegExp(`^250[- ]${name}(?:[ =]|$)`, 'i').test(line))
}

async function deliver(config: SmtpConfig, message: SmtpMessage): Promise<void> {
  const socket = await connectSocket(config)
  const session = new SmtpSession(socket)
  try {
    requireClass(await session.response(), [2])
    let ehlo = await command(session, 'EHLO instatic.local', [2])
    if (config.tlsMode === 'starttls') {
      if (!supports(ehlo, 'STARTTLS')) throw fail()
      await command(session, 'STARTTLS', [2])
      session.replaceSocket(await startTls(session, socket as NetSocket, config.host))
      ehlo = await command(session, 'EHLO instatic.local', [2])
    }
    if (config.username) {
      if (!supports(ehlo, 'AUTH')) throw fail()
      const authLine = ehlo.lines.join('\n')
      if (/^250[- ]AUTH(?:[ =]|$).*\bPLAIN\b/im.test(authLine)) {
        const token = Buffer.from(`\u0000${config.username}\u0000${config.password}`, 'utf8').toString('base64')
        await command(session, `AUTH PLAIN ${token}`, [2])
      } else if (/^250[- ]AUTH(?:[ =]|$).*\bLOGIN\b/im.test(authLine)) {
        requireClass(await command(session, 'AUTH LOGIN', [3]), [3])
        requireClass(await command(session, Buffer.from(config.username, 'utf8').toString('base64'), [3]), [3])
        await command(session, Buffer.from(config.password, 'utf8').toString('base64'), [2])
      } else throw fail()
    }
    await command(session, `MAIL FROM:<${message.from}>`, [2])
    await command(session, `RCPT TO:<${message.to}>`, [2])
    await command(session, 'DATA', [3])
    const mime = buildMimeMessage(message)
    session.writeData(`${mime}.\r\n`)
    requireClass(await session.response(), [2])
    try { await command(session, 'QUIT', [2, 4]) } catch { /* accepted message remains successful */ }
  } finally {
    session.destroy()
  }
}

export async function sendSmtpMessage(settings: Record<string, unknown>, message: SmtpMessage): Promise<void> {
  const config = validateSmtpConfig(settings)
  validateMessage(message)
  await deliver(config, message)
}
