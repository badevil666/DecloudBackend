const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const { createDealsForFile } = require('../controllers/dealController');

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
  } else if (msg.type === 'chunk_stored') {
    handleChunkStored(peerId, msg);
  } else if (msg.type === 'proof_response') {
    handleProofResponse(peerId, msg);
  } else {
    wsWarn(peerId, `unknown message type: "${msg.type}", ignored`);
  }
}

/**
 * Peer reports it has successfully stored a chunk.
 * Validates ownership via relay_sessions token, then flips chunk_replicas.status → ACTIVE.
 * If all replicas for the file are now ACTIVE, also sets files.status → 'STORED'.
 *
 * Expected message:
 * { type: "chunk_stored", token: "hex", fileId: "uuid", chunkIndex: 0 }
 */
async function handleChunkStored(peerId, msg) {
  const { token, fileId, chunkIndex } = msg;

  if (!token || !fileId || !Number.isInteger(chunkIndex) || chunkIndex < 0) {
    wsWarn(peerId, `chunk_stored — missing or invalid fields, ignored`);
    return;
  }

  try {
    // Verify the token belongs to this peer for this file, and the chunkIndex
    // is one they were assigned. Then flip the replica to ACTIVE.
    const { rowCount } = await query(
      `UPDATE chunk_replicas cr
       SET    status = 'ACTIVE'
       FROM   file_chunks    fc
       JOIN   relay_sessions rs ON rs.file_id  = fc.file_id
                                AND rs.peer_id  = $1
                                AND rs.token    = $2
                                AND $4          = ANY(rs.chunk_indexes)
       WHERE  fc.file_id        = $3
         AND  fc.chunk_index    = $4
         AND  cr.chunk_id       = fc.chunk_id
         AND  cr.current_peer_id = $1
         AND  cr.status          = 'PENDING'`,
      [peerId, token, fileId, chunkIndex]
    );

    if (rowCount === 0) {
      wsWarn(peerId, `chunk_stored — no matching PENDING replica  fileId: ${fileId}  chunk: ${chunkIndex}`);
      return;
    }

    wsLog(peerId, `✔ chunk_stored  fileId: ${fileId}  chunk: ${chunkIndex}  replica → ACTIVE`);

    // Atomically mark the file STORED only if ALL replicas are ACTIVE and
    // the file isn't already STORED. The WHERE clause guards against races
    // where two chunk_stored events arrive simultaneously — only one UPDATE
    // wins the status transition, preventing duplicate deal creation.
    const { rowCount: _storedCount } = await query(
      `UPDATE files
       SET status = 'STORED'
       WHERE file_id = $1
         AND status != 'STORED'
         AND (
           SELECT COUNT(*) FILTER (WHERE cr.status = 'ACTIVE') = COUNT(*)
           FROM file_chunks    fc
           JOIN chunk_replicas cr ON cr.chunk_id = fc.chunk_id
           WHERE fc.file_id = $1
         )`,
      [fileId]
    );

    if (_storedCount > 0) {
      wsLog(peerId, `★ all replicas ACTIVE — file ${fileId} → STORED`);
      setImmediate(() => {
        createDealsForFile(fileId).catch((err) =>
          wsErr(peerId, `createDealsForFile error for ${fileId}: ${err.message}`)
        );
      });
    }
  } catch (err) {
    wsErr(peerId, `chunk_stored DB error: ${err.message}`);
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

/**
 * Handle a proof_response from a peer.
 * Delegates to proofService for verification and on-chain release/slash.
 *
 * Expected message:
 * { type: "proof_response", dealId: "0x...", interval: 3, hash: "0x..." }
 */
function handleProofResponse(peerId, msg) {
  const { dealId, interval, hash } = msg;
  if (!dealId || !interval || !hash) {
    wsWarn(peerId, `proof_response — missing fields, ignored`);
    return;
  }
  wsLog(peerId, `proof_response  dealId: ${dealId.slice(0, 12)}…  interval: ${interval}`);

  // Lazy require to avoid circular dependency at module load time
  try {
    const { verifyProofResponse } = require('../services/proofService');
    verifyProofResponse(peerId, dealId, interval, hash).catch((err) => {
      wsErr(peerId, `proof verification error: ${err.message}`);
    });
  } catch (err) {
    wsErr(peerId, `proofService not available: ${err.message}`);
  }
}

/**
 * Notify a peer to push one specific chunk to the relay for a client download.
 * One message is sent per chunk so the peer knows the exact chunkIndex for each
 * relay connection. The relay must pair by (token + chunkIndex).
 * Fire-and-forget — no ACK expected.
 *
 * { type: "chunk_download_request", fileId, token, chunkIndex, relayUrl }
 */
function sendDownloadRequest(peerId, { fileId, token, chunkIndex, relayUrl }) {
  const ws = connectedPeers.get(peerId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    wsLog(peerId, `→ chunk_download_request  fileId: ${fileId}  chunk: ${chunkIndex}`);
    ws.send(JSON.stringify({ type: 'chunk_download_request', fileId, token, chunkIndex, relayUrl }));
  }
}

/**
 * Send a cancel_assignment notice to a peer (fire-and-forget, no ACK expected).
 */
function sendCancel(peerId, fileId, token) {
  const ws = connectedPeers.get(peerId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    wsLog(peerId, `→ cancel_assignment  fileId: ${fileId}  token: ${token.slice(0, 12)}…`);
    ws.send(JSON.stringify({ type: 'cancel_assignment', fileId, token }));
  }
}

/**
 * Notify a peer that a deal needs their EIP-712 signature.
 * Fire-and-forget — no ACK expected.
 *
 * { type: "deal_signing_request", dealId, fileId, merkleRoot,
 *   clientAddress, peerAddress, sizeBytes, durationBlocks,
 *   priceWei, peerEscrowWei, chunkHashes[], escrowAddress }
 */
function sendDealSigningRequest(peerId, dealData) {
  const ws = connectedPeers.get(peerId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    wsLog(peerId, `→ deal_signing_request  dealId: ${dealData.dealId?.slice(0, 12)}…`);
    ws.send(JSON.stringify({ type: 'deal_signing_request', ...dealData }));
  }
}

/**
 * Send a storage-proof challenge to a peer.
 * Fire-and-forget — peer responds with proof_response.
 *
 * { type: "proof_challenge", dealId, interval, nonce }
 */
function sendProofChallenge(peerId, { dealId, interval, nonce }) {
  const ws = connectedPeers.get(peerId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    wsLog(peerId, `→ proof_challenge  dealId: ${dealId.slice(0, 12)}…  interval: ${interval}`);
    ws.send(JSON.stringify({ type: 'proof_challenge', dealId, interval, nonce }));
  }
}

module.exports = {
  attachPeerWS, connectedPeers, getPeerCount,
  sendAssignment, sendCancel, sendDownloadRequest,
  sendDealSigningRequest, sendProofChallenge,
};
