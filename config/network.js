'use strict';

/**
 * config/network.js
 *
 * Single source of truth for blockchain network config.
 * Switch between Sepolia and local Hardhat by setting NETWORK in .env:
 *
 *   NETWORK=sepolia   (default)
 *   NETWORK=local     (Hardhat — npx hardhat node)
 */

const NETWORK = (process.env.NETWORK || 'sepolia').toLowerCase();

const configs = {
  sepolia: {
    name:                 'Sepolia',
    chainId:              11155111n,
    rpcUrl:               process.env.SEPOLIA_RPC_URL,
    dcldTokenAddress:     process.env.DCLD_TOKEN_ADDRESS,
    escrowAddress:        process.env.ESCROW_CONTRACT_ADDRESS,
  },
  local: {
    name:                 'Hardhat Local',
    chainId:              31337n,
    rpcUrl:               process.env.LOCAL_RPC_URL || 'http://127.0.0.1:8545',
    dcldTokenAddress:     process.env.LOCAL_DCLD_TOKEN_ADDRESS,
    escrowAddress:        process.env.LOCAL_ESCROW_CONTRACT_ADDRESS,
  },
};

if (!configs[NETWORK]) {
  throw new Error(`Unknown NETWORK="${NETWORK}". Use "sepolia" or "local".`);
}

const network = configs[NETWORK];

console.log(`[Network] Using ${network.name}  rpc=${network.rpcUrl}`);

module.exports = network;
