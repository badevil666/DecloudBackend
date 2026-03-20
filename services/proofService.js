'use strict';
/**
 * services/proofService.js
 *
 * Storage-proof challenge system.
 *
 * At each of the 10 storage intervals, the coordinator:
 *   1. Generates a random nonce
 *   2. Sends a proof_challenge to the peer via WebSocket
 *   3. Waits for a proof_response (hash of chunk data + nonce)
 *   4. Verifies the hash against stored chunk hashes in the DB
 *   5. If valid  → calls contract.releaseInterval(dealId, interval)
 *      If invalid/timeout → calls contract.slashDeal(dealId)
 *
 * Proof hash formula (peer computes):
 *   sha256(chunk_0_bytes || chunk_1_bytes || ... || nonce_bytes)
 *
 * Coordinator verification (off-chain, using stored chunk hashes):
 *   expected = sha256(unhex(chunkHash_0) || unhex(chunkHash_1) || ... || unhex(nonce))
 *   The stored chunk hashes ARE the sha256 of the chunk bytes, so:
 *   expected = sha256(chunkHash_0_bytes || chunkHash_1_bytes || ... || nonce_bytes)
 *
 * This works because sha256(chunk_bytes) = chunkHash — so the peer hashing actual chunk
 * bytes is equivalent to the coordinator hashing the stored chunk hash bytes, given the same nonce.
 *
 * Background scheduler:
 *   startProofScheduler() polls every POLL_INTERVAL_MS and fires challenges for
 *   any ACTIVE storage contracts whose next interval block has been reached.
 */

const crypto = require('crypto');
const { query } = require('../config/database');
const { sendProofChallenge } = require('../websocket/peerWS');
const { releaseDealInterval, slashDealOnChain } = require('./settlementService');
const { ethers } = require('ethers');

// How often the scheduler polls for due intervals (ms)
const POLL_INTERVAL_MS = 30_000;

// How long to wait for a peer's proof_response before declaring a timeout (ms)
const PROOF_TIMEOUT_MS = 60_000;

// In-flight challenges: dealId:interval → { resolve, reject, timer }
const pendingChallenges = new Map();

let schedulerTimer = null;

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Start the background interval scheduler.
 * Safe to call multiple times — only one scheduler runs at a time.
 */
function startProofScheduler() {
  if (schedulerTimer) return;
  console.log('[proofService] Scheduler started');
  schedulerTimer = setInterval(runSchedulerTick, POLL_INTERVAL_MS);
  // Run immediately on start
  runSchedulerTick().catch(err => console.error('[proofService] Scheduler tick error:', err.message));
}

function stopProofScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

/**
 * Handle an incoming proof_response from a peer.
 * Called by peerWS.handleProofResponse.
 *
 * @param {string} peerId
 * @param {string} dealId
 * @param {number} interval
 * @param {string} hash  - hex-encoded sha256 result from peer
 */
async function verifyProofResponse(peerId, dealId, interval, hash) {
  const key = `${dealId}:${interval}`;
  const pending = pendingChallenges.get(key);

  if (!pending) {
    console.warn(`[proofService] Unexpected proof_response for ${key} — no pending challenge`);
    return;
  }

  pending.resolve({ peerId, hash });
}

// ─── Internal: scheduler tick ─────────────────────────────────────────────────

async function runSchedulerTick() {
  const rpcUrl = process.env.SEPOLIA_RPC_URL;
  if (!rpcUrl) return; // Not configured yet

  let currentBlock;
  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    currentBlock = Number(await provider.getBlockNumber());
  } catch {
    return; // RPC unavailable — skip tick
  }

  // Find all ACTIVE storage contracts with intervals due
  const { rows } = await query(
    `SELECT
       sc.file_id         AS "fileId",
       sc.peer_id         AS "peerId",
       sc.start_block     AS "startBlock",
       sc.end_block       AS "endBlock",
       sc.interval_count  AS "intervalCount",
       sc.intervals_done  AS "intervalsDone",
       pd.deal_id         AS "dealId",
       pd.chunk_hashes    AS "chunkHashes",
       pd.peer_address    AS "peerAddress"
     FROM storage_contracts sc
     JOIN pending_deals pd ON pd.file_id = sc.file_id::text AND pd.peer_id = sc.peer_id::text
     WHERE sc.status = 'ACTIVE'
       AND sc.intervals_done < sc.interval_count
       AND pd.status = 'SETTLED'`,
    []
  );

  for (const row of rows) {
    const intervalsDone = row.intervalsDone ?? 0;
    const nextInterval  = intervalsDone + 1;
    const totalBlocks   = Number(row.endBlock) - Number(row.startBlock);
    const blocksPerInterval = Math.floor(totalBlocks / row.intervalCount);
    const nextDueBlock  = Number(row.startBlock) + nextInterval * blocksPerInterval;

    if (currentBlock < nextDueBlock) continue; // Not due yet

    // Don't re-challenge if already in-flight
    const key = `${row.dealId}:${nextInterval}`;
    if (pendingChallenges.has(key)) continue;

    challengePeer(row, nextInterval).catch(err => {
      console.error(`[proofService] Challenge failed for ${key}: ${err.message}`);
    });
  }
}

