/**
 * Pure in-memory storage allocation — zero DB access.
 *
 * Takes the current peer state and chunk list, runs the greedy
 * least-loaded algorithm entirely in local variables, and returns
 * the allocation plan. The caller is responsible for all DB reads
 * and writes before and after calling this.
 *
 * @param {Array<{ peer_id: string, available_space: number }>} peers  - active peers from DB
 * @param {Array<{ hash: string, size: number }>}               chunks - ordered chunk list
 * @param {number}                                              replicationFactor
 *
 * @returns {{
 *   allocations:    string[][],              // allocations[i] = [peer_id, ...] for chunk i
 *   peerDeductions: Object.<string, number>  // { peer_id: totalBytesToDeduct }
 * }}
 *
 * @throws {Error} with .status = 503 if allocation is impossible
 */
function allocateChunks(peers, chunks, replicationFactor) {
  if (peers.length === 0) {
    const err = new Error('No storage peers are currently online. Please try again later.');
    err.status = 503;
    throw err;
  }

  if (peers.length < replicationFactor) {
    const err = new Error(
      `Not enough online peers to satisfy replication factor of ${replicationFactor}. ` +
      `Only ${peers.length} peer${peers.length === 1 ? ' is' : 's are'} currently active.`
    );
    err.status = 503;
    throw err;
  }

  // Local mutable copy — never touches the DB
  const peerState = peers.map((p) => ({
    peer_id: p.peer_id,
    available: Number(p.available_space), // bytes
  }));

  const allocations = []; // allocations[i] = [peer_id, ...]

  for (let i = 0; i < chunks.length; i++) {
    const chunkSize = chunks[i].size; // bytes

    // Re-sort before each chunk: most free space first
    peerState.sort((a, b) => b.available - a.available);

    const selected = [];

    for (const peer of peerState) {
      if (selected.length === replicationFactor) break;
      if (peer.available < chunkSize) continue; // not enough space on this peer
      selected.push(peer.peer_id);
      peer.available -= chunkSize; // deduct locally so next replica sees updated state
    }

    if (selected.length < replicationFactor) {
      const needed = replicationFactor - selected.length;
      const err = new Error(
        `Cannot store chunk ${i} (${chunkSize} bytes): ` +
        `need ${replicationFactor} peers with at least ${chunkSize} bytes free, ` +
        `but only ${selected.length} qualify. ` +
        `${needed} more peer${needed === 1 ? '' : 's'} with sufficient space needed.`
      );
      err.status = 503;
      throw err;
    }

    allocations.push(selected);
  }

  // Aggregate total bytes per peer for a single UPDATE per peer at commit time
  const peerDeductions = {};
  for (let i = 0; i < chunks.length; i++) {
    for (const peerId of allocations[i]) {
      peerDeductions[peerId] = (peerDeductions[peerId] || 0) + chunks[i].size;
    }
  }

  return { allocations, peerDeductions };
}

module.exports = { allocateChunks };
