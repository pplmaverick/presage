// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

abstract contract OracleInterface {
    function submitResult(
        string calldata city,
        int256 temp,
        uint256 marketId
    ) external virtual;
}
