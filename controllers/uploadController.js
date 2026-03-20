const crypto = require('crypto');
const { query } = require('../config/database');
const { allocateAndNotify } = require('../services/relayTokenService');
const { sendCancel } = require('../websocket/peerWS');

const isHex = (str) => typeof str === 'string' && /^[0-9a-fA-F]+$/.test(str);

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/* ─────────────────────────────────────────────────────────────────────────────
 * Pending upload store
 *
 * After phase 1 (POST /client/upload) the server holds allocation state here
 * until the client confirms (POST /client/upload/confirm).
 * Each entry has a TTL timer; expiry cancels the upload and notifies peers.
 * ───────────────────────────────────────────────────────────────────────────── */

const PENDING_TTL_MS = 2 * 60 * 1000; // 2 minutes

// sessionId → { clientId, fileId, merkleRoot, endDate, filename, fileHash,
//               filesize, replicationFactor, numberOfChunks, chunkInfo,
//               allocations, peerDeductions, peerAssignments, timerId }
const pendingUploads = new Map();

function cancelPendingUpload(sessionId) {
  const pending = pendingUploads.get(sessionId);
  if (!pending) return;
  clearTimeout(pending.timerId);
  pendingUploads.delete(sessionId);

  for (const [peerId, { token }] of Object.entries(pending.peerAssignments)) {
    sendCancel(peerId, pending.fileId, token);
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
 * PHASE 1  —  POST /client/upload
 *
 * Validates the request, runs greedy allocation, pushes chunk_assignment to
 * each peer via WebSocket, and waits for their ACKs (= storage peer confirmation).
 * Stores the allocation plan in pendingUploads under a sessionId and returns
 * 202 so the client can review the allocation before confirming.
 *
 * Request Body:
 * {
 *   "filename": "video.mp4",
 *   "filesize": 10485760,
 *   "fileHash": "abc123...",
 *   "numberOfChunks": 4,
 *   "replicationFactor": 3,
 *   "endDate": "2026-06-01T00:00:00.000Z",
 *   "chunkInfo": [
 *     {
 *       "hash": "chunkHash0...",
 *       "size": 2621440,
 *       "nonces": [
 *         { "nonce": "deadbeef...", "hash": "combined_hash..." }
 *       ]
 *     }
 *   ]
 * }
 *
 * Response (202):
 * {
 *   "sessionId": "uuid",
 *   "fileId": "uuid",
 *   "merkleRoot": "hex",
 *   "peers": { "<peer_id>": { "token": "hex", "chunkIndexes": [0, 1] }, ... },
 *   "expiresIn": 120
 * }
 * ───────────────────────────────────────────────────────────────────────────── */
const uploadFile = async (req, res, next) => {
  try {
    const {
      filename,
      filesize,
      fileHash,
      numberOfChunks,
      replicationFactor,
      endDate,
      chunkInfo,
    } = req.body;

    const { sub: clientId } = req.user;

    /* ================= BASIC VALIDATION ================= */

    if (!filename || typeof filename !== 'string') {
      return res.status(400).json({ error: 'filename is required' });
    }

    if (!Number.isInteger(filesize) || filesize <= 0) {
      return res.status(400).json({ error: 'filesize must be a positive integer (bytes)' });
    }

    if (!isHex(fileHash)) {
      return res.status(400).json({ error: 'fileHash must be a hex string' });
    }

    if (!Number.isInteger(numberOfChunks) || numberOfChunks <= 0) {
      return res.status(400).json({ error: 'numberOfChunks must be a positive integer' });
    }

    if (!Number.isInteger(replicationFactor) || replicationFactor <= 0) {
      return res.status(400).json({ error: 'replicationFactor must be a positive integer' });
    }

    if (!endDate || isNaN(Date.parse(endDate))) {
      return res.status(400).json({ error: 'endDate must be a valid ISO date string' });
    }

    /* ================= CHUNK VALIDATION ================= */

    if (!Array.isArray(chunkInfo) || chunkInfo.length !== numberOfChunks) {
      return res.status(400).json({ error: `chunkInfo must be an array of ${numberOfChunks} chunks` });
    }

    const seenNonces = new Set();
    let totalChunkBytes = 0;

    for (let i = 0; i < numberOfChunks; i++) {
      const chunk = chunkInfo[i];

      if (!chunk || !isHex(chunk.hash)) {
        return res.status(400).json({ error: `Invalid chunk hash at index ${i}` });
      }

      if (!Number.isInteger(chunk.size) || chunk.size <= 0) {
        return res.status(400).json({ error: `chunk ${i}: size must be a positive integer (bytes)` });
      }

      totalChunkBytes += chunk.size;

      if (!Array.isArray(chunk.nonces) || chunk.nonces.length === 0) {
        return res.status(400).json({ error: `chunk ${i} must have at least one nonce` });
      }

      for (let j = 0; j < chunk.nonces.length; j++) {
        const { nonce, hash } = chunk.nonces[j];

        if (!isHex(nonce) || !isHex(hash)) {
          return res.status(400).json({ error: `Invalid nonce or hash at chunk ${i}, nonce ${j}` });
        }

        if (seenNonces.has(nonce)) {
          return res.status(400).json({ error: `Nonce reuse detected at chunk ${i}, nonce ${j}` });
        }
        seenNonces.add(nonce);
      }
    }

    if (totalChunkBytes < filesize) {
      return res.status(400).json({
        error: `Total chunk sizes (${totalChunkBytes} bytes) is less than filesize (${filesize} bytes)`,
      });
    }

    /* ================= MERKLE ROOT ================= */

    const merkleRoot = sha256(chunkInfo.map((c) => c.hash).join(''));

    /* ================= LOAD ACTIVE PEERS ================= */

    const { rows: activePeers } = await query(
      `SELECT peer_id, available_space
       FROM storage_peers
       WHERE peer_status = 'ACTIVE'
       ORDER BY available_space DESC`
    );

    /* ================= PRE-GENERATE FILE ID ================= */

    const fileId = crypto.randomUUID();

    /* ================= ALLOCATE + NOTIFY PEERS (storage peer confirmation) ===
     * allocateAndNotify pushes WS chunk_assignment messages and waits for ACKs.
     * A successful return means every allocated peer has confirmed.
     * ======================================================================= */

    const { allocations, peerDeductions, peerAssignments } = await allocateAndNotify(
      activePeers,
      chunkInfo,
      replicationFactor,
      fileId
    );

    /* ================= STORE PENDING STATE ================= */

    const sessionId = crypto.randomUUID();

    const timerId = setTimeout(() => {
      cancelPendingUpload(sessionId);
    }, PENDING_TTL_MS);

    pendingUploads.set(sessionId, {
      clientId,
      fileId,
      merkleRoot,
      endDate,
      filename,
      fileHash,
      filesize,
      replicationFactor,
      numberOfChunks,
      chunkInfo,
      allocations,
      peerDeductions,
      peerAssignments,
      timerId,
    });

    /* ================= AWAIT CLIENT CONFIRMATION ================= */

    return res.status(202).json({
      sessionId,
      fileId,
      merkleRoot,
      peers: peerAssignments,
      expiresIn: PENDING_TTL_MS / 1000,
    });

  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

/* ─────────────────────────────────────────────────────────────────────────────
 * PHASE 2  —  POST /client/upload/confirm
 *
 * Client confirms the allocation returned from phase 1. This triggers the DB
 * transaction that persists the file, chunks, replicas, commitments, relay
 * sessions, and peer space deductions.
 *
 * Request Body:
 * {
 *   "sessionId": "uuid"
 * }
 *
 * Response (201):
 * {
 *   "fileId": "uuid",
 *   "merkleRoot": "hex",
 *   "status": "ALLOCATED",
 *   "peers": { "<peer_id>": { "token": "hex", "chunkIndexes": [0, 1] }, ... }
 * }
 * ───────────────────────────────────────────────────────────────────────────── */
const confirmUpload = async (req, res, next) => {
  let txStarted = false;
  try {
    const { sessionId } = req.body;
    const { sub: clientId } = req.user;

    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }

    const pending = pendingUploads.get(sessionId);

    if (!pending) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    if (pending.clientId !== clientId) {
      return res.status(403).json({ error: 'Session does not belong to this client' });
    }

    // Claim the session immediately to prevent double-confirm races
    clearTimeout(pending.timerId);
    pendingUploads.delete(sessionId);

    const {
      fileId, merkleRoot, endDate, filename, fileHash, filesize,
      replicationFactor, numberOfChunks, chunkInfo,
      allocations, peerDeductions, peerAssignments,
    } = pending;

    /* ================= DB TRANSACTION ================= */

    await query('BEGIN');
    txStarted = true;

    /* --- FILE --- */

    await query(
      `INSERT INTO files
       (file_id, owner_id, file_name, file_hash, file_size, merkle_root, status, end_date, replication_factor, chunking_factor)
       VALUES ($1, $2, $3, $4, $5, $6, 'ALLOCATED', $7, $8, $9)`,
      [fileId, clientId, filename, fileHash, filesize, merkleRoot, endDate, replicationFactor, numberOfChunks]
    );

    /* --- FILE CHUNKS --- */

    const chunkValues = [];
    const chunkParams = [];
    let p = 1;

    for (let i = 0; i < numberOfChunks; i++) {
      chunkValues.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
      chunkParams.push(fileId, i, chunkInfo[i].hash, chunkInfo[i].size);
    }

    const chunkInsert = await query(
      `INSERT INTO file_chunks (file_id, chunk_index, chunk_hash, chunk_size)
       VALUES ${chunkValues.join(',')}
       RETURNING chunk_id, chunk_index`,
      chunkParams
    );

    const chunkRows = chunkInsert.rows.sort((a, b) => a.chunk_index - b.chunk_index);

    /* --- CHUNK REPLICAS --- */

    const replicaValues = [];
    const replicaParams = [];
    p = 1;

    for (let i = 0; i < numberOfChunks; i++) {
      const chunkId = chunkRows[i].chunk_id;
      for (let r = 0; r < replicationFactor; r++) {
        replicaValues.push(`($${p++}, $${p++}, $${p++}, 'PENDING')`);
        replicaParams.push(chunkId, r, allocations[i][r]);
      }
    }

    const replicaInsert = await query(
      `INSERT INTO chunk_replicas (chunk_id, replica_index, current_peer_id, status)
       VALUES ${replicaValues.join(',')}
       RETURNING replica_id, chunk_id`,
      replicaParams
    );

    /* --- REPLICA COMMITMENTS --- */

    const chunkIdToIndex = {};
    for (const row of chunkRows) {
      chunkIdToIndex[row.chunk_id] = row.chunk_index;
    }

    const commitValues = [];
    const commitParams = [];
    p = 1;

    for (const replica of replicaInsert.rows) {
      const chunkIndex = chunkIdToIndex[replica.chunk_id];
      const chunkData = chunkInfo[chunkIndex];

      for (let j = 0; j < chunkData.nonces.length; j++) {
        const { nonce, hash } = chunkData.nonces[j];
        commitValues.push(`($${p++}, $${p++}, $${p++}, $${p++})`);
        commitParams.push(replica.replica_id, j, nonce, hash);
      }
    }

    await query(
      `INSERT INTO replica_commitments (replica_id, interval_index, nonce_commitment, expected_hash)
       VALUES ${commitValues.join(',')}`,
      commitParams
    );

    /* --- RELAY SESSIONS --- */

    const sessionValues = [];
    const sessionParams = [];
    p = 1;
    const expiresAt = new Date(endDate);

    for (const [peerId, { token, chunkIndexes }] of Object.entries(peerAssignments)) {
      sessionValues.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++})`);
      sessionParams.push(fileId, peerId, clientId, token, chunkIndexes, expiresAt);
    }

    await query(
      `INSERT INTO relay_sessions (file_id, peer_id, client_id, token, chunk_indexes, expires_at)
       VALUES ${sessionValues.join(',')}`,
      sessionParams
    );

    /* --- DEDUCT AVAILABLE SPACE FROM PEERS --- */

    for (const [peerId, deduction] of Object.entries(peerDeductions)) {
      await query(
        `UPDATE storage_peers SET available_space = available_space - $1 WHERE peer_id = $2`,
        [deduction, peerId]
      );
    }

    /* --- COMMIT --- */

    await query('COMMIT');

    return res.status(201).json({
      fileId,
      merkleRoot,
      status: 'ALLOCATED',
      peers: peerAssignments,
    });

  } catch (err) {
    if (txStarted) await query('ROLLBACK');
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

/* ─────────────────────────────────────────────────────────────────────────────
 * OPTIONAL  —  POST /client/upload/cancel
 *
 * Explicitly cancel a pending upload before it expires. Notifies peers and
 * frees the in-memory slot immediately.
 *
 * Request Body: { "sessionId": "uuid" }
 * Response (200): { "cancelled": true }
 * ───────────────────────────────────────────────────────────────────────────── */
const cancelUpload = (req, res) => {
  const { sessionId } = req.body;
  const { sub: clientId } = req.user;

  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  const pending = pendingUploads.get(sessionId);

  if (!pending) {
    return res.status(404).json({ error: 'Session not found or already expired' });
  }

  if (pending.clientId !== clientId) {
    return res.status(403).json({ error: 'Session does not belong to this client' });
  }

  cancelPendingUpload(sessionId);
  return res.status(200).json({ cancelled: true });
};

module.exports = { uploadFile, confirmUpload, cancelUpload };
