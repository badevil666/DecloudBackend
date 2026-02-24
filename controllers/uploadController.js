const { query } = require('../config/database');
const { ethers } = require('ethers');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const isHex = (str) => /^[0-9a-fA-F]+$/.test(str);

const sha256 = (data) =>
    crypto.createHash('sha256').update(data).digest('hex');

const uploadFile = async (req, res) => {
    try {
        const { walletAddress, jwt: token, file } = req.body;

        /* ================= AUTH ================= */

        if (!walletAddress || !ethers.isAddress(walletAddress)) {
            return res.status(400).json({ error: 'Invalid wallet address' });
        }

        if (!token || typeof token !== 'string') {
            return res.status(401).json({ error: 'JWT required' });
        }

        let decoded;
        try {
            decoded = jwt.verify(token, process.env.JWT_SECRET);
        } catch {
            return res.status(401).json({ error: 'Invalid JWT' });
        }

        if (decoded.walletAddress !== walletAddress) {
            return res.status(401).json({ error: 'Wallet mismatch' });
        }

        /* ================= FILE OBJECT ================= */

        if (!file || typeof file !== 'object') {
            return res.status(400).json({ error: 'file object required' });
        }

        const {
            name,
            filesize,
            fileHash,
            merkleRoot,
            replicationFactor,
            chunkingFactor,
            chunkHashes,
            chunkSizes,
            chunkNonce,
            chunkHash
        } = file;

        /* ================= BASIC VALIDATION ================= */

        if (!name || typeof name !== 'string') {
            return res.status(400).json({ error: 'Invalid file name' });
        }

        if (!Number.isInteger(filesize) || filesize <= 0) {
            return res.status(400).json({ error: 'Invalid filesize' });
        }

        if (!Number.isInteger(replicationFactor) || replicationFactor <= 0) {
            return res.status(400).json({ error: 'Invalid replicationFactor' });
        }

        if (!Number.isInteger(chunkingFactor) || chunkingFactor <= 0) {
            return res.status(400).json({ error: 'Invalid chunkingFactor' });
        }

        if (!isHex(fileHash) || !isHex(merkleRoot)) {
            return res.status(400).json({ error: 'Invalid hash format' });
        }

        /* ================= DIMENSION CHECKS ================= */

        if (
            !Array.isArray(chunkHashes) ||
            !Array.isArray(chunkSizes) ||
            !Array.isArray(chunkNonce) ||
            !Array.isArray(chunkHash)
        ) {
            return res.status(400).json({ error: 'Chunk arrays missing' });
        }

        if (
            chunkHashes.length !== chunkingFactor ||
            chunkSizes.length !== chunkingFactor ||
            chunkNonce.length !== chunkingFactor ||
            chunkHash.length !== chunkingFactor
        ) {
            return res.status(400).json({ error: 'Chunk dimension mismatch' });
        }

        /* ================= SIZE CHECK ================= */

        const totalSize = chunkSizes.reduce((a, b) => a + b, 0);
        if (totalSize < filesize) {
            return res.status(400).json({ error: 'Chunk sizes < filesize' });
        }

        chunkSizes.forEach((s) => {
            if (!Number.isInteger(s) || s <= 0) {
                throw new Error('Invalid chunk size');
            }
        });

        /* ================= CRYPTO VALIDATION ================= */

        const seenNonces = new Set();

        for (let i = 0; i < chunkingFactor; i++) {
            if (!isHex(chunkHashes[i])) {
                return res.status(400).json({ error: `Invalid chunk hash at ${i}` });
            }

            if (
                !Array.isArray(chunkNonce[i]) ||
                !Array.isArray(chunkHash[i]) ||
                chunkNonce[i].length !== chunkHash[i].length ||
                chunkNonce[i].length === 0
            ) {
                return res.status(400).json({ error: `Invalid nonce/hash list at chunk ${i}` });
            }

            for (let j = 0; j < chunkNonce[i].length; j++) {
                const nonce = chunkNonce[i][j];
                const expectedHash = chunkHash[i][j];

                if (!isHex(nonce) || !isHex(expectedHash)) {
                    return res.status(400).json({ error: 'Invalid nonce or hash encoding' });
                }

                if (seenNonces.has(nonce)) {
                    return res.status(400).json({ error: 'Nonce reuse detected' });
                }
                seenNonces.add(nonce);

                const computed = sha256(chunkHashes[i] + nonce);
                if (computed !== expectedHash) {
                    return res.status(400).json({ error: 'Commitment mismatch' });
                }
            }
        }

        /* ================= MERKLE ROOT CHECK ================= */

        const recomputedRoot = sha256(chunkHashes.join(''));
        if (recomputedRoot !== merkleRoot) {
            return res.status(400).json({ error: 'Merkle root mismatch' });
        }

        /* ================= DB INSERT (FILE ONLY) ================= */

        const result = await query(
            `INSERT INTO files
             (owner_wallet, file_name, file_hash, file_size, status)
             VALUES ($1, $2, $3, $4, 'pending')
             RETURNING id`,
            [walletAddress, name, fileHash, filesize]
        );

        return res.status(200).json({
            success: true,
            fileId: result.rows[0].id,
            status: 'pending'
        });

    } catch (err) {
        console.error(err);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

module.exports = uploadFile;
