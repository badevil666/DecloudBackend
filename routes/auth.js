const express = require('express');
const router = express.Router();
const { requestNonce, verify } = require('../controllers/authController');

router.post('/request-nonce', requestNonce);
router.post('/verify', verify);

module.exports = router;

