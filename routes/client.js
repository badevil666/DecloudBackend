const express = require('express');
const router = express.Router();
const { getNonce, clientLogin, clientRegister } = require('../controllers/authController');
const authenticate = require('../middleware/auth');
const { uploadFile, confirmUpload, cancelUpload } = require('../controllers/uploadController');
const { getFiles, deleteFile } = require('../controllers/fileController');
const { submitClientDealSignature, getDealStatus, getFileDeals, getAllDeals, retryDeal } = require('../controllers/dealController');
const { requestDownload } = require('../controllers/downloadController');
const { getPeerCount } = require('../websocket/peerWS');
const network = require('../config/network');
const { query } = require('../config/database');

/**
 * GET /client/login
 * Request a nonce to sign for login.
 *
 * Request Body:
 * {
 *   "wallet_address": "string (Valid Ethereum wallet address)"
 * }
 *
 * Response:
 * {
 *   "nonce": "string (Decloud nonce: <random hex>)"
 * }
 */
router.get('/login', getNonce);

/**
 * POST /client/login
 * Verify signed nonce and return a JWT for an existing client.
 *
 * Request Body:
 * {
 *   "wallet_address": "string (Valid Ethereum wallet address)",
 *   "nonce": "string (Nonce received from GET /client/login)",
 *   "signature": "string (Nonce signed by the wallet)"
 * }
 *
 * Response:
 * {
 *   "token": "string (JWT)"
 * }
 */
router.post('/login', clientLogin);

/**
 * GET /client/register
 * Request a nonce to sign for registration.
 *
 * Request Body:
 * {
 *   "wallet_address": "string (Valid Ethereum wallet address)"
 * }
 *
 * Response:
 * {
 *   "nonce": "string (Decloud nonce: <random hex>)"
 * }
 */
router.get('/register', getNonce);

/**
 * POST /client/register
 * Verify signed nonce and register a new client, returning a JWT.
 *
 * Request Body:
 * {
 *   "wallet_address": "string (Valid Ethereum wallet address)",
 *   "nonce": "string (Nonce received from GET /client/register)",
 *   "signature": "string (Nonce signed by the wallet)"
 * }
 *
 * Response (201):
 * {
 *   "token": "string (JWT)"
 * }
 */
router.post('/register', clientRegister);

/**
 * POST /client/upload
 * Upload file metadata and chunk commitments.
 * JWT (CLIENT role) must be included in the request body as "jwt".
 *
 * Request Body:
 * {
 *   "jwt": "string",
 *   "filename": "video.mp4",
 *   "filesize": 10485760,
 *   "fileHash": "abc123...",
 *   "numberOfChunks": 4,
 *   "replicationFactor": 3,
 *   "endDate": "2026-06-01T00:00:00.000Z",
 *   "chunkInfo": [
 *     {
 *       "hash": "chunkHash0...",
 *       "nonces": [
 *         { "nonce": "deadbeef...", "hash": "combined_hash..." }
 *       ]
 *     }
 *   ]
 * }
 *
 * Response (201):
 * {
 *   "fileId": "uuid",
 *   "merkleRoot": "hex",
 *   "status": "PENDING"
 * }
 */
router.post('/upload', authenticate('CLIENT'), uploadFile);

/**
 * POST /client/upload/confirm
 * Phase 2: commit a pending upload to the database (client confirmation).
 *
 * Request Body: { "sessionId": "uuid" }
 * Response (201): { "fileId", "merkleRoot", "status": "ALLOCATED", "peers" }
 */
router.post('/upload/confirm', authenticate('CLIENT'), confirmUpload);

/**
 * POST /client/upload/cancel
 * Explicitly cancel a pending upload before its 2-minute TTL expires.
 *
 * Request Body: { "sessionId": "uuid" }
 * Response (200): { "cancelled": true }
 */
router.post('/upload/cancel', authenticate('CLIENT'), cancelUpload);

/**
 * GET /client/files
 * Returns all files uploaded by the authenticated client.
 * Auth: Authorization: Bearer <token>
 */
router.get('/files', authenticate('CLIENT'), getFiles);

/**
 * GET /client/files/:fileId
 * Returns full details for a single file — chunks, replica peers, relay tokens.
 * Auth: Authorization: Bearer <token>
 */
router.get('/files/:fileId', authenticate('CLIENT'), getFiles);

/**
 * DELETE /client/files/:fileId
 * Permanently delete a file owned by the authenticated client.
 */
router.delete('/files/:fileId', authenticate('CLIENT'), deleteFile);

/**
 * POST /client/deals/:dealId/sign
 * Submit an EIP-712 signature for a pending deal (client confirmation).
 *
 * Request Body: { "signature": "0x..." }
 * Response (200): { "status": "accepted", "dealId": "0x..." }
 */
