const { query } = require('../config/database');
const { ethers } = require('ethers');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

const validateEthAddress = (address) => {
  if (!address || typeof address !== 'string' || !ethers.isAddress(address)) {
    const err = new Error('Invalid Ethereum wallet address');
    err.status = 400;
    throw err;
  }
  return ethers.getAddress(address).toLowerCase();
};

// POST /auth/request-nonce
// Body: { wallet_address }
const requestNonce = async (req, res, next) => {
  try {
    const { wallet_address } = req.body;

    const normalizedWallet = validateEthAddress(wallet_address);
    let nonce = crypto.randomBytes(32).toString('hex');
    nonce = `Decloud nonce: ${nonce}`;
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + 10 * 60 * 1000);

    console.log('nonce', nonce);
    console.log('normalizedWallet', normalizedWallet);
    console.log('issuedAt', issuedAt);
    console.log('expiresAt', expiresAt);

    await query(
      `INSERT INTO auth_nonces (nonce, wallet_address, issued_at, expires_at, used)
       VALUES ($1, $2, $3, $4, $5)`,
      [nonce, normalizedWallet, issuedAt, expiresAt, false]
    );

    res.json({ nonce });
  } catch (error) {
    next(error);
  }
};

// Internal helper: verifies nonce + signature and marks nonce as used
const verifyNonceAndSignature = async ({ walletAddress, nonce, signature }) => {
  const normalizedWallet = validateEthAddress(walletAddress);

  if (!nonce || typeof nonce !== 'string') {
    const err = new Error('nonce is required');
    err.status = 400;
    throw err;
  }
  if (!signature || typeof signature !== 'string') {
    const err = new Error('signature is required');
    err.status = 400;
    throw err;
  }

  const result = await query(
    `SELECT nonce, wallet_address, expires_at, used
     FROM auth_nonces
     WHERE nonce = $1 AND wallet_address = $2
     ORDER BY issued_at DESC
     LIMIT 1`,
    [nonce, normalizedWallet]
  );

  if (result.rows.length === 0) {
    const err = new Error('Nonce not found');
    err.status = 401;
    throw err;
  }

  const row = result.rows[0];
  console.log('row', row);
  if (row.used) {
    const err = new Error('Nonce already used');
    err.status = 401;
    throw err;
  }

  if (row.expires_at && new Date(row.expires_at) <= new Date()) {
    const err = new Error('Nonce expired');
    err.status = 401;
    throw err;
  }

  let recoveredAddress;
  try {
    recoveredAddress = ethers.verifyMessage(nonce, signature);

  } catch (e) {
    const err = new Error('Invalid signature');
    err.status = 401;
    throw err;
  }

  const normalizedRecovered = recoveredAddress.toLowerCase();
  console.log('normalizedRecovered', normalizedRecovered); 
  console.log('normalizedWallet', normalizedWallet)
  

  if (normalizedRecovered !== normalizedWallet) {
    const err = new Error('Signature verification failed');
    err.status = 401;
    throw err;
  }

  await query(
    'UPDATE auth_nonces SET used = true WHERE nonce = $1 AND wallet_address = $2',
    [nonce, normalizedWallet]
  );

  return { walletAddress: normalizedWallet };
};

// POST /auth/verify
// Body: { wallet_address, nonce, signature, mode, role, os_type?, declared_capacity? }
const verify = async (req, res, next) => {
  try {
    const {
      wallet_address,
      nonce,
      signature,
      mode,
      role,
      os_type,
      declared_capacity,
    } = req.body;

    const upperMode = typeof mode === 'string' ? mode.toUpperCase() : '';
    const upperRole = typeof role === 'string' ? role.toUpperCase() : '';

    if (!['LOGIN', 'REGISTER'].includes(upperMode)) {
      return res.status(400).json({ error: 'Invalid mode' });
    }

    if (!['CLIENT', 'STORAGE_PEER'].includes(upperRole)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    if (upperMode === 'REGISTER' && upperRole === 'STORAGE_PEER') {
      if (!os_type || typeof os_type !== 'string') {
        return res.status(400).json({ error: 'os_type is required for STORAGE_PEER registration' });
      }
      if (
        declared_capacity === undefined ||
        declared_capacity === null ||
        typeof declared_capacity !== 'number' ||
        declared_capacity <= 0
      ) {
        return res.status(400).json({ error: 'declared_capacity must be a positive number' });
      }
    }

    const { walletAddress } = await verifyNonceAndSignature({
      walletAddress: wallet_address,
      nonce,
      signature,
    });

    let subjectId;

    if (upperMode === 'REGISTER') {
      if (upperRole === 'CLIENT') {
        const existing = await query(
          'SELECT client_id FROM clients WHERE wallet_address = $1',
          [walletAddress]
        );

        if (existing.rows.length > 0) {
          return res.status(409).json({ error: 'Client already registered' });
        }

        const inserted = await query(
          'INSERT INTO clients (wallet_address) VALUES ($1) RETURNING client_id',
          [walletAddress]
        );

        subjectId = inserted.rows[0].client_id;
      } else if (upperRole === 'STORAGE_PEER') {
        const existing = await query(
          'SELECT peer_id FROM storage_peers WHERE wallet_address = $1',
          [walletAddress]
        );

        if (existing.rows.length > 0) {
          return res.status(409).json({ error: 'Storage peer already registered' });
        }

        const inserted = await query(
          `INSERT INTO storage_peers (wallet_address, os_type, declared_capacity, verified_capacity, peer_status)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING peer_id`,
          [walletAddress, os_type, declared_capacity, 0, 'PENDING']
        );

        subjectId = inserted.rows[0].peer_id;
      }
    } else if (upperMode === 'LOGIN') {
      if (upperRole === 'CLIENT') {
        const existing = await query(
          'SELECT client_id FROM clients WHERE wallet_address = $1',
          [walletAddress]
        );

        if (existing.rows.length === 0) {
          return res.status(401).json({ error: 'Client not registered' });
        }

        subjectId = existing.rows[0].client_id;
      } else if (upperRole === 'STORAGE_PEER') {
        const existing = await query(
          'SELECT peer_id FROM storage_peers WHERE wallet_address = $1',
          [walletAddress]
        );

        if (existing.rows.length === 0) {
          return res.status(401).json({ error: 'Storage peer not registered' });
        }

        subjectId = existing.rows[0].peer_id;
      }
    }

    const tokenPayload = {
      sub: subjectId,
      role: upperRole,
      wallet_address: walletAddress,
    };

    const token = jwt.sign(tokenPayload, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
    });

    res.json({ token });
  } catch (error) {
    if (error.status) {
      return res.status(error.status).json({ error: error.message });
    }
    next(error);
  }
};

module.exports = {
  requestNonce,
  verify,
  verifyNonceAndSignature,
};

