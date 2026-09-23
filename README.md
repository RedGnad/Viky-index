# Viky-index

Viky releases money on attested readings of public pages: a funder locks AUSD on Monad for someone's daily goal or
milestone, and the contract pays days out or gives them back, one event at a time. This repository indexes those
events with [Envio HyperIndex](https://docs.envio.dev/docs/HyperIndex/overview) and serves them as GraphQL: every gift,
every check-in, every drained day, every payout and refund, and three aggregates (per UTC day, per condition, and the
whole), so a funder's board and a recipient's timeline read one query instead of a capped `eth_getLogs`.

No secret lives here. The only credential the indexer may use, an Envio API token for HyperSync, goes in `.env`
(see `.env.example`) and never in the repository.

## What is indexed

Four contracts on Monad mainnet (chain 143), addresses and deployment blocks read from the chain on 23 Sep 2026:

| Contract | Address | From block |
|---|---|---|
| `GiftEscrow`, the daily contract | `0x995Ab09d8B20511d057E9E87D00fa1f41fC0e233` | 103,970,877 (deployment, 11 Sep 2026) |
| `GiftEscrow`, the earlier contract still running gift 1 | `0xE04CD59bB93765333200a9da01df83149D4C4d67` | 103,644,003 (its first event, read from the chain) |
| `MilestoneGift` | `0x8dc281Ac8a1c789fdb65a063b9225E98eC522F0e` | 105,654,716 (deployment, 17 Sep 2026) |
| `ExitRouter` | `0x8a1790DfD10CF1599bDaeD5eC8BB46B2A6eB6223` | 105,185,369 (deployment, 16 Sep 2026) |

The ABIs in `abis/` are the compiled interfaces of Viky's contract sources (Solidity 0.8.30). The events indexed are
listed in `config.yaml`; the ones about ownership, pauses and the evidence signer are not, since they move no money.

## The words

- **earned**: a recipient's credited days times the gift's per-day amount (daily), or a milestone's amount.
- **returned**: what left the recipient's side for the funder's: drained days (daily), an expiry (milestone).
- **withdrawn**: what a recipient took out (`EarnedWithdrawn`), to the address they chose.
- **refunded**: what went back to the funder's address (`UnearnedRefunded`, `GiftCancelled`).
- **payout by currency and rail**: an `Exited` on the router: AUSD in, `tokenOut` out, through one allowed `exchange`.

Amounts are kept in base units as the contracts emit them (AUSD has 6 decimals). Nothing here is estimated: every
figure is a sum of what events carried.

## Entities (`schema.graphql`)

`Gift`, `CheckIn`, `Milestone`, `Drain`, `Withdrawal`, `Refund`, `Exit`, `Goal`, `Exchange`, and the aggregates
`DayStat` (id `YYYY-MM-DD`), `ConditionStat` (id `<contract>-<goalType>`), `PayoutStat` (id `<tokenOut>-<exchange>`),
`GlobalStat` (id `global`).

## Running it

```
pnpm install
pnpm codegen                      # generates .envio/types.d.ts from config.yaml and schema.graphql
pnpm typecheck
pnpm dev                          # Docker: Postgres, Hasura at http://localhost:8080 (password testing), the indexer
```

`config.yaml` reads the chain through HyperSync and needs `ENVIO_API_TOKEN` in `.env`
([create one](https://envio.dev/app/api-tokens); requests without a token are refused with 401).
`config.rpc.yaml` is the same indexer over the public RPC `https://rpc1.monad.xyz`, which answered the whole history in one
call on 23 Sep 2026 (`https://rpc.monad.xyz` caps `eth_getLogs` at 100 blocks); it needs no token:
`ENVIO_CONFIG=config.rpc.yaml pnpm dev`.

## Measured against the chain, before any aggregate is called right

`scripts/count-on-chain.py` counts every event of the four addresses, per event topic, with the first and last block of
each, from a public RPC in windows of a chosen size: 100 blocks on `rpc.monad.xyz` (42,273 calls,
`artifacts/counts-on-chain.json`) and 100,000 blocks on `rpc1.monad.xyz` (`artifacts/counts-on-chain-rpc1.json`); two
endpoints and two window sizes that agree are the check.
`scripts/compare-counts.ts` asks the running indexer the same counts through GraphQL and prints both side by side; a
line that differs is a bug to read, not a number to publish. `scripts/check-gifts-on-chain.ts` sets each gift's indexed
sums (days credited and drained, amounts withdrawn, refunded, earned) beside the contract's own storage, read with
`getGift`. The records of the runs are in `artifacts/run-<date>/`.

## The page

`page/index.html` is one static page that asks a GraphQL endpoint for the aggregates and the last events; the
endpoint is a parameter in the URL (`?endpoint=`), so the same page reads a local run or the hosted one.

## Deployment

Envio's hosted service deploys from this repository (GitHub app, branch `main`, config `config.yaml`), or from the
command line with `envio-cloud`. The endpoint, once deployed, is written here with the date it was read.
