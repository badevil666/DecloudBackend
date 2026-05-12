const http = require('http');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config();
const { attachPeerWS } = require('./websocket/peerWS');
const { startProofScheduler } = require('./services/proofService');

const app = express();
const PORT = process.env.PORT || 3000;

const api = require('./routes/index');
const client = require('./routes/client');
const peer = require('./routes/peer');
const logger = require('./middleware/logger');
const network = require('./config/network');

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(logger);

// Routes
app.get('/', (_req, res) => {
  res.json({
    message: 'Welcome to DecloudBackend API',
    status: 'running',
    version: '1.0.0'
  });
});

// Public network config — no auth required; lets any client/peer resolve addresses
app.get('/network-config', (_req, res) => {
  res.json({
    escrowAddress:    network.escrowAddress    ?? null,
    dcldTokenAddress: network.dcldTokenAddress ?? null,
    chainId:          network.chainId?.toString() ?? null,
    rpcUrl:           network.rpcUrl           ?? null,
  });
});

// API Routes
app.use('/api', api);
app.use('/client', client);
app.use('/peer', peer);

// 404 Handler
app.use((_req, res) => {
  res.status(404).json({
    error: 'Route not found'
  });
});

// Error Handler
app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error'
  });
});

// Start server
const server = http.createServer(app);
attachPeerWS(server);

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  startProofScheduler();
});

module.exports = app;

