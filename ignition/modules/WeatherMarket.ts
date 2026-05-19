import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const WeatherMarketModule = buildModule("WeatherMarketModule", (m) => {
  const weatherMarket = m.contract("WeatherMarket");
  return { weatherMarket };
});

export default WeatherMarketModule;