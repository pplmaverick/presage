// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IPlaceBet {
    function placeBet(uint256 marketId, uint8 bucket, uint256 amount) external;
}

// 僅用於測試，不部署到正式網路。
// transferFrom 期間回呼 WeatherMarket.placeBet，用來驗證 INV-4 的 nonReentrant。
contract ReentrantUSDC is ERC20 {
    address public target;
    bool public attackArmed;
    uint256 public reentryMarketId;
    uint8 public reentryBucket;
    uint256 public reentryAmount;

    constructor() ERC20("Reentrant USD Coin", "rUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address _target, uint256 marketId, uint8 bucket, uint256 amount) external {
        target = _target;
        attackArmed = true;
        reentryMarketId = marketId;
        reentryBucket = bucket;
        reentryAmount = amount;
    }

    function transferFrom(address from, address to, uint256 value)
        public
        override
        returns (bool)
    {
        if (attackArmed && msg.sender == target) {
            attackArmed = false; // 只重入一次，避免無限遞迴
            IPlaceBet(target).placeBet(reentryMarketId, reentryBucket, reentryAmount);
        }
        return super.transferFrom(from, to, value);
    }
}

// 僅用於測試。收 1% 轉帳稅，用來驗證 placeBet 的 received == amount 檢查。
contract FeeOnTransferUSDC is ERC20 {
    constructor() ERC20("Fee On Transfer USD Coin", "fUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 value)
        public
        override
        returns (bool)
    {
        uint256 fee = value / 100;
        _spendAllowance(from, msg.sender, value);
        _transfer(from, to, value - fee);
        _burn(from, fee);
        return true;
    }
}
