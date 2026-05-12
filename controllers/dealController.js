'use strict';
/**
 * controllers/dealController.js
 *
 * Manages the EIP-712 deal signing lifecycle:
 *
 *   1. createDealsForFile(fileId)  — internal, called from peerWS when file → STORED
 *      Creates one pending_deal per allocated peer with chunk hashes + file metadata.
 *
 *   2. POST /client/deals/:dealId/sign  (submitClientDealSignature)
 *      Client submits their EIP-712 signature.
 *
 *   3. POST /peer/deals/:dealId/sign    (submitPeerDealSignature)
 *      Peer submits their EIP-712 signature.
 *
 *   4. GET  /client/deals/:dealId       (getDealStatus)
 *      Returns current deal state for polling by client apps.
 *
 *   5. GET  /client/files/:fileId/deals (getFileDeals)
 *      Returns all pending deals for a file needing the client's signature.
 *
 * When both signatures arrive, processSignature() sets status → SUBMITTING and
 * triggers settlementService.submitDeal() via setImmediate (non-blocking).
 */

const crypto  = require('crypto');
const { ethers } = require('ethers');
const { query }  = require('../config/database');
const { buildDealValue, recoverDealSigner } = require('../utils/signDeal');
const { submitDeal } = require('../services/settlementService');
const { escrowAddress: ESCROW_ADDRESS, chainId: CHAIN_ID } = require('../config/network');
// Lazy require to break circular dependency: peerWS → dealController → peerWS
function sendDealSigningRequest(...args) {
  require('../websocket/peerWS').sendDealSigningRequest(...args);
}

const DEAL_TTL_HOURS = 24;
const INTERVAL_COUNT = 10;

// Pricing: ~0.00833 DCLD per KB per second (1 DCLD per KB per 2 minutes)
// priceWei = sizeBytes * durationBlocks * 1e17 / 1024
// → 100 KB file stored for 2 min (10 blocks) ≈ 100 DCLD per replica
const PRICE_NUMERATOR   = 100_000_000_000_000_000n; // 1e17
const PRICE_DENOMINATOR = 1024n;

// Escrow ratio = 20% of peer price
const ESCROW_DIVISOR = 5n;

// ─────────────────────────────────────────────────────────────────────────────
// Pricing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute price and escrow for one peer based on how many replicas they hold.
 *
 * @param {bigint} sizeBytes
 * @param {bigint} durationBlocks
 * @param {number} replicaCount  — number of ACTIVE chunk replicas this peer holds
 * @returns {{ priceWei: bigint, peerEscrowWei: bigint }}
 */
function computePricing(sizeBytes, durationBlocks, replicaCount) {
  const pricePerReplica = (sizeBytes * durationBlocks * PRICE_NUMERATOR) / PRICE_DENOMINATOR;
  const priceWei        = pricePerReplica * BigInt(replicaCount);
  const peerEscrowWei   = priceWei / ESCROW_DIVISOR; // 20%
  return { priceWei, peerEscrowWei };
}

/**
 * Derive a deterministic bytes32 dealId.
 */
function deriveDealId(fileId, peerId, nowMs) {
  return '0x' + crypto.createHash('sha256').update(fileId + peerId + nowMs.toString()).digest('hex');
}

/**
 * Convert a UUID string to a bytes32 hex value (left-padded, no collision risk for UUIDs).
 * We hash it so it fits exactly in 32 bytes.
 */
