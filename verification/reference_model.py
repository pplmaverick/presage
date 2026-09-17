#!/usr/bin/env python3
"""
Independent Reference Model — Presage / WeatherMarket

This model is written from the specification alone. It deliberately does not consult
the implementation in contracts/WeatherMarket.sol.

Specification sources: README.md ("Temperature Encoding & Bucket System" and
"Fees & Security") plus the INV-1..INV-4 statements from the deep-audit brief.

  1. `buckets` is a strictly increasing array of upper bounds of length n, defining
     n+1 ranges. Bucket i (0 <= i < n) means buckets[i-1] < temp <= buckets[i];
     bucket n means temp > buckets[n-1].
     Resolution: scan upwards for the first i where temp <= buckets[i]; if none
     matches the answer is n.

  2. A bet accumulates into three counters — (market, bucket, user), the
     (market, bucket) total, and the (market, user) total — and into the market's
     totalPool.

  3. Settlement determines winningBucket. If that bucket's total is 0, noWinner = True.

  4. The fee is FEE_BPS = 200 (2%), charged only when there is a winner:
     fee = floor(totalPool * 200 / 10000). With noWinner the fee is 0.

  5. Claiming:
       noWinner    -> refund everything the user staked in that market (no fee).
       has winner  -> netPool = totalPool - fee;
                      payout = floor(user's stake in winningBucket * netPool
                                     / the winningBucket total).
                      A user with no stake in winningBucket cannot claim (treated
                      as a revert).
       Each (market, user) can claim only once.

  6. Every market stores a lockedTimeout at creation (falling back to the contract's
     defaultLockedTimeout, 3 days by default; allowed range 1 to 30 days). Once locked:
       now <  lockTime + lockedTimeout  -> settlement allowed, refunds not.
       now >= lockTime + lockedTimeout  -> settlement closed, refunds allowed;
                                           the refund is the user's full stake (no fee).
     Changing defaultLockedTimeout afterwards does not affect existing markets.

  7. lockMarket only applies to markets that exist (marketId < nextMarketId).

Outputs:
  verification/cases.json         - test cases plus the expected values this model derives
  verification/commitments.sha256 - the SHA-256 commitment for each trace
"""

import hashlib
import json
import os

FEE_BPS = 200
BPS_DENOM = 10_000
DEFAULT_LOCKED_TIMEOUT = 3 * 24 * 60 * 60   # 3 days
MIN_LOCKED_TIMEOUT = 1 * 24 * 60 * 60       # 1 day
MAX_LOCKED_TIMEOUT = 30 * 24 * 60 * 60      # 30 days

USDC = 10 ** 6  # 6 decimals


# ── Specification, implemented ──────────────────────────────────────────────

def determine_winning_bucket(buckets, temp):
    """Spec 1: scan upwards for the first temp <= buckets[i]; if none matches, len(buckets)."""
    for i, upper in enumerate(buckets):
        if temp <= upper:
            return i
    return len(buckets)


def tally(bets):
    """Spec 2: fan bets out into the per-level counters. bets = [(user, bucket, amount), ...]"""
    bucket_totals = {}
    user_bucket = {}
    user_total = {}
    total_pool = 0
    for user, bucket, amount in bets:
        bucket_totals[bucket] = bucket_totals.get(bucket, 0) + amount
        user_bucket[(user, bucket)] = user_bucket.get((user, bucket), 0) + amount
        user_total[user] = user_total.get(user, 0) + amount
        total_pool += amount
    return bucket_totals, user_bucket, user_total, total_pool


