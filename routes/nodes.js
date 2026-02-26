const express = require('express');
const router = express.Router();
const { query } = require('../config/database'); 

router.post('/heartbeat', async (req, res, next) => {
    try {
        const { walletAddress, ipAddress, freeCapacity } = req.body;

        if (!walletAddress) {
            return res.status(400).json({ error: "Wallet address required" });
        }

        const normalizedWallet = walletAddress.toLowerCase();

        // 1. UPDATE the existing Storage Peer 
        const peerQuery = `
            UPDATE storage_peers 
            SET peer_status = 'ACTIVE' 
            WHERE wallet_address = $1 
            RETURNING peer_id;
        `;
        const peerResult = await query(peerQuery, [normalizedWallet]);

        if (peerResult.rows.length === 0) {
            return res.status(404).json({ error: "Peer not found. Please authenticate first." });
        }

        // 2. INSERT the Heartbeat Log 
        // 🚨 TEMPORARILY REMOVED UNTIL TEAMMATE CREATES THE TABLE!
        /* const capacityNum = parseInt(freeCapacity) || 0;
        const availableBytes = capacityNum * 1024 * 1024 * 1024;
        const peerId = peerResult.rows[0].peer_id;
        const heartbeatQuery = `
            INSERT INTO peer_heartbeats (peer_id, available_storage_bytes, heartbeat_at)
            VALUES ($1, $2, NOW());
        `;
        await query(heartbeatQuery, [peerId, availableBytes]);
        */

        console.log(`💓 Heartbeat logged (Status only) for ${normalizedWallet.substring(0, 6)}...`);
        res.json({ status: "seen" });

    } catch (err) {
        console.error("❌ Database Error in Heartbeat:", err);
        next(err); 
    }
});

module.exports = router;