// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title  StorageEscrow
 * @notice EIP-712 escrow for Decloud storage deals on Sepolia (chainId 11155111).
 *
 * Flow:
 *  1. Client and Peer sign the Deal struct off-chain using EIP-712 typed data.
 *  2. The Coordinator calls executeDeal(), providing both signatures.
 *  3. The contract verifies both signatures, locks client payment + peer escrow.
 *  4. At each of the 10 storage-proof intervals, the Coordinator calls
 *     releaseInterval() after verifying the peer's proof off-chain. The peer
 *     receives a geometrically-weighted fraction of the total price.
 *  5. If a peer fails a proof challenge, the Coordinator calls slashDeal():
 *     remaining price is refunded to the client; peer forfeits escrow.
 *
 * Interval reward formula (geometric series, later intervals worth more):
 *   interval 10 → price / 2
 *   interval  9 → price / 4
 *   …
 *   interval  2 → price / 512
 *   interval  1 → price / 1024 + remainder  (ensures sum == price)
 *
 * Prerequisites (must be done before executeDeal is called):
 *  - Client must have called token.approve(escrowAddress, deal.price)
 *  - Peer   must have called token.approve(escrowAddress, deal.peerEscrowAmount)
 */
contract StorageEscrow is EIP712 {
    using SafeERC20 for IERC20;

    // ─── EIP-712 Type Hash ───────────────────────────────────────────────────
    // Must exactly match utils/signDeal.js DEAL_TYPES — same field names, same order.

    bytes32 public constant DEAL_TYPEHASH = keccak256(
        "Deal(bytes32 dealId,bytes32 fileId,bytes32 merkleRoot,"
        "address client,address peer,"
        "uint256 size,uint256 duration,uint256 price,uint256 peerEscrowAmount,"
        "bytes32[] chunkHashes)"
    );

    // ─── Deal Struct ─────────────────────────────────────────────────────────

    struct Deal {
        bytes32   dealId;           // Unique deal identifier (keccak256 derived off-chain)
        bytes32   fileId;           // keccak256 of the file UUID string
        bytes32   merkleRoot;       // File merkle root committed at upload
        address   client;           // Client Ethereum address
        address   peer;             // Storage peer Ethereum address
        uint256   size;             // Total bytes this peer stores
        uint256   duration;         // Deal duration in blocks
        uint256   price;            // Total token units the client pays
        uint256   peerEscrowAmount; // Token units the peer locks as collateral
        bytes32[] chunkHashes;      // SHA-256 hashes of chunks this peer stores
    }

    // ─── Live deal record (for release / slash) ───────────────────────────────

    struct DealRecord {
        address client;
        address peer;
        uint256 price;
        uint256 peerEscrowAmount;
        uint8   intervalsCompleted; // 0–10
        bool    slashed;
    }

    // ─── State ───────────────────────────────────────────────────────────────

    IERC20  public immutable token;
    address public immutable coordinator;

    /// @dev Prevents replay of the same dealId
    mapping(bytes32 => bool)       public executedDeals;

    /// @dev Live deal state used by releaseInterval / slashDeal
    mapping(bytes32 => DealRecord) public deals;

    // ─── Events ──────────────────────────────────────────────────────────────

    event DealExecuted(
        bytes32 indexed dealId,
        address indexed client,
        address indexed peer,
        uint256 price,
        uint256 peerEscrowAmount
    );

    event IntervalReleased(
        bytes32 indexed dealId,
        uint8   interval,
        uint256 reward
    );

    event DealSlashed(
        bytes32 indexed dealId,
        address indexed peer,
        uint256 escrowForfeited
    );

    // ─── Errors ──────────────────────────────────────────────────────────────

    error NotCoordinator();
    error DealAlreadyExecuted(bytes32 dealId);
    error InvalidClientSignature();
    error InvalidPeerSignature();
    error DealNotFound(bytes32 dealId);
    error DealAlreadySlashed(bytes32 dealId);
    error DealAlreadyCompleted(bytes32 dealId);
    error WrongInterval(uint8 expected, uint8 given);

    // ─── Constructor ─────────────────────────────────────────────────────────

    /// @param _token       ERC-20 payment token on Sepolia
    /// @param _coordinator Coordinator wallet address
    constructor(address _token, address _coordinator)
        EIP712("StorageEscrow", "1")
    {
        token       = IERC20(_token);
        coordinator = _coordinator;
    }

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyCoordinator() {
        if (msg.sender != coordinator) revert NotCoordinator();
        _;
    }

    // ─── Core: execute deal ───────────────────────────────────────────────────

    /**
     * @notice Execute a storage deal by verifying both EIP-712 signatures and
     *         pulling tokens from the client (payment) and peer (escrow collateral).
     *
     * @param deal      The Deal struct — must identically match what both parties signed.
     * @param clientSig 65-byte EIP-712 signature from deal.client.
     * @param peerSig   65-byte EIP-712 signature from deal.peer.
     */
    function executeDeal(
        Deal calldata deal,
        bytes calldata clientSig,
        bytes calldata peerSig
    ) external onlyCoordinator {
        if (executedDeals[deal.dealId]) revert DealAlreadyExecuted(deal.dealId);

        // Compute the EIP-712 digest
        bytes32 structHash = keccak256(abi.encode(
            DEAL_TYPEHASH,
            deal.dealId,
            deal.fileId,
            deal.merkleRoot,
            deal.client,
            deal.peer,
            deal.size,
            deal.duration,
            deal.price,
            deal.peerEscrowAmount,
            keccak256(abi.encodePacked(deal.chunkHashes))
        ));
        bytes32 digest = _hashTypedDataV4(structHash);

        // Verify both signatures
        if (ECDSA.recover(digest, clientSig) != deal.client) revert InvalidClientSignature();
        if (ECDSA.recover(digest, peerSig)   != deal.peer)   revert InvalidPeerSignature();

        // Mark as executed before transferring (reentrancy guard via state change first)
        executedDeals[deal.dealId] = true;

        // Record live deal state
        deals[deal.dealId] = DealRecord({
            client:             deal.client,
            peer:               deal.peer,
            price:              deal.price,
            peerEscrowAmount:   deal.peerEscrowAmount,
            intervalsCompleted: 0,
            slashed:            false
        });

        // Pull client payment and peer collateral into this contract
        token.safeTransferFrom(deal.client, address(this), deal.price);
        token.safeTransferFrom(deal.peer,   address(this), deal.peerEscrowAmount);

        emit DealExecuted(
            deal.dealId,
            deal.client,
            deal.peer,
            deal.price,
            deal.peerEscrowAmount
        );
    }

    // ─── Interval release ────────────────────────────────────────────────────

    /**
     * @notice Release the reward for one storage-proof interval to the peer.
     *         Must be called in ascending order (interval 1 first, 10 last).
     *         Called by the coordinator after verifying the peer's proof off-chain.
     *
     * @param dealId   The deal identifier.
     * @param interval The interval being released (1–10).
     */
    function releaseInterval(bytes32 dealId, uint8 interval) external onlyCoordinator {
        DealRecord storage rec = deals[dealId];
        if (rec.client == address(0))              revert DealNotFound(dealId);
        if (rec.slashed)                           revert DealAlreadySlashed(dealId);
        if (rec.intervalsCompleted == 10)          revert DealAlreadyCompleted(dealId);
        if (interval != rec.intervalsCompleted + 1) revert WrongInterval(rec.intervalsCompleted + 1, interval);

        uint256 reward = _intervalReward(rec.price, interval);
        rec.intervalsCompleted = interval;

        token.safeTransfer(rec.peer, reward);

        emit IntervalReleased(dealId, interval, reward);

        // On final interval, return peer's escrow collateral
        if (interval == 10) {
            uint256 escrow = rec.peerEscrowAmount;
            rec.peerEscrowAmount = 0;
            token.safeTransfer(rec.peer, escrow);
        }
    }

    // ─── Slash ───────────────────────────────────────────────────────────────

    /**
     * @notice Slash a peer that failed a storage-proof challenge.
     *         Remaining unreleased price is refunded to the client.
     *         Peer's escrow collateral is forfeited (stays in contract).
     *
     * @param dealId The deal identifier.
     */
    function slashDeal(bytes32 dealId) external onlyCoordinator {
        DealRecord storage rec = deals[dealId];
        if (rec.client == address(0))     revert DealNotFound(dealId);
        if (rec.slashed)                  revert DealAlreadySlashed(dealId);
        if (rec.intervalsCompleted == 10) revert DealAlreadyCompleted(dealId);

        rec.slashed = true;

        // Compute how much price has already been paid out
        uint256 paid = _paidSoFar(rec.price, rec.intervalsCompleted);
        uint256 remaining = rec.price - paid;

        // Refund remaining price to client; escrow stays in contract
        if (remaining > 0) {
            token.safeTransfer(rec.client, remaining);
        }

        emit DealSlashed(dealId, rec.peer, rec.peerEscrowAmount);
    }

    // ─── Internal helpers ────────────────────────────────────────────────────

    /**
     * @dev Geometric reward for a single interval.
     *      interval 10 → price/2, interval 9 → price/4, …, interval 2 → price/512
     *      interval  1 → remainder so that sum of all 10 equals price exactly.
     */
    function _intervalReward(uint256 price, uint8 interval) internal pure returns (uint256) {
        if (interval == 1) {
            // price - sum(intervals 2..10) = price - price*1023/1024
            return price - (price * 1023 / 1024);
        }
        // price / 2^(11 - interval)
        return price >> (11 - interval);
    }

    /**
     * @dev Sum of rewards already released for intervals 1..completed.
     */
    function _paidSoFar(uint256 price, uint8 completed) internal pure returns (uint256) {
        if (completed == 0) return 0;
        uint256 total = 0;
        for (uint8 i = 1; i <= completed; i++) {
            total += _intervalReward(price, i);
        }
        return total;
    }
}
