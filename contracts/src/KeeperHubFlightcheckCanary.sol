// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title KeeperHubFlightcheckCanary
/// @notice Target for KeeperHub Flightcheck, the onboarding execution conformance check.
///         Flightcheck proves that a newly configured environment can drive a real write
///         through KeeperHub and verify the result independently. It needs a write that
///         settles onchain and moves nothing.
///
///         `ping` is the whole contract. It writes no storage, holds no balance, makes no
///         external call, grants no approval and is not payable, so the only persistent
///         effect of calling it is the log it emits. That log is the proof: the challenge
///         is generated per run and has to survive end to end, and the chain id is read
///         from the executing chain rather than passed in, so a receipt from the wrong
///         chain cannot satisfy it.
contract KeeperHubFlightcheckCanary {
    /// @param sender    the address that actually called `ping`. Under a gas-sponsored or
    ///                  smart-account execution path this is not necessarily the caller's
    ///                  org EOA, so verifiers record it before they assert anything about it.
    /// @param challenge the per-run value the verifier generated and expects back.
    /// @param chainId   read from the chain at execution time, never supplied by the caller.
    event Flightcheck(address indexed sender, bytes32 indexed challenge, uint256 chainId);

    /// @notice Emit a Flightcheck log for `challenge`.
    /// @dev Not payable, so a call carrying value reverts rather than stranding funds here.
    function ping(bytes32 challenge) external {
        emit Flightcheck(msg.sender, challenge, block.chainid);
    }
}
