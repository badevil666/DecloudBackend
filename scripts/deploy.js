'use strict';
/**
 * scripts/deploy.js
 *
 * Deploys StorageEscrow.sol to Sepolia using ethers.js v6.
 * No Hardhat/Foundry needed — compiles with solc, deploys with ethers.
 *
 * Usage:
 *   npm install --save-dev solc          (one-time)
 *   node scripts/deploy.js
 *
 * Required env vars (in .env):
 *   SEPOLIA_RPC_URL          - e.g. https://sepolia.infura.io/v3/YOUR_KEY
 *   COORDINATOR_PRIVATE_KEY  - 0x-prefixed key that pays gas AND becomes coordinator
 *   DCLD_TOKEN_ADDRESS       - deployed DCLD ERC-20 address on Sepolia
 */

require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const { ethers } = require('ethers');

async function main() {
  const rpcUrl     = process.env.SEPOLIA_RPC_URL;
  const privateKey = process.env.COORDINATOR_PRIVATE_KEY;
  const tokenAddr  = process.env.DCLD_TOKEN_ADDRESS || '0x1702e56a169517e8EFf510DFBF2579Cf1d94621A';

  if (!rpcUrl)     throw new Error('SEPOLIA_RPC_URL not set in .env');
  if (!privateKey) throw new Error('COORDINATOR_PRIVATE_KEY not set in .env');

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet   = new ethers.Wallet(privateKey, provider);

  console.log(`Deploying from:  ${wallet.address}`);
  console.log(`Token address:   ${tokenAddr}`);
  console.log(`Coordinator:     ${wallet.address}  (same as deployer)`);

  const balance = await provider.getBalance(wallet.address);
  console.log(`ETH balance:     ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) throw new Error('Wallet has no ETH — fund it with Sepolia ETH first');

  // ── Compile ───────────────────────────────────────────────────────────────
  let solc;
  try {
    solc = require('solc');
  } catch {
    throw new Error('solc not installed. Run: npm install --save-dev solc');
  }

  const contractPath = path.join(__dirname, '../contracts/StorageEscrow.sol');
  const source = fs.readFileSync(contractPath, 'utf8');

  console.log('\nCompiling StorageEscrow.sol…');

  const input = {
    language: 'Solidity',
    sources: { 'StorageEscrow.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } },
    },
  };

  // solc needs OpenZeppelin imports — use a remapping callback
  function findImports(importPath) {
    try {
      // Try node_modules
      const candidate = path.join(__dirname, '../node_modules', importPath);
      return { contents: fs.readFileSync(candidate, 'utf8') };
    } catch {
      return { error: `File not found: ${importPath}` };
    }
  }

  const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

  if (output.errors) {
    const errors = output.errors.filter(e => e.severity === 'error');
    if (errors.length > 0) {
      errors.forEach(e => console.error(e.formattedMessage));
      throw new Error('Compilation failed');
    }
    output.errors
      .filter(e => e.severity === 'warning')
      .forEach(w => console.warn('⚠️', w.formattedMessage));
  }

  const contract = output.contracts['StorageEscrow.sol']['StorageEscrow'];
  const abi      = contract.abi;
  const bytecode = contract.evm.bytecode.object;

  console.log('✅ Compiled');

  // ── Deploy ────────────────────────────────────────────────────────────────
  console.log('\nDeploying…');
  const factory  = new ethers.ContractFactory(abi, bytecode, wallet);
  const deployed = await factory.deploy(tokenAddr, wallet.address);

  console.log(`Tx hash: ${deployed.deploymentTransaction().hash}`);
  console.log('Waiting for 2 confirmations…');

  await deployed.waitForDeployment();
  const address = await deployed.getAddress();

  console.log('\n✅ StorageEscrow deployed!');
  console.log(`Address: ${address}`);
  console.log('\nAdd these to your .env:');
  console.log(`ESCROW_CONTRACT_ADDRESS=${address}`);
  console.log('\nAdd this to decloud-android/lib/core/config/blockchain_config.dart:');
  console.log(`const String escrowContractAddress = "${address}";`);
}

main().catch(err => {
  console.error('\n❌', err.message);
  process.exit(1);
});
