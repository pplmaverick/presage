import { defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import dotenv from "dotenv";

dotenv.config();

const DUMMY_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const deployerKey = process.env.PRIVATE_KEY
  ? `0x${process.env.PRIVATE_KEY}`
  : DUMMY_KEY;

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
      accounts: [deployerKey],
      chainId: 5042002,
    },
    pharos: {
      type: "http",
      url: "https://atlantic.dplabs-internal.com",
      accounts: [deployerKey],
      chainId: 688689,
    },
    pharosMainnet: {
      type: "http",
      url: "https://rpc.pharos.xyz",
      accounts: [deployerKey],
      chainId: 1672,
    },
  },
});
