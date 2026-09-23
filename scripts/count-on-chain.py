#!/usr/bin/env python3
"""Counts every event of Viky's four contracts straight from Monad's public RPC, independently of the indexer.

The public RPC (https://rpc.monad.xyz) limits eth_getLogs to 100 blocks per call (measured on 23 Sep 2026: "eth_getLogs
is limited to a 100 range"), so the whole range is walked in 100-block windows, sixteen at a time, one call per window
for the four addresses together. The result is a JSON record: per address, per event topic, the count, the first and
the last block; and the total. The indexer's aggregates are checked against this file before any of them is called
right (scripts/compare-counts.py).

Usage: python3 scripts/count-on-chain.py [--from 103000000] [--to latest] [--out artifacts/counts-on-chain.json]
"""
import argparse
import concurrent.futures
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict

RPC = os.environ.get("MONAD_RPC_URL", "https://rpc.monad.xyz")
ADDRESSES = [
    "0x995Ab09d8B20511d057E9E87D00fa1f41fC0e233",  # GiftEscrow, the daily contract
    "0xE04CD59bB93765333200a9da01df83149D4C4d67",  # GiftEscrow, the earlier contract
    "0x8dc281Ac8a1c789fdb65a063b9225E98eC522F0e",  # MilestoneGift
    "0x8a1790DfD10CF1599bDaeD5eC8BB46B2A6eB6223",  # ExitRouter
]
WINDOW = 100
WORKERS = 4  # sixteen workers drew HTTP 429 after a minute on 23 Sep 2026; four hold at about 10 calls a second


def rpc(method, params, attempts=40):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    last = None
    for attempt in range(attempts):
        try:
            req = urllib.request.Request(RPC, data=body, headers={"content-type": "application/json"})
            answer = json.load(urllib.request.urlopen(req, timeout=30))
            if "result" in answer:
                return answer["result"]
            last = answer.get("error")
        except urllib.error.HTTPError as error:  # 429: the provider's rate limit; wait what it says, or 5 s
            last = f"HTTP {error.code}"
            if error.code == 429:
                time.sleep(float(error.headers.get("Retry-After") or 5))
                continue
        except Exception as error:  # network hiccups are retried, then reported
            last = str(error)
        time.sleep(min(0.5 * (attempt + 1), 10))
    raise RuntimeError(f"{method} failed after {attempts} attempts: {last}")


def logs_of(window):
    frm, to = window
    return frm, rpc("eth_getLogs", [{"fromBlock": hex(frm), "toBlock": hex(to), "address": ADDRESSES}])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--from", dest="frm", type=int, default=103_000_000)
    parser.add_argument("--to", dest="to", default="latest")
    parser.add_argument("--out", default="artifacts/counts-on-chain.json")
    args = parser.parse_args()
    head = int(rpc("eth_blockNumber", []), 16)
    to = head if args.to == "latest" else int(args.to)
    windows = [(f, min(f + WINDOW - 1, to)) for f in range(args.frm, to + 1, WINDOW)]
    print(f"rpc {RPC}, blocks {args.frm} to {to} ({to - args.frm + 1}), {len(windows)} windows of {WINDOW}", flush=True)

    counts = defaultdict(lambda: defaultdict(lambda: {"count": 0, "first_block": None, "last_block": None}))
    total = 0
    failures = []
    started = time.time()
    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for frm, result in pool.map(logs_of, windows):
            done += 1
            for log in result:
                address = log["address"].lower()
                topic = log["topics"][0]
                block = int(log["blockNumber"], 16)
                entry = counts[address][topic]
                entry["count"] += 1
                entry["first_block"] = block if entry["first_block"] is None else min(entry["first_block"], block)
                entry["last_block"] = block if entry["last_block"] is None else max(entry["last_block"], block)
                total += 1
            if done % 2000 == 0:
                rate = done / (time.time() - started)
                print(f"  {done}/{len(windows)} windows, {total} logs, {rate:.1f} calls/s", flush=True)

    record = {
        "rpc": RPC,
        "read_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "from_block": args.frm,
        "to_block": to,
        "head_at_start": head,
        "window": WINDOW,
        "calls": len(windows),
        "seconds": round(time.time() - started, 1),
        "total_logs": total,
        "per_address": {a: dict(t) for a, t in counts.items()},
        "failures": failures,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(record, f, indent=2)
    print(f"total {total} logs in {record['seconds']} s; written to {args.out}", flush=True)
    for address, topics in sorted(counts.items()):
        first = min(t["first_block"] for t in topics.values())
        print(f"  {address}: {sum(t['count'] for t in topics.values())} logs, first block {first}, {len(topics)} event kinds")


if __name__ == "__main__":
    sys.exit(main())
