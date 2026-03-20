'use strict';
/**
 * services/settlementService.js
 *
 * Submits a fully-signed Deal to the StorageEscrow contract on Sepolia,
 * then records the resulting on-chain contract in the storage_contracts table.
 *
 * Also exports releaseDeal() and slashDeal() for use by proofService.
 *
 * Required env vars:
 *   SEPOLIA_RPC_URL           - e.g. https://sepolia.infura.io/v3/YOUR_KEY
 *   COORDINATOR_PRIVATE_KEY   - 0x-prefixed private key; this wallet pays gas
 *   ESCROW_CONTRACT_ADDRESS   - deployed StorageEscrow address
 */

const { ethers } = require('ethers');
const { query }  = require('../config/database');
const { buildDealValue } = require('../utils/signDeal');

// Minimal ABI — functions we call + events we may parse
const ESCROW_ABI = [
  'function executeDeal((bytes32 dealId, bytes32 fileId, bytes32 merkleRoot, address client, address peer, uint256 size, uint256 duration, uint256 price, uint256 peerEscrowAmount, bytes32[] chunkHashes) deal, bytes clientSig, bytes peerSig)',
  'function releaseInterval(bytes32 dealId, uint8 interval)',
  'function slashDeal(bytes32 dealId)',
  'event DealExecuted(bytes32 indexed dealId, address indexed client, address indexed peer, uint256 price, uint256 peerEscrowAmount)',
  'event IntervalReleased(bytes32 indexed dealId, uint8 interval, uint256 reward)',
  'event DealSlashed(bytes32 indexed dealId, address indexed peer, uint256 escrowForfeited)',
];

// Lazily initialised on first call so the server starts even without RPC env vars
let _provider = null;
let _wallet   = null;
let _contract  = null;

function getOnchainResources() {
  if (_contract) return { provider: _provider, wallet: _wallet, contract: _contract };

  const rpcUrl     = process.env.SEPOLIA_RPC_URL;
  const privateKey = process.env.COORDINATOR_PRIVATE_KEY;
  const escrowAddr = process.env.ESCROW_CONTRACT_ADDRESS;

  if (!rpcUrl)     throw Object.assign(new Error('SEPOLIA_RPC_URL env var not set'),         { status: 500 });
  if (!privateKey) throw Object.assign(new Error('COORDINATOR_PRIVATE_KEY env var not set'), { status: 500 });
  if (!escrowAddr) throw Object.assign(new Error('ESCROW_CONTRACT_ADDRESS env var not set'), { status: 500 });

  _provider = new ethers.JsonRpcProvider(rpcUrl);
  _wallet   = new ethers.Wallet(privateKey, _provider);
  _contract  = new ethers.Contract(escrowAddr, ESCROW_ABI, _wallet);

  return { provider: _provider, wallet: _wallet, contract: _contract };
}

/**
 * Submit a fully-signed deal to the StorageEscrow contract on Sepolia.
 * Waits for 1 confirmation, then records the result in storage_contracts
 * and marks the pending_deal as SETTLED.
 *
 * @param {object} dealRow  - Row from pending_deals (snake_case DB columns)
 * @param {string} clientSig
 * @param {string} peerSig
 * @returns {Promise<{ txHash: string, startBlock: bigint, endBlock: bigint }>}
 */
async function submitDeal(dealRow, clientSig, peerSig) {
  const { contract } = getOnchainResources();

  const chunkHashes = dealRow.chunk_hashes
    ? (typeof dealRow.chunk_hashes === 'string' ? JSON.parse(dealRow.chunk_hashes) : dealRow.chunk_hashes)
    : [];

  const dealValue = buildDealValue({
    dealId:         dealRow.deal_id,
    fileId:         dealRow.file_id_bytes32,
    merkleRoot:     dealRow.file_merkle_root,
    clientAddress:  dealRow.client_address,
    peerAddress:    dealRow.peer_address,
    sizeBytes:      dealRow.size_bytes,
    durationBlocks: dealRow.duration_blocks,
    priceWei:       dealRow.price_wei,
    peerEscrowWei:  dealRow.peer_escrow_wei,
    chunkHashes,
  });

  // Solidity expects a tuple — pass as array in the same order as the struct
  const dealTuple = [
    dealValue.dealId,
    dealValue.fileId,
    dealValue.merkleRoot,
    dealValue.client,
    dealValue.peer,
    dealValue.size,
    dealValue.duration,
    dealValue.price,
    dealValue.peerEscrowAmount,
    dealValue.chunkHashes,
  ];

  let tx;
  try {
    tx = await contract.executeDeal(dealTuple, clientSig, peerSig);
  } catch (err) {
    await query(
      `UPDATE pending_deals SET status = 'FAILED', error_message = $1 WHERE deal_id = $2`,
      [err.shortMessage || err.message, dealRow.deal_id]
    );
    throw Object.assign(
      new Error(`Chain submission failed: ${err.shortMessage || err.message}`),
      { status: 502 }
    );
  }

  // Record tx hash while waiting for confirmation
  await query(
    `UPDATE pending_deals SET status = 'SUBMITTING', tx_hash = $1 WHERE deal_id = $2`,
    [tx.hash, dealRow.deal_id]
  );

  let receipt;
  try {
    receipt = await tx.wait(1);
  } catch (err) {
    await query(
      `UPDATE pending_deals SET status = 'FAILED', error_message = $1 WHERE deal_id = $2`,
      [err.message, dealRow.deal_id]
    );
    throw Object.assign(new Error(`Transaction reverted: ${err.message}`), { status: 502 });
  }

  const startBlock = BigInt(receipt.blockNumber);
  const endBlock   = startBlock + BigInt(dealRow.duration_blocks);

  await query('BEGIN');
  try {
    await query(
      `INSERT INTO storage_contracts
         (file_id, peer_id, contract_address, total_reward, interval_count,
          start_block, end_block, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')`,
      [
        dealRow.file_id,
        dealRow.peer_id,
        process.env.ESCROW_CONTRACT_ADDRESS,
        dealRow.price_wei,
        dealRow.interval_count,
        startBlock.toString(),
        endBlock.toString(),
      ]
    );

    await query(
      `UPDATE pending_deals SET status = 'SETTLED', tx_hash = $1 WHERE deal_id = $2`,
      [receipt.hash, dealRow.deal_id]
    );

    await query('COMMIT');
  } catch (err) {
    await query('ROLLBACK');
    throw err;
  }

  return { txHash: receipt.hash, startBlock, endBlock };
}

/**
 * Call releaseInterval(dealId, interval) on chain.
 * Called by proofService after a proof passes.
 *
 * @param {string} dealId
 * @param {number} interval  1–10
 * @returns {Promise<string>} txHash
 */
async function releaseDealInterval(dealId, interval) {
  const { contract } = getOnchainResources();
  const tx = await contract.releaseInterval(dealId, interval);
  const receipt = await tx.wait(1);
  return receipt.hash;
}

/**
 * Call slashDeal(dealId) on chain.
 * Called by proofService when a peer fails a proof.
 *
 * @param {string} dealId
 * @returns {Promise<string>} txHash
 */
async function slashDealOnChain(dealId) {
  const { contract } = getOnchainResources();
  const tx = await contract.slashDeal(dealId);
  const receipt = await tx.wait(1);
  return receipt.hash;
}

module.exports = { submitDeal, releaseDealInterval, slashDealOnChain };
