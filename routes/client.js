const express = require('express');
const router = express.Router();

router.get('/upload', (req, res) => {
    res.json({
        message: 'This endpoint expects a get request with a valid wallet address and signature'
    });
});

router.post('/upload', (req, res) => {
    res.json({
        message: 'This endpoint expects a post request with a valid wallet address and signature'
    });
});