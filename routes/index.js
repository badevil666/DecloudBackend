const express = require('express');
const router = express.Router();

// Health check route
router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

// Add more routes here
// router.use('/users', require('./users'));
// router.use('/products', require('./products'));

module.exports = router;

