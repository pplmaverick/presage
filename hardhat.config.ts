import { defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import dotenv from "dotenv";

dotenv.config();

// Only ever handed out for local/hardhat networks — see deployerKeyFor().
const DUMMY_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const REAL_NETWORKS = ["arc", "arcMainnet", "pharos", "pharosMainnet"];

const networkArgIndex = process.argv.findIndex(
  (arg) => arg === "--network" || arg.startsWith("--network=")
);
const targetNetwork =
  networkArgIndex === -1
    ? undefined
    : process.argv[networkArgIndex].includes("=")
      ? process.argv[networkArgIndex].split("=")[1]
      : process.argv[networkArgIndex + 1];

function deployerKeyFor(networkName: string): string {
  if (process.env.PRIVATE_KEY) {
    return `0x${process.env.PRIVATE_KEY}`;
  }
  if (REAL_NETWORKS.includes(networkName) && targetNetwork === networkName) {
    throw new Error(
      `PRIVATE_KEY not set — refusing to use DUMMY_KEY on a real network (${networkName})`
    );
  }
  // Not actually connecting to this real network right now (e.g. `compile`
  // or `test` on the default in-memory network) — this value is never used
  // for signing, so DUMMY_KEY is just a syntactically valid placeholder.
  return DUMMY_KEY;
}

export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: "0.8.28",
  chainDescriptors: {
    5042002: {
      name: "Arc Testnet",
      blockExplorers: {
        etherscan: {
          name: "ArcScan",
          url: "https://testnet.arcscan.app",
          apiUrl: "https://testnet.arcscan.app/api",
        },
      },
    },
    5042: {
      name: "Arc Mainnet",
      blockExplorers: {
        etherscan: {
          name: "Arc Explorer",
          url: "https://explorer.arc.io",
          apiUrl: "https://explorer.arc.io/api",
        },
      },
    },
  },
  verify: {
    etherscan: {
      apiKey: "placeholder",
    },
  },
  networks: {
    arc: {
      type: "http",
      url: process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network",
      accounts: [deployerKeyFor("arc")],
      chainId: 5042002,
      httpHeaders: {
        Origin: "http://localhost",
      },
    },
    // Arc Mainnet — chainId 5042 (0x13b2). The native gas token is USDC (accounted in
    // 18 decimals); the official RPC is https://rpc.mainnet.arc.io. Gas parameters are
    // deliberately not hard-coded here: every script derives them dynamically through
    // scripts/lib/ops.ts (see the notes in that file).
    arcMainnet: {
      type: "http",
      url: process.env.ARC_MAINNET_RPC_URL ?? "https://rpc.mainnet.arc.io",
      accounts: [deployerKeyFor("arcMainnet")],
      chainId: 5042,
    },
    pharos: {
      type: "http",
      url: "https://atlantic.dplabs-internal.com",
      accounts: [deployerKeyFor("pharos")],
      chainId: 688689,
    },
    pharosMainnet: {
      type: "http",
      url: "https://rpc.pharos.xyz",
      accounts: [deployerKeyFor("pharosMainnet")],
      chainId: 1672,
    },
  },
});
