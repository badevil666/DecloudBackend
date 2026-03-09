const express = require('express');
const router = express.Router();
const { ethers } = require('ethers');
const { query } = require('../config/database'); 

router.post('/claim', async (req, res) => {
    try {
        const { walletAddress } = req.body;

        if (!walletAddress) {
            return res.status(400).json({ error: "Wallet address required" });
        }

        const normalizedWallet = walletAddress.toLowerCase();

        // 1. VERIFY NODE IN THE DATABASE
        // Before we write a check, let's make sure they are actually in our system!
        const dbCheck = await query(
            'SELECT peer_status, last_heartbeat FROM storage_peers WHERE wallet_address = $1',
            [normalizedWallet]
        );

        if (dbCheck.rows.length === 0) {
            return res.status(404).json({ error: "Node not found in Coordinator database." });
        }

        // 2. CALCULATE THE REWARD (The Math)
        // Note: Later, we will use dbCheck.rows[0].last_heartbeat to calculate exact uptime.
        // For now, we are hardcoding a 50 DCLD token reward to test the blockchain bridge!
        const earnedTokens = "50"; 
        const amountWei = ethers.parseEther(earnedTokens); 

        // 3. THE COORDINATOR'S IDENTITY
        const privateKey = process.env.COORDINATOR_PRIVATE_KEY;
        if (!privateKey) {
             return res.status(500).json({ error: "Coordinator Private Key not configured." });
        }
        
        const coordinatorWallet = new ethers.Wallet(privateKey);
        console.log(`✍️ Coordinator (${coordinatorWallet.address}) is signing a reward for ${normalizedWallet}`);

        // 4. RECREATE THE MESSAGE HASH
        // This perfectly matches the Solidity contract: keccak256(abi.encodePacked(msg.sender, _amount))
        const messageHash = ethers.solidityPackedKeccak256(
            ["address", "uint256"],
            [walletAddress, amountWei] // Ensure we use the exact casing the user passed for signing
        );

        // 5. SIGN THE HASH
        const signature = await coordinatorWallet.signMessage(ethers.getBytes(messageHash));

        // 6. HAND THE CHECK TO THE NODE
        res.json({
            wallet: walletAddress,
            amountWei: amountWei.toString(),
            amountDisplay: earnedTokens,
            signature: signature
        });

    } catch (err) {
        console.error("❌ Reward Generation Error:", err);
        res.status(500).json({ error: "Failed to generate reward signature" });
    }
});

module.exports = router;