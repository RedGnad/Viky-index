/**
 * The handlers, run over events written here rather than read from the chain (Envio's test indexer), with the
 * configuration as it is committed. What they pin: money that went back to a funder is counted once, on the one event
 * that carries the transfer; a milestone reached says so; and the second version of the gift contracts, which has no
 * address yet, is not indexed at all. Its own handlers are tested in handlers-v2.test.ts, with addresses given.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTestIndexer } from "envio";

const DAILY_V1 = "0x995ab09d8b20511d057e9e87d00fa1f41fc0e233";
const DAILY_V2 = "0x00000000000000000000000000000000000d0002";
const MILESTONE_V1 = "0x8dc281ac8a1c789fdb65a063b9225e98ec522f0e";
const FUNDER = "0x00000000000000000000000000000000000000f1";
const RECIPIENT = "0x00000000000000000000000000000000000000a1";
const HASH = `0x${"11".repeat(32)}`;
const BLOCK = 110_000_000;

test("a cancelled gift's refund is counted once: the cancellation says the status, the transfer carries the amount", async () => {
  const indexer = createTestIndexer();
  await indexer.process({
    chains: {
      143: {
        simulate: [
          { contract: "GiftEscrow", event: "GiftCreated", srcAddress: DAILY_V1, block: { number: BLOCK }, params: { giftId: 9n, funder: FUNDER, refundTo: FUNDER, recipientContactHash: HASH, goalType: 1n, dailyTarget: 10n, durationDays: 7n, amount: 7_000_000n, perDay: 1_000_000n } },
          { contract: "GiftEscrow", event: "GiftFunded", srcAddress: DAILY_V1, block: { number: BLOCK }, params: { giftId: 9n, amount: 7_000_000n } },
          { contract: "GiftEscrow", event: "GiftCancelled", srcAddress: DAILY_V1, block: { number: BLOCK + 1 }, params: { giftId: 9n, refunded: 7_000_000n } },
          { contract: "GiftEscrow", event: "UnearnedRefunded", srcAddress: DAILY_V1, block: { number: BLOCK + 1 }, params: { giftId: 9n, refundTo: FUNDER, amount: 7_000_000n } },
        ],
      },
    },
  });
  const gift = await indexer.Gift.get(`${DAILY_V1}-9`);
  assert.equal(gift?.version, 1);
  assert.equal(gift?.recipientContactHash, HASH);
  assert.equal(gift?.status, "cancelled");
  assert.equal(gift?.amountRefunded, 7_000_000n, "7.00 came back, not 14.00");
  assert.equal((await indexer.GlobalStat.get("global"))?.amountRefunded, 7_000_000n);
});

test("a milestone reached says so, and an expiry moves no money by itself", async () => {
  const indexer = createTestIndexer();
  const created = (giftId: bigint) =>
    ({ contract: "MilestoneGift", event: "GiftCreated", srcAddress: MILESTONE_V1, block: { number: BLOCK }, params: { giftId, funder: FUNDER, refundTo: FUNDER, recipientContactHash: HASH, goalType: 3n, shape: 0n, target: 1_500n, maximumStart: 1_460n, subject: HASH, durationDays: 30n, amount: 5_000_000n, deadline: 0n } }) as const;
  await indexer.process({
    chains: {
      143: {
        simulate: [
          created(1_000_010n),
          { contract: "MilestoneGift", event: "MilestoneReached", srcAddress: MILESTONE_V1, block: { number: BLOCK + 1 }, params: { giftId: 1_000_010n, recipient: RECIPIENT, metricValue: 1_510n, observedAt: 1_800_000_000n, amount: 5_000_000n } },
          created(1_000_011n),
          { contract: "MilestoneGift", event: "GiftExpired", srcAddress: MILESTONE_V1, block: { number: BLOCK + 2 }, params: { giftId: 1_000_011n, amount: 5_000_000n } },
        ],
      },
    },
  });
  const reached = await indexer.Gift.get(`${MILESTONE_V1}-1000010`);
  assert.equal(reached?.status, "reached");
  assert.equal(reached?.amountEarned, 5_000_000n);
  const expired = await indexer.Gift.get(`${MILESTONE_V1}-1000011`);
  assert.equal(expired?.status, "expired");
  assert.equal(expired?.amountReturned, 5_000_000n);
  assert.equal(expired?.amountRefunded, 0n, "nothing was sent yet: the transfer is an event of its own");
  const global = await indexer.GlobalStat.get("global");
  assert.equal(global?.milestonesReached, 1);
  assert.equal(global?.amountRefunded, 0n);
});

test("the second version has no address yet, so nothing is indexed for it", async () => {
  const indexer = createTestIndexer();
  await assert.rejects(
    indexer.process({
      chains: { 143: { simulate: [{ contract: "GiftEscrowV2", event: "GiftFunded", srcAddress: DAILY_V2, block: { number: BLOCK }, params: { giftId: 4n, amount: 7_000_004n } }] } },
    }),
    /never reached a handler/,
  );
});
