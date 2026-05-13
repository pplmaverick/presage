// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract WeatherMarket is ReentrancyGuard, Ownable {
    IERC20 public immutable usdc;
    address public oracle;

    uint256 public constant FEE_BPS = 200; // 2%
    uint256 public collectedFees;
    uint256 public nextMarketId;

    enum Status {
        OPEN,
        LOCKED,
        SETTLED
    }

    struct Market {
        string city;
        uint256 targetDate;
        uint256 lockTime;
        Status status;
        uint256 totalPool;
        int256 finalTemp;
        uint8 winningBucket;
        int256[] buckets; // 上界陣列，[25,28,31,34] → 5 個區間
        bool noWinner;    // 沒有人押中得獎區間時設為 true，允許全額退款
    }

    // marketId → bucketIndex → user → 下注金額
    mapping(uint256 => mapping(uint8 => mapping(address => uint256))) public bets;
    // marketId → bucketIndex → 該區間總金額
    mapping(uint256 => mapping(uint8 => uint256)) public bucketTotals;
    // marketId → user → 各區間下注加總（退款用）
    mapping(uint256 => mapping(address => uint256)) public userTotalBets;
    // marketId → user → 已領取
    mapping(uint256 => mapping(address => bool)) public claimed;
    // marketId → Market
    mapping(uint256 => Market) private _markets;

    event MarketCreated(
        uint256 indexed marketId,
        string city,
        uint256 targetDate,
        uint256 lockTime,
        uint256 bucketCount
    );
    event BetPlaced(
        uint256 indexed marketId,
        address indexed user,
        uint8 bucket,
        uint256 amount
    );
    event MarketLocked(uint256 indexed marketId);
    event ResultSubmitted(
        uint256 indexed marketId,
        int256 finalTemp,
        uint8 winningBucket,
        bool noWinner
    );
    event WinningsClaimed(
        uint256 indexed marketId,
        address indexed user,
        uint256 amount
    );
    event FeesWithdrawn(address indexed to, uint256 amount);
    event OracleUpdated(address indexed newOracle);

    modifier onlyOracle() {
        require(msg.sender == oracle, "WeatherMarket: not oracle");
        _;
    }

    constructor(address _usdc, address _oracle) Ownable(msg.sender) {
        require(_usdc != address(0), "WeatherMarket: zero usdc");
        require(_oracle != address(0), "WeatherMarket: zero oracle");
        usdc = IERC20(_usdc);
        oracle = _oracle;
    }

    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "WeatherMarket: zero oracle");
        oracle = _oracle;
        emit OracleUpdated(_oracle);
    }

    // buckets: 溫度區間上界（必須嚴格遞增）
    // buckets = [25,28,31,34] → bucket 0 (≤25), 1 (25~28], 2 (28~31], 3 (31~34], 4 (>34)
    function createMarket(
        string calldata city,
        uint256 targetDate,
        int256[] calldata buckets,
        uint256 lockTime
    ) external onlyOwner returns (uint256 marketId) {
        require(buckets.length > 0, "WeatherMarket: empty buckets");
        require(buckets.length <= 253, "WeatherMarket: too many buckets");
        require(lockTime > block.timestamp, "WeatherMarket: lockTime in past");
        require(targetDate > lockTime, "WeatherMarket: targetDate before lockTime");

        for (uint256 i = 1; i < buckets.length; i++) {
            require(buckets[i] > buckets[i - 1], "WeatherMarket: buckets not sorted");
        }

        marketId = nextMarketId++;
        Market storage m = _markets[marketId];
        m.city = city;
        m.targetDate = targetDate;
        m.lockTime = lockTime;
        m.status = Status.OPEN;
        m.buckets = buckets;

        emit MarketCreated(marketId, city, targetDate, lockTime, buckets.length + 1);
    }

    function placeBet(uint256 marketId, uint8 bucket, uint256 amount) external {
        Market storage m = _markets[marketId];
        require(m.status == Status.OPEN, "WeatherMarket: not open");
        require(block.timestamp < m.lockTime, "WeatherMarket: past lock time");
        require(bucket <= uint8(m.buckets.length), "WeatherMarket: invalid bucket");
        require(amount > 0, "WeatherMarket: zero amount");

        require(
            usdc.transferFrom(msg.sender, address(this), amount),
            "WeatherMarket: transferFrom failed"
        );

        bets[marketId][bucket][msg.sender] += amount;
        bucketTotals[marketId][bucket] += amount;
        userTotalBets[marketId][msg.sender] += amount;
        m.totalPool += amount;

        emit BetPlaced(marketId, msg.sender, bucket, amount);
    }

    // 任何人都可以呼叫，lockTime 到了才能鎖定
    function lockMarket(uint256 marketId) external {
        Market storage m = _markets[marketId];
        require(m.status == Status.OPEN, "WeatherMarket: not open");
        require(block.timestamp >= m.lockTime, "WeatherMarket: lock time not reached");

        m.status = Status.LOCKED;
        emit MarketLocked(marketId);
    }

    // 只有 oracle 能呼叫，市場必須已鎖定
    function submitResult(uint256 marketId, int256 finalTemp) external onlyOracle {
        Market storage m = _markets[marketId];
        require(m.status == Status.LOCKED, "WeatherMarket: not locked");

        uint8 winning = _determineWinningBucket(m.buckets, finalTemp);
        bool noWinner = bucketTotals[marketId][winning] == 0;

        m.finalTemp = finalTemp;
        m.winningBucket = winning;
        m.noWinner = noWinner;
        m.status = Status.SETTLED;

        // 手續費只在有得獎者時收取
        if (!noWinner) {
            collectedFees += (m.totalPool * FEE_BPS) / 10000;
        }

        emit ResultSubmitted(marketId, finalTemp, winning, noWinner);
    }

    // ReentrancyGuard 保護
    function claimWinnings(uint256 marketId) external nonReentrant {
        Market storage m = _markets[marketId];
        require(m.status == Status.SETTLED, "WeatherMarket: not settled");
        require(!claimed[marketId][msg.sender], "WeatherMarket: already claimed");

        uint256 payout;

        if (m.noWinner) {
            // 沒有人押中：退還全額下注
            payout = userTotalBets[marketId][msg.sender];
            require(payout > 0, "WeatherMarket: no bets to refund");
        } else {
            uint8 winning = m.winningBucket;
            uint256 userBet = bets[marketId][winning][msg.sender];
            require(userBet > 0, "WeatherMarket: no winning bet");

            uint256 netPool = m.totalPool - (m.totalPool * FEE_BPS) / 10000;
            payout = (userBet * netPool) / bucketTotals[marketId][winning];
        }

        claimed[marketId][msg.sender] = true;
        require(usdc.transfer(msg.sender, payout), "WeatherMarket: transfer failed");

        emit WinningsClaimed(marketId, msg.sender, payout);
    }

    function withdrawFees() external onlyOwner {
        uint256 amount = collectedFees;
        require(amount > 0, "WeatherMarket: no fees");
        collectedFees = 0;
        require(usdc.transfer(owner(), amount), "WeatherMarket: transfer failed");
        emit FeesWithdrawn(owner(), amount);
    }

    function getMarket(uint256 marketId)
        external
        view
        returns (
            string memory city,
            uint256 targetDate,
            uint256 lockTime,
            Status status,
            uint256 totalPool,
            int256 finalTemp,
            uint8 winningBucket,
            int256[] memory buckets,
            bool noWinner
        )
    {
        Market storage m = _markets[marketId];
        return (
            m.city,
            m.targetDate,
            m.lockTime,
            m.status,
            m.totalPool,
            m.finalTemp,
            m.winningBucket,
            m.buckets,
            m.noWinner
        );
    }

    function _determineWinningBucket(
        int256[] storage buckets,
        int256 temp
    ) internal view returns (uint8) {
        for (uint8 i = 0; i < uint8(buckets.length); i++) {
            if (temp <= buckets[i]) return i;
        }
        return uint8(buckets.length);
    }
}