function uuidToBytes32(uuid) {
  return '0x' + crypto.createHash('sha256').update(uuid).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: called from peerWS.handleChunkStored when file → STORED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create one pending_deal per distinct allocated peer for the given file.
 * Includes chunk hashes, file metadata, and notifies the peer to sign via WS.
 *
 * @param {string} fileId
 */
async function createDealsForFile(fileId) {
  const escrowAddress = ESCROW_ADDRESS;
  if (!escrowAddress) {
    console.warn('[dealController] escrowAddress not configured for this network — skipping deal creation');
    return;
  }

  // File metadata + owner's wallet address
  const { rows: fileRows } = await query(
    `SELECT f.file_id, f.file_name, f.file_size, f.merkle_root, f.end_date, f.owner_id,
            c.wallet_address AS client_address
     FROM files   f
     JOIN clients c ON c.client_id = f.owner_id
     WHERE f.file_id = $1`,
    [fileId]
  );

  if (fileRows.length === 0) return;
  const file = fileRows[0];

  const nowMs          = Date.now();
  const endMs          = new Date(file.end_date).getTime();
  const durationSec    = Math.max(0, Math.floor((endMs - nowMs) / 1000));
  // Anvil mines on demand (1s per block when driven by scheduler); Sepolia ≈ 12s
  const blockTimeSec   = (require('../config/network').chainId === 31337n) ? 1 : 12;
  const durationBlocks = BigInt(Math.ceil(durationSec / blockTimeSec));
  const sizeBytes      = BigInt(file.file_size);
  const expiresAt      = new Date(nowMs + DEAL_TTL_HOURS * 3_600_000);
  const fileIdBytes32  = uuidToBytes32(file.file_id);
  const merkleRoot     = file.merkle_root.startsWith('0x')
    ? file.merkle_root
    : '0x' + file.merkle_root;

  // Distinct peers that have an ACTIVE replica for this file
  const { rows: peerRows } = await query(
    `SELECT DISTINCT sp.peer_id, sp.wallet_address AS peer_address
     FROM chunk_replicas cr
     JOIN file_chunks   fc ON fc.chunk_id  = cr.chunk_id
     JOIN storage_peers sp ON sp.peer_id   = cr.current_peer_id
     WHERE fc.file_id = $1 AND cr.status = 'ACTIVE'`,
    [fileId]
  );

  if (peerRows.length === 0) return;

  for (const peer of peerRows) {
    // Query this peer's assigned chunk hashes and count replicas
    const { rows: chunkRows } = await query(
      `SELECT fc.chunk_hash
       FROM chunk_replicas cr
       JOIN file_chunks fc ON fc.chunk_id = cr.chunk_id
       WHERE fc.file_id = $1 AND cr.current_peer_id = $2 AND cr.status = 'ACTIVE'
       ORDER BY fc.chunk_index`,
      [fileId, peer.peer_id]
    );

    const replicaCount = chunkRows.length;
    if (replicaCount === 0) continue;

    const chunkHashes = chunkRows.map(r =>
      r.chunk_hash.startsWith('0x') ? r.chunk_hash : '0x' + r.chunk_hash
    );

    const { priceWei, peerEscrowWei } = computePricing(sizeBytes, durationBlocks, replicaCount);
    const dealId = deriveDealId(fileId, peer.peer_id, nowMs);

    try {
      await query(
        `INSERT INTO pending_deals
           (deal_id, file_id, client_id, peer_id,
            client_address, peer_address,
            size_bytes, duration_blocks, price_wei, peer_escrow_wei,
            interval_count, expires_at,
            chunk_hashes, file_merkle_root, file_id_bytes32)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (deal_id) DO NOTHING`,
        [
          dealId,
          fileId,
          file.owner_id,
          peer.peer_id,
          ethers.getAddress(file.client_address),
          ethers.getAddress(peer.peer_address),
          sizeBytes.toString(),
          durationBlocks.toString(),
          priceWei.toString(),
          peerEscrowWei.toString(),
          INTERVAL_COUNT,
          expiresAt,
          JSON.stringify(chunkHashes),
          merkleRoot,
          fileIdBytes32,
        ]
      );

      console.log(`[dealController] Created deal ${dealId} — file: ${fileId}  peer: ${peer.peer_id}  replicas: ${replicaCount}`);

      // Notify peer to sign via WebSocket
      sendDealSigningRequest(peer.peer_id, {
        dealId,
        fileId:           fileIdBytes32,
        merkleRoot,
        clientAddress:    ethers.getAddress(file.client_address),
        peerAddress:      ethers.getAddress(peer.peer_address),
        sizeBytes:        sizeBytes.toString(),
        durationBlocks:   durationBlocks.toString(),
        priceWei:         priceWei.toString(),
        peerEscrowWei:    peerEscrowWei.toString(),
        chunkHashes,
        escrowAddress,
      });

    } catch (err) {
      console.error(`[dealController] Failed to create deal for peer ${peer.peer_id}: ${err.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: validate + store a signature, trigger settlement when both present
// ─────────────────────────────────────────────────────────────────────────────

async function processSignature(dealId, signature, role, expectedAddress) {
  const { rows } = await query(
    `SELECT * FROM pending_deals WHERE deal_id = $1`,
    [dealId]
  );

  if (rows.length === 0) {
    throw Object.assign(new Error('Deal not found'), { status: 404 });
  }

  const deal = rows[0];

  if (deal.status === 'SETTLED' || deal.status === 'SUBMITTING') {
    throw Object.assign(new Error('Deal already settled or submission in progress'), { status: 409 });
  }
  if (deal.status === 'FAILED') {
    throw Object.assign(new Error('Deal failed on chain'), { status: 422 });
  }
  if (deal.status === 'EXPIRED' || new Date(deal.expires_at) <= new Date()) {
    throw Object.assign(new Error('Deal has expired'), { status: 410 });
  }

  const addressField = role === 'client' ? 'client_address' : 'peer_address';
  if (deal[addressField].toLowerCase() !== expectedAddress.toLowerCase()) {
    throw Object.assign(
      new Error(`This deal does not belong to your ${role} address`),
      { status: 403 }
    );
  }

  const escrowAddress = ESCROW_ADDRESS;
  if (!escrowAddress) {
    throw Object.assign(new Error('escrowAddress not configured for this network'), { status: 500 });
  }

  const chunkHashes = deal.chunk_hashes
    ? (typeof deal.chunk_hashes === 'string' ? JSON.parse(deal.chunk_hashes) : deal.chunk_hashes)
    : [];

  const dealValue = buildDealValue({
    dealId:         deal.deal_id,
    fileId:         deal.file_id_bytes32,
    merkleRoot:     deal.file_merkle_root,
    clientAddress:  deal.client_address,
    peerAddress:    deal.peer_address,
    sizeBytes:      deal.size_bytes,
    durationBlocks: deal.duration_blocks,
    priceWei:       deal.price_wei,
    peerEscrowWei:  deal.peer_escrow_wei,
    chunkHashes,
  });

  let recovered;
  try {
    recovered = recoverDealSigner(dealValue, signature, escrowAddress);
  } catch {
    throw Object.assign(new Error('Signature format is invalid'), { status: 400 });
  }

  if (recovered.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw Object.assign(new Error('Signature does not match expected address'), { status: 401 });
  }

  const sigField        = role === 'client' ? 'client_sig' : 'peer_sig';
  const otherSigField   = role === 'client' ? 'peer_sig'   : 'client_sig';
  const singleSignedStatus = role === 'client' ? 'CLIENT_SIGNED' : 'PEER_SIGNED';

  const { rows: updated } = await query(
    `UPDATE pending_deals
     SET ${sigField} = $1,
         status = CASE
           WHEN ${otherSigField} IS NOT NULL THEN 'SUBMITTING'
           ELSE $2
         END
     WHERE deal_id = $3
     RETURNING *`,
    [signature, singleSignedStatus, dealId]
  );

  const updatedDeal = updated[0];

  if (updatedDeal.status === 'SUBMITTING') {
    setImmediate(() => {
      submitDeal(updatedDeal, updatedDeal.client_sig, updatedDeal.peer_sig)
        .then(({ txHash }) => {
          console.log(`[dealController] Deal ${dealId} settled. tx: ${txHash}`);
        })
        .catch((err) => {
          console.error(`[dealController] Settlement failed for deal ${dealId}: ${err.message}`);
        });
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

const submitClientDealSignature = async (req, res, next) => {
  try {
    const { dealId } = req.params;
    const { signature } = req.body;
    const { wallet_address } = req.user;

    if (!signature || typeof signature !== 'string' || !signature.startsWith('0x')) {
      return res.status(400).json({ error: 'signature must be a 0x-prefixed hex string' });
    }
    if (!dealId || !dealId.startsWith('0x') || dealId.length !== 66) {
      return res.status(400).json({ error: 'dealId must be a 0x-prefixed 32-byte hex string' });
    }

    await processSignature(dealId, signature, 'client', wallet_address);
    return res.status(200).json({ status: 'accepted', dealId });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

const submitPeerDealSignature = async (req, res, next) => {
  try {
    const { dealId } = req.params;
    const { signature } = req.body;
    const { wallet_address } = req.user;

    if (!signature || typeof signature !== 'string' || !signature.startsWith('0x')) {
      return res.status(400).json({ error: 'signature must be a 0x-prefixed hex string' });
    }
    if (!dealId || !dealId.startsWith('0x') || dealId.length !== 66) {
      return res.status(400).json({ error: 'dealId must be a 0x-prefixed 32-byte hex string' });
    }

    await processSignature(dealId, signature, 'peer', wallet_address);
    return res.status(200).json({ status: 'accepted', dealId });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    next(err);
  }
};

const getDealStatus = async (req, res, next) => {
  try {
    const { dealId } = req.params;
    const { sub: clientId } = req.user;

    const { rows } = await query(
      `SELECT
         deal_id          AS "dealId",
         file_id          AS "fileId",
         peer_id          AS "peerId",
         client_address   AS "clientAddress",
         peer_address     AS "peerAddress",
         size_bytes       AS "sizeBytes",
         duration_blocks  AS "durationBlocks",
         price_wei        AS "priceWei",
         peer_escrow_wei  AS "peerEscrowWei",
         chunk_hashes     AS "chunkHashes",
         file_merkle_root AS "merkleRoot",
         file_id_bytes32  AS "fileIdBytes32",
         status,
         created_at       AS "createdAt",
         expires_at       AS "expiresAt",
         tx_hash          AS "txHash",
         error_message    AS "errorMessage",
         (client_sig IS NOT NULL) AS "clientSigned",
         (peer_sig   IS NOT NULL) AS "peerSigned"
       FROM pending_deals
       WHERE deal_id = $1 AND client_id = $2`,
      [dealId, clientId]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Deal not found' });
    return res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /client/files/:fileId/deals
 * Returns all pending deals for a file that need the client's signature.
 * Includes all fields required for EIP-712 signing on the client side.
 */
const getFileDeals = async (req, res, next) => {
  try {
    const { fileId } = req.params;
    const { sub: clientId, wallet_address } = req.user;

    const { rows } = await query(
      `SELECT
         deal_id          AS "dealId",
         peer_id          AS "peerId",
         peer_address     AS "peerAddress",
         client_address   AS "clientAddress",
         size_bytes       AS "sizeBytes",
         duration_blocks  AS "durationBlocks",
         price_wei        AS "priceWei",
         peer_escrow_wei  AS "peerEscrowWei",
         chunk_hashes     AS "chunkHashes",
         file_merkle_root AS "merkleRoot",
         file_id_bytes32  AS "fileIdBytes32",
         status,
         expires_at       AS "expiresAt",
         (client_sig IS NOT NULL) AS "clientSigned"
       FROM pending_deals
       WHERE file_id = $1
         AND client_id = $2
         AND status IN ('PENDING', 'PEER_SIGNED')
         AND expires_at > NOW()`,
      [fileId, clientId]
    );

    return res.json({
      fileId,
      clientAddress: wallet_address,
      escrowAddress: ESCROW_ADDRESS ?? null,
      chainId:       CHAIN_ID?.toString() ?? null,
      deals: rows,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /client/deals
 * Returns all deals for the authenticated client, newest first.
 */
const getAllDeals = async (req, res, next) => {
  try {
    const { sub: clientId } = req.user;

    const { rows } = await query(
      `SELECT
         deal_id                        AS "dealId",
         file_id                        AS "fileId",
         peer_id                        AS "peerId",
         COALESCE(client_address,  '')  AS "clientAddress",
         COALESCE(peer_address,    '')  AS "peerAddress",
         COALESCE(size_bytes,      '0') AS "sizeBytes",
         COALESCE(duration_blocks, '0') AS "durationBlocks",
         COALESCE(price_wei,       '0') AS "priceWei",
         COALESCE(peer_escrow_wei, '0') AS "peerEscrowWei",
         chunk_hashes                   AS "chunkHashes",
         COALESCE(file_merkle_root, '') AS "merkleRoot",
         COALESCE(file_id_bytes32,  '') AS "fileIdBytes32",
         status,
         tx_hash          AS "txHash",
         error_message    AS "errorMessage",
         created_at       AS "createdAt",
         expires_at       AS "expiresAt",
         (client_sig IS NOT NULL) AS "clientSigned",
         (peer_sig   IS NOT NULL) AS "peerSigned"
       FROM pending_deals
       WHERE client_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [clientId]
    );

    return res.json({ deals: rows, escrowAddress: ESCROW_ADDRESS ?? null, chainId: CHAIN_ID?.toString() ?? null });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /client/deals/:dealId/retry
 * Reset a FAILED deal back to PENDING so it can be re-signed.
 * Clears both signatures, extends the TTL, and re-notifies the peer.
 */
const retryDeal = async (req, res, next) => {
  try {
    const { dealId } = req.params;
    const { sub: clientId } = req.user;

    if (!dealId || !dealId.startsWith('0x') || dealId.length !== 66) {
      return res.status(400).json({ error: 'dealId must be a 0x-prefixed 32-byte hex string' });
    }

    const { rows } = await query(
      `SELECT * FROM pending_deals WHERE deal_id = $1 AND client_id = $2`,
      [dealId, clientId]
    );

    if (rows.length === 0) return res.status(404).json({ error: 'Deal not found' });

    const deal = rows[0];

    if (deal.status !== 'FAILED') {
      return res.status(409).json({ error: `Cannot retry a deal in status: ${deal.status}` });
    }

    const newExpiresAt = new Date(Date.now() + DEAL_TTL_HOURS * 3_600_000);

    const { rows: updated } = await query(
      `UPDATE pending_deals
       SET status      = 'PENDING',
           client_sig  = NULL,
           peer_sig    = NULL,
           error_message = NULL,
           tx_hash     = NULL,
           expires_at  = $1
       WHERE deal_id = $2
       RETURNING *`,
      [newExpiresAt, dealId]
    );

    const d = updated[0];

    const chunkHashes = d.chunk_hashes
      ? (typeof d.chunk_hashes === 'string' ? JSON.parse(d.chunk_hashes) : d.chunk_hashes)
      : [];

    const escrowAddress = ESCROW_ADDRESS;
    if (escrowAddress) {
      sendDealSigningRequest(d.peer_id, {
        dealId:         d.deal_id,
        fileId:         d.file_id_bytes32,
        merkleRoot:     d.file_merkle_root,
        clientAddress:  d.client_address,
        peerAddress:    d.peer_address,
        sizeBytes:      d.size_bytes,
        durationBlocks: d.duration_blocks,
        priceWei:       d.price_wei,
        peerEscrowWei:  d.peer_escrow_wei,
        chunkHashes,
        escrowAddress,
      });
    }

    console.log(`[dealController] Retrying deal ${dealId} — peer: ${d.peer_id}`);
    return res.status(200).json({ status: 'retrying', dealId });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createDealsForFile,
  submitClientDealSignature,
  submitPeerDealSignature,
  getDealStatus,
  getFileDeals,
  getAllDeals,
  retryDeal,
};
