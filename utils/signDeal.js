'use strict';
/**
 * utils/signDeal.js
 *
 * EIP-712 typed-data helpers for StorageEscrow Deal signing.
 *
 * Used by:
 *  - Server-side: dealController.js (recoverDealSigner for off-chain sig verification)
 *  - Desktop peer: chunkService.ts mirrors these types/domain inline
 *  - Android client: deal_service.dart builds the digest manually
 *
 * ethers v6 notes:
 *  - All uint256 fields MUST be BigInt, not plain number.
 *  - Do NOT include EIP712Domain in DEAL_TYPES — ethers v6 injects it automatically.
 *  - bytes32[] is supported natively by ethers v6 signTypedData.
 */

const { ethers } = require('ethers');

const CHAIN_ID = 11155111n; // Sepolia

/**
 * The EIP-712 types. Must match DEAL_TYPEHASH in StorageEscrow.sol exactly —
 * same field names, same order, same types.
 */
const DEAL_TYPES = {
  Deal: [
    { name: 'dealId',           type: 'bytes32'   },
    { name: 'fileId',           type: 'bytes32'   },
    { name: 'merkleRoot',       type: 'bytes32'   },
    { name: 'client',           type: 'address'   },
    { name: 'peer',             type: 'address'   },
    { name: 'size',             type: 'uint256'   },
    { name: 'duration',         type: 'uint256'   },
    { name: 'price',            type: 'uint256'   },
    { name: 'peerEscrowAmount', type: 'uint256'   },
    { name: 'chunkHashes',      type: 'bytes32[]' },
  ],
};

/**
 * Build the EIP-712 domain object for StorageEscrow.
 *
 * @param {string} verifyingContract - checksummed deployed contract address
 * @returns {object}
 */
function getDomain(verifyingContract) {
  return {
    name:              'StorageEscrow',
    version:           '1',
    chainId:           CHAIN_ID,
    verifyingContract: ethers.getAddress(verifyingContract),
  };
}

/**
 * Build the Deal value object ready for EIP-712 signing.
 * All numeric fields are coerced to BigInt.
 * chunkHashes must be an array of '0x'-prefixed 32-byte hex strings.
 *
 * @param {object} params
 * @param {string}   params.dealId
 * @param {string}   params.fileId          - bytes32 hex (0x + 64 chars)
 * @param {string}   params.merkleRoot      - bytes32 hex (0x + 64 chars)
 * @param {string}   params.clientAddress
 * @param {string}   params.peerAddress
 * @param {bigint|string|number} params.sizeBytes
 * @param {bigint|string|number} params.durationBlocks
 * @param {bigint|string|number} params.priceWei
 * @param {bigint|string|number} params.peerEscrowWei
 * @param {string[]} params.chunkHashes     - array of 0x-prefixed bytes32 strings
 * @returns {object} value object for wallet.signTypedData(domain, DEAL_TYPES, value)
 */
function buildDealValue({
  dealId,
  fileId,
  merkleRoot,
  clientAddress,
  peerAddress,
  sizeBytes,
  durationBlocks,
  priceWei,
  peerEscrowWei,
  chunkHashes,
}) {
  return {
    dealId,
    fileId,
    merkleRoot,
    client:           ethers.getAddress(clientAddress),
    peer:             ethers.getAddress(peerAddress),
    size:             BigInt(sizeBytes),
    duration:         BigInt(durationBlocks),
    price:            BigInt(priceWei),
    peerEscrowAmount: BigInt(peerEscrowWei),
    chunkHashes:      chunkHashes ?? [],
  };
}

/**
 * Sign a Deal using an ethers v6 Wallet.
 *
 * @param {ethers.Wallet} wallet
 * @param {object}        dealValue    - from buildDealValue()
 * @param {string}        escrowAddress
 * @returns {Promise<string>} 65-byte hex signature
 */
async function signDeal(wallet, dealValue, escrowAddress) {
  return wallet.signTypedData(getDomain(escrowAddress), DEAL_TYPES, dealValue);
}

/**
 * Recover the signer address from an EIP-712 Deal signature (off-chain, no RPC needed).
 *
 * @param {object} dealValue    - from buildDealValue()
 * @param {string} signature    - 65-byte hex sig
 * @param {string} escrowAddress
 * @returns {string} checksummed recovered address
 */
function recoverDealSigner(dealValue, signature, escrowAddress) {
  return ethers.verifyTypedData(getDomain(escrowAddress), DEAL_TYPES, dealValue, signature);
}

module.exports = { getDomain, DEAL_TYPES, buildDealValue, signDeal, recoverDealSigner };
