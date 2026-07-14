import { createPublicClient, http, formatUnits, defineChain } from "viem";
import hre from "hardhat";

const arc = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.arc.network"] } },
});

const WEATHER_MARKET =
  "0xcac5b9d2817325e78090e3ce4b9c299c819cf953" as `0x${string}`;

const STATUS_LABEL = ["OPEN", "LOCKED", "SETTLED"];

async function main() {
  const publicClient = createPublicClient({ chain: arc, transport: http() });
  const artifact = await hre.artifacts.readArtifact("WeatherMarket");

  for (let id = 19; id <= 22; id++) {
    try {
      const result = (await publicClient.readContract({
        address: WEATHER_MARKET,
        abi: artifact.abi,
        functionName: "getMarket",
        args: [BigInt(id)],
      })) as [
        string,
        bigint,
        bigint,
        number,
        bigint,
        bigint,
        number,
        bigint[],
        boolean,
      ];

      const [city, targetDate, lockTime, status, totalPool, finalTemp] =
        result;
      const nowSec = Math.floor(Date.now() / 1000);

      console.log(
        `Market #${id} (${city}): ${STATUS_LABEL[status] ?? status}, totalPool=${formatUnits(totalPool, 6)} USDC, finalTemp=${finalTemp}`,
      );
      console.log(
        `  lockTime  : ${lockTime} (${new Date(Number(lockTime) * 1000).toISOString()}) — ${nowSec >= Number(lockTime) ? "已到達，可鎖盤" : "尚未到達"}`,
      );
      console.log(
        `  targetDate: ${targetDate} (${new Date(Number(targetDate) * 1000).toISOString()})`,
      );
    } catch (e: any) {
      console.log(`Market #${id}: ERROR - ${e.shortMessage ?? e.message}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
