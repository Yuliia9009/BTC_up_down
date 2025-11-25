// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface AggregatorV3Interface {
  function latestRoundData() external view returns (
    uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound
  );
}

contract BtcUpDown {
    enum Side { UP, DOWN }

    // Тайминги демо-раунда: 10 сек ставки, 20 сек ожидание settle, 5 сек пауза
    uint256 public constant BET_DURATION   = 10;
    uint256 public constant SETTLE_DELAY   = 20;
    uint256 public constant NEXT_DELAY     = 5;

    // Комиссия владельца (1% = 100 б.п.)
    uint256 public feeBps = 100;

    address public owner;
    AggregatorV3Interface public oracle;
    uint256 public currentRoundId;
    uint256 public minBet = 0.00002 ether;
    uint256 public feesAccrued;
    mapping(address => uint256) public balance; // внутренняя касса игроков

    // простая защита от реентранси
    uint256 private _lock;
    modifier nonReentrant() {
        require(_lock == 0, "REENTRANCY");
        _lock = 1; _;
        _lock = 0;
    }
    modifier onlyOwner(){ require(msg.sender == owner, "NOT_OWNER"); _; }

    struct Round {
        uint256 startTime;
        uint256 lockTime;
        uint256 settleTime;
        bool locked;
        bool settled;
        bool refund;
        int256 priceLock;
        int256 priceSettle;
        uint256 poolUp;
        uint256 poolDown;
        mapping(address => uint256) betUp;
        mapping(address => uint256) betDown;
        mapping(address => bool) claimed;
    }

    mapping(uint256 => Round) private rounds;
    mapping(address => uint256) public winsCount; // число выигранных раундов адресом

    event RoundStarted(uint256 indexed rid, uint256 lockTime, uint256 settleTime);
    event Bet(uint256 indexed rid, address indexed user, Side side, uint256 amount);
    event Locked(uint256 indexed rid, int256 price);
    event Settled(uint256 indexed rid, int256 price, Side winner);
    event Claimed(uint256 indexed rid, address indexed user, uint256 amount);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);

    constructor(address oracleFeed) {
        owner = msg.sender;
        oracle = AggregatorV3Interface(oracleFeed);
        _startRound(block.timestamp); // стартуем мгновенно
    }

    // ====== Раунды и автоматизация ======
    function _startRound(uint256 start) internal {
        currentRoundId++;
        Round storage r = rounds[currentRoundId];
        r.startTime = start;
        r.lockTime = start + BET_DURATION;
        // settleTime отсчитываем от lockTime, чтобы между lock и settle прошло ровно SETTLE_DELAY секунд
        r.settleTime = r.lockTime + SETTLE_DELAY;
        emit RoundStarted(currentRoundId, r.lockTime, r.settleTime);
    }

    /// @notice Универсальный «тикер»: любой может дернуть, чтобы продвинуть фазу
    function progress() external {
        Round storage r = rounds[currentRoundId];

        // 1) Дошли до lock → фиксируем стартовую цену
        if (!r.locked && block.timestamp >= r.lockTime) {
            (, int256 p,,,) = oracle.latestRoundData();
            r.priceLock = p;
            r.locked = true;
            emit Locked(currentRoundId, p);
            return;
        }

        // 2) Дошли до settle → завершаем
        if (r.locked && !r.settled && block.timestamp >= r.settleTime) {
            (, int256 q,,,) = oracle.latestRoundData();
            r.priceSettle = q;

            // ничья или пустая сторона → рефанд, без комиссии
            if (q == r.priceLock || r.poolUp == 0 || r.poolDown == 0) {
                r.refund = true;
            } else {
                uint256 pool = r.poolUp + r.poolDown;
                uint256 fee = (pool * feeBps) / 10000;
                feesAccrued += fee;
            }
            r.settled = true;
            emit Settled(currentRoundId, q, (q > r.priceLock ? Side.UP : Side.DOWN));
            return;
        }

        // 3) После паузы запускаем новый
        if (r.settled && block.timestamp >= r.settleTime + NEXT_DELAY) {
            _startRound(block.timestamp);
            return;
        }

        revert("NO_ACTION");
    }

    // ====== Ставки / Выплаты ======
    function bet(Side side, uint256 amount) external {
        Round storage r = rounds[currentRoundId];
        require(block.timestamp < r.lockTime, "BET_CLOSED");
        require(amount >= minBet, "MIN_BET");
        require(balance[msg.sender] >= amount, "NO_FUNDS");
        balance[msg.sender] -= amount;
        if (side == Side.UP) {
            r.poolUp += amount; r.betUp[msg.sender] += amount;
        } else {
            r.poolDown += amount; r.betDown[msg.sender] += amount;
        }
        emit Bet(currentRoundId, msg.sender, side, amount);
    }

    function claim(uint256 rid) external nonReentrant {
        Round storage r = rounds[rid];
        require(r.settled, "NOT_SETTLED");
        require(!r.claimed[msg.sender], "ALREADY_CLAIMED");

        if (r.refund) {
            uint256 sum = r.betUp[msg.sender] + r.betDown[msg.sender];
            require(sum > 0, "NOTHING");
            r.betUp[msg.sender] = 0; r.betDown[msg.sender] = 0;
            r.claimed[msg.sender] = true;
            balance[msg.sender] += sum;
            emit Claimed(rid, msg.sender, sum);
            return;
        }

        bool upWins = (r.priceSettle > r.priceLock);
        uint256 user = upWins ? r.betUp[msg.sender] : r.betDown[msg.sender];
        require(user > 0, "NO_WIN");

        uint256 pool = r.poolUp + r.poolDown;
        uint256 rewardPool = pool - (pool * feeBps / 10000);
        uint256 denom = upWins ? r.poolUp : r.poolDown;
        uint256 share = (rewardPool * user) / denom;

        r.betUp[msg.sender] = 0; r.betDown[msg.sender] = 0;
        r.claimed[msg.sender] = true;

        winsCount[msg.sender] += 1; // +1 победа за этот раунд
        balance[msg.sender] += share;
        emit Claimed(rid, msg.sender, share);
    }

    function _pay(address to, uint256 amt) internal {
        (bool ok,) = payable(to).call{value: amt}("");
        require(ok, "TRANSFER_FAIL");
    }

    // ====== Вью и админ ======
    function getRound(uint256 rid) external view returns (
        uint256 startTime,
        uint256 lockTime,
        uint256 settleTime,
        bool locked,
        bool settled,
        bool refund,
        int256 priceLock,
        int256 priceSettle,
        uint256 poolUp,
        uint256 poolDown
    ) {
        Round storage r = rounds[rid];
        return (
            r.startTime, r.lockTime, r.settleTime, r.locked, r.settled, r.refund,
            r.priceLock, r.priceSettle, r.poolUp, r.poolDown
        );
    }

    function withdrawFees(address to) external onlyOwner {
        uint256 amt = feesAccrued;
        feesAccrued = 0;
        _pay(to, amt);
        emit FeesWithdrawn(to, amt);
    }

    // ====== Баланс игрока ======
    function deposit() external payable {
        require(msg.value > 0, "ZERO_DEPOSIT");
        balance[msg.sender] += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    function withdraw(uint256 amount) external nonReentrant {
        require(balance[msg.sender] >= amount, "NO_FUNDS");
        balance[msg.sender] -= amount;
        _pay(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    function withdrawAll() external nonReentrant {
        uint256 amt = balance[msg.sender];
        require(amt > 0, "NO_FUNDS");
        balance[msg.sender] = 0;
        _pay(msg.sender, amt);
        emit Withdrawn(msg.sender, amt);
    }
}
