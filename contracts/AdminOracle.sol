// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./OracleInterface.sol";

interface IWeatherMarketOracle {
    function submitResult(uint256 marketId, int256 finalTemp) external;
}

contract AdminOracle is OracleInterface, Ownable {
    IWeatherMarketOracle public weatherMarket;

    event ResultSubmitted(string city, int256 temp, uint256 indexed marketId);
    // 改寫結算目標是最高權限的操作之一，原本無事件，鏈上查不到何時被改過。
    event WeatherMarketUpdated(address indexed newWeatherMarket);

    constructor(address _weatherMarket) Ownable(msg.sender) {
        require(_weatherMarket != address(0), "AdminOracle: zero weatherMarket");
        weatherMarket = IWeatherMarketOracle(_weatherMarket);
    }

    function setWeatherMarket(address _weatherMarket) external onlyOwner {
        require(_weatherMarket != address(0), "AdminOracle: zero weatherMarket");
        weatherMarket = IWeatherMarketOracle(_weatherMarket);
        emit WeatherMarketUpdated(_weatherMarket);
    }

    function submitResult(
        string calldata city,
        int256 temp,
        uint256 marketId
    ) external override onlyOwner {
        weatherMarket.submitResult(marketId, temp);
        emit ResultSubmitted(city, temp, marketId);
    }
}
