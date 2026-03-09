const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const { query } = require('../config/database');

const JWT_SECRET = process.env.JWT_SECRET;

const PING_INTERVAL_MS = 30_000;

// peerId → ws
const connectedPeers = new Map();

// relay token → { resolve, reject }
const pendingAcks = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// WS Logger helpers
// ─────────────────────────────────────────────────────────────────────────────

const ts = () => new Date().toISOString();

const wsLog  = (peerId, msg)  => console.log( `\n  [WS ◈] ${ts()}  peer: ${peerId ?? 'unknown'}\n         ${msg}`);
const wsWarn = (peerId, msg)  => console.warn( `\n  [WS ⚠] ${ts()}  peer: ${peerId ?? 'unknown'}\n         ${msg}`);
const wsErr  = (peerId, msg)  => console.error(`\n  [WS ✘] ${ts()}  peer: ${peerId ?? 'unknown'}\n         ${msg}`);

const wsSect = (title) =>
  console.log(`\n${'━'.repeat(60)}\n  [WS] ${title}\n${'━'.repeat(60)}`);

// ─────────────────────────────────────────────────────────────────────────────

function getPeerCount() {
  return connectedPeers.size;
}

async function setPeerStatus(peerId, status) {
  await query(
    `UPDATE storage_peers SET peer_status = $1 WHERE peer_id = $2`,
    [status, peerId]
  );
}

async function updateHeartbeat(peerId) {
  await query(
    `UPDATE storage_peers SET last_heartbeat = NOW() WHERE peer_id = $1`,
    [peerId]
  );
}

/**
 * Send a chunk_assignment to a peer and await their ACK.
 * Rejects if the peer is offline or doesn't ACK within timeoutMs.
 */
function sendAssignment(peerId, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ws = connectedPeers.get(peerId);

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      wsWarn(peerId, `sendAssignment — peer not connected, skipping`);
      return reject(new Error(`Peer ${peerId} is not connected`));
    }

    wsLog(peerId, `→ chunk_assignment  chunks: [${payload.chunkIndexes}]  token: ${payload.token.slice(0, 12)}…`);

    const timer = setTimeout(() => {
      pendingAcks.delete(payload.token);
      wsWarn(peerId, `✘ ACK timeout after ${timeoutMs}ms  token: ${payload.token.slice(0, 12)}…`);
      reject(new Error(`Peer ${peerId} did not ACK within ${timeoutMs}ms`));
    }, timeoutMs);

    pendingAcks.set(payload.token, {
      resolve: () => { clearTimeout(timer); resolve(); },
      reject:  () => { clearTimeout(timer); reject(new Error(`Peer ${peerId} rejected assignment`)); },
    });

    ws.send(JSON.stringify(payload));
  });
}

function handlePeerMessage(peerId, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    wsWarn(peerId, `malformed message (non-JSON), ignored`);
    return;
  }

  if (msg.type === 'chunk_assignment_ack' && msg.token) {
    const pending = pendingAcks.get(msg.token);
    if (pending) {
      pendingAcks.delete(msg.token);
      wsLog(peerId, `✔ chunk_assignment_ack  token: ${msg.token.slice(0, 12)}…`);
      pending.resolve();
    } else {
      wsWarn(peerId, `chunk_assignment_ack for unknown token: ${msg.token.slice(0, 12)}… (already expired?)`);
    }
  } else {
    wsWarn(peerId, `unknown message type: "${msg.type}", ignored`);
  }
}

function attachPeerWS(server) {
  const wss = new WebSocketServer({ server, path: '/peer/ws' });

  wss.on('connection', (ws) => {
    let peerId = null;
    let pingTimer = null;
    let isAlive = true;

    wsLog(null, `new raw connection (awaiting auth)  total: ${connectedPeers.size + 1}`);

    const cleanup = async () => {
      clearInterval(pingTimer);
      if (peerId) {
        connectedPeers.delete(peerId);
        try {
          await setPeerStatus(peerId, 'IDLE');
        } catch (err) {
          wsErr(peerId, `failed to set IDLE status: ${err.message}`);
        }
        wsSect(`PEER OFFLINE  ${peerId}  →  IDLE  (${connectedPeers.size} online)`);
      }
    };

    const startPing = () => {
      pingTimer = setInterval(() => {
        if (!isAlive) {
          wsWarn(peerId, `missed pong — no response to last ping, terminating → IDLE`);
          ws.terminate();
          return;
        }
        isAlive = false;
        ws.ping();
      }, PING_INTERVAL_MS);
    };

    ws.on('pong', async () => {
      isAlive = true;
      if (peerId) {
        try {
          await updateHeartbeat(peerId);
          wsLog(peerId, `♡ pong received  last_heartbeat updated`);
        } catch (err) {
          wsErr(peerId, `failed to update heartbeat: ${err.message}`);
        }
      }
    });

    // ── AUTH (first message only) ────────────────────────────────────────────
    ws.once('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        wsWarn(null, `auth failed — invalid JSON, closing with 4000`);
        ws.close(4000, 'Invalid JSON');
        return;
      }

      if (msg.type !== 'auth' || !msg.jwt) {
        wsWarn(null, `auth failed — first message was not { type:"auth", jwt }, closing with 4001`);
        ws.close(4001, 'First message must be { type: "auth", jwt: "..." }');
        return;
      }

      let decoded;
      try {
        decoded = jwt.verify(msg.jwt, JWT_SECRET);
      } catch {
        wsWarn(null, `auth failed — JWT invalid or expired, closing with 4002`);
        ws.close(4002, 'Invalid or expired JWT');
        return;
      }

      if (decoded.role !== 'STORAGE_PEER') {
        wsWarn(decoded.sub, `auth failed — role "${decoded.role}" is not STORAGE_PEER, closing with 4003`);
        ws.close(4003, 'STORAGE_PEER role required');
        return;
      }

      peerId = decoded.sub;

      // Replace any stale connection for this peer
      const existing = connectedPeers.get(peerId);
      if (existing) {
        wsWarn(peerId, `existing connection found — closing stale socket with 4004`);
        existing.close(4004, 'Replaced by new connection');
      }

      connectedPeers.set(peerId, ws);

      try {
        await setPeerStatus(peerId, 'ACTIVE');
        await updateHeartbeat(peerId);
      } catch (err) {
        wsErr(peerId, `DB error during connect: ${err.message} — closing with 4005`);
        ws.close(4005, 'DB error');
        return;
      }

      wsSect(`PEER ONLINE  ${peerId}  →  ACTIVE  (${connectedPeers.size} online)`);
      wsLog(peerId, `wallet: ${decoded.wallet_address}  ping every ${PING_INTERVAL_MS / 1000}s`);

      ws.send(JSON.stringify({ type: 'auth_ok', peerId }));

      ws.on('message', (raw) => handlePeerMessage(peerId, raw));
      startPing();
    });

    ws.on('close', (code, reason) => {
      if (peerId) wsLog(peerId, `socket closed  code: ${code}  reason: ${reason?.toString() || 'none'}`);
      cleanup();
    });

    ws.on('error', (err) => {
      wsErr(peerId, `socket error: ${err.message}`);
    });
  });

  wsSect('Peer WebSocket server ready at /peer/ws');
  return wss;
}

module.exports = { attachPeerWS, connectedPeers, getPeerCount, sendAssignment };
