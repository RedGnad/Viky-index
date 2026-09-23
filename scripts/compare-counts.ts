/**
 * Compares what the indexer holds with what the chain says, event by event, before any aggregate is called right.
 *
 * The chain side is artifacts/counts-on-chain.json, written by scripts/count-on-chain.py (the public RPC, 100 blocks
 * per call, every log of the four addresses grouped by event topic). The indexer side is the running GraphQL
 * endpoint (Hasura, http://localhost:8080/v1/graphql by default, admin secret "testing" as `envio dev` sets it).
 *
 * Usage: npx tsx scripts/compare-counts.ts [--counts artifacts/counts-on-chain.json] [--endpoint http://localhost:8080/v1/graphql]
 * Exit code 1 when any line differs.
 */
import { readFileSync } from "node:fs";
import { id as keccakOfSignature } from "ethers";

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const countsPath = argument("counts", "artifacts/counts-on-chain.json");
const endpoint = argument("endpoint", "http://localhost:8080/v1/graphql");
const adminSecret = process.env.HASURA_ADMIN_SECRET ?? "testing";

type OnChain = {
  from_block: number;
  to_block: number;
  read_at: string;
  per_address: Record<string, Record<string, { count: number; first_block: number; last_block: number }>>;
};

const DAILY = ["0x995ab09d8b20511d057e9e87d00fa1f41fc0e233", "0xe04cd59bb93765333200a9da01df83149d4c4d67"];
const MILESTONE = ["0x8dc281ac8a1c789fdb65a063b9225e98ec522f0e"];
const ROUTER = ["0x8a1790dfd10cf1599bdaed5ec8bb46b2a6eb6223"];

// Event signatures as the contracts declare them (indexed keywords do not change the topic).
const signatures = {
  dailyGoalRegistered: "GoalRegistered(uint8,bytes32)",
  dailyGiftCreated: "GiftCreated(uint256,address,address,bytes32,uint8,uint32,uint32,uint256,uint256)",
  giftFunded: "GiftFunded(uint256,uint256)",
  giftClaimed: "GiftClaimed(uint256,address)",
  identityBound: "IdentityBound(uint256,address,bytes32)",
  checkInAccepted: "CheckInAccepted(uint256,address,uint32,uint32,uint32,uint64,uint64)",
  daysDrained: "DaysDrained(uint256,uint32,uint32,uint32,uint256)",
  earnedWithdrawn: "EarnedWithdrawn(uint256,address,address,uint256)",
  unearnedRefunded: "UnearnedRefunded(uint256,address,uint256)",
  giftCancelled: "GiftCancelled(uint256,uint256)",
  giftFinalised: "GiftFinalised(uint256,uint32,uint32,uint256)",
  milestoneGoalRegistered: "GoalRegistered(uint8,bytes32,uint8)",
  milestoneGiftCreated: "GiftCreated(uint256,address,address,bytes32,uint8,uint8,uint64,uint64,bytes32,uint32,uint256,uint64)",
  startRecorded: "StartRecorded(uint256,address,bytes32,uint64,uint64)",
  milestoneReached: "MilestoneReached(uint256,address,uint64,uint64,uint256)",
  giftExpired: "GiftExpired(uint256,uint256)",
  exchangeAllowed: "ExchangeAllowed(address,bool,address)",
  exited: "Exited(address,uint256,address,uint256,address)",
};
const topics = Object.fromEntries(Object.entries(signatures).map(([k, v]) => [k, keccakOfSignature(v).toLowerCase()]));

function onChainCount(data: OnChain, addresses: string[], keys: (keyof typeof signatures)[]): number {
  let total = 0;
  for (const address of addresses) {
    const perTopic = data.per_address[address] ?? {};
    for (const key of keys) total += perTopic[topics[key]]?.count ?? 0;
  }
  return total;
}

async function graphql<T>(query: string): Promise<T> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hasura-admin-secret": adminSecret },
    body: JSON.stringify({ query }),
  });
  const body = (await response.json()) as { data?: T; errors?: unknown };
  if (!body.data) throw new Error(`GraphQL: ${JSON.stringify(body.errors)}`);
  return body.data;
}

