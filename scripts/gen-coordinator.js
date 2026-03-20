'use strict';
/**
 * scripts/gen-coordinator.js
 *
 * Generates a fresh Ethereum wallet to use as the coordinator.
 * Run once, save the output somewhere safe, then add to .env.
 *
 * Usage:
 *   node scripts/gen-coordinator.js
 */

const { ethers } = require('ethers');

const wallet = ethers.Wallet.createRandom();

console.log('\n========================================');
console.log('  COORDINATOR WALLET — SAVE THIS SAFELY');
console.log('========================================');
console.log(`Address:     ${wallet.address}`);
console.log(`Private key: ${wallet.privateKey}`);
console.log(`Mnemonic:    ${wallet.mnemonic?.phrase}`);
console.log('========================================\n');
console.log('Add to DecloudBackend/.env:');
console.log(`COORDINATOR_PRIVATE_KEY=${wallet.privateKey}\n`);
console.log('Then fund this address with Sepolia ETH (for gas):');
console.log(`  https://sepoliafaucet.com  →  ${wallet.address}\n`);
