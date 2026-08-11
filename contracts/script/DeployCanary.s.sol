// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {KeeperHubFlightcheckCanary} from "../src/KeeperHubFlightcheckCanary.sol";

/// @notice Maintainer-only, run once. A user of the Flightcheck template never runs this:
///         the canary address, chain id, runtime bytecode hash and ABI version are pinned in
///         the tool's config, and the tool re-verifies that hash against a public node before
///         it asks KeeperHub to execute anything.
///
///         DEPLOYER_PRIVATE_KEY is read from the environment and is never logged. The address
///         it derives is public and is printed.
contract DeployCanary is Script {
    uint256 internal constant BASE_SEPOLIA = 84532;

    function run() external returns (KeeperHubFlightcheckCanary canary) {
        require(block.chainid == BASE_SEPOLIA, "DeployCanary: v1 deploys to Base Sepolia only");

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);
        canary = new KeeperHubFlightcheckCanary();
        vm.stopBroadcast();

        console.log("canary address :", address(canary));
        console.log("chainId        :", block.chainid);
        console.log("runtime hash   :");
        console.logBytes32(keccak256(address(canary).code));
    }
}
