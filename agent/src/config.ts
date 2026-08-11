/**
 * Pinned deployment facts. Everything here is a security control, not a convenience default.
 *
 * A user of this template never deploys a contract. The canary below is already live, and
 * Flightcheck re-derives its runtime bytecode hash from a public node before it will ask
 * KeeperHub to execute anything against it. If the code at that address ever changes, the
 * hash stops matching and the run stops at CANARY_VERIFIED.
 *
 * The expected hash is reproducible. `cd contracts && forge build` on a clean checkout
 * regenerates it byte for byte, because solc, evm version, optimizer runs and CBOR metadata
 * are all pinned in contracts/foundry.toml. It is verifiable rather than merely asserted.
 */

export const KEEPERHUB_BASE_URL = "https://app.keeperhub.com";

export interface CanaryDeployment {
  readonly chainId: number;
  readonly chainName: string;
  readonly explorerTxBase: string;
  readonly address: string;
  readonly abiVersion: string;
  readonly expectedRuntimeBytecodeHash: string;
  readonly eventSignature: string;
  readonly eventTopic0: string;
  readonly functionName: string;
  readonly defaultRpcUrl: string;
}

export const BASE_SEPOLIA: CanaryDeployment = {
  chainId: 84532,
  chainName: "Base Sepolia",
  explorerTxBase: "https://sepolia.basescan.org/tx/",
  address: "0x2A6FC8182Bf9928Ef7517dA980dC79e8107c555A",
  abiVersion: "1",
  expectedRuntimeBytecodeHash:
    "0x753157870ee9e692c7e35e0890fad801fd30fc4674a74a62a7526758da649dd0",
  eventSignature: "Flightcheck(address,bytes32,uint256)",
  eventTopic0: "0x4947ef22330e8e81cdedf82c33d366e9c942511f5edf79140686b33af9de7f33",
  functionName: "ping",
  defaultRpcUrl: "https://sepolia.base.org",
};

/** Every chain Flightcheck will run against. v1 is deliberately one testnet. */
export const DEPLOYMENTS: readonly CanaryDeployment[] = [BASE_SEPOLIA];

export function deploymentFor(chainId: number): CanaryDeployment | undefined {
  return DEPLOYMENTS.find((d) => d.chainId === chainId);
}

/**
 * The canary ABI, inline rather than read from the Foundry artifact.
 *
 * KeeperHub will auto-fetch an ABI from the block explorer when the request omits it. We always
 * send it explicitly: the correctness of the whole run rests on calling the function we think we
 * are calling, and explorer verification is a third-party dependency we do not control.
 */
export const CANARY_ABI = [
  {
    type: "function",
    name: "ping",
    inputs: [{ name: "challenge", type: "bytes32", internalType: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "Flightcheck",
    inputs: [
      { name: "sender", type: "address", indexed: true, internalType: "address" },
      { name: "challenge", type: "bytes32", indexed: true, internalType: "bytes32" },
      { name: "chainId", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
] as const;

/** KeeperHub replays a stored response for 24 hours. Past that the same key executes again. */
export const IDEMPOTENCY_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export const TOOL_VERSION = "0.1.0";
export const PROOF_SCHEMA = "keeperhub-flightcheck/v1";
