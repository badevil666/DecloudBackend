const express = require('express');
const router = express.Router();
const { query } = require('../config/database'); // add this line

// Health check route
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

router.get('/db-check', async (req, res, next) => {
  try {
    const { rows } = await query('SELECT NOW() AS now');
    res.json({
      status: 'ok',
      now: rows[0].now
    });
  } catch (err) {
    next(err);
  }
});
// Add more routes here
// router.use('/users', require('./users'));
// router.use('/products', require('./products'));

module.exports = router;

