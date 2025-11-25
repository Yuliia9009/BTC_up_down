// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal mock compatible with Chainlink AggregatorV3's latestRoundData signature
contract MockOracle {
    int256 private _answer;      // price * 1e8
    uint80 private _roundId;
    uint256 private _updatedAt;

    function setAnswer(int256 answer) external {
        _answer = answer;
        _roundId += 1;
        _updatedAt = block.timestamp;
    }

    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
            return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }
}