router.post('/deals/:dealId/sign', authenticate('CLIENT'), submitClientDealSignature);

/**
 * GET /client/deals/:dealId
 * Poll the current state of a pending deal.
 * Returns deal fields + clientSigned/peerSigned flags. Raw sigs are omitted.
 */
router.get('/deals/:dealId', authenticate('CLIENT'), getDealStatus);

/**
 * GET /client/files/:fileId/deals
 * Returns all pending deals for a file that need the client's EIP-712 signature.
 * Includes all fields required for signing (chunkHashes, merkleRoot, fileIdBytes32, etc).
 *
 * Response (200): { fileId, clientAddress, escrowAddress, deals[] }
 */
router.get('/files/:fileId/deals', authenticate('CLIENT'), getFileDeals);

/**
 * GET /client/files/:fileId/proofs
 * Returns storage-contract proof data for each settled peer holding this file.
 *
 * Response (200): { fileId, peers: [{ peerId, peerAddress, intervalsVerified, intervalCount, status }] }
 */
router.get('/files/:fileId/proofs', authenticate('CLIENT'), async (req, res) => {
    const { fileId } = req.params;
    if (!fileId) return res.status(400).json({ error: 'fileId is required' });

    const clientId = req.user.sub;

    // Per-chunk proof status: for each chunk, which peers hold it and how many
    // storage-proof intervals have been verified out of 10.
    const sql = `
        SELECT
          fc.chunk_index                          AS "chunkIndex",
          sp.wallet_address                       AS "peerAddress",
          COALESCE(sc.intervals_done, 0)          AS "intervalsVerified",
          COALESCE(sc.interval_count, 10)         AS "intervalCount",
          COALESCE(sc.status, 'NO_DEAL')          AS "status"
        FROM files f
        JOIN file_chunks fc    ON fc.file_id = f.file_id
        JOIN chunk_replicas cr ON cr.chunk_id = fc.chunk_id AND cr.status = 'ACTIVE'
        JOIN storage_peers sp  ON sp.peer_id = cr.current_peer_id
        LEFT JOIN storage_contracts sc
          ON sc.file_id::text = f.file_id::text
          AND sc.peer_id::text = cr.current_peer_id::text
        WHERE f.file_id = $1::uuid
          AND f.owner_id = $2
        ORDER BY fc.chunk_index, sp.wallet_address
    `;

    try {
        const { rows } = await query(sql, [fileId, clientId]);

        // Group rows by chunk index
        const chunkMap = new Map();
        for (const row of rows) {
            const idx = row.chunkIndex;
            if (!chunkMap.has(idx)) chunkMap.set(idx, []);
            chunkMap.get(idx).push({
                peerAddress:      row.peerAddress,
                intervalsVerified: Number(row.intervalsVerified),
                intervalCount:     Number(row.intervalCount),
                status:            row.status,
            });
        }

        const chunks = [...chunkMap.entries()]
            .sort(([a], [b]) => a - b)
            .map(([chunkIndex, peers]) => ({ chunkIndex, peers }));

        return res.json({ fileId, chunks });
    } catch (err) {
        console.error('[proofs] query error', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * POST /client/files/:fileId/download
 * Request a download manifest for a stored file.
 * Coordinator picks best available replica per chunk, notifies peers via WS,
 * and returns chunk list with relay tokens so the client can pull from the relay.
 *
 * Response (200): { fileId, filename, filesize, merkleRoot, relayUrl, chunks[] }
 */
router.post('/files/:fileId/download', authenticate('CLIENT'), requestDownload);

router.get('/deals', authenticate('CLIENT'), getAllDeals);

/**
 * POST /client/deals/:dealId/retry
 * Reset a FAILED deal back to PENDING, clearing both signatures and re-notifying the peer.
 */
router.post('/deals/:dealId/retry', authenticate('CLIENT'), retryDeal);

/**
 * GET /client/peers/online
 * Returns the number of storage peers currently connected via WebSocket.
 */
router.get('/peers/online', authenticate('CLIENT'), (req, res) => {
    res.json({ count: getPeerCount() });
});

/**
 * GET /client/network-config
 * Returns the active blockchain network config so clients can use correct addresses
 * without needing compile-time flags.
 *
 * Response: { escrowAddress, dcldTokenAddress, chainId }
 */
router.get('/network-config', authenticate('CLIENT'), (_req, res) => {
    res.json({
        escrowAddress:    network.escrowAddress    ?? null,
        dcldTokenAddress: network.dcldTokenAddress ?? null,
        chainId:          network.chainId?.toString() ?? null,
    });
});

module.exports = router;
