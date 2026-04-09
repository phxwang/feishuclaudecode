#!/usr/bin/env bun
/**
 * Feishu Router — spawns a dedicated Claude Code instance per chat group.
 *
 * Single Feishu WebSocket connection, routes messages by chat_id.
 * Each group gets its own Claude process with an isolated conversation context.
 *
 * Usage:  bun router.ts
 * Config: ~/.claude/channels/feishu/access.json  (groups.<chatId>.workdir)
 */
import * as lark from '@larksuiteoapi/node-sdk'
import { spawn, type ChildProcess } from 'child_process'
import {
  readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, rmSync,
  chmodSync, renameSync,
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// ── Config ──────────────────────────────────────────────────────────────────

const STATE_DIR = process.env.FEISHU_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'feishu')
const ACCESS_FILE = join(STATE_DIR, 'access.json')
const ENV_FILE = join(STATE_DIR, '.env')
const DEBUG_LOG = join(STATE_DIR, 'router-debug.log')
const ROUTER_DIR = join(STATE_DIR, 'router')

function dbg(msg: string) {
  const line = `${new Date().toISOString()} [router] ${msg}\n`
  process.stderr.write(line)
  try { appendFileSync(DEBUG_LOG, line) } catch {}
}

// Load .env
try {
  chmodSync(ENV_FILE, 0o600)
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/)
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2]
  }
} catch {}

const APP_ID = process.env.FEISHU_APP_ID
const APP_SECRET = process.env.FEISHU_APP_SECRET
const ENCRYPT_KEY = process.env.FEISHU_ENCRYPT_KEY ?? ''

if (!APP_ID || !APP_SECRET) {
  process.stderr.write(`feishu router: FEISHU_APP_ID and FEISHU_APP_SECRET required\n  set in ${ENV_FILE}\n`)
  process.exit(1)
}

// ── Access control ──────────────────────────────────────────────────────────

type GroupPolicy = { requireMention: boolean; allowFrom: string[]; workdir?: string; idleTimeout?: number }
type Access = {
  dmPolicy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
  p2pChats: Record<string, string>
  groups: Record<string, GroupPolicy>
  pending: Record<string, unknown>
  mentionPatterns?: string[]
  ackReaction?: string
  defaultWorkdir?: string
}

function readAccess(): Access {
  try {
    const p = JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) as Partial<Access>
    return {
      dmPolicy: p.dmPolicy ?? 'pairing',
      allowFrom: p.allowFrom ?? [],
      p2pChats: p.p2pChats ?? {},
      groups: p.groups ?? {},
      pending: p.pending ?? {},
      mentionPatterns: p.mentionPatterns,
      ackReaction: p.ackReaction ?? 'Get',
      defaultWorkdir: p.defaultWorkdir,
    }
  } catch {
    return { dmPolicy: 'pairing', allowFrom: [], p2pChats: {}, groups: {}, pending: {}, ackReaction: 'Get' }
  }
}

// ── Feishu API ──────────────────────────────────────────────────────────────

const apiClient = new lark.Client({ appId: APP_ID, appSecret: APP_SECRET, loggerLevel: lark.LoggerLevel.warn })
let botOpenId: string | null = null
async function fetchBotOpenId() {
  try {
    const r = await (apiClient as any).bot.botInfo.get()
    botOpenId = r?.bot?.open_id ?? r?.data?.bot?.open_id ?? null
    if (botOpenId) dbg(`bot open_id = ${botOpenId}`)
  } catch (e) { dbg(`could not fetch bot open_id: ${e}`) }
}

function checkMention(mentions: any[], text: string, patterns?: string[]): boolean {
  for (const m of mentions) {
    if (m.mentioned_type === 'bot') return true
    if (botOpenId && m.id?.open_id === botOpenId) return true
  }
  for (const p of patterns ?? []) { try { if (new RegExp(p, 'i').test(text)) return true } catch {} }
  return false
}

// ── Instance management ─────────────────────────────────────────────────────

type Instance = {
  chatId: string
  proc: ChildProcess
  lastActivity: number
  workdir: string
}

const instances = new Map<string, Instance>()
const DEFAULT_IDLE_TIMEOUT = 30 * 60 * 1000 // 30 min