def settle(buckets, bets, final_temp):
    """Spec 3-5: settle and work out what each user can claim."""
    bucket_totals, user_bucket, user_total, total_pool = tally(bets)
    winning = determine_winning_bucket(buckets, final_temp)
    no_winner = bucket_totals.get(winning, 0) == 0

    fee = 0 if no_winner else (total_pool * FEE_BPS) // BPS_DENOM

    payouts = []
    for user in sorted(user_total):
        if no_winner:
            payouts.append((user, "claimable", user_total[user]))
        else:
            stake = user_bucket.get((user, winning), 0)
            if stake == 0:
                payouts.append((user, "revert", 0))
            else:
                net_pool = total_pool - fee
                payouts.append(
                    (user, "claimable", (stake * net_pool) // bucket_totals[winning])
                )

    distributed = sum(a for _, kind, a in payouts if kind == "claimable")
    # The remainder left by flooring integer division stays in the contract forever
    dust = total_pool - fee - distributed
    return {
        "winning": winning,
        "no_winner": no_winner,
        "fee": fee,
        "total_pool": total_pool,
        "payouts": payouts,
        "dust": dust,
    }


def refund(bets):
    """Spec 6: timed-out refund — everyone takes back their full stake, no fee."""
    _, _, user_total, total_pool = tally(bets)
    payouts = [(u, "claimable", user_total[u]) for u in sorted(user_total)]
    distributed = sum(a for _, _, a in payouts)
    return {
        "winning": None,
        "no_winner": None,
        "fee": 0,
        "total_pool": total_pool,
        "payouts": payouts,
        "dust": total_pool - distributed,
    }


# ── Test cases ──────────────────────────────────────────────────────────────
# Users are indices: 0=alice, 1=bob, 2=carol
# Amounts are in the smallest USDC unit (6 decimals)

BUCKETS_STD = [25, 28, 31, 34]

CASES = [
    # ── Ordinary settlement ───────────────────────────────────────────────
    dict(name="settle_single_winner", buckets=BUCKETS_STD,
         bets=[(0, 2, 100 * USDC), (1, 3, 50 * USDC)],
         mode="settle", final_temp=30, at="timeout_minus_3600"),

    dict(name="settle_two_winners_even_split", buckets=BUCKETS_STD,
         bets=[(0, 2, 100 * USDC), (1, 2, 100 * USDC)],
         mode="settle", final_temp=30, at="timeout_minus_3600"),

    dict(name="settle_three_winners_uneven", buckets=BUCKETS_STD,
         bets=[(0, 1, 30 * USDC), (1, 1, 20 * USDC), (2, 1, 50 * USDC),
               (0, 4, 17 * USDC)],
         mode="settle", final_temp=27, at="timeout_minus_3600"),

    # ── Boundary: temperature exactly on a bucket's upper bound ───────────
    dict(name="settle_temp_exactly_on_upper_bound", buckets=BUCKETS_STD,
         bets=[(0, 1, 40 * USDC), (1, 2, 60 * USDC)],
         mode="settle", final_temp=28, at="timeout_minus_3600"),

    dict(name="settle_temp_one_above_upper_bound", buckets=BUCKETS_STD,
         bets=[(0, 1, 40 * USDC), (1, 2, 60 * USDC)],
         mode="settle", final_temp=29, at="timeout_minus_3600"),

    # ── noWinner ─────────────────────────────────────────────────────────
    dict(name="no_winner_fee_waived", buckets=BUCKETS_STD,
         bets=[(0, 0, 100 * USDC), (1, 1, 50 * USDC)],
         mode="settle", final_temp=33, at="timeout_minus_3600"),

    dict(name="no_winner_single_bettor", buckets=BUCKETS_STD,
         bets=[(0, 4, 7 * USDC)],
         mode="settle", final_temp=20, at="timeout_minus_3600"),

    # ── Extreme finalTemp, including negatives ────────────────────────────
    dict(name="extreme_temp_negative_hits_bucket0", buckets=BUCKETS_STD,
         bets=[(0, 0, 80 * USDC), (1, 3, 20 * USDC)],
         mode="settle", final_temp=-40, at="timeout_minus_3600"),

    dict(name="extreme_temp_very_negative", buckets=BUCKETS_STD,
         bets=[(0, 0, 11 * USDC), (1, 2, 13 * USDC)],
         mode="settle", final_temp=-(2 ** 200), at="timeout_minus_3600"),

    dict(name="extreme_temp_very_large_top_bucket", buckets=BUCKETS_STD,
         bets=[(0, 4, 90 * USDC), (1, 0, 10 * USDC)],
         mode="settle", final_temp=2 ** 200, at="timeout_minus_3600"),

    dict(name="extreme_temp_negative_no_winner", buckets=BUCKETS_STD,
         bets=[(0, 4, 5 * USDC)],
         mode="settle", final_temp=-100, at="timeout_minus_3600"),

    # ── A single user spanning several buckets ────────────────────────────
    dict(name="single_user_spans_all_buckets", buckets=BUCKETS_STD,
         bets=[(0, 0, 10 * USDC), (0, 1, 20 * USDC), (0, 2, 30 * USDC),
               (0, 3, 40 * USDC), (0, 4, 50 * USDC)],
         mode="settle", final_temp=30, at="timeout_minus_3600"),

    dict(name="multi_bucket_user_vs_single_bucket_user", buckets=BUCKETS_STD,
         bets=[(0, 1, 25 * USDC), (0, 2, 75 * USDC), (1, 2, 25 * USDC)],
         mode="settle", final_temp=31, at="timeout_minus_3600"),

    # ── rounding dust ────────────────────────────────────────────────────
    dict(name="rounding_dust_thirds", buckets=BUCKETS_STD,
         bets=[(0, 2, 1), (1, 2, 1), (2, 2, 1)],
         mode="settle", final_temp=30, at="timeout_minus_3600"),

    dict(name="rounding_dust_primes", buckets=BUCKETS_STD,
         bets=[(0, 2, 999_983), (1, 2, 7), (2, 3, 1_000_003)],
         mode="settle", final_temp=29, at="timeout_minus_3600"),

    dict(name="rounding_fee_floors_to_zero", buckets=BUCKETS_STD,
         bets=[(0, 2, 49), (1, 3, 1)],
         mode="settle", final_temp=30, at="timeout_minus_3600"),

    # ── Single-boundary market (buckets length 1 -> 2 ranges) ─────────────
    dict(name="single_boundary_market_low", buckets=[25],
         bets=[(0, 0, 60 * USDC), (1, 1, 40 * USDC)],
         mode="settle", final_temp=24, at="timeout_minus_3600"),

    dict(name="single_boundary_market_high", buckets=[25],
         bets=[(0, 0, 60 * USDC), (1, 1, 40 * USDC)],
         mode="settle", final_temp=26, at="timeout_minus_3600"),

    # ── Settlement window boundary (1s either side of lockTime + timeout) ─
    dict(name="settle_at_deadline_minus_1s", buckets=BUCKETS_STD,
         bets=[(0, 2, 100 * USDC), (1, 3, 100 * USDC)],
         mode="settle", final_temp=30, at="timeout_minus_1"),

    dict(name="settle_at_deadline_exact_reverts", buckets=BUCKETS_STD,
         bets=[(0, 2, 100 * USDC)],
         mode="settle_revert", final_temp=30, at="timeout_exact",
         revert_reason="settlement window closed"),

    dict(name="settle_at_deadline_plus_1s_reverts", buckets=BUCKETS_STD,
         bets=[(0, 2, 100 * USDC)],
         mode="settle_revert", final_temp=30, at="timeout_plus_1",
         revert_reason="settlement window closed"),

    # ── claimRefund timeout boundary ──────────────────────────────────────
    dict(name="refund_at_deadline_minus_1s_reverts", buckets=BUCKETS_STD,
         bets=[(0, 2, 100 * USDC), (1, 3, 50 * USDC)],
         mode="refund_revert", final_temp=None, at="timeout_minus_1",
         revert_reason="refund window not open"),

    dict(name="refund_at_deadline_exact_succeeds", buckets=BUCKETS_STD,
         bets=[(0, 2, 100 * USDC), (1, 3, 50 * USDC)],
         mode="refund", final_temp=None, at="timeout_exact"),

    dict(name="refund_at_deadline_plus_1s_succeeds", buckets=BUCKETS_STD,
         bets=[(0, 2, 100 * USDC), (1, 3, 50 * USDC), (2, 0, 1)],
         mode="refund", final_temp=None, at="timeout_plus_1"),

    dict(name="refund_multi_bucket_user_gets_full_stake", buckets=BUCKETS_STD,
         bets=[(0, 0, 11 * USDC), (0, 2, 22 * USDC), (1, 4, 33 * USDC)],
         mode="refund", final_temp=None, at="timeout_plus_1"),

    # ── lockMarket on a nonexistent marketId ──────────────────────────────
    dict(name="lock_nonexistent_market_reverts", buckets=BUCKETS_STD,
         bets=[], mode="lock_revert", final_temp=None, at="lock_time_plus_1",
         revert_reason="market not exist"),

    # ── Custom lockedTimeout (what the admin panel's dropdown produces) ───
    dict(name="custom_timeout_7d_settle_before_deadline", buckets=BUCKETS_STD,
         bets=[(0, 2, 100 * USDC), (1, 3, 40 * USDC)],
         mode="settle", final_temp=30, at="timeout_minus_1",
         locked_timeout=7 * 24 * 3600),

    dict(name="custom_timeout_7d_refund_at_deadline", buckets=BUCKETS_STD,
         bets=[(0, 2, 100 * USDC), (1, 3, 40 * USDC)],
         mode="refund", final_temp=None, at="timeout_exact",
         locked_timeout=7 * 24 * 3600),

    dict(name="custom_timeout_1d_min_boundary", buckets=BUCKETS_STD,
         bets=[(0, 1, 15 * USDC)],
         mode="refund", final_temp=None, at="timeout_plus_1",
         locked_timeout=1 * 24 * 3600),

    dict(name="custom_timeout_30d_max_boundary", buckets=BUCKETS_STD,
         bets=[(0, 2, 21 * USDC)],
         mode="settle", final_temp=29, at="timeout_minus_1",
         locked_timeout=30 * 24 * 3600),

    # A lockedTimeout outside MIN/MAX must prevent market creation
    dict(name="create_timeout_below_min_reverts", buckets=BUCKETS_STD,
         bets=[], mode="create_revert", final_temp=None, at="lock_time_plus_1",
         locked_timeout=1 * 24 * 3600 - 1, revert_reason="timeout out of range"),

    dict(name="create_timeout_above_max_reverts", buckets=BUCKETS_STD,
         bets=[], mode="create_revert", final_temp=None, at="lock_time_plus_1",
         locked_timeout=30 * 24 * 3600 + 1, revert_reason="timeout out of range"),
]


# ── Trace generation ────────────────────────────────────────────────────────

def effective_timeout(case):
    return case.get("locked_timeout") or DEFAULT_LOCKED_TIMEOUT


def build_trace(case):
    mode = case["mode"]

    if mode in ("settle_revert", "refund_revert", "lock_revert", "create_revert"):
        result = {
            "winning": None, "no_winner": None, "fee": 0,
            "total_pool": sum(a for _, _, a in case["bets"]),
            "payouts": [], "dust": 0,
        }
        outcome = "revert"
    elif mode == "settle":
        result = settle(case["buckets"], case["bets"], case["final_temp"])
        outcome = "settle"
    elif mode == "refund":
        result = refund(case["bets"])
        outcome = "refund"
    else:
        raise ValueError(f"unknown mode: {mode}")

    return {
        "case": case["name"],
        "outcome": outcome,
        "lockedTimeout": str(effective_timeout(case)),
        "buckets": [str(b) for b in case["buckets"]],
        "finalTemp": None if case["final_temp"] is None else str(case["final_temp"]),
        "winningBucket": result["winning"],
        "noWinner": result["no_winner"],
        "totalPool": str(result["total_pool"]),
        "fee": str(result["fee"]),
        "dust": str(result["dust"]),
        "payouts": [[u, kind, str(a)] for u, kind, a in result["payouts"]],
        "revertReason": case.get("revert_reason"),
    }


def canonical(trace):
    """Must produce exactly the same bytes as canonical() on the TypeScript side."""
    return json.dumps(trace, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def main():
    here = os.path.dirname(os.path.abspath(__file__))

    cases_out = []
    commitments = []

    for case in CASES:
        trace = build_trace(case)
        blob = canonical(trace)
        digest = hashlib.sha256(blob.encode("utf-8")).hexdigest()
        commitments.append((digest, case["name"]))
        cases_out.append({
            "name": case["name"],
            "mode": case["mode"],
            "at": case["at"],
            "lockedTimeout": (
                None if case.get("locked_timeout") is None
                else str(case["locked_timeout"])
            ),
            "buckets": [str(b) for b in case["buckets"]],
            "bets": [[u, b, str(a)] for u, b, a in case["bets"]],
            "finalTemp": None if case["final_temp"] is None else str(case["final_temp"]),
            "revertReason": case.get("revert_reason"),
            "expected": trace,
            "sha256": digest,
        })

    with open(os.path.join(here, "cases.json"), "w", encoding="utf-8") as f:
        json.dump(
            {
                "model": "presage-weather-market-irm",
                "feeBps": FEE_BPS,
                "defaultLockedTimeout": DEFAULT_LOCKED_TIMEOUT,
                "minLockedTimeout": MIN_LOCKED_TIMEOUT,
                "maxLockedTimeout": MAX_LOCKED_TIMEOUT,
                "caseCount": len(cases_out),
                "cases": cases_out,
            },
            f, ensure_ascii=False, indent=2,
        )
        f.write("\n")

    with open(os.path.join(here, "commitments.sha256"), "w", encoding="utf-8") as f:
        f.write("# Independent Reference Model commitments — Presage WeatherMarket\n")
        f.write("# sha256(canonical_json(trace))  case_name\n")
        f.write(f"# generated by verification/reference_model.py — {len(commitments)} cases\n")
        for digest, name in commitments:
            f.write(f"{digest}  {name}\n")

    print(f"{len(cases_out)} cases written to verification/cases.json")
    print(f"{len(commitments)} SHA-256 commitments written to verification/commitments.sha256")

    # Print the key numbers the model derived, for eyeballing
    for c in cases_out:
        e = c["expected"]
        if e["outcome"] == "settle":
            print(f"  {c['name']:<44} winner={e['winningBucket']} "
                  f"noWinner={e['noWinner']} fee={e['fee']} dust={e['dust']}")
        elif e["outcome"] == "refund":
            print(f"  {c['name']:<44} refund total={e['totalPool']} dust={e['dust']}")
        else:
            print(f"  {c['name']:<44} revert: {e['revertReason']}")


if __name__ == "__main__":
    main()
