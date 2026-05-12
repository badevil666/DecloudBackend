'use strict';
/**
 * scripts/fund-local.js
 *
 * Sends 10 ETH + 10 000 DCLD to any address from the Hardhat coordinator wallet.
 *
 * Usage:
 *   node scripts/fund-local.js 0xYOUR_ADDRESS
 */

require('dotenv').config();
const { ethers } = require('ethers');

const LOCAL_RPC               = process.env.LOCAL_RPC_URL || 'http://127.0.0.1:8545';
const COORDINATOR_KEY         = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DCLD_TOKEN_ADDRESS      = process.env.LOCAL_DCLD_TOKEN_ADDRESS;
const DCLD_MINT_AMOUNT        = BigInt('10000') * BigInt('1000000000000000000'); // 10k DCLD
const ETH_AMOUNT              = ethers.parseEther('10');

const TOKEN_ABI = [
  'function mint(address to, uint256 amount)',
  'function balanceOf(address) view returns (uint256)',
];

async function main() {
  const target = process.argv[2];
  if (!target || !ethers.isAddress(target)) {
    console.error('Usage: node scripts/fund-local.js 0xYOUR_ADDRESS');
    process.exit(1);
  }
  if (!DCLD_TOKEN_ADDRESS) {
    console.error('LOCAL_DCLD_TOKEN_ADDRESS not set in .env — run deploy-local.js first');
    process.exit(1);
  }

  const provider    = new ethers.JsonRpcProvider(LOCAL_RPC);
  const coordinator = new ethers.Wallet(COORDINATOR_KEY, provider);

  console.log(`\nFunding ${target}…`);

  // Send ETH
  let nonce = Number(await provider.send('eth_getTransactionCount', [coordinator.address, 'pending']));
  const ethTx = await coordinator.sendTransaction({ to: target, value: ETH_AMOUNT, nonce: nonce++ });
  await ethTx.wait(1);
  console.log(`✅ Sent 10 ETH  (tx: ${ethTx.hash.slice(0, 14)}…)`);

  // Mint DCLD
  const token  = new ethers.Contract(DCLD_TOKEN_ADDRESS, TOKEN_ABI, coordinator);
  const mintTx = await token.mint(target, DCLD_MINT_AMOUNT, { nonce: nonce++ });
  await mintTx.wait(1);
  console.log(`✅ Minted 10 000 DCLD  (tx: ${mintTx.hash.slice(0, 14)}…)`);

  const ethBal  = await provider.getBalance(target);
  const dcldBal = await token.balanceOf(target);
  console.log(`\nNew balances:`);
  console.log(`  ETH:  ${ethers.formatEther(ethBal)}`);
  console.log(`  DCLD: ${ethers.formatUnits(dcldBal, 18)}`);
}

main().catch(err => {
  console.error('\n❌', err.message);
  process.exit(1);
});