function writeMessage(chatId: string, payload: Record<string, unknown>) {
  const dir = join(ROUTER_DIR, chatId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`)
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(payload) + '\n')
  renameSync(tmp, file)
}

function spawnClaude(chatId: string, workdir: string): Instance {
  dbg(`spawning claude for ${chatId} in ${workdir}`)
  const proc = spawn('claude', [
    '--dangerously-load-development-channels', 'plugin:feishu@feishu-local',
  ], {
    cwd: workdir,
    env: { ...process.env, FEISHU_CHAT_ID: chatId },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: false,
  })

  proc.stdout?.on('data', (d: Buffer) => dbg(`[${chatId}] stdout: ${d.toString().trim()}`))
  proc.stderr?.on('data', (d: Buffer) => dbg(`[${chatId}] stderr: ${d.toString().trim()}`))

  proc.on('exit', (code, signal) => {
    dbg(`claude for ${chatId} exited (code=${code}, signal=${signal})`)
    instances.delete(chatId)
  })

  // Close stdin so claude enters non-interactive channel mode
  proc.stdin?.end()

  const inst: Instance = { chatId, proc, lastActivity: Date.now(), workdir }
  instances.set(chatId, inst)
  return inst
}

function ensureInstance(chatId: string, workdir: string): Instance {
  const existing = instances.get(chatId)
  if (existing && !existing.proc.killed) {
    existing.lastActivity = Date.now()
    return existing
  }
  return spawnClaude(chatId, workdir)
}

function killInstance(chatId: string) {
  const inst = instances.get(chatId)
  if (!inst) return
  dbg(`killing claude for ${chatId}`)
  inst.proc.kill('SIGTERM')
  instances.delete(chatId)
}

// Idle reaper
setInterval(() => {
  const access = readAccess()
  const now = Date.now()
  for (const [chatId, inst] of instances) {
    const policy = access.groups[chatId]
    const timeout = policy?.idleTimeout ?? DEFAULT_IDLE_TIMEOUT
    if (now - inst.lastActivity > timeout) {
      dbg(`idle timeout for ${chatId} (${Math.round((now - inst.lastActivity) / 1000)}s)`)
      killInstance(chatId)
    }
  }
}, 30_000).unref()

// ── Message routing ─────────────────────────────────────────────────────────

function routeMessage(chatId: string, chatType: string, payload: Record<string, unknown>) {
  const access = readAccess()

  let workdir: string | undefined
  if (chatType === 'group') {
    workdir = access.groups[chatId]?.workdir
  }
  workdir = workdir ?? access.defaultWorkdir
  if (!workdir) {
    dbg(`no workdir configured for ${chatId}, dropping`)
    return
  }

  ensureInstance(chatId, workdir)
  writeMessage(chatId, payload)
}

async function handleInbound(data: any) {
  const ev = data.event ?? data
  const sender = ev.sender, message = ev.message
  if (!sender || !message) return

  const senderId: string = sender.sender_id?.open_id ?? ''
  const chatId: string = message.chat_id ?? ''
  const chatType: string = message.chat_type ?? 'p2p'
  const messageId: string = message.message_id ?? ''
  const msgType: string = message.message_type ?? (message as any).msg_type ?? 'text'
  const contentStr: string = message.content ?? message.body?.content ?? ''
  const mentions: any[] = message.mentions ?? []
  const createTime: string = message.create_time ?? ''
  if (!senderId || !chatId || !messageId) return

  let text = ''
  try { text = JSON.parse(contentStr).text ?? '' } catch { text = contentStr }

  const access = readAccess()

  // Access check
  if (chatType === 'p2p') {
    if (!access.allowFrom.includes(senderId)) { dbg(`dm from unknown ${senderId}, dropping`); return }
  } else {
    const policy = access.groups[chatId]
    if (!policy) { dbg(`group ${chatId} not configured, dropping`); return }
    if (policy.allowFrom.length > 0 && !policy.allowFrom.includes(senderId)) return
    const mentioned = checkMention(mentions, text, access.mentionPatterns)
    if ((policy.requireMention ?? true) && !mentioned) return
  }

  // Ack reaction
  if (access.ackReaction) {
    void (apiClient as any).im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: access.ackReaction } },
    }).catch(() => {})
  }

  // Build attachment info
  const atts: string[] = []
  if (msgType === 'file') { try { const c = JSON.parse(contentStr); atts.push(`${c.file_name ?? 'file'} (file, key:${c.file_key ?? ''})`) } catch {} }
  else if (msgType === 'image') { try { const c = JSON.parse(contentStr); atts.push(`image (image/jpeg, key:${c.image_key ?? ''})`) } catch {} }

  const ts = createTime
    ? new Date(parseInt(createTime) > 1e12 ? parseInt(createTime) : parseInt(createTime) * 1000).toISOString()
    : new Date().toISOString()
  const content = text || (atts.length ? '(attachment)' : '')
  if (!content) return

  dbg(`routing message from ${senderId} in ${chatId} (${chatType})`)
  routeMessage(chatId, chatType, {
    type: 'channel_message',
    content,
    meta: {
      chat_id: chatId,
      message_id: messageId,
      user: senderId,
      user_id: senderId,
      ts,
      chat_type: chatType,
      ...(atts.length ? { attachment_count: String(atts.length), attachments: atts.join('; ') } : {}),
    },
  })
}

async function handleCardAction(data: any): Promise<Record<string, unknown>> {
  const value = data?.action?.value ?? {}
  const code = value.code as string | undefined
  const action = value.action as string | undefined
  const chatId = data?.open_chat_id ?? ''
  if (!code || !action) return {}

  if (action === 'perm_allow' || action === 'perm_deny') {
    const behavior = action === 'perm_deny' ? 'deny' : 'allow'
    if (chatId) {
      // Route to the instance for this chat
      const access = readAccess()
      const targetChat = Object.keys(access.groups).find(gid => instances.has(gid)) ?? chatId
      writeMessage(targetChat, { type: 'permission_response', request_id: code, behavior })
    }
    const statusText = behavior === 'allow' ? '✅ 已允许' : '❌ 已拒绝'
    return {
      toast: { type: behavior === 'deny' ? 'info' : 'success', content: statusText },
      card: {
        type: 'raw',
        data: {
          schema: '2.0', config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: `🔐 Permission Request — ${statusText}` }, template: behavior === 'deny' ? 'grey' : 'green' },
          body: { elements: [{ tag: 'hr' }, { tag: 'markdown', content: `**${statusText}**` }] },
        },
      },
    }
  }

  if (action === 'confirm' || action === 'cancel') {
    const isConfirm = action === 'confirm'
    const targetChat = chatId || [...instances.keys()][0]
    if (targetChat) {
      writeMessage(targetChat, {
        type: 'confirm_response',
        content: isConfirm ? `CONFIRMED ${code}` : `CANCELLED ${code}`,
        meta: {
          chat_id: targetChat,
          message_id: `card-${Date.now()}`,
          user: 'system',
          user_id: 'system',
          ts: new Date().toISOString(),
          chat_type: 'p2p',
        },
      })
    }
    const statusText = isConfirm ? '✅ 已确认' : '❌ 已取消'
    return {
      toast: { type: isConfirm ? 'success' : 'info', content: statusText },
      card: {
        type: 'raw',
        data: {
          schema: '2.0', config: { wide_screen_mode: true },
          header: { title: { tag: 'plain_text', content: `⚡ 操作确认 — ${statusText}` }, template: isConfirm ? 'green' : 'grey' },
          body: { elements: [{ tag: 'hr' }, { tag: 'markdown', content: `**${statusText}**` }] },
        },
      },
    }
  }

  return {}
}

// ── Startup ─────────────────────────────────────────────────────────────────

dbg('router starting')
mkdirSync(ROUTER_DIR, { recursive: true })
await fetchBotOpenId()

const wsClient = new lark.WSClient({ appId: APP_ID, appSecret: APP_SECRET, loggerLevel: lark.LoggerLevel.warn })
const dispatcher = new lark.EventDispatcher({ encryptKey: ENCRYPT_KEY }).register({
  'im.message.receive_v1': async (data: any) => {
    dbg('im.message.receive_v1 fired')
    return handleInbound(data).catch(e => dbg(`handleInbound failed: ${e}`))
  },
  'card.action.trigger': async (data: any) => {
    dbg('card.action.trigger fired')
    return handleCardAction(data).catch(e => { dbg(`handleCardAction failed: ${e}`); return {} })
  },
})

wsClient.start({ eventDispatcher: dispatcher }).catch(e => dbg(`wsClient error: ${e}`))

// Status on SIGUSR1
process.on('SIGUSR1', () => {
  const lines = [`\n=== Router Status ===`, `instances: ${instances.size}`]
  for (const [chatId, inst] of instances) {
    const idle = Math.round((Date.now() - inst.lastActivity) / 1000)
    lines.push(`  ${chatId}: pid=${inst.proc.pid}, idle=${idle}s, cwd=${inst.workdir}`)
  }
  dbg(lines.join('\n'))
})

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return; shuttingDown = true
  dbg('shutting down — killing all instances')
  for (const [chatId] of instances) killInstance(chatId)
  try { (wsClient as any).disconnect?.() } catch {}
  setTimeout(() => process.exit(0), 3000)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

dbg(`router ready — ${Object.keys(readAccess().groups).length} groups configured`)

// Keep alive
await new Promise(() => {})
