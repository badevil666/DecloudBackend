'use strict';
/**
 * controllers/downloadController.js
 *
 * POST /client/files/:fileId/download
 *
 * Mirrors the upload flow in reverse:
 *   Upload:   coordinator assigns chunks → peers store → relay carries client→peer
 *   Download: coordinator assigns chunks → peers serve → relay carries peer→client
 *
 * Steps:
 *   1. Verify file ownership and that it has been fully stored.
 *   2. For each chunk, pick the best available replica
 *      (status=ACTIVE, peer_status=ACTIVE, peer connected via WS right now).
 *   3. Generate a fresh relay token per peer (upload tokens are stale after upload completes).
 *   4. Push `chunk_download_request` to each involved peer via WebSocket.
 *   5. Return the download manifest to the client.
 *
 * The client uses the manifest to connect to the relay server per chunk.
 * The peer uses the WS push to know it should push that chunk to the relay.
 *
 * Response (200):
 * {
 *   "fileId": "uuid",
 *   "filename": "video.mp4",
 *   "filesize": 10485760,
 *   "merkleRoot": "hex",
 *   "relayUrl": "wss://relay.example.com",   // from RELAY_SERVER_URL env var
 *   "chunks": [
 *     {
 *       "chunkIndex": 0,
 *       "chunkHash": "hex",
 *       "chunkSize": 2621440,
 *       "peerId": "uuid",
 *       "token": "hex"       // fresh relay token generated for this download request
 *     }
 *   ]
 * }
 */

const crypto = require('crypto');
const { query } = require('../config/database');
const { connectedPeers } = require('../websocket/peerWS');
const { sendDownloadRequest } = require('../websocket/peerWS');

const requestDownload = async (req, res, next) => {
  try {
    const { fileId } = req.params;
    const { sub: clientId } = req.user;

    /* ── 1. Verify file ownership ─────────────────────────────────────────── */

    const { rows: fileRows } = await query(
      `SELECT file_id, file_name, file_size, merkle_root, status, chunking_factor
       FROM files
       WHERE file_id = $1 AND owner_id = $2`,
      [fileId, clientId]
    );

    if (fileRows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const file = fileRows[0];

    if (file.status !== 'STORED') {
      return res.status(409).json({
        error: `File is not fully stored yet (status: ${file.status})`,
      });
    }

    /* ── 2. Fetch all ACTIVE replicas ────────────────────────────────────── */
    // File ownership already verified above. chunk_replicas.current_peer_id
    // with status=ACTIVE tells us which peer holds each chunk.

    const { rows: replicaRows } = await query(
      `SELECT
         fc.chunk_index                 AS "chunkIndex",
         fc.chunk_hash                  AS "chunkHash",
         fc.chunk_size                  AS "chunkSize",
         cr.current_peer_id             AS "peerId"
       FROM file_chunks    fc
       JOIN chunk_replicas cr ON cr.chunk_id        = fc.chunk_id
                              AND cr.status          = 'ACTIVE'
       JOIN storage_peers  sp ON sp.peer_id          = cr.current_peer_id
                              AND sp.peer_status      = 'ACTIVE'
       WHERE fc.file_id = $1
       ORDER BY fc.chunk_index, sp.last_heartbeat DESC`,
      [fileId]
    );

    /* ── 3. Pick best replica per chunk (must be WS-connected right now) ──── */
    // replicaRows is sorted by chunk_index then recency of heartbeat.
    // Take the first WS-connected peer for each chunk.

    const chunkMap = new Map(); // chunkIndex → best replica row
    const peerTokens = new Map(); // peerId → fresh download token (one per peer)

    for (const row of replicaRows) {
      if (chunkMap.has(row.chunkIndex)) continue; // already picked a peer for this chunk
      if (!connectedPeers.has(row.peerId)) continue; // peer not online right now
      if (!peerTokens.has(row.peerId)) {
        peerTokens.set(row.peerId, crypto.randomBytes(32).toString('hex'));
      }
      chunkMap.set(row.chunkIndex, { ...row, token: peerTokens.get(row.peerId) });
    }

    /* ── 4. Ensure every chunk is covered ────────────────────────────────── */

    const numberOfChunks = file.chunking_factor;
    const unavailable = [];

    for (let i = 0; i < numberOfChunks; i++) {
      if (!chunkMap.has(i)) unavailable.push(i);
    }

    if (unavailable.length > 0) {
      return res.status(503).json({
        error: `${unavailable.length} chunk(s) are not currently available: [${unavailable.join(', ')}]. Try again later.`,
      });
    }

    /* ── 5. Push one chunk_download_request per chunk via WS ─────────────── */
    // One message per chunk (not grouped) so the peer knows the exact chunkIndex
    // for each relay connection. The relay must pair by (token + chunkIndex),
    // not by token alone — otherwise a peer serving multiple chunks can't tell
    // which chunk a given relay connection is asking for.

    const relayUrl = process.env.RELAY_SERVER_URL ?? null;

    for (const [chunkIndex, row] of chunkMap) {
      sendDownloadRequest(row.peerId, { fileId, token: row.token, chunkIndex, relayUrl });
    }

    /* ── 6. Build and return the manifest ────────────────────────────────── */

    const chunks = [];
    for (let i = 0; i < numberOfChunks; i++) {
      const row = chunkMap.get(i);
      chunks.push({
        chunkIndex: row.chunkIndex,
        chunkHash:  row.chunkHash,
        chunkSize:  row.chunkSize,
        peerId:     row.peerId,
        token:      row.token,
      });
    }

    return res.json({
      fileId,
      filename:   file.file_name,
      filesize:   file.file_size,
      merkleRoot: file.merkle_root,
      relayUrl:   process.env.RELAY_SERVER_URL ?? null,
      chunks,
    });

  } catch (err) {
    next(err);
  }
};

module.exports = { requestDownload };
