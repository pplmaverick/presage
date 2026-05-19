import { defineConfig } from "hardhat/config";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import dotenv from "dotenv";

dotenv.config();

export default defineConfig({
  plugins: [hardhatToolboxViem],
  solidity: "0.8.28",
  networks: {
    arc: {
      type: "http",
      url: "https://rpc.testnet.arc.network",
      accounts: [`0x${process.env.PRIVATE_KEY}`],
      chainId: 5042002,
    },
    pharos: {
      type: "http",
      url: "https://atlantic.dplabs-internal.com",
      accounts: [`0x${process.env.PRIVATE_KEY}`],
      chainId: 688689,
    },
    pharosMainnet: {
      type: "http",
      url: "https://rpc.pharos.xyz",
      accounts: [`0x${process.env.PRIVATE_KEY}`],
      chainId: 1672,
    },
  },
});
