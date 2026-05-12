'use strict';
/**
 * scripts/deploy-local.js
 *
 * Deploys DecloudToken + StorageEscrow to a local Hardhat node,
 * mints DCLD to all 20 test accounts, and auto-updates .env.
 *
 * Usage:
 *   1. Terminal A:  npx hardhat node           (keep running)
 *   2. Terminal B:  node scripts/deploy-local.js
 *
 * Uses Hardhat account 0 as coordinator (pre-funded with 10 000 ETH).
 * Private key is the well-known Hardhat default — safe for local only.
 */

require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const { ethers } = require('ethers');

const LOCAL_RPC = process.env.LOCAL_RPC_URL || 'http://127.0.0.1:8545';

// Hardhat account 0 — always pre-funded, well-known key (local only)
const HARDHAT_COORDINATOR_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

// All 20 Hardhat default accounts
const HARDHAT_ACCOUNTS = [
  { address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', key: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' },
  { address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' },
  { address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', key: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a' },
  { address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', key: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6' },
  { address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', key: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a' },
  { address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc', key: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba' },
  { address: '0x976EA74026E726554dB657fA54763abd0C3a0aa9', key: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564' },
  { address: '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955', key: '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356' },
  { address: '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f', key: '0xdbda1821b80551c9d65939329250132c0b3a3d69d0e58f8e3b1a3b74d3acaf1' },
  { address: '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720', key: '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6' },
  { address: '0xBcd4042DE499D14e55001CcbB24a551F3b954096', key: '0xf214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897' },
  { address: '0x71bE63f3384f5fb98995898A86B02Fb2426c5788', key: '0x701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82' },
  { address: '0xFABB0ac9d68B0B445fB7357272Ff202C5651694a', key: '0xa267530f49f8280200edf313ee7af6b827f2a8bce2897751d06a843f644967b2' },
  { address: '0x1CBd3b2770909D4e10f157cABC84C7264073C9Ec', key: '0x47c99abed3324a2707c28affff1267e45918ec8c3f20b8aa892e8b065d2942dd' },
  { address: '0xdF3e18d64BC6A983f673Ab319CCaE4f1a57C7097', key: '0xc526ee95bf44d8fc405a158bb884d9d1238d99f0612e9f33d006bb0789009aaa' },
  { address: '0xcd3B766CCDd6AE721141F452C550Ca635964ce71', key: '0x8166f546bab6da521a8369cab06c5d2b9e46670292d85c875ee9ec20e84ffb61' },
  { address: '0x2546BcD3c84621e976D8185a91A922aE77ECEc30', key: '0xea6c44ac03bff858b476bba28179e906dca47b0b76c13a6b6b3a93c46c2eade9' },
  { address: '0xbDA5747bFD65F08deb54cb465eB87D40e51B197E', key: '0x689af8efa8c651a91ad287602527f3af2fe9f6501a7ac4b061667b5a93e037fd' },
  { address: '0xdD2FD4581271e230360230F9337D5c0430Bf44C0', key: '0xde9be858da4a475276426320d5e9262ecfc3ba460bfac56360bfa6c4c28b4ee0' },
  { address: '0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199', key: '0xdf57089febbacf7ba0bc227dafbffa9fc08a93fdc68e1e42411a14efcf23656e' },
];

const DCLD_MINT_AMOUNT = BigInt('10000') * BigInt('1000000000000000000'); // 10k DCLD each

async function compile(contractFile, contractName, needsImports) {
  const solc = require('solc');
  const source = fs.readFileSync(path.join(__dirname, '../contracts', contractFile), 'utf8');

  const input = {
    language: 'Solidity',
    sources: { [contractFile]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode'] } },
    },
  };

  function findImports(p) {
    try {
      return { contents: fs.readFileSync(path.join(__dirname, '../node_modules', p), 'utf8') };
    } catch {
      return { error: `Not found: ${p}` };
    }
  }

  const output = JSON.parse(
    needsImports
      ? solc.compile(JSON.stringify(input), { import: findImports })
      : solc.compile(JSON.stringify(input))
  );

  const errors = (output.errors || []).filter(e => e.severity === 'error');
  if (errors.length > 0) {
    errors.forEach(e => console.error(e.formattedMessage));
    throw new Error(`Compilation of ${contractFile} failed`);
  }

  return output.contracts[contractFile][contractName];
}

function updateEnv(kvPairs) {
  const envPath = path.join(__dirname, '../.env');
  let content = fs.readFileSync(envPath, 'utf8');

  for (const [key, value] of Object.entries(kvPairs)) {
    const regex = new RegExp(`^#?\\s*${key}=.*$`, 'm');
    const line  = `${key}=${value}`;
    if (regex.test(content)) {
      content = content.replace(regex, line);
    } else {
      content += `\n${line}`;
    }
  }

  fs.writeFileSync(envPath, content);
}

async function main() {
  console.log(`\n🔗 Connecting to ${LOCAL_RPC}…`);
  const provider = new ethers.JsonRpcProvider(LOCAL_RPC);

  let blockNumber;
  try {
    blockNumber = await provider.getBlockNumber();
  } catch {
    console.error(`\n❌ Cannot reach ${LOCAL_RPC}`);
    console.error('   Start the node first:  npx hardhat node');
    process.exit(1);
  }
  console.log(`✅ Connected  (block ${blockNumber})`);

  const coordinator = new ethers.Wallet(HARDHAT_COORDINATOR_KEY, provider);
  const coordBalance = await provider.getBalance(coordinator.address);
  console.log(`\nCoordinator: ${coordinator.address}`);
  console.log(`Balance:     ${ethers.formatEther(coordBalance)} ETH`);

  // Fetch nonce once and track manually to avoid ethers v6 caching bugs on Hardhat
  let nonce = Number(await provider.send('eth_getTransactionCount', [coordinator.address, 'pending']));

  // ── 1. Deploy DecloudToken ────────────────────────────────────────────────
  console.log('\n📦 Compiling DecloudToken.sol…');
  const tokenArtifact = await compile('DecloudToken.sol', 'DecloudToken', false);
  console.log('✅ Compiled');

  console.log('🚀 Deploying DecloudToken…');
  const tokenFactory  = new ethers.ContractFactory(tokenArtifact.abi, tokenArtifact.evm.bytecode.object, coordinator);
  const tokenDeployed = await tokenFactory.deploy(10_000_000, { nonce: nonce++ });
  await tokenDeployed.waitForDeployment();
  const tokenAddress = await tokenDeployed.getAddress();
  console.log(`✅ DecloudToken:  ${tokenAddress}`);

  // ── 2. Deploy StorageEscrow ───────────────────────────────────────────────
  console.log('\n📦 Compiling StorageEscrow.sol…');
  const escrowArtifact = await compile('StorageEscrow.sol', 'StorageEscrow', true);
  console.log('✅ Compiled');

  console.log('🚀 Deploying StorageEscrow…');
  const escrowFactory  = new ethers.ContractFactory(escrowArtifact.abi, escrowArtifact.evm.bytecode.object, coordinator);
  const escrowDeployed = await escrowFactory.deploy(tokenAddress, coordinator.address, { nonce: nonce++ });
  await escrowDeployed.waitForDeployment();
  const escrowAddress = await escrowDeployed.getAddress();
  console.log(`✅ StorageEscrow: ${escrowAddress}`);

  // ── 3. Mint DCLD to all 20 accounts ──────────────────────────────────────
  console.log('\n💰 Minting 10 000 DCLD to all 20 Hardhat accounts…');
  const token = new ethers.Contract(tokenAddress, tokenArtifact.abi, coordinator);
  for (const { address } of HARDHAT_ACCOUNTS) {
    const tx = await token.mint(address, DCLD_MINT_AMOUNT, { nonce: nonce++ });
    await tx.wait(1);
    process.stdout.write('.');
  }
  console.log('\n✅ Done minting');

  // ── 4. Update .env ────────────────────────────────────────────────────────
  console.log('\n📝 Updating .env…');
  updateEnv({
    LOCAL_RPC_URL:                'http://127.0.0.1:8545',
    LOCAL_DCLD_TOKEN_ADDRESS:     tokenAddress,
    LOCAL_ESCROW_CONTRACT_ADDRESS: escrowAddress,
  });
  console.log('✅ .env updated');

  // ── 5. Print summary ──────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(70));
  console.log('  LOCAL DEPLOYMENT COMPLETE');
  console.log('═'.repeat(70));
  console.log(`  DCLD Token:     ${tokenAddress}`);
  console.log(`  StorageEscrow:  ${escrowAddress}`);
  console.log(`  Coordinator:    ${coordinator.address}`);
  console.log('');
  console.log('  ⚠️  To use the local network, add to .env:');
  console.log('     NETWORK=local');
  console.log(`     COORDINATOR_PRIVATE_KEY=${HARDHAT_COORDINATOR_KEY}`);
  console.log('');
  console.log('  Hardhat accounts (all have 10 000 ETH + 10 000 DCLD):');
  console.log('  ─'.repeat(70));
  const roles = ['[0] Coordinator/Deployer', '[1] Peer 1', '[2] Peer 2', '[3] Client 1 (Android)', '[4] Client 2 (Android)', '[5] Spare', '[6] Spare', '[7] Spare', '[8] Spare', '[9] Spare'];
  for (let i = 0; i < 10; i++) {
    const { address, key } = HARDHAT_ACCOUNTS[i];
    console.log(`  ${(roles[i] || `[${i}]`).padEnd(26)} ${address}`);
    console.log(`  ${'Key:'.padEnd(26)} ${key}`);
  }
  console.log('═'.repeat(70));
  console.log('');
  console.log('  Android / Desktop: paste the private key of your account into');
  console.log('  the wallet import screen. Set RPC to http://<your-ip>:8545');
  console.log('');
}

main().catch(err => {
  console.error('\n❌', err.message);
  process.exit(1);
});
