const express = require('express');
const router = express.Router();
const { getNonce, clientLogin, clientRegister } = require('../controllers/authController');
const authenticate = require('../middleware/auth');
const { uploadFile } = require('../controllers/uploadController');
const { getFiles } = require('../controllers/fileController');

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

/**
 * POST /client/upload
 * Upload file metadata and chunk commitments.
 * JWT (CLIENT role) must be included in the request body as "jwt".
 *
 * Request Body:
 * {
 *   "jwt": "string",
 *   "filename": "video.mp4",
 *   "filesize": 10485760,
 *   "fileHash": "abc123...",
 *   "numberOfChunks": 4,
 *   "replicationFactor": 3,
 *   "endDate": "2026-06-01T00:00:00.000Z",
 *   "chunkInfo": [
 *     {
 *       "hash": "chunkHash0...",
 *       "nonces": [
 *         { "nonce": "deadbeef...", "hash": "combined_hash..." }
 *       ]
 *     }
 *   ]
 * }
 *
 * Response (201):
 * {
 *   "fileId": "uuid",
 *   "merkleRoot": "hex",
 *   "status": "PENDING"
 * }
 */
router.post('/upload', authenticate('CLIENT'), uploadFile);

/**
 * GET /client/files
 * Returns all files uploaded by the authenticated client.
 * Auth: Authorization: Bearer <token>
 */
router.get('/files', authenticate('CLIENT'), getFiles);

/**
 * GET /client/files/:fileId
 * Returns full details for a single file — chunks, replica peers, relay tokens.
 * Auth: Authorization: Bearer <token>
 */
router.get('/files/:fileId', authenticate('CLIENT'), getFiles);

module.exports = router;
