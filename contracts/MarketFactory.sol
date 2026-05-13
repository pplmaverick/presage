// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./WeatherMarket.sol";
import "./AdminOracle.sol";

contract MarketFactory is Ownable {
    address public immutable usdc;

    address[] public deployedMarkets;
    address[] public deployedOracles;

    event Deployed(
        address indexed market,
        address indexed oracle,
        address indexed marketOwner
    );

    constructor(address _usdc) Ownable(msg.sender) {
        require(_usdc != address(0), "MarketFactory: zero usdc");
        usdc = _usdc;
    }

    // 一次部署一對 WeatherMarket + AdminOracle，ownership 轉給 msg.sender
    function deployMarketWithOracle()
        external
        onlyOwner
        returns (address market, address oracle)
    {
        // 1. 先用 factory 自身當暫時 oracle 部署 WeatherMarket
        WeatherMarket weatherMarket = new WeatherMarket(usdc, address(this));

        // 2. 部署 AdminOracle，指向剛建立的 WeatherMarket
        AdminOracle adminOracle = new AdminOracle(address(weatherMarket));

        // 3. 把 oracle 更新為真正的 AdminOracle
        weatherMarket.setOracle(address(adminOracle));

        // 4. 把兩個合約的 ownership 交給呼叫者
        weatherMarket.transferOwnership(msg.sender);
        adminOracle.transferOwnership(msg.sender);

        deployedMarkets.push(address(weatherMarket));
        deployedOracles.push(address(adminOracle));

        emit Deployed(address(weatherMarket), address(adminOracle), msg.sender);

        return (address(weatherMarket), address(adminOracle));
    }

    function getDeployedMarkets() external view returns (address[] memory) {
        return deployedMarkets;
    }

    function getDeployedOracles() external view returns (address[] memory) {
        return deployedOracles;
    }
}
