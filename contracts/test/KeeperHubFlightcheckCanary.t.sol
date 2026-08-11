// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {KeeperHubFlightcheckCanary} from "../src/KeeperHubFlightcheckCanary.sol";

/// @dev These tests defend the two properties Flightcheck depends on: the log carries the
///      challenge and chain id faithfully, and calling `ping` cannot move or trap value.
contract KeeperHubFlightcheckCanaryTest is Test {
    event Flightcheck(address indexed sender, bytes32 indexed challenge, uint256 chainId);

    KeeperHubFlightcheckCanary internal canary;

    function setUp() public {
        canary = new KeeperHubFlightcheckCanary();
    }

    function test_ping_emitsSenderChallengeAndChainId() public {
        bytes32 challenge = keccak256("flightcheck-fixed-challenge");
        address caller = address(0xA11CE);

        vm.expectEmit(true, true, true, true, address(canary));
        emit Flightcheck(caller, challenge, block.chainid);

        vm.prank(caller);
        canary.ping(challenge);
    }

    /// @dev The chain id is read onchain rather than supplied, so a log mined on the wrong
    ///      chain cannot satisfy a verifier expecting 84532.
    function test_ping_reportsExecutingChainNotCallerSuppliedChain() public {
        bytes32 challenge = keccak256("base-sepolia");
        vm.chainId(84532);

        vm.recordLogs();
        canary.ping(challenge);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1, "exactly one log");
        assertEq(abi.decode(logs[0].data, (uint256)), 84532, "chainId is the executing chain");
    }

    function test_ping_isNotPayable() public {
        bytes32 challenge = keccak256("value-attached");
        address caller = address(0xB0B);
        vm.deal(caller, 1 ether);

        vm.prank(caller);
        (bool ok,) = address(canary).call{value: 1 wei}(
            abi.encodeCall(KeeperHubFlightcheckCanary.ping, (challenge))
        );

        assertFalse(ok, "a call carrying value must revert");
        assertEq(address(canary).balance, 0, "canary never holds a balance");
    }

    function test_ping_writesNoStorage() public {
        canary.ping(keccak256("storage-check"));

        for (uint256 slot = 0; slot < 8; slot++) {
            assertEq(
                vm.load(address(canary), bytes32(slot)),
                bytes32(0),
                "canary must write no storage"
            );
        }
    }

    /// @dev The challenge is the anti-replay device. Any 32 bytes must survive verbatim,
    ///      including zero, which is the value a buggy encoder is most likely to produce.
    function testFuzz_ping_challengeRoundTrips(bytes32 challenge, address caller) public {
        vm.assume(caller != address(0));

        vm.recordLogs();
        vm.prank(caller);
        canary.ping(challenge);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(logs.length, 1, "exactly one log");
        assertEq(logs[0].topics.length, 3, "one signature topic and two indexed args");
        assertEq(
            logs[0].topics[0],
            keccak256("Flightcheck(address,bytes32,uint256)"),
            "event signature is stable"
        );
        assertEq(address(uint160(uint256(logs[0].topics[1]))), caller, "sender round-trips");
        assertEq(logs[0].topics[2], challenge, "challenge round-trips");
    }
}
