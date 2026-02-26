const express = require('express');
const router = express.Router();
const { requestNonce, verify } = require('../controllers/authController');
console.log("AUTH ROUTER LOADED");

router.post('/nonce', requestNonce);

router.get('/nonce', (req, res) => {
    res.json({
        message: 'This endpoint expects a get request with a valid wallet addresss'
    });
});

router.get('/verify', (req, res) => {
    res.json({
        message: 'This endpoint expects a post request with a valid wallet address and signature'
    });
});

router.post('/verify', verify);

module.exports = router;

