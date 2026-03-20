'use strict';
/**
 * scripts/deployToken.js
 *
 * Deploys DecloudToken.sol (full ERC-20) to Sepolia and mints initial supply.
 * Run this BEFORE deploying StorageEscrow if the existing DCLD token is broken.
 *
 * Usage:
 *   npm install --save-dev solc          (one-time)
 *   node scripts/deployToken.js
 *
 * Required env vars (in .env):
 *   SEPOLIA_RPC_URL          - e.g. https://sepolia.infura.io/v3/YOUR_KEY
 *   COORDINATOR_PRIVATE_KEY  - deployer wallet (becomes token owner)
 *
 * Optional env vars:
 *   TOKEN_HOLDER_ADDRESS     - wallet to receive the full initial supply (defaults to deployer)
 *   PEER_ADDRESS             - peer wallet to mint initial DCLD to
 *   CLIENT_ADDRESS           - client wallet to mint initial DCLD to
 *
 * After running, update:
 *   DecloudBackend/.env                                → DCLD_TOKEN_ADDRESS=<new addr>
 *   desktop/src/services/ethService.ts                → DCLD_TOKEN_ADDR
 *   decloud-android/lib/core/config/blockchain_config.dart → dcldTokenAddress
 */

require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const { ethers } = require('ethers');

const INITIAL_SUPPLY   = 10_000_000; // 10M DCLD minted to deployer
const PEER_MINT        = 10_000;     // 10k DCLD minted to each peer/client address
const WEI_PER_DCLD     = BigInt('1000000000000000000'); // 1e18

async function main() {
  const rpcUrl     = process.env.SEPOLIA_RPC_URL;
  const privateKey = process.env.COORDINATOR_PRIVATE_KEY;

  if (!rpcUrl)     throw new Error('SEPOLIA_RPC_URL not set in .env');
  if (!privateKey) throw new Error('COORDINATOR_PRIVATE_KEY not set in .env');

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet   = new ethers.Wallet(privateKey, provider);

  console.log(`Deploying from: ${wallet.address}`);

  const balance = await provider.getBalance(wallet.address);
  console.log(`ETH balance:    ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) throw new Error('Wallet has no ETH — fund it with Sepolia ETH first');

  // ── Compile ───────────────────────────────────────────────────────────────
  let solc;
  try {
    solc = require('solc');
  } catch {
    throw new Error('solc not installed. Run: npm install --save-dev solc');
  }

  const contractPath = path.join(__dirname, '../contracts/DecloudToken.sol');
  const source = fs.readFileSync(contractPath, 'utf8');

  console.log('\nCompiling DecloudToken.sol…');

  const input = {
    language: 'Solidity',
    sources: { 'DecloudToken.sol': { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } },
    },
  };

  const output = JSON.parse(solc.compile(JSON.stringify(input)));

  if (output.errors) {
    const errors = output.errors.filter(e => e.severity === 'error');
    if (errors.length > 0) {
      errors.forEach(e => console.error(e.formattedMessage));
      throw new Error('Compilation failed');
    }
  }

  const contract = output.contracts['DecloudToken.sol']['DecloudToken'];
  const abi      = contract.abi;
  const bytecode = contract.evm.bytecode.object;

  console.log('✅ Compiled');

  // ── Deploy ────────────────────────────────────────────────────────────────
  console.log('\nDeploying…');
  const factory  = new ethers.ContractFactory(abi, bytecode, wallet);
  const deployed = await factory.deploy(INITIAL_SUPPLY);

  console.log(`Tx hash: ${deployed.deploymentTransaction().hash}`);
  console.log('Waiting for 2 confirmations…');
  await deployed.waitForDeployment();

  const address = await deployed.getAddress();
  console.log(`\n✅ DecloudToken deployed at: ${address}`);

  const token = new ethers.Contract(address, abi, wallet);

  // Transfer initial supply to TOKEN_HOLDER_ADDRESS if specified
  const holder = process.env.TOKEN_HOLDER_ADDRESS;
  if (holder && holder.toLowerCase() !== wallet.address.toLowerCase()) {
    const amount = BigInt(INITIAL_SUPPLY) * WEI_PER_DCLD;
    const tx = await token.transfer(holder, amount);
    await tx.wait(1);
    console.log(`   Transferred ${INITIAL_SUPPLY.toLocaleString()} DCLD → ${holder}`);
  } else {
    console.log(`   Minted ${INITIAL_SUPPLY.toLocaleString()} DCLD to deployer (${wallet.address})`);
  }

  // ── Mint to peer/client wallets if specified ──────────────────────────────
  const recipients = [
    process.env.PEER_ADDRESS,
    process.env.CLIENT_ADDRESS,
  ].filter(Boolean);

  for (const addr of recipients) {
    const amount = BigInt(PEER_MINT) * WEI_PER_DCLD;
    const tx = await token.mint(addr, amount);
    await tx.wait(1);
    console.log(`   Minted ${PEER_MINT.toLocaleString()} DCLD → ${addr}`);
  }

  // ── Print update instructions ─────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────────────────────');
  console.log('Update these files:');
  console.log(`\n1. DecloudBackend/.env`);
  console.log(`   DCLD_TOKEN_ADDRESS=${address}`);
  console.log(`\n2. desktop/src/services/ethService.ts`);
  console.log(`   export const DCLD_TOKEN_ADDR = '${address}';`);
  console.log(`\n3. decloud-android/lib/core/config/blockchain_config.dart`);
  console.log(`   const String dcldTokenAddress = "${address}";`);
  console.log('\nThen redeploy StorageEscrow with:');
  console.log('   DCLD_TOKEN_ADDRESS=' + address + ' node scripts/deploy.js');
}

main().catch(err => {
  console.error('\n❌', err.message);
  process.exit(1);
});
