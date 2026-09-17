// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract WeatherMarket is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public oracle;

    uint256 public constant FEE_BPS = 200; // 2%

    // 鎖盤後 oracle 必須在 lockTime + 該市場的 lockedTimeout 之前送出結果。
    // 過了這個窗口 submitResult 就永久關閉，使用者改走 claimRefund 全額取回本金。
    // 結算窗口與退款窗口互斥（submitResult 要求 now < deadline，claimRefund 要求
    // now >= deadline），所以同一筆本金不可能同時走兩條路徑領兩次。
    //
    // lockedTimeout 在建立市場時寫進該市場，之後改 defaultLockedTimeout 不會回頭
    // 影響已建立的市場——已經有人下注的市場，退款時點不該被事後改動。
    uint256 public constant MIN_LOCKED_TIMEOUT = 1 days;
    uint256 public constant MAX_LOCKED_TIMEOUT = 30 days;

    uint256 public defaultLockedTimeout = 3 days;

    // createMarket 的時間上限。沒有上限的話，一個誤植的 lockTime（例如多打一個 0）
    // 會讓該市場的資金被鎖到遠未來，而結算/退款窗口是從 lockTime 起算，
    // 連退款窗口都跟著被推遠。
    uint256 public constant MAX_LOCK_DELAY = 90 days;
    uint256 public constant MAX_TARGET_DELAY = 90 days;

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
        uint256 lockedTimeout; // 建立當下鎖定的結算期長度，之後不再變動
    }

    // marketId → bucketIndex → user → 下注金額
    mapping(uint256 => mapping(uint8 => mapping(address => uint256))) public bets;
    // marketId → bucketIndex → 該區間總金額
    mapping(uint256 => mapping(uint8 => uint256)) public bucketTotals;
    // marketId → user → 各區間下注加總（退款用）
    mapping(uint256 => mapping(address => uint256)) public userTotalBets;
    // marketId → user → 已領取（claimWinnings 與 claimRefund 共用同一把鎖）
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
    event RefundClaimed(
        uint256 indexed marketId,
        address indexed user,
        uint256 amount
    );
    event FeesWithdrawn(address indexed to, uint256 amount);
    event OracleUpdated(address indexed newOracle);
    event DefaultLockedTimeoutUpdated(uint256 previous, uint256 current);
    event MarketLockedTimeoutSet(uint256 indexed marketId, uint256 lockedTimeout);

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

    // 只影響之後新建立的市場；已建立的市場沿用當時寫入的值。
    function setDefaultLockedTimeout(uint256 newTimeout) external onlyOwner {
        require(
            newTimeout >= MIN_LOCKED_TIMEOUT && newTimeout <= MAX_LOCKED_TIMEOUT,
            "WeatherMarket: timeout out of range"
        );
        uint256 previous = defaultLockedTimeout;
        defaultLockedTimeout = newTimeout;
        emit DefaultLockedTimeoutUpdated(previous, newTimeout);
    }

    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "WeatherMarket: zero oracle");
        oracle = _oracle;
        emit OracleUpdated(_oracle);
    }

    // buckets: 溫度區間上界（必須嚴格遞增）
    // buckets = [25,28,31,34] → bucket 0 (≤25), 1 (25~28], 2 (28~31], 3 (31~34], 4 (>34)
    // 沿用 defaultLockedTimeout。既有腳本與測試走這條，簽章未變。
    function createMarket(
        string calldata city,
        uint256 targetDate,
        int256[] calldata buckets,
        uint256 lockTime
    ) external onlyOwner returns (uint256 marketId) {
        return _createMarket(city, targetDate, buckets, lockTime, defaultLockedTimeout);
    }

    // 明確指定該市場的結算期長度（admin 面板用）。
    function createMarket(
        string calldata city,
        uint256 targetDate,
        int256[] calldata buckets,
        uint256 lockTime,
        uint256 lockedTimeout
    ) external onlyOwner returns (uint256 marketId) {
        return _createMarket(city, targetDate, buckets, lockTime, lockedTimeout);
    }

    function _createMarket(
        string calldata city,
        uint256 targetDate,
        int256[] calldata buckets,
        uint256 lockTime,
        uint256 lockedTimeout
    ) internal returns (uint256 marketId) {
        require(
            lockedTimeout >= MIN_LOCKED_TIMEOUT && lockedTimeout <= MAX_LOCKED_TIMEOUT,
            "WeatherMarket: timeout out of range"
        );
        require(buckets.length > 0, "WeatherMarket: empty buckets");
        require(buckets.length <= 253, "WeatherMarket: too many buckets");
        require(lockTime > block.timestamp, "WeatherMarket: lockTime in past");
        require(
            lockTime <= block.timestamp + MAX_LOCK_DELAY,
            "WeatherMarket: lockTime too far"
        );
        require(targetDate > lockTime, "WeatherMarket: targetDate before lockTime");
        require(
            targetDate <= lockTime + MAX_TARGET_DELAY,
            "WeatherMarket: targetDate too far"
        );

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
        m.lockedTimeout = lockedTimeout;

        emit MarketCreated(marketId, city, targetDate, lockTime, buckets.length + 1);
        emit MarketLockedTimeoutSet(marketId, lockedTimeout);
    }

    function placeBet(uint256 marketId, uint8 bucket, uint256 amount)
        external
        nonReentrant
    {
        Market storage m = _markets[marketId];
        require(m.status == Status.OPEN, "WeatherMarket: not open");
        require(block.timestamp < m.lockTime, "WeatherMarket: past lock time");
        require(bucket <= uint8(m.buckets.length), "WeatherMarket: invalid bucket");
        require(amount > 0, "WeatherMarket: zero amount");

        // Effects — 所有狀態變更都在外部呼叫之前完成（CEI）
        bets[marketId][bucket][msg.sender] += amount;
        bucketTotals[marketId][bucket] += amount;
        userTotalBets[marketId][msg.sender] += amount;
        m.totalPool += amount;

        // Interaction — 唯一的外部呼叫放在最後
        uint256 balanceBefore = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = usdc.balanceOf(address(this)) - balanceBefore;

        // 上面記的帳是 amount，這裡證明合約真的收到 amount。
        // 若 usdc 變成 fee-on-transfer / rebasing，delta 會小於 amount，整筆 revert，
        // 不會留下「帳面 totalPool 大於實際餘額」的狀態。
        require(received == amount, "WeatherMarket: transfer amount mismatch");

        emit BetPlaced(marketId, msg.sender, bucket, amount);
    }

    // 任何人都可以呼叫，lockTime 到了才能鎖定
    function lockMarket(uint256 marketId) external {
        require(marketId < nextMarketId, "WeatherMarket: market not exist");

        Market storage m = _markets[marketId];
        require(m.status == Status.OPEN, "WeatherMarket: not open");
        require(block.timestamp >= m.lockTime, "WeatherMarket: lock time not reached");

        m.status = Status.LOCKED;
        emit MarketLocked(marketId);
    }

    // 只有 oracle 能呼叫，市場必須已鎖定，且必須在結算窗口關閉前
    function submitResult(uint256 marketId, int256 finalTemp) external onlyOracle {
        Market storage m = _markets[marketId];
        require(m.status == Status.LOCKED, "WeatherMarket: not locked");
        require(
            block.timestamp < m.lockTime + m.lockedTimeout,
            "WeatherMarket: settlement window closed"
        );

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
        usdc.safeTransfer(msg.sender, payout);

        emit WinningsClaimed(marketId, msg.sender, payout);
    }

    // oracle 逾時未結算時的逃生口：市場停在 LOCKED 且已過 lockTime + lockedTimeout，
    // 任何下過注的人都能自行取回本金全額（不扣手續費）。
    function claimRefund(uint256 marketId) external nonReentrant {
        Market storage m = _markets[marketId];
        require(m.status == Status.LOCKED, "WeatherMarket: not locked");
        require(
            block.timestamp >= m.lockTime + m.lockedTimeout,
            "WeatherMarket: refund window not open"
        );
        require(!claimed[marketId][msg.sender], "WeatherMarket: already claimed");

        uint256 refund = userTotalBets[marketId][msg.sender];
        require(refund > 0, "WeatherMarket: no bets to refund");

        claimed[marketId][msg.sender] = true;
        usdc.safeTransfer(msg.sender, refund);

        emit RefundClaimed(marketId, msg.sender, refund);
    }

    function withdrawFees() external onlyOwner {
        uint256 amount = collectedFees;
        require(amount > 0, "WeatherMarket: no fees");
        collectedFees = 0;
        usdc.safeTransfer(owner(), amount);
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

    // submitResult 的截止時間 / claimRefund 的開放時間（同一個時間點）。
    // 供結算腳本與前端判斷市場還來不來得及結算。
    function settlementDeadline(uint256 marketId) external view returns (uint256) {
        Market storage m = _markets[marketId];
        return m.lockTime + m.lockedTimeout;
    }

    // 該市場建立當下寫入的結算期長度。getMarket 的回傳型別刻意不動，
    // 以免既有前端/腳本的位置解構被打亂。
    function marketLockedTimeout(uint256 marketId) external view returns (uint256) {
        return _markets[marketId].lockedTimeout;
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
