const express = require('express');
const router = express.Router();
const { getNonce, peerLogin, peerRegister } = require('../controllers/authController');
const authenticate = require('../middleware/auth');
const { submitPeerDealSignature } = require('../controllers/dealController');
const { query } = require('../config/database');

/**
 * GET /peer/login
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
 * POST /peer/login
 * Verify signed nonce and return a JWT for an existing storage peer.
 *
 * Request Body:
 * {
 *   "wallet_address": "string (Valid Ethereum wallet address)",
 *   "nonce": "string (Nonce received from GET /peer/login)",
 *   "signature": "string (Nonce signed by the wallet)"
 * }
 *
 * Response:
 * {
 *   "token": "string (JWT)"
 * }
 */
router.post('/login', peerLogin);

/**
 * GET /peer/register
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
 * POST /peer/register
 * Verify signed nonce and register a new storage peer, returning a JWT.
 *
 * Request Body:
 * {
 *   "wallet_address": "string (Valid Ethereum wallet address)",
 *   "nonce": "string (Nonce received from GET /peer/register)",
 *   "signature": "string (Nonce signed by the wallet)",
 *   "os_type": "string (Operating system of the peer)",
 *   "declared_capacity": 100 // number (Positive number, in GB)
 * }
 *
 * Response (201):
 * {
 *   "token": "string (JWT)"
 * }
 */
router.post('/register', peerRegister);

/**
 * POST /peer/deals/:dealId/sign
 * Submit an EIP-712 signature for a pending deal (peer confirmation).
 *
 * Request Body: { "signature": "0x..." }
 * Response (200): { "status": "accepted", "dealId": "0x..." }
 */
router.post('/deals/:dealId/sign', authenticate('STORAGE_PEER'), submitPeerDealSignature);

/**
 * GET /peer/files
 * Returns all storage contracts for this peer with file info and proof progress.
 *
 * Response (200): [
 *   {
 *     fileId, filename, fileSize, fileStatus, endDate,
 *     totalReward, intervalCount, intervalsDone,
 *     startBlock, endBlock, contractStatus,
 *     dealId, dealTxHash
 *   }
 * ]
 */
/**
 * GET /peer/dashboard
 * Returns persisted total earnings (wei) and recent deal history for the peer.
 *
 * Response (200): {
 *   totalEarnedWei: string,
 *   recentDeals: [{ dealId, phase, timestamp }]
 * }
 */
router.get('/dashboard', authenticate('STORAGE_PEER'), async (req, res) => {
  const peerId = req.user.sub;
  try {
    const [contractsRes, dealsRes] = await Promise.all([
      query(
        `SELECT total_reward AS "totalReward", intervals_done AS "intervalsDone"
           FROM storage_contracts
          WHERE peer_id = $1`,
        [peerId]
      ),
      query(
        `SELECT deal_id AS "dealId", status, created_at AS "timestamp"
           FROM pending_deals
          WHERE peer_id = $1::text
            AND status IN ('SETTLED', 'FAILED', 'EXPIRED')
          ORDER BY created_at DESC
          LIMIT 20`,
        [peerId]
      ),
    ]);

    // Mirror the Solidity geometric reward formula to compute total released
    let totalWei = 0n;
    for (const row of contractsRes.rows) {
      const price = BigInt(row.totalReward ?? 0);
      const done  = Number(row.intervalsDone ?? 0);
      for (let i = 1; i <= done; i++) {
        totalWei += i === 1 ? price - (price * 1023n / 1024n) : price >> BigInt(11 - i);
      }
    }

    const recentDeals = dealsRes.rows.map(d => ({
      dealId:    d.dealId,
      phase:     d.status === 'SETTLED' ? 'signed' : d.status === 'EXPIRED' ? 'expired' : 'rejected',
      timestamp: new Date(d.timestamp).getTime(),
    }));

    res.json({ totalEarnedWei: totalWei.toString(), recentDeals });
  } catch (err) {
    console.error('[peer/dashboard]', err.message, err.detail ?? '');
    res.status(500).json({ error: 'Failed to fetch peer dashboard' });
  }
});

router.get('/files', authenticate('STORAGE_PEER'), async (req, res) => {
  const peerId = req.user.sub;
  try {
    const { rows } = await query(
      `SELECT
         f.file_id          AS "fileId",
         f.file_name        AS "filename",
         f.file_size        AS "fileSize",
         f.status           AS "fileStatus",
         f.end_date         AS "endDate",
         sc.total_reward    AS "totalReward",
         sc.interval_count  AS "intervalCount",
         sc.intervals_done  AS "intervalsDone",
         sc.start_block     AS "startBlock",
         sc.end_block       AS "endBlock",
         sc.status          AS "contractStatus",
         pd.deal_id         AS "dealId",
         pd.tx_hash         AS "dealTxHash"
       FROM storage_contracts sc
       JOIN files f ON f.file_id = sc.file_id
       LEFT JOIN LATERAL (
         SELECT deal_id, tx_hash
           FROM pending_deals
          WHERE file_id = sc.file_id::text
            AND peer_id = sc.peer_id::text
            AND status  = 'SETTLED'
          LIMIT 1
       ) pd ON true
       WHERE sc.peer_id = $1
       ORDER BY f.created_at DESC`,
      [peerId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[peer/files]', err.message, err.detail ?? '');
    res.status(500).json({ error: 'Failed to fetch peer files' });
  }
});

module.exports = router;
