# Viky-index

Viky releases money on attested readings of public pages: a funder locks AUSD on Monad for someone's daily goal or
milestone, and the contract pays days out or gives them back, one event at a time. This repository indexes those
events with [Envio HyperIndex](https://docs.envio.dev/docs/HyperIndex/overview) and serves them as GraphQL: every gift,
every check-in, every drained day, every payout and refund, and three aggregates (per UTC day, per condition, and the
whole), so a funder's board and a recipient's timeline read one query instead of a capped `eth_getLogs`.

No secret lives here. The only credential the indexer may use, an Envio API token for HyperSync, goes in `.env`
(see `.env.example`) and never in the repository.

## What is indexed

Eight contracts on Monad mainnet (chain 143). The first four, addresses and deployment blocks read from the chain on
23 Sep 2026:

| Contract | Address | From block |
|---|---|---|
| `GiftEscrow`, the daily contract | `0x995Ab09d8B20511d057E9E87D00fa1f41fC0e233` | 103,970,877 (deployment, 11 Sep 2026) |
| `GiftEscrow`, the earlier contract still running gift 1 | `0xE04CD59bB93765333200a9da01df83149D4C4d67` | 103,644,003 (its first event, read from the chain) |
| `MilestoneGift` | `0x8dc281Ac8a1c789fdb65a063b9225E98eC522F0e` | 105,654,716 (deployment, 17 Sep 2026) |
| `ExitRouter` | `0x8a1790DfD10CF1599bDaeD5eC8BB46B2A6eB6223` | 105,185,369 (deployment, 16 Sep 2026) |

The ABIs in `abis/` are the compiled interfaces of Viky's contract sources (Solidity 0.8.30). The events indexed are
listed in `config.yaml`; the ones about ownership, pauses and the evidence signer are not, since they move no money.

### The second version of the gift contracts, and the anchor of agreements

Deployed on 2 Oct 2026 from the Viky repository at commit `c837bb6`, each block read from its deployment's receipt:

| Contract | Address | From block |
|---|---|---|
| `GiftEscrowV2` | `0xC83d8028347967Fc84D0e36Ae5876d9b29EAEc51` | 109,877,558 |
| `MilestoneGiftV2` | `0x493c87A27E637bBc7179C17bE2B215fC18523CC0` | 109,877,586 |
| `ConsentAnchor` | `0x2a15DF23fF62120700f14D1E5d5d56CA0dAd027e` | 109,877,728 |

The two gift contracts emit the same events as the first version for everything the two share, and the same handlers
serve both. What differs: a gift is created with `openingKey` (the address of the key its link carries) where the
first version had a contact hash, and the person a gift is for can end it (`GiftEnded`, the `Ending` entity, the
gift's status `ended`, `daysGivenBack`, `giftsEnded` in the three aggregates).

### The third version of the daily contract

Deployed on 3 Oct 2026 from the Viky repository at commit `d8cbbd3`, the block read from its deployment's receipt:

| Contract | Address | From block |
|---|---|---|
| `GiftEscrowV3` | `0x591d76863177E70FfcA2C793212d4715A367Ec70` | 110,278,100 |

A day is paid the day it is read, and new daily gifts are made on it, from number 1000. It emits the second version's
events, one for one (its ABI is the one verified on MonadVision's Sourcify, an exact match, read on 4 Oct 2026; a test
holds the two lists of events equal), so the same handlers read it and a gift made on it carries `version: 3`.

It is in the configuration since 4 Oct 2026. The deployment in service, below, was made before it and does not hold
it: it is indexed from the next push of the branch `envio`.

The anchor moves no money. It is where the agreement of the person a gift is for is written down in public: a consent
key bound once to an account by the account's own signature (`ConsentKeyBound`, the `ConsentKey` entity), then every
yes and every stop at the next place of the gift's sequence (`ConsentAnchored`, the `ConsentEntry` entity, with the
digest of the text agreed to and the two halves of the key's signature). `GlobalStat` counts the three:
`consentKeysBound`, `yesAnchored`, `stopsAnchored`.

## The words

- **earned**: a recipient's credited days times the gift's per-day amount (daily), or a milestone's amount.
- **returned**: what left the recipient's side for the funder's: drained days (daily), an expiry (milestone), the
  days given back or the whole amount when the person a gift is for ends it (second version).
- **withdrawn**: what a recipient took out (`EarnedWithdrawn`), to the address they chose.
- **refunded**: what went back to the funder's address: `UnearnedRefunded`, and nothing else. A cancellation, an
  expiry and an ending say what a gift became; the money they send back is an `UnearnedRefunded` of its own. Until
  1 Oct 2026 a cancellation's amount was added on both events, so a cancelled gift's refund counted twice.
- **payout by currency and rail**: an `Exited` on the router: AUSD in, `tokenOut` out, through one allowed `exchange`.

Amounts are kept in base units as the contracts emit them (AUSD has 6 decimals). Nothing here is estimated: every
figure is a sum of what events carried.

## Entities (`schema.graphql`)

`Gift`, `CheckIn`, `Milestone`, `Drain`, `Ending`, `Withdrawal`, `Refund`, `Exit`, `Goal`, `Exchange`, and the aggregates
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

Envio's hosted service deploys this repository from the branch `envio` (config `config.yaml`, root `./`, Development
plan; every push to that branch makes a new deployment with a new endpoint id, so `main` moves ahead for anything
that is not the indexer).

The deployment in service is `47c0fbc`, of 2 Oct 2026, 13:47 CEST: the seven contracts, HyperSync, synced to the head
in one minute, endpoint public:

```
https://indexer.dev.hyperindex.xyz/26195ec/v1/graphql
```

Read the same day at block 109,886,535: `_meta` at the head, 168 events processed (the 131 of the first four contracts
and the 37 goal registrations of the two new ones); `scripts/check-gifts-on-chain.ts`: every gift equal to its
contract's storage. No gift had been made on the second version yet, and nothing was written on the anchor.

The first deployment, `796f011` of 23 Sep 2026 (`https://indexer.dev.hyperindex.xyz/8213f52/v1/graphql`, measured in
`docs/measured-2026-09-23.md`), indexes the first four contracts only.

**How long it stays.** Envio's Development plan, as its pricing page says it (read on 2 Oct 2026): a deployment older
than thirty days is deleted, and so is one over 20 GB. That is a hard limit: `796f011` goes on 23 Oct 2026, `47c0fbc`
on 1 Nov 2026. There are soft limits too, whichever comes first: 100,000 events processed, 5 GB, or no request for
seven days. Those start a grace period of seven days, then three days read-only, then deletion.

The account shows a deployment's creation date and no end date. To stay hosted past the thirty days: push `envio`
again before the limit, which makes a new deployment with thirty days of its own and a new endpoint id that every
reader must then be given; or move the indexer to a Production plan (70, 300 or 800 dollars a month, read in the
account on 2 Oct 2026). The account also offers to promote a deployment to a "static production endpoint", whose
address stays the same across deployments: not tried.

The page reads the endpoint in service by default: https://redgnad.github.io/Viky-index/page/ (GitHub Pages from
`main`).
