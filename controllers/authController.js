const { query } = require('../config/database');
const { ethers } = require('ethers');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const requestNonce = async (req, res, next) => {
  try {
    const { walletAddress } = req.body;

    if (!walletAddress || !ethers.isAddress(walletAddress)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    const normalizedAddress = walletAddress.toLowerCase();
    const nonce = crypto.randomBytes(32).toString('hex');
    const message = `Login to Decloud: ${nonce}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    await query(
      'INSERT INTO auth_nonces (wallet_address, nonce, expires_at, used) VALUES ($1, $2, $3, $4)',
      [normalizedAddress, nonce, expiresAt, false]
    );

    res.json({ message });
  } catch (error) {
    next(error);
  }
};

const verify = async (req, res, next) => {
  try {
    const { walletAddress, signature } = req.body;

    if (!walletAddress || !ethers.isAddress(walletAddress)) {
      return res.status(400).json({ error: 'Invalid wallet address' });
    }

    if (!signature) {
      return res.status(400).json({ error: 'Signature required' });
    }

    const normalizedAddress = walletAddress.toLowerCase();

    const result = await query(
      `SELECT nonce FROM auth_nonces 
       WHERE wallet_address = $1 
       AND expires_at > NOW() 
       AND used = false 
       ORDER BY created_at DESC 
       LIMIT 1`,
      [normalizedAddress]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'No valid nonce found' });
    }

    const { nonce } = result.rows[0];
    const message = `Login to Decloud: ${nonce}`;

    const recoveredAddress = ethers.verifyMessage(message, signature);
    const normalizedRecovered = recoveredAddress.toLowerCase();

    if (normalizedRecovered !== normalizedAddress) {
      return res.status(401).json({ error: 'Signature verification failed' });
    }

    await query(
      'UPDATE auth_nonces SET used = true WHERE wallet_address = $1 AND nonce = $2',
      [normalizedAddress, nonce]
    );

    /*await query(
      'INSERT INTO users (wallet_address) VALUES ($1) ON CONFLICT (wallet_address) DO NOTHING',
      [normalizedAddress]
    );*/

    const token = jwt.sign(
      { walletAddress: normalizedAddress },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({ token });
  } catch (error) {
    if (error.code === 'INVALID_ARGUMENT' || error.reason === 'invalid signature') {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    next(error);
  }
};

module.exports = {
  requestNonce,
  verify
};

