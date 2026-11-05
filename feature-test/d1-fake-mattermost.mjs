// Minimal fake Mattermost for the D1 isolated suite.
//
// Why this exists: the real suite needs a live Mattermost, and the only bot
// token on this host is the PRODUCTION one. Starting a second instance with it
// would open a second WebSocket consumer on the live bot account — explicitly
// forbidden. This server speaks just enough of the v4 API for the plugin's
// transport (users/me, channels, posts, WebSocket upgrade) and records every
// outbound message in memory, so the D1 cases can assert on what the bot
// replied without touching any real deployment.
//
//   node feature-test/d1-fake-mattermost.mjs <port> <channelId> [botId] [username]
//
// Read back what was posted: GET /__posts
import http from 'node:http'
import { createRequire } from 'node:module'

const require = createRequire('/opt/node-v24.20.0/lib/node_modules/@deepseek-ai/dsh/node_modules/ws/index.js')
const { WebSocketServer } = require('ws')

const PORT = Number(process.argv[2] || 3099)
const CHANNEL = process.argv[3] || 'd1chan'
const BOT_ID = process.argv[4] || 'devbot0000000000000000000'
const BOT_USERNAME = process.argv[5] || 'dsh'
// The human the fake DM/G membership lists contain. Only the approval router
// reads it; the D1 suite never needs it.
const HUMAN_ID = process.argv[6] || 'human0000000000000000000000'

/** Channel shape by id convention: `dm…` direct, `gdm…` group DM, else channel. */
function channelType(id) {
  if (id.startsWith('gdm')) return 'G'
  if (id.startsWith('dm')) return 'D'
  return 'O'
}

const botUser = {
  id: BOT_ID,
  username: BOT_USERNAME,
  is_bot: true,
  delete_at: 0,
  roles: 'system_user',
}
const channel = { id: CHANNEL, type: channelType(CHANNEL), name: 'd1-isolated', display_name: 'D1 isolated' }

const posts = []
let seq = 0
const nextPostId = () => `fake${String(++seq).padStart(21, '0')}`

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const json = (code, value) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(value))
  }
  const body = await new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')) } catch { resolve({}) }
    })
  })

  if (url.pathname === '/__posts' && req.method === 'GET') return json(200, posts)
  if (url.pathname === '/__reset') { posts.length = 0; return json(200, { ok: true }) }

  if (url.pathname === '/api/v4/users/me' && req.method === 'GET') return json(200, botUser)
  if (url.pathname === '/api/v4/users/me/channels' && req.method === 'GET') return json(200, [channel])
  const channelMatch = /^\/api\/v4\/channels\/([A-Za-z0-9_-]+)$/.exec(url.pathname)
  if (channelMatch && req.method === 'GET') {
    const id = channelMatch[1]
    if (id === 'missingchan') return json(404, { id: 'not_found', message: 'no such channel' })
    return json(200, { id, type: channelType(id), name: id })
  }

  // Membership is what the approval router needs to tell a one-to-one DM from a
  // group DM or a channel. The channel NAME carries the shape here: `dm…` is a
  // direct message, `gdm…` a group DM, everything else a channel.
  const memberMatch = /^\/api\/v4\/channels\/([A-Za-z0-9_-]+)\/members$/.exec(url.pathname)
  if (memberMatch && req.method === 'GET') {
    const id = memberMatch[1]
    if (id === 'missingchan') return json(404, { id: 'not_found', message: 'no such channel' })
    const type = channelType(id)
    const members = type === 'D' ? [botUser.id, HUMAN_ID]
      : type === 'G' ? [botUser.id, HUMAN_ID, 'other000000000000000000000']
        : [botUser.id, HUMAN_ID]
    return json(200, members.map((user_id) => ({ channel_id: id, user_id, roles: '' })))
  }

  if (url.pathname === '/api/v4/posts' && req.method === 'POST') {
    if (body.channel_id === 'failchan') {
      return json(500, { id: 'store.sql_error', message: 'injected delivery failure' })
    }
    const post = {
      id: nextPostId(),
      channel_id: body.channel_id || CHANNEL,
      root_id: body.root_id || '',
      user_id: BOT_ID,
      message: String(body.message ?? ''),
      props: body.props || {},
      create_at: Date.now(),
      update_at: Date.now(),
      delete_at: 0,
      type: '',
    }
    posts.push(post)
    return json(201, post)
  }
  if (url.pathname.startsWith('/api/v4/posts/') && (req.method === 'PUT' || req.method === 'PATCH')) {
    const id = url.pathname.split('/').pop()
    const found = posts.find((p) => p.id === id)
    if (!found) return json(404, { id: 'not_found', message: 'no such post' })
    if (body.message !== undefined) found.message = String(body.message)
    if (body.props !== undefined) found.props = body.props
    found.update_at = Date.now()
    return json(200, found)
  }

  const listMatch = /^\/api\/v4\/channels\/([A-Za-z0-9_-]+)\/posts$/.exec(url.pathname)
  if (listMatch && req.method === 'GET') {
    const want = listMatch[1]
    // The plugin's reconnect backfill always carries `since=`; answer it empty so
    // recorded posts are never replayed into the inbound handler. The suite reads
    // the endpoint without `since` and gets the real list it needs to assert on.
    if (url.searchParams.has('since')) {
      return json(200, { order: [], posts: {}, next_post_id: '', prev_post_id: '' })
    }
    const list = posts.filter((p) => p.channel_id === want).slice(-200)
    const map = {}
    for (const p of list) map[p.id] = p
    return json(200, { order: list.map((p) => p.id).reverse(), posts: map, next_post_id: '', prev_post_id: '' })
  }

  return json(404, { id: 'not_found', message: `fake mattermost: ${req.method} ${url.pathname}` })
})

const wss = new WebSocketServer({ server, path: '/api/v4/websocket' })
wss.on('connection', (socket) => {
  // The plugin marks itself connected on 'open' and only then starts sending;
  // nothing has to be spoken for that. Ignore application-level pings.
  socket.on('message', () => {})
  socket.on('error', () => {})
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fake-mattermost listening on http://127.0.0.1:${PORT} channel=${CHANNEL} bot=${BOT_ID}`)
})