async function count(entity: string, where = ""): Promise<number> {
  const data = await graphql<Record<string, { aggregate: { count: number } }>>(
    `{ ${entity}_aggregate${where ? `(where: ${where})` : ""} { aggregate { count } } }`,
  );
  return data[`${entity}_aggregate`].aggregate.count;
}

async function main(): Promise<void> {
  const chain = JSON.parse(readFileSync(countsPath, "utf8")) as OnChain;
  const lines: { what: string; chain: number; indexer: number }[] = [];
  const push = async (what: string, chainCount: number, indexerCount: Promise<number>) => {
    lines.push({ what, chain: chainCount, indexer: await indexerCount });
  };

  await push("gifts created (daily)", onChainCount(chain, DAILY, ["dailyGiftCreated"]), count("Gift", '{kind: {_eq: "daily"}}'));
  await push("gifts created (milestone)", onChainCount(chain, MILESTONE, ["milestoneGiftCreated"]), count("Gift", '{kind: {_eq: "milestone"}}'));
  await push("check-ins accepted", onChainCount(chain, DAILY, ["checkInAccepted"]), count("CheckIn"));
  await push("days drained", onChainCount(chain, DAILY, ["daysDrained"]), count("Drain"));
  await push("milestones reached", onChainCount(chain, MILESTONE, ["milestoneReached"]), count("Milestone"));
  await push(
    "withdrawals",
    onChainCount(chain, DAILY, ["earnedWithdrawn"]) + onChainCount(chain, MILESTONE, ["earnedWithdrawn"]),
    count("Withdrawal"),
  );
  await push(
    "refunds (unearned, cancelled, expired)",
    onChainCount(chain, DAILY, ["unearnedRefunded", "giftCancelled"]) + onChainCount(chain, MILESTONE, ["unearnedRefunded", "giftCancelled", "giftExpired"]),
    count("Refund"),
  );
  await push("exits", onChainCount(chain, ROUTER, ["exited"]), count("Exit"));
  await push(
    "goal registrations (events)",
    onChainCount(chain, DAILY, ["dailyGoalRegistered"]) + onChainCount(chain, MILESTONE, ["milestoneGoalRegistered"]),
    count("GoalRegistration"),
  );
  // Goal keeps one row per contract and goal type; a goal registered twice counts once here, so no chain figure.
  await push("goals (distinct contract and goal type)", NaN, count("Goal"));
  await push("exchanges allowed or revoked (distinct)", NaN, count("Exchange"));

  const indexedKinds: (keyof typeof signatures)[] = [
    "dailyGoalRegistered", "dailyGiftCreated", "giftFunded", "giftClaimed", "identityBound", "checkInAccepted", "daysDrained",
    "earnedWithdrawn", "unearnedRefunded", "giftCancelled", "giftFinalised",
  ];
  const milestoneKinds: (keyof typeof signatures)[] = [
    "milestoneGoalRegistered", "milestoneGiftCreated", "giftFunded", "giftClaimed", "startRecorded", "milestoneReached", "giftExpired",
    "earnedWithdrawn", "unearnedRefunded", "giftCancelled",
  ];
  const eventsOnChain =
    onChainCount(chain, DAILY, indexedKinds) + onChainCount(chain, MILESTONE, milestoneKinds) + onChainCount(chain, ROUTER, ["exchangeAllowed", "exited"]);
  const global = await graphql<{ GlobalStat: { eventsIndexed: number }[] }>(`{ GlobalStat(where: {id: {_eq: "global"}}) { eventsIndexed } }`);
  await push("events indexed (all configured kinds)", eventsOnChain, Promise.resolve(global.GlobalStat[0]?.eventsIndexed ?? 0));

  console.log(`chain: ${countsPath} (blocks ${chain.from_block} to ${chain.to_block}, read ${chain.read_at}); indexer: ${endpoint}`);
  console.log("what".padEnd(44) + "chain".padStart(8) + "indexer".padStart(10) + "  verdict");
  let differing = 0;
  for (const line of lines) {
    const same = Number.isNaN(line.chain) ? "(not counted on chain)" : line.chain === line.indexer ? "same" : "DIFFERS";
    if (same === "DIFFERS") differing += 1;
    console.log(line.what.padEnd(44) + String(Number.isNaN(line.chain) ? "-" : line.chain).padStart(8) + String(line.indexer).padStart(10) + "  " + same);
  }
  process.exit(differing === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
