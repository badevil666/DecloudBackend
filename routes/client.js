const express = require('express');
const router = express.Router();
const { getNonce, clientLogin, clientRegister } = require('../controllers/authController');

/**
 * GET /client/login
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
 * POST /client/login
 * Verify signed nonce and return a JWT for an existing client.
 *
 * Request Body:
 * {
 *   "wallet_address": "string (Valid Ethereum wallet address)",
 *   "nonce": "string (Nonce received from GET /client/login)",
 *   "signature": "string (Nonce signed by the wallet)"
 * }
 *
 * Response:
 * {
 *   "token": "string (JWT)"
 * }
 */
router.post('/login', clientLogin);

/**
 * GET /client/register
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
 * POST /client/register
 * Verify signed nonce and register a new client, returning a JWT.
 *
 * Request Body:
 * {
 *   "wallet_address": "string (Valid Ethereum wallet address)",
 *   "nonce": "string (Nonce received from GET /client/register)",
 *   "signature": "string (Nonce signed by the wallet)"
 * }
 *
 * Response (201):
 * {
 *   "token": "string (JWT)"
 * }
 */
router.post('/register', clientRegister);

router.get('/upload', (_req, res) => {
  res.json({
    message: 'This endpoint expects a post request with a valid wallet address and signature'
  });
});

router.post('/upload', (_req, res) => {
  res.json({
    message: 'This endpoint expects a post request with a valid wallet address and signature'
  });
});

module.exports = router;
