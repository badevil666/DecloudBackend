# DecloudBackend

A Node.js Express backend API project.

## Getting Started

### Prerequisites

- Node.js (v14 or higher)
- npm (comes with Node.js)

### Installation

Dependencies are already installed. If you need to reinstall:

```bash
npm install
```

### Environment Setup

1. Copy the example environment file:
```bash
cp .env.example .env
```

2. Update `.env` with your configuration:
```
PORT=3000
NODE_ENV=development
```

### Running the Server

**Development mode (with auto-reload):**
```bash
npm run dev
```

**Production mode:**
```bash
npm start
```

The server will start on `http://localhost:3000` (or the PORT specified in your `.env` file).

### API Endpoints

- `GET /` - Welcome message
- `GET /api/health` - Health check endpoint

### Project Structure

```
DecloudBackend/
├── config/           # Configuration files (database, etc.)
├── controllers/      # Route controllers
├── middleware/       # Custom middleware
├── routes/           # API routes
├── server.js         # Main server file
└── package.json      # Dependencies and scripts
```

### Adding New Routes

1. Create a route file in `routes/` (e.g., `routes/users.js`)
2. Create a controller in `controllers/` (e.g., `controllers/userController.js`)
3. Import and use the route in `routes/index.js`:
```javascript
router.use('/users', require('./users'));
```

### Development

- Uses `nodemon` for automatic server restarts during development
- CORS enabled for cross-origin requests
- Morgan middleware for HTTP request logging
- Error handling middleware included
