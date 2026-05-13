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

    constructor(address _weatherMarket) Ownable(msg.sender) {
        weatherMarket = IWeatherMarketOracle(_weatherMarket);
    }

    function setWeatherMarket(address _weatherMarket) external onlyOwner {
        weatherMarket = IWeatherMarketOracle(_weatherMarket);
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
