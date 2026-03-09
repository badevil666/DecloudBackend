const crypto = require('crypto');
const { allocateChunks } = require('./allocationService');
const { connectedPeers, sendAssignment } = require('../websocket/peerWS');

const ACK_TIMEOUT_MS = 5_000;
const MAX_RETRIES = 2;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Builds a per-peer assignment map from the allocations array.
 * Aggregates all chunk indexes for each peer and generates one relay token per peer.
 *
 * @param {string[][]} allocations - allocations[i] = [peer_id, ...] for chunk i
 * @returns {Object.<string, { token: string, chunkIndexes: number[] }>}
 */
function buildPeerAssignments(allocations) {
  const assignments = {};
  for (let i = 0; i < allocations.length; i++) {
    for (const peerId of allocations[i]) {
      if (!assignments[peerId]) {
        assignments[peerId] = { token: generateToken(), chunkIndexes: [] };
      }
      assignments[peerId].chunkIndexes.push(i);
    }
  }
  return assignments;
}

/**
 * Runs allocation then notifies each allocated peer via WebSocket, waiting for ACK.
 * Retries up to MAX_RETRIES times, excluding peers that time out.
 *
 * @param {Array<{ peer_id: string, available_space: number }>} dbPeers - ACTIVE peers from DB
 * @param {Array<{ hash: string, size: number }>} chunkInfo
 * @param {number} replicationFactor
 * @param {string} fileId - pre-generated UUID for the file
 * @returns {{
 *   allocations:      string[][],
 *   peerDeductions:   Object.<string, number>,
 *   peerAssignments:  Object.<string, { token: string, chunkIndexes: number[] }>
 * }}
 */
async function allocateAndNotify(dbPeers, chunkInfo, replicationFactor, fileId) {
  const excludedPeers = new Set();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Only consider peers that are both in the DB active set AND currently connected via WS
    const eligiblePeers = dbPeers.filter(
      (p) => connectedPeers.has(p.peer_id) && !excludedPeers.has(p.peer_id)
    );

    if (eligiblePeers.length === 0) {
      const err = new Error(
        'No storage peers are currently online. Please try again later.'
      );
      err.status = 503;
      throw err;
    }

    // Pure in-memory allocation — throws 503 if it can't satisfy replicationFactor
    const { allocations, peerDeductions } = allocateChunks(eligiblePeers, chunkInfo, replicationFactor);

    // One token per peer (covers all their chunks for this upload)
    const peerAssignments = buildPeerAssignments(allocations);
    const peerIds = Object.keys(peerAssignments);

    // Push assignment to all peers simultaneously, collect ACK results
    const results = await Promise.allSettled(
      peerIds.map((peerId) =>
        sendAssignment(
          peerId,
          {
            type: 'chunk_assignment',
            token: peerAssignments[peerId].token,
            fileId,
            chunkIndexes: peerAssignments[peerId].chunkIndexes,
          },
          ACK_TIMEOUT_MS
        )
      )
    );

    const timedOut = peerIds.filter((_, i) => results[i].status === 'rejected');

    if (timedOut.length === 0) {
      // All peers ACKed — return the full plan
      return { allocations, peerDeductions, peerAssignments };
    }

    if (attempt === MAX_RETRIES) {
      const err = new Error(
        `${timedOut.length} peer${timedOut.length === 1 ? '' : 's'} did not acknowledge the ` +
        `assignment after ${MAX_RETRIES + 1} attempt${MAX_RETRIES === 0 ? '' : 's'}. ` +
        `Please try again.`
      );
      err.status = 503;
      throw err;
    }

    // Exclude timed-out peers and retry with the rest
    timedOut.forEach((id) => excludedPeers.add(id));
    console.warn(
      `[Allocation] ${timedOut.length} peer(s) timed out on attempt ${attempt + 1}/${MAX_RETRIES + 1}, retrying without them`
    );
  }
}

module.exports = { allocateAndNotify };
