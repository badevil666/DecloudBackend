const express = require('express');
const router = express.Router();
const { getNonce, peerLogin, peerRegister } = require('../controllers/authController');
const authenticate = require('../middleware/auth');
const { submitPeerDealSignature } = require('../controllers/dealController');

/**
 * GET /peer/login
 * Request a nonce to sign for login.
 *
 * Request Body:
 * {
 *   "wallet_address": "string (Valid Ethereum wallet address)"
 * }
 *
 * Response:
 * {
 *   "nonce": "string (Decloud nonce: <random hex>)"
 * }
 */
router.get('/login', getNonce);

/**
 * POST /peer/login
 * Verify signed nonce and return a JWT for an existing storage peer.
 *
 * Request Body:
 * {
 *   "wallet_address": "string (Valid Ethereum wallet address)",
 *   "nonce": "string (Nonce received from GET /peer/login)",
 *   "signature": "string (Nonce signed by the wallet)"
 * }
 *
 * Response:
 * {
 *   "token": "string (JWT)"
 * }
 */
router.post('/login', peerLogin);

/**
 * GET /peer/register
 * Request a nonce to sign for registration.
 *
 * Request Body:
 * {
 *   "wallet_address": "string (Valid Ethereum wallet address)"
 * }
 *
 * Response:
 * {
 *   "nonce": "string (Decloud nonce: <random hex>)"
 * }
 */
router.get('/register', getNonce);

/**
 * POST /peer/register
 * Verify signed nonce and register a new storage peer, returning a JWT.
 *
 * Request Body:
 * {
 *   "wallet_address": "string (Valid Ethereum wallet address)",
 *   "nonce": "string (Nonce received from GET /peer/register)",
 *   "signature": "string (Nonce signed by the wallet)",
 *   "os_type": "string (Operating system of the peer)",
 *   "declared_capacity": 100 // number (Positive number, in GB)
 * }
 *
 * Response (201):
 * {
 *   "token": "string (JWT)"
 * }
 */
router.post('/register', peerRegister);

/**
 * POST /peer/deals/:dealId/sign
 * Submit an EIP-712 signature for a pending deal (peer confirmation).
 *
 * Request Body: { "signature": "0x..." }
 * Response (200): { "status": "accepted", "dealId": "0x..." }
 */
router.post('/deals/:dealId/sign', authenticate('STORAGE_PEER'), submitPeerDealSignature);

module.exports = router;
