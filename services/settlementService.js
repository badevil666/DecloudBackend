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

const { ethers }  = require('ethers');
const { query }   = require('../config/database');
const { buildDealValue } = require('../utils/signDeal');
const network     = require('../config/network');

// Minimal ABI — functions we call + events we may parse
const ESCROW_ABI = [
  'function executeDeal((bytes32 dealId, bytes32 fileId, bytes32 merkleRoot, address client, address peer, uint256 size, uint256 duration, uint256 price, uint256 peerEscrowAmount, bytes32[] chunkHashes) deal, bytes clientSig, bytes peerSig)',
  'function releaseInterval(bytes32 dealId, uint8 interval)',
  'function slashDeal(bytes32 dealId)',
  'event DealExecuted(bytes32 indexed dealId, address indexed client, address indexed peer, uint256 price, uint256 peerEscrowAmount)',
  'event IntervalReleased(bytes32 indexed dealId, uint8 interval, uint256 reward)',
  'event DealSlashed(bytes32 indexed dealId, address indexed peer, uint256 escrowForfeited)',
];

const DCLD_ABI = [
  'function mint(address to, uint256 amount)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
];

// Lazily initialised on first call so the server starts even without RPC env vars
let _provider = null;
let _wallet   = null;
let _contract  = null;

// Serial queue — all coordinator txs run one at a time to avoid nonce collisions
let _txQueue = Promise.resolve();

function getOnchainResources() {
  if (_contract) return { provider: _provider, wallet: _wallet, contract: _contract };

  const rpcUrl     = network.rpcUrl;
  const privateKey = process.env.COORDINATOR_PRIVATE_KEY;
  const escrowAddr = network.escrowAddress;

  if (!rpcUrl)     throw Object.assign(new Error('RPC URL not set — check NETWORK + .env'),              { status: 500 });
  if (!privateKey) throw Object.assign(new Error('COORDINATOR_PRIVATE_KEY env var not set'),             { status: 500 });
  if (!escrowAddr) throw Object.assign(new Error('Escrow address not set — check NETWORK + .env'),       { status: 500 });

  _provider = new ethers.JsonRpcProvider(rpcUrl);
  _wallet   = new ethers.Wallet(privateKey, _provider);
  _contract  = new ethers.Contract(escrowAddr, ESCROW_ABI, _wallet);

  return { provider: _provider, wallet: _wallet, contract: _contract };
}

/**
 * Local-dev only: fund client + peer with DCLD and set MaxUint256 allowance via
 * Anvil account impersonation, so executeDeal succeeds without manual steps.
 * No-ops on any non-local network.
 */
async function localDevFundAndApprove(dealRow, wallet, provider) {
  if (network.chainId !== 31337n) return;

  const dcldAddr  = network.dcldTokenAddress;
  const escrowAddr = network.escrowAddress;
  if (!dcldAddr || !escrowAddr) return;

  const dcld = new ethers.Contract(dcldAddr, DCLD_ABI, wallet);
  const priceWei      = BigInt(dealRow.price_wei);
  const peerEscrowWei = BigInt(dealRow.peer_escrow_wei);
  const ethForGas     = ethers.parseEther('0.1');

  for (const [addr, dcldAmount] of [
    [dealRow.client_address, priceWei],
    [dealRow.peer_address,   peerEscrowWei],
  ]) {
    // Check current allowance and balance — skip if already covered
    const [allowance, balance] = await Promise.all([
      dcld.allowance(addr, escrowAddr),
      dcld.balanceOf(addr),
    ]);
    const needsDcld   = balance   < dcldAmount;
    const needsApproval = allowance < dcldAmount;
    if (!needsDcld && !needsApproval) continue;

    // Ensure the address has ETH to pay gas for the approve call
    const ethBal = await provider.getBalance(addr);
    if (ethBal < ethForGas) {
      await (await wallet.sendTransaction({ to: addr, value: ethForGas })).wait(1);
    }

    // Mint DCLD directly (local dev only — emits Transfer from address(0), not from coordinator)
    if (needsDcld) {
      await (await dcld.mint(addr, dcldAmount)).wait(1);
    }

    // Impersonate the address and call approve
    if (needsApproval) {
      await provider.send('anvil_impersonateAccount', [addr]);
      try {
        const signer = await provider.getSigner(addr);
        await (await new ethers.Contract(dcldAddr, DCLD_ABI, signer)
          .approve(escrowAddr, ethers.MaxUint256)).wait(1);
      } finally {
        await provider.send('anvil_stopImpersonatingAccount', [addr]);
      }
    }

    console.log(`[settlementService:local] Funded+approved ${addr}`);
  }
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
function enqueue(fn) {
  const result = _txQueue.then(fn);
  // swallow errors so a failed tx doesn't poison the queue for subsequent calls
  _txQueue = result.catch(() => {});
  return result;
}

async function _submitDeal(dealRow, clientSig, peerSig) {
  const { contract, wallet, provider } = getOnchainResources();

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

  await localDevFundAndApprove(dealRow, wallet, provider);

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
        network.escrowAddress,
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
function isAlreadyDoneError(err) {
  const msg = (err.shortMessage || err.message || '').toLowerCase();
  // ethers encodes the revert reason; these are the two terminal states
  return msg.includes('dealreadycompleted') || msg.includes('dealreadyslashed')
      || msg.includes('0x7133e9eb') || msg.includes('0x4a42b8dc');
}

async function _releaseDealInterval(dealId, interval) {
  const { contract } = getOnchainResources();
  try {
    const tx = await contract.releaseInterval(dealId, interval);
    const receipt = await tx.wait(1);
    return receipt.hash;
  } catch (err) {
    if (isAlreadyDoneError(err)) {
      console.warn(`[settlementService] releaseInterval(${interval}) skipped — deal already completed/slashed on-chain`);
      return null;
    }
    throw err;
  }
}

async function _slashDealOnChain(dealId) {
  const { contract } = getOnchainResources();
  try {
    const tx = await contract.slashDeal(dealId);
    const receipt = await tx.wait(1);
    return receipt.hash;
  } catch (err) {
    if (isAlreadyDoneError(err)) {
      console.warn(`[settlementService] slashDeal skipped — deal already completed/slashed on-chain`);
      return null;
    }
    throw err;
  }
}

// Public API — all coordinator transactions are serialised through the queue
const submitDeal          = (dealRow, clientSig, peerSig) => enqueue(() => _submitDeal(dealRow, clientSig, peerSig));
const releaseDealInterval = (dealId, interval)            => enqueue(() => _releaseDealInterval(dealId, interval));
const slashDealOnChain    = (dealId)                      => enqueue(() => _slashDealOnChain(dealId));

module.exports = { submitDeal, releaseDealInterval, slashDealOnChain };