// ─── Internal: single challenge cycle ────────────────────────────────────────

async function challengePeer(row, interval) {
  const { dealId, peerId, chunkHashes: rawHashes } = row;
  const key = `${dealId}:${interval}`;

  const chunkHashes = rawHashes
    ? (typeof rawHashes === 'string' ? JSON.parse(rawHashes) : rawHashes)
    : [];

  // Generate random nonce (32 bytes hex without 0x prefix)
  const nonce = crypto.randomBytes(32).toString('hex');

  console.log(`[proofService] Challenging peer ${peerId}  deal: ${dealId.slice(0, 12)}…  interval: ${interval}`);

  // Register the pending challenge BEFORE sending so the response can resolve it
  const responsePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingChallenges.delete(key);
      reject(new Error(`Proof timeout after ${PROOF_TIMEOUT_MS / 1000}s`));
    }, PROOF_TIMEOUT_MS);

    pendingChallenges.set(key, {
      resolve: (result) => { clearTimeout(timer); pendingChallenges.delete(key); resolve(result); },
      reject:  (err)    => { clearTimeout(timer); pendingChallenges.delete(key); reject(err); },
    });
  });

  // Send challenge
  sendProofChallenge(peerId, { dealId, interval, nonce });

  let response;
  try {
    response = await responsePromise;
  } catch (err) {
    // Timeout — slash the peer
    console.warn(`[proofService] Proof timeout for ${key} — slashing peer ${peerId}`);
    await handleProofFailure(row, interval, `Timeout: ${err.message}`);
    return;
  }

  // Verify the hash
  const expectedHash = computeExpectedHash(chunkHashes, nonce);

  if (response.hash.replace('0x', '') !== expectedHash) {
    console.warn(`[proofService] Hash mismatch for ${key} — slashing peer ${peerId}`);
    console.warn(`  expected: ${expectedHash}`);
    console.warn(`  received: ${response.hash}`);
    await handleProofFailure(row, interval, 'Hash mismatch');
    return;
  }

  // Proof passed — release interval on chain
  console.log(`[proofService] Proof valid for ${key} — releasing interval`);
  try {
    const txHash = await releaseDealInterval(dealId, interval);
    await query(
      `UPDATE storage_contracts SET intervals_done = $1 WHERE file_id = $2 AND peer_id = $3`,
      [interval, row.fileId, row.peerId]
    );
    if (interval >= row.intervalCount) {
      await query(
        `UPDATE storage_contracts SET status = 'COMPLETED' WHERE file_id = $1 AND peer_id = $2`,
        [row.fileId, row.peerId]
      );
    }
    console.log(`[proofService] Interval ${interval} released for deal ${dealId.slice(0, 12)}…  tx: ${txHash}`);
  } catch (err) {
    console.error(`[proofService] releaseInterval failed for ${key}: ${err.message}`);
  }
}

async function handleProofFailure(row, interval, reason) {
  try {
    const txHash = await slashDealOnChain(row.dealId);
    await query(
      `UPDATE storage_contracts SET status = 'SLASHED' WHERE file_id = $1 AND peer_id = $2`,
      [row.fileId, row.peerId]
    );
    console.log(`[proofService] Deal ${row.dealId.slice(0, 12)}… slashed at interval ${interval}. reason: ${reason}  tx: ${txHash}`);
  } catch (err) {
    console.error(`[proofService] slashDeal failed: ${err.message}`);
  }
}

// ─── Hash computation ─────────────────────────────────────────────────────────

/**
 * Compute the expected proof hash that a peer should produce.
 *
 * Formula: sha256(chunkHash_0_bytes || chunkHash_1_bytes || ... || nonce_bytes)
 *
 * This matches what the peer computes:
 *   sha256(chunk_0_bytes || chunk_1_bytes || ... || nonce_bytes)
 * because chunkHash_n = sha256(chunk_n_bytes), so the peer hashing chunk bytes
 * is equivalent to coordinator hashing stored chunk hashes.
 *
 * @param {string[]} chunkHashes  - array of hex chunk hashes (with or without 0x)
 * @param {string}   nonce        - 64-char hex string (no 0x)
 * @returns {string} 64-char hex hash (no 0x)
 */
function computeExpectedHash(chunkHashes, nonce) {
  const parts = chunkHashes.map(h => Buffer.from(h.replace('0x', ''), 'hex'));
  parts.push(Buffer.from(nonce, 'hex'));
  return crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex');
}

module.exports = { startProofScheduler, stopProofScheduler, verifyProofResponse };
