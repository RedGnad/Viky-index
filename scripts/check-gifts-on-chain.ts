/**
 * Sets each gift's sums in the index beside the contract's own storage for that gift, read with getGift(giftId) on
 * Monad through a public RPC. Events summed by the handlers (days credited and drained, amounts withdrawn and
 * refunded, earned) must equal what the contract itself keeps; a line that differs is a bug to read.
 *
 * The index side is the aggregates record of a run (artifacts/aggregates.json, the Gift rows) or a live GraphQL
 * endpoint. The chain side is https://rpc1.monad.xyz by default (it refuses unnamed agents, so one is set).
 *
 * Usage: npx tsx scripts/check-gifts-on-chain.ts [--aggregates artifacts/aggregates.json | --endpoint <graphql url>]
 *        [--rpc https://rpc1.monad.xyz]
 * Exit code 1 when any line differs.
 */
import { readFileSync } from "node:fs";
import { Contract, FetchRequest, JsonRpcProvider } from "ethers";

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

type GiftRow = {
  id: string;
  kind: "daily" | "milestone";
  /** 1, 2 or 3: which version of its contract holds the gift, and so which ABI reads its storage. */
  version: number;
  status: string;
  amount: string;
  fundedAmount: string;
  daysEarned: number;
  daysReturned: number;
  daysGivenBack: number;
  amountEarned: string;
  amountReturned: string;
  amountWithdrawn: string;
  amountRefunded: string;
};

async function giftsFromIndex(): Promise<GiftRow[]> {
  const endpoint = argument("endpoint");
  if (endpoint) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // the local Hasura wants its admin secret; the hosted endpoint is public and rejects the header
        ...(process.env.HASURA_ADMIN_SECRET || endpoint.includes("localhost") ? { "x-hasura-admin-secret": process.env.HASURA_ADMIN_SECRET ?? "testing" } : {}),
      },
      body: JSON.stringify({ query: "{ Gift(order_by: {createdAt: asc}) { id kind version status amount fundedAmount daysEarned daysReturned daysGivenBack amountEarned amountReturned amountWithdrawn amountRefunded } }" }),
    });
    return ((await response.json()) as { data: { Gift: GiftRow[] } }).data.Gift;
  }
  const path = argument("aggregates", "artifacts/aggregates.json")!;
  return (JSON.parse(readFileSync(path, "utf8")) as { data: { Gift: GiftRow[] } }).data.Gift;
}

async function main(): Promise<void> {
  const request = new FetchRequest(argument("rpc", "https://rpc1.monad.xyz")!);
  request.setHeader("User-Agent", "viky-index/0.1 (+https://github.com/RedGnad/Viky-index)");
  const provider = new JsonRpcProvider(request, 143, { staticNetwork: true });
  const abis = {
    daily: { 1: JSON.parse(readFileSync("abis/GiftEscrow.json", "utf8")), 2: JSON.parse(readFileSync("abis/GiftEscrowV2.json", "utf8")), 3: JSON.parse(readFileSync("abis/GiftEscrowV3.json", "utf8")) },
    // A milestone gift has no third version: the third is the daily contract alone.
    milestone: { 1: JSON.parse(readFileSync("abis/MilestoneGift.json", "utf8")), 2: JSON.parse(readFileSync("abis/MilestoneGiftV2.json", "utf8")), 3: JSON.parse(readFileSync("abis/MilestoneGiftV2.json", "utf8")) },
  };

  const gifts = await giftsFromIndex();
  let differing = 0;
  const line = (what: string, chain: string | number | bigint | boolean, index: string | number | bigint | boolean) => {
    const same = String(chain) === String(index);
    if (!same) differing += 1;
    console.log(`    ${what.padEnd(28)} chain ${String(chain).padStart(12)}   index ${String(index).padStart(12)}   ${same ? "same" : "DIFFERS"}`);
  };

  for (const gift of gifts) {
    const [contract, giftId] = gift.id.split("-");
    // A record made before the index kept the version is a gift of the first.
    const version = gift.version === 3 ? 3 : gift.version === 2 ? 2 : 1;
    const abi = abis[gift.kind][version];
    const stored = await new Contract(contract, abi, provider).getGift(BigInt(giftId));
    console.log(`${gift.kind} gift ${giftId} on ${contract} (index status: ${gift.status})`);
    line("amount", stored.amount, gift.amount);
    line("withdrawn by recipient", stored.withdrawnByRecipient, gift.amountWithdrawn);
    line("refunded to funder", stored.refundedToFunder, gift.amountRefunded);
    if (gift.kind === "daily") {
      line("credited days", stored.creditedDays, gift.daysEarned);
      line("drained days", stored.drainedDays, gift.daysReturned);
      line("earned (credited x perDay)", BigInt(stored.creditedDays) * BigInt(stored.perDay), gift.amountEarned);
      line("cancelled", stored.cancelled, gift.status === "cancelled");
      // An ending finalises the gift in the contract's storage, and the index says which of the two it was.
      line("finalised", stored.finalised, gift.status === "finalised" || gift.status === "ended");
      if (version >= 2) {
        line("given back days", stored.givenBackDays, gift.daysGivenBack);
        line("ended", stored.endedAt > 0n, gift.status === "ended");
      }
    } else {
      line("earned", stored.earned, gift.amountEarned);
      line("cancelled", stored.cancelled, gift.status === "cancelled");
      if (version >= 2) line("ended", stored.endedAt > 0n, gift.status === "ended");
    }
    console.log(`    refundable still held: ${stored.refundable} (not an event sum; shown for the reader)`);
  }
  console.log(differing === 0 ? "every line matches the contracts' storage" : `${differing} line(s) differ`);
  process.exit(differing === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
