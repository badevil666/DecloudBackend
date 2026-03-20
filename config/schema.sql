-- Enable UUID support
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

--------------------------------------------------
-- 1. Nonce Table (Ethereum Wallet Auth)
--------------------------------------------------

CREATE TABLE  if not exists auth_nonces (
    nonce UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT NOT NULL,
    issued_at TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP NOT NULL,
    used BOOLEAN DEFAULT FALSE
);

CREATE INDEX  if not exists idx_auth_nonces_wallet_address 
ON auth_nonces(wallet_address);

CREATE INDEX  if not exists idx_auth_nonces_expires_at 
ON auth_nonces(expires_at);

--------------------------------------------------
-- 2. Clients Table (Android Application)
--------------------------------------------------

CREATE TABLE  if not exists clients (
    client_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

--------------------------------------------------
-- 3. Storage Peers Table (Desktop Nodes)
--------------------------------------------------

CREATE TABLE  if not exists storage_peers (
    peer_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_address TEXT UNIQUE NOT NULL,
    os_type TEXT,
    declared_capacity BIGINT NOT NULL,
    available_space BIGINT DEFAULT 0,
    peer_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (
        peer_status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'IDLE')
    ),
    last_heartbeat TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX  if not exists idx_storage_peers_status 
ON storage_peers(peer_status);

CREATE INDEX  if not exists idx_storage_peers_last_heartbeat 
ON storage_peers(last_heartbeat);

--------------------------------------------------
-- 4. File Table
--------------------------------------------------

CREATE TABLE  if not exists files (
    file_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id UUID NOT NULL,
    file_name TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    merkle_root TEXT,
    replication_factor INT,
    chunking_factor INT,
    created_at TIMESTAMP DEFAULT NOW(),
    status TEXT NOT NULL CHECK (
        status IN ('PENDING','ALLOCATED','STORED','EXPIRED')
    ),
    end_date TIMESTAMP NOT NULL,

    FOREIGN KEY (owner_id) 
    REFERENCES clients(client_id)
    ON DELETE CASCADE
);

--------------------------------------------------
-- 5. File Chunks
--------------------------------------------------

CREATE TABLE  if not exists file_chunks (
    chunk_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_id UUID NOT NULL,
    chunk_index INT NOT NULL,
    chunk_hash TEXT NOT NULL,
    chunk_size BIGINT NOT NULL,

    UNIQUE(file_id, chunk_index),

    FOREIGN KEY (file_id)
    REFERENCES files(file_id)
    ON DELETE CASCADE
);

--------------------------------------------------
-- 6. Chunk Replicas
--------------------------------------------------

CREATE TABLE  if not exists chunk_replicas (
    replica_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    chunk_id UUID NOT NULL,
    replica_index INT NOT NULL,
    current_peer_id UUID,
    created_at TIMESTAMP DEFAULT NOW(),
    status TEXT NOT NULL CHECK (
        status IN ('ACTIVE','FAILED','MIGRATED', 'PENDING')
    ),

    UNIQUE(chunk_id, replica_index),

    FOREIGN KEY (chunk_id)
    REFERENCES file_chunks(chunk_id)
    ON DELETE CASCADE,

    FOREIGN KEY (current_peer_id)
    REFERENCES storage_peers(peer_id)
);

--------------------------------------------------
-- 7. Replica Commitments
--------------------------------------------------

CREATE TABLE  if not exists replica_commitments (
    commitment_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    replica_id UUID NOT NULL,
    interval_index INT NOT NULL,
    nonce_commitment TEXT NOT NULL,
    expected_hash TEXT NOT NULL,

    FOREIGN KEY (replica_id)
    REFERENCES chunk_replicas(replica_id)
    ON DELETE CASCADE
);

--------------------------------------------------
-- 8. Relay Sessions
--------------------------------------------------

CREATE TABLE IF NOT EXISTS relay_sessions (
    session_id  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_id     UUID NOT NULL,
    peer_id     UUID NOT NULL,
    client_id   UUID NOT NULL,
    token       TEXT UNIQUE NOT NULL,
    chunk_indexes INT[] NOT NULL,
    created_at  TIMESTAMP DEFAULT NOW(),
    expires_at  TIMESTAMP NOT NULL,

    FOREIGN KEY (file_id)   REFERENCES files(file_id)   ON DELETE CASCADE,
    FOREIGN KEY (peer_id)   REFERENCES storage_peers(peer_id),
    FOREIGN KEY (client_id) REFERENCES clients(client_id)
);

CREATE INDEX IF NOT EXISTS idx_relay_sessions_token   ON relay_sessions(token);
CREATE INDEX IF NOT EXISTS idx_relay_sessions_file_id ON relay_sessions(file_id);

--------------------------------------------------
-- 9. Storage Contracts
--------------------------------------------------

CREATE TABLE  if not exists storage_contracts (
    contract_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_id UUID NOT NULL,
    peer_id UUID NOT NULL,
    contract_address TEXT NOT NULL,
    total_reward NUMERIC NOT NULL,
    interval_count INT NOT NULL,
    start_block BIGINT NOT NULL,
    end_block BIGINT NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('ACTIVE','COMPLETED','SLASHED')
    ),

    FOREIGN KEY (file_id)
    REFERENCES files(file_id),

    FOREIGN KEY (peer_id)
    REFERENCES storage_peers(peer_id)
);

