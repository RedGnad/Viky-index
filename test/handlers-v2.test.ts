/**
 * The handlers of the second version of the gift contracts, run over events written here (Envio's test indexer).
 *
 * The committed configuration gives the second version no address, so nothing is indexed for it. This file runs the
 * same configuration with an address for each of the two, exactly as it will be filled at their deployment: it writes
 * that configuration to a folder of its own and runs from there. What it pins: the same handlers read both versions
 * where they agree, a gift of the second version is created with its opening key, and an ending is its own status,
 * gives its days back without calling them missed, and counts the money once, on the transfer.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const DAILY_V2 = "0x00000000000000000000000000000000000d0002";
const MILESTONE_V1 = "0x8dc281ac8a1c789fdb65a063b9225e98ec522f0e";
const MILESTONE_V2 = "0x00000000000000000000000000000000000e0002";
const FUNDER = "0x00000000000000000000000000000000000000f1";
const RECIPIENT = "0x00000000000000000000000000000000000000a1";
const OPENING_KEY = "0x00000000000000000000000000000000000000c1";
const HASH = `0x${"11".repeat(32)}`;
const BLOCK = 110_000_000;

// The committed configuration, with the two addresses the deployment will give.
const root = resolve(import.meta.dirname, "..");
const folder = join(root, ".envio", "test-v2");
rmSync(folder, { recursive: true, force: true });
mkdirSync(folder, { recursive: true });
const committed = readFileSync(join(root, "config.yaml"), "utf8");
const filled = committed
  .replace("      - name: GiftEscrowV2\n", `      - name: GiftEscrowV2\n        address: "${DAILY_V2}"\n        start_block: ${BLOCK}\n`)
  .replace("      - name: MilestoneGiftV2\n", `      - name: MilestoneGiftV2\n        address: "${MILESTONE_V2}"\n        start_block: ${BLOCK}\n`);
assert.notEqual(filled, committed, "the committed configuration lists the second version with no address");
writeFileSync(join(folder, "config.yaml"), filled);
for (const name of ["abis", "src", "schema.graphql", "node_modules", "package.json"]) symlinkSync(join(root, name), join(folder, name));
process.chdir(folder);
const { createTestIndexer } = await import("envio");

test("a daily gift of the second version: created with its opening key, read, then ended by the person it is for", async () => {
  const indexer = createTestIndexer();
  await indexer.process({
    chains: {
      143: {
        simulate: [
          { contract: "GiftEscrowV2", event: "GiftCreated", srcAddress: DAILY_V2, block: { number: BLOCK }, params: { giftId: 4n, funder: FUNDER, refundTo: FUNDER, openingKey: OPENING_KEY, goalType: 1n, dailyTarget: 10n, durationDays: 7n, amount: 7_000_004n, perDay: 1_000_000n } },
          { contract: "GiftEscrowV2", event: "GiftFunded", srcAddress: DAILY_V2, block: { number: BLOCK }, params: { giftId: 4n, amount: 7_000_004n } },
          { contract: "GiftEscrowV2", event: "GiftClaimed", srcAddress: DAILY_V2, block: { number: BLOCK + 1 }, params: { giftId: 4n, recipient: RECIPIENT } },
          { contract: "GiftEscrowV2", event: "CheckInAccepted", srcAddress: DAILY_V2, block: { number: BLOCK + 2 }, params: { giftId: 4n, recipient: RECIPIENT, fromDay: 20_700n, toDay: 20_701n, creditedDays: 2n, metricValue: 1_020n, observedAt: 1_800_000_000n } },
          // The ending and the transfer it makes, in one transaction.
          { contract: "GiftEscrowV2", event: "GiftEnded", srcAddress: DAILY_V2, block: { number: BLOCK + 3 }, params: { giftId: 4n, recipient: RECIPIENT, kept: 2_000_000n, givenBack: 5_000_004n, givenBackDays: 5n } },
          { contract: "GiftEscrowV2", event: "UnearnedRefunded", srcAddress: DAILY_V2, block: { number: BLOCK + 3 }, params: { giftId: 4n, refundTo: FUNDER, amount: 5_000_004n } },
        ],
      },
    },
  });
  const gift = await indexer.Gift.get(`${DAILY_V2}-4`);
  assert.ok(gift, "the gift is indexed under its contract and number");
  assert.equal(gift.version, 2);
  assert.equal(gift.openingKey, OPENING_KEY);
  assert.equal(gift.recipientContactHash, undefined);
  assert.equal(gift.status, "ended");
  assert.equal(gift.daysEarned, 2);
  assert.equal(gift.daysReturned, 0, "a day given back is not a day missed");
  assert.equal(gift.daysGivenBack, 5);
  assert.equal(gift.amountEarned, 2_000_000n);
  assert.equal(gift.amountReturned, 5_000_000n, "the five days given back, at the gift's amount per day");
  assert.equal(gift.amountRefunded, 5_000_004n, "what went back to the funder, counted once, on the transfer");
  const global = await indexer.GlobalStat.get("global");
  assert.equal(global?.giftsEnded, 1);
  assert.equal(global?.amountRefunded, 5_000_004n);
  assert.equal(global?.eventsIndexed, 6);
});

test("a milestone gift of the second version is ended: the whole amount goes back, counted once", async () => {
  const indexer = createTestIndexer();
  await indexer.process({
    chains: {
      143: {
        simulate: [
          { contract: "MilestoneGiftV2", event: "GiftCreated", srcAddress: MILESTONE_V2, block: { number: BLOCK }, params: { giftId: 1_000_012n, funder: FUNDER, refundTo: FUNDER, openingKey: OPENING_KEY, goalType: 3n, shape: 0n, target: 1_500n, maximumStart: 1_460n, subject: HASH, durationDays: 30n, amount: 5_000_000n, deadline: 0n } },
          { contract: "MilestoneGiftV2", event: "GiftEnded", srcAddress: MILESTONE_V2, block: { number: BLOCK + 3 }, params: { giftId: 1_000_012n, recipient: RECIPIENT, kept: 0n, givenBack: 5_000_000n } },
          { contract: "MilestoneGiftV2", event: "UnearnedRefunded", srcAddress: MILESTONE_V2, block: { number: BLOCK + 3 }, params: { giftId: 1_000_012n, refundTo: FUNDER, amount: 5_000_000n } },
          // And the first version is still read beside it, by the same handlers.
          { contract: "MilestoneGift", event: "GiftCreated", srcAddress: MILESTONE_V1, block: { number: BLOCK + 4 }, params: { giftId: 1_000_010n, funder: FUNDER, refundTo: FUNDER, recipientContactHash: HASH, goalType: 3n, shape: 0n, target: 1_500n, maximumStart: 1_460n, subject: HASH, durationDays: 30n, amount: 5_000_000n, deadline: 0n } },
        ],
      },
    },
  });
  const ended = await indexer.Gift.get(`${MILESTONE_V2}-1000012`);
  assert.equal(ended?.version, 2);
  assert.equal(ended?.openingKey, OPENING_KEY);
  assert.equal(ended?.status, "ended");
  assert.equal(ended?.amountReturned, 5_000_000n);
  assert.equal(ended?.amountRefunded, 5_000_000n);
  assert.equal((await indexer.Gift.get(`${MILESTONE_V1}-1000010`))?.version, 1);
  const global = await indexer.GlobalStat.get("global");
  assert.equal(global?.giftsEnded, 1);
  assert.equal(global?.giftsCreated, 2);
  assert.equal(global?.amountRefunded, 5_000_000n);
});
