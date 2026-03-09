const { query } = require('../config/database');

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
           file_id            AS "fileId",
           file_name          AS "filename",
           file_hash          AS "fileHash",
           file_size          AS "filesize",
           merkle_root        AS "merkleRoot",
           status,
           replication_factor AS "replicationFactor",
           chunking_factor    AS "numberOfChunks",
           created_at         AS "createdAt",
           end_date           AS "endDate"
         FROM files
         WHERE file_id = $1 AND owner_id = $2`,
        [fileId, clientId]
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
           cr.status            AS "replicaStatus"
         FROM file_chunks fc
         LEFT JOIN chunk_replicas cr ON cr.chunk_id = fc.chunk_id
         WHERE fc.file_id = $1
         ORDER BY fc.chunk_index, cr.replica_index`,
        [fileId]
      );

      const chunkMap = {};
      for (const row of chunkResult.rows) {
        if (!chunkMap[row.chunkIndex]) {
          chunkMap[row.chunkIndex] = {
            chunkIndex: row.chunkIndex,
            chunkHash:  row.chunkHash,
            chunkSize:  row.chunkSize,
            replicas:   [],
          };
        }
        if (row.replicaIndex !== null) {
          chunkMap[row.chunkIndex].replicas.push({
            replicaIndex: row.replicaIndex,
            peerId:       row.peerId,
            status:       row.replicaStatus,
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
        chunks:        Object.values(chunkMap),
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
         COUNT(fc.chunk_id)::INT AS "chunkCount"
       FROM files f
       LEFT JOIN file_chunks fc ON fc.file_id = f.file_id
       WHERE f.owner_id = $1
       GROUP BY f.file_id
       ORDER BY f.created_at DESC`,
      [clientId]
    );

    return res.json({ files: rows });
  } catch (err) {
    next(err);
  }
};

module.exports = { getFiles };