--------------------------------------------------
-- 9. Storage Intervals
--------------------------------------------------

CREATE TABLE  if not exists storage_intervals (
    interval_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    contract_id UUID NOT NULL,
    interval_index INT NOT NULL,
    reward_fraction NUMERIC NOT NULL,
    interval_reward_amount NUMERIC NOT NULL,
    start_time TIMESTAMP NOT NULL,
    end_time TIMESTAMP NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('PENDING','COMPLETED','FAILED')
    ),

    FOREIGN KEY (contract_id)
    REFERENCES storage_contracts(contract_id)
    ON DELETE CASCADE
);

--------------------------------------------------
-- 10. Proof Challenges
--------------------------------------------------

CREATE TABLE  if not exists proof_challenges (
    challenge_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    replica_id UUID NOT NULL,
    interval_id UUID NOT NULL,
    nonce_sent_at TIMESTAMP NOT NULL,
    response_deadline TIMESTAMP NOT NULL,
    status TEXT NOT NULL CHECK (
        status IN ('PENDING','RESPONDED','EXPIRED')
    ),

    FOREIGN KEY (replica_id)
    REFERENCES chunk_replicas(replica_id),

    FOREIGN KEY (interval_id)
    REFERENCES storage_intervals(interval_id)
);

--------------------------------------------------
-- 11. Proof Responses
--------------------------------------------------

CREATE TABLE  if not exists proof_responses (
    response_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    challenge_id UUID NOT NULL,
    submitted_hash TEXT NOT NULL,
    submitted_at TIMESTAMP NOT NULL,
    verified BOOLEAN,

    FOREIGN KEY (challenge_id)
    REFERENCES proof_challenges(challenge_id)
    ON DELETE CASCADE
);

--------------------------------------------------
-- 12. Replica Storage History
--------------------------------------------------

CREATE TABLE  if not exists replica_storage (
    replica_id UUID NOT NULL,
    peer_id UUID NOT NULL,
    stored_at TIMESTAMP NOT NULL,
    unstored_at TIMESTAMP,
    last_verified TIMESTAMP,

    PRIMARY KEY (replica_id, peer_id),

    FOREIGN KEY (replica_id)
    REFERENCES chunk_replicas(replica_id),

    FOREIGN KEY (peer_id)
    REFERENCES storage_peers(peer_id)
);

--------------------------------------------------
-- 13. Interval Settlement
--------------------------------------------------

--------------------------------------------------
-- 14. Pending Deals (awaiting dual EIP-712 signatures)
--------------------------------------------------

CREATE TABLE IF NOT EXISTS pending_deals (
    deal_id          TEXT PRIMARY KEY,
    file_id          UUID NOT NULL,
    client_id        UUID NOT NULL,
    peer_id          UUID NOT NULL,

    client_address   TEXT NOT NULL,
    peer_address     TEXT NOT NULL,
    size_bytes       NUMERIC NOT NULL,
    duration_blocks  NUMERIC NOT NULL,
    price_wei        NUMERIC NOT NULL,
    peer_escrow_wei  NUMERIC NOT NULL,
    interval_count   INT NOT NULL DEFAULT 12,

    client_sig       TEXT,
    peer_sig         TEXT,

    status           TEXT NOT NULL DEFAULT 'AWAITING_SIGNATURES'
                     CHECK (status IN (
                         'AWAITING_SIGNATURES', 'CLIENT_SIGNED', 'PEER_SIGNED',
                         'SUBMITTING', 'SETTLED', 'FAILED', 'EXPIRED'
                     )),

    created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    expires_at       TIMESTAMP NOT NULL,
    tx_hash          TEXT,
    error_message    TEXT,

    FOREIGN KEY (file_id)   REFERENCES files(file_id),
    FOREIGN KEY (client_id) REFERENCES clients(client_id),
    FOREIGN KEY (peer_id)   REFERENCES storage_peers(peer_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_deals_file_id ON pending_deals(file_id);
CREATE INDEX IF NOT EXISTS idx_pending_deals_status  ON pending_deals(status);
CREATE INDEX IF NOT EXISTS idx_pending_deals_expires ON pending_deals(expires_at);

--------------------------------------------------
-- 15. Interval Settlement
--------------------------------------------------

CREATE TABLE  if not exists interval_settlements (
    settlement_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    interval_id UUID NOT NULL,
    peer_id UUID NOT NULL,
    proofs_passed BOOLEAN,
    amount_earned NUMERIC NOT NULL,
    tx_hash TEXT,
    settled_at TIMESTAMP,

    FOREIGN KEY (interval_id)
    REFERENCES storage_intervals(interval_id),

    FOREIGN KEY (peer_id)
    REFERENCES storage_peers(peer_id)
);