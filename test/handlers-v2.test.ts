/**
 * The handlers of the second version of the gift contracts and of the anchor of agreements, run over events written
 * here (Envio's test indexer), on the committed configuration: since 2 Oct 2026 it holds the three deployed addresses.
 *
 * What it pins: the same handlers read both versions where they agree, a gift of the second version is created with
 * its opening key, an ending is its own status, gives its days back without calling them missed, and counts the
 * money once, on the transfer; and a consent key, a yes and a stop are each written down with their place.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTestIndexer } from "envio";

const DAILY_V2 = "0xc83d8028347967fc84d0e36ae5876d9b29eaec51";
const MILESTONE_V1 = "0x8dc281ac8a1c789fdb65a063b9225e98ec522f0e";
const MILESTONE_V2 = "0x493c87a27e637bbc7179c17be2b215fc18523cc0";
const ANCHOR = "0x2a15df23ff62120700f14d1e5d5d56ca0dad027e";
const FUNDER = "0x00000000000000000000000000000000000000f1";
const RECIPIENT = "0x00000000000000000000000000000000000000a1";
const OPENING_KEY = "0x00000000000000000000000000000000000000c1";
const HASH = `0x${"11".repeat(32)}`;
const BLOCK = 110_000_000;

test("the committed configurations hold the three deployed addresses, each from its own block", () => {
  for (const file of ["config.yaml", "config.rpc.yaml"]) {
    const config = readFileSync(file, "utf8");
    assert.match(config, /- name: GiftEscrowV2\n {8}address: "0xC83d8028347967Fc84D0e36Ae5876d9b29EAEc51"\n {8}start_block: 109877558\n/, file);
    assert.match(config, /- name: MilestoneGiftV2\n {8}address: "0x493c87A27E637bBc7179C17bE2B215fC18523CC0"\n {8}start_block: 109877586\n/, file);
    assert.match(config, /- name: ConsentAnchor\n {8}address: "0x2a15DF23fF62120700f14D1E5d5d56CA0dAd027e"\n {8}start_block: 109877728\n/, file);
  }
});

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


test("the anchor of agreements: a key bound to an account, then a yes and a stop at their places", async () => {
  const indexer = createTestIndexer();
  const KEY = `0x${"22".repeat(32)}`;
  const R = `0x${"33".repeat(32)}`;
  const S = `0x${"44".repeat(32)}`;
  await indexer.process({
    chains: {
      143: {
        simulate: [
          { contract: "ConsentAnchor", event: "ConsentKeyBound", srcAddress: ANCHOR, block: { number: BLOCK }, params: { account: RECIPIENT, key: KEY } },
          { contract: "ConsentAnchor", event: "ConsentAnchored", srcAddress: ANCHOR, block: { number: BLOCK + 1 }, params: { account: RECIPIENT, giftId: 4n, kind: 1n, sequence: 0n, digest: HASH, signatureR: R, signatureS: S } },
          { contract: "ConsentAnchor", event: "ConsentAnchored", srcAddress: ANCHOR, block: { number: BLOCK + 2 }, params: { account: RECIPIENT, giftId: 4n, kind: 2n, sequence: 1n, digest: HASH, signatureR: R, signatureS: S } },
        ],
      },
    },
  });
  const key = await indexer.ConsentKey.get(RECIPIENT);
  assert.equal(key?.key, KEY);
  assert.equal(key?.account, RECIPIENT);
  const entries = (await indexer.ConsentEntry.getAll()).sort((a, b) => a.sequence - b.sequence);
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.sequence, entry.giftId, entry.account]), [["yes", 0, 4n, RECIPIENT], ["stop", 1, 4n, RECIPIENT]]);
  assert.equal(entries[0].digest, HASH);
  assert.equal(entries[0].signatureR, R);
  assert.equal(entries[0].signatureS, S);
  const global = await indexer.GlobalStat.get("global");
  assert.equal(global?.consentKeysBound, 1);
  assert.equal(global?.yesAnchored, 1);
  assert.equal(global?.stopsAnchored, 1);
  assert.equal(global?.eventsIndexed, 3);
  // It moves no money and no gift: nothing else is counted.
  assert.equal(global?.giftsCreated, 0);
  assert.equal(global?.amountRefunded, 0n);
});
