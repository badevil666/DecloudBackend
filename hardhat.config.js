'use strict';
/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  networks: {
    hardhat: { chainId: 31337 },
    localhost: { url: 'http://127.0.0.1:8545', chainId: 31337 },
  },
  // No solidity version needed — we compile via solc directly in deploy scripts
};
