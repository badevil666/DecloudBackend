const { query } = require('../config/database');
const { sendDeleteChunks, sendDealSlashedByClient } = require('../websocket/peerWS');
const { slashDealOnChain } = require('../services/settlementService');

const HEARTBEAT_THRESHOLD_MINUTES = 5;

/**
 * GET /client/files          → all files for the client
 * GET /client/files/:fileId  → full detail for one file (chunks + replicas + relay sessions)
 * Auth: Authorization: Bearer <token>
 */
const getFiles = async (req, res, next) => {
  try {
    const { sub: clientId } = req.user;
    const { fileId } = req.params;
    
    /* ── SINGLE FILE ─────────────────────────────────────────────────────── */
    if (fileId) {
      const fileResult = await query(
        `SELECT
           f.file_id            AS "fileId",
           f.file_name          AS "filename",
           f.file_hash          AS "fileHash",
           f.file_size          AS "filesize",
           f.merkle_root        AS "merkleRoot",
           f.status,
           f.replication_factor AS "replicationFactor",
           f.chunking_factor    AS "numberOfChunks",
           f.created_at         AS "createdAt",
           f.end_date           AS "endDate",
           (
             SELECT COUNT(DISTINCT fc2.chunk_id) FILTER (
               WHERE cr2.status        = 'ACTIVE'
                 AND sp2.peer_status   = 'ACTIVE'
                 AND sp2.last_heartbeat >= NOW() - ($3 * INTERVAL '1 minute')
             ) = COUNT(DISTINCT fc2.chunk_id)
             FROM file_chunks    fc2
             LEFT JOIN chunk_replicas cr2 ON cr2.chunk_id      = fc2.chunk_id
             LEFT JOIN storage_peers  sp2 ON sp2.peer_id       = cr2.current_peer_id
             WHERE fc2.file_id = f.file_id
           ) AS "isAvailable"
         FROM files f
         WHERE f.file_id = $1 AND f.owner_id = $2`,
        [fileId, clientId, HEARTBEAT_THRESHOLD_MINUTES]
      );

      if (fileResult.rows.length === 0) {
        return res.status(404).json({ error: 'File not found' });
      }

      // Chunks + replicas
      const chunkResult = await query(
        `SELECT
           fc.chunk_index       AS "chunkIndex",
           fc.chunk_hash        AS "chunkHash",
           fc.chunk_size        AS "chunkSize",
           cr.replica_index     AS "replicaIndex",
           cr.current_peer_id   AS "peerId",
           cr.status            AS "replicaStatus",
           sp.peer_status       AS "peerStatus",
           sp.last_heartbeat    AS "peerLastHeartbeat"
         FROM file_chunks fc
         LEFT JOIN chunk_replicas cr ON cr.chunk_id      = fc.chunk_id
         LEFT JOIN storage_peers  sp ON sp.peer_id       = cr.current_peer_id
         WHERE fc.file_id = $1
         ORDER BY fc.chunk_index, cr.replica_index`,
        [fileId]
      );

      const chunkMap = {};
      for (const row of chunkResult.rows) {
        if (!chunkMap[row.chunkIndex]) {
          chunkMap[row.chunkIndex] = {
            chunkIndex: row.chunkIndex,
            chunkHash: row.chunkHash,
            chunkSize: row.chunkSize,
            replicas: [],
          };
        }
        if (row.replicaIndex !== null) {
          chunkMap[row.chunkIndex].replicas.push({
            replicaIndex: row.replicaIndex,
            peerId: row.peerId,
            status: row.replicaStatus,
            peerStatus: row.peerStatus,
            peerLastHeartbeat: row.peerLastHeartbeat,
          });
        }
      }

      // Relay sessions
      const relayResult = await query(
        `SELECT
           peer_id       AS "peerId",
           token,
           chunk_indexes AS "chunkIndexes",
           expires_at    AS "expiresAt"
         FROM relay_sessions
         WHERE file_id = $1 AND client_id = $2
         ORDER BY created_at`,
        [fileId, clientId]
      );

      return res.json({
        ...fileResult.rows[0],
        chunks: Object.values(chunkMap),
        relaySessions: relayResult.rows,
      });
    }

    /* ── FILE LIST ───────────────────────────────────────────────────────── */
    const { rows } = await query(
      `SELECT
         f.file_id            AS "fileId",
         f.file_name          AS "filename",
         f.file_hash          AS "fileHash",
         f.file_size          AS "filesize",
         f.merkle_root        AS "merkleRoot",
         f.status,
         f.replication_factor AS "replicationFactor",
         f.chunking_factor    AS "numberOfChunks",
         f.created_at         AS "createdAt",
         f.end_date           AS "endDate",
         COUNT(fc.chunk_id)::INT AS "chunkCount",
         (
           SELECT COUNT(DISTINCT fc2.chunk_id) FILTER (
             WHERE cr2.status        = 'ACTIVE'
               AND sp2.peer_status   = 'ACTIVE'
               AND sp2.last_heartbeat >= NOW() - ($2 * INTERVAL '1 minute')
           ) = COUNT(DISTINCT fc2.chunk_id)
           FROM file_chunks    fc2
           LEFT JOIN chunk_replicas cr2 ON cr2.chunk_id      = fc2.chunk_id
           LEFT JOIN storage_peers  sp2 ON sp2.peer_id       = cr2.current_peer_id
           WHERE fc2.file_id = f.file_id
         ) AS "isAvailable"
       FROM files f
       LEFT JOIN file_chunks fc ON fc.file_id = f.file_id
       WHERE f.owner_id = $1
       GROUP BY f.file_id
       ORDER BY f.created_at DESC`,
      [clientId, HEARTBEAT_THRESHOLD_MINUTES]
    );

    return res.json({ files: rows });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /client/files/:fileId
 * Permanently delete a file and all associated data.
 * Only the file owner can delete.
 */
const deleteFile = async (req, res, next) => {
  try {
    const { sub: clientId } = req.user;
    const { fileId } = req.params;

    const check = await query(
      'SELECT file_id FROM files WHERE file_id::text = $1 AND owner_id = $2',
      [fileId, clientId],
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Slash all active on-chain deals → refunds remaining DCLD to client
    const dealRows = await query(
      `SELECT pd.deal_id AS "dealId", sc.peer_id AS "peerId"
       FROM storage_contracts sc
       JOIN pending_deals pd
         ON pd.file_id::text = sc.file_id::text
        AND pd.peer_id::text = sc.peer_id::text
        AND pd.status = 'SETTLED'
       WHERE sc.file_id::text = $1
         AND sc.status = 'ACTIVE'`,
      [fileId],
    );
    for (const deal of dealRows.rows) {
      sendDealSlashedByClient(deal.peerId, deal.dealId, fileId);
      // Slash on-chain (refunds client, forfeits peer escrow)
      slashDealOnChain(deal.dealId).catch(err =>
        console.error(`[deleteFile] slashDeal ${deal.dealId.slice(0, 10)} failed: ${err.message}`),
      );
    }

    // Notify all connected peers holding this file's chunks to delete them
    const peerRows = await query(
      `SELECT DISTINCT cr.current_peer_id AS "peerId"
       FROM file_chunks fc
       JOIN chunk_replicas cr ON cr.chunk_id = fc.chunk_id AND cr.status = 'ACTIVE'
       WHERE fc.file_id::text = $1`,
      [fileId],
    );
    for (const row of peerRows.rows) {
      sendDeleteChunks(row.peerId, fileId);
    }

    // Delete tables that lack ON DELETE CASCADE first
    await query('DELETE FROM pending_deals     WHERE file_id::text = $1', [fileId]);
    await query('DELETE FROM storage_contracts WHERE file_id::text = $1', [fileId]);
    // file_chunks, chunk_replicas, relay_sessions all cascade from files
    await query('DELETE FROM files WHERE file_id::text = $1', [fileId]);

    return res.json({ deleted: true });
  } catch (err) {
    next(err);
  }
};

module.exports = { getFiles, deleteFile };