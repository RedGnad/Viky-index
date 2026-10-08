/**
 * The third version of the daily contract (3 Oct 2026: a day is paid the day it is read), run over events written here
 * (Envio's test indexer), on the committed configuration, which holds its deployed address since 4 Oct 2026.
 *
 * What it pins: its events are the second version's, one for one, so the same handlers read it; a gift made on it is
 * indexed under its own contract with version 3; a day counted the day it is read is a day earned like any other; and
 * the second version is still read beside it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTestIndexer } from "envio";

const DAILY_V2 = "0xc83d8028347967fc84d0e36ae5876d9b29eaec51";
const DAILY_V3 = "0x591d76863177e70ffca2c793212d4715a367ec70";
const FUNDER = "0x00000000000000000000000000000000000000f1";
const RECIPIENT = "0x00000000000000000000000000000000000000a1";
const OPENING_KEY = "0x00000000000000000000000000000000000000c1";
const BLOCK = 110_290_771;

type Entry = { type: string; name?: string; inputs?: { type: string; name: string; indexed?: boolean }[] };
const events = (file: string) =>
  (JSON.parse(readFileSync(file, "utf8")) as Entry[])
    .filter((entry) => entry.type === "event")
    .map((entry) => `${entry.name}(${(entry.inputs ?? []).map((input) => `${input.type}${input.indexed ? " indexed" : ""} ${input.name}`).join(", ")})`)
    .sort();

test("the committed configurations hold the third version at its deployed address, from its own block", () => {
  for (const file of ["config.yaml", "config.rpc.yaml"]) {
    const config = readFileSync(file, "utf8");
    assert.match(config, /- name: GiftEscrowV3\n {8}address: "0x591d76863177E70FfcA2C793212d4715A367Ec70"\n {8}start_block: 110278100\n/, file);
    assert.match(config, /- name: GiftEscrowV3\n {4}abi_file_path: abis\/GiftEscrowV3\.json\n {4}handler: src\/EventHandlers\.ts\n/, file);
    // The second version stays where it was.
    assert.match(config, /- name: GiftEscrowV2\n {8}address: "0xC83d8028347967Fc84D0e36Ae5876d9b29EAEc51"\n {8}start_block: 109877558\n/, file);
  }
});

test("its events are the second version's, one for one, in its verified ABI and in what the configuration listens to", () => {
  assert.deepEqual(events("abis/GiftEscrowV3.json"), events("abis/GiftEscrowV2.json"));
  for (const file of ["config.yaml", "config.rpc.yaml"]) {
    const config = readFileSync(file, "utf8");
    const listened = (name: string) => {
      const from = config.indexOf(`  - name: ${name}\n    abi_file_path`);
      const block = config.slice(from, config.indexOf("\n  - name: ", from + 1));
      return [...block.matchAll(/- event: "([^"]+)"/g)].map((match) => match[1]);
    };
    assert.deepEqual(listened("GiftEscrowV3"), listened("GiftEscrowV2"), file);
    assert.equal(listened("GiftEscrowV3").length, 12, file);
  }
});

test("a gift of the third version: made from number 1000, opened, a day counted the day it is read, then ended", async () => {
  const indexer = createTestIndexer();
  await indexer.process({
    chains: {
      143: {
        simulate: [
          { contract: "GiftEscrowV3", event: "GiftCreated", srcAddress: DAILY_V3, block: { number: BLOCK }, params: { giftId: 1_000n, funder: FUNDER, refundTo: FUNDER, openingKey: OPENING_KEY, goalType: 1n, dailyTarget: 5n, durationDays: 30n, amount: 5_610_000n, perDay: 187_000n } },
          { contract: "GiftEscrowV3", event: "GiftFunded", srcAddress: DAILY_V3, block: { number: BLOCK }, params: { giftId: 1_000n, amount: 5_610_000n } },
          { contract: "GiftEscrowV3", event: "GiftClaimed", srcAddress: DAILY_V3, block: { number: BLOCK + 95 }, params: { giftId: 1_000n, recipient: RECIPIENT } },
          // The first reading counts its own day: one day, the day it is read.
          { contract: "GiftEscrowV3", event: "CheckInAccepted", srcAddress: DAILY_V3, block: { number: BLOCK + 200 }, params: { giftId: 1_000n, recipient: RECIPIENT, fromDay: 20_730n, toDay: 20_730n, creditedDays: 1n, metricValue: 1_020n, observedAt: 1_800_000_000n } },
          { contract: "GiftEscrowV3", event: "GiftEnded", srcAddress: DAILY_V3, block: { number: BLOCK + 300 }, params: { giftId: 1_000n, recipient: RECIPIENT, kept: 187_000n, givenBack: 5_423_000n, givenBackDays: 29n } },
          { contract: "GiftEscrowV3", event: "UnearnedRefunded", srcAddress: DAILY_V3, block: { number: BLOCK + 300 }, params: { giftId: 1_000n, refundTo: FUNDER, amount: 5_423_000n } },
          // And the second version is still read beside it, by the same handlers, under its own version.
          { contract: "GiftEscrowV2", event: "GiftCreated", srcAddress: DAILY_V2, block: { number: BLOCK + 301 }, params: { giftId: 5n, funder: FUNDER, refundTo: FUNDER, openingKey: OPENING_KEY, goalType: 1n, dailyTarget: 10n, durationDays: 7n, amount: 7_000_000n, perDay: 1_000_000n } },
        ],
      },
    },
  });
  const gift = await indexer.Gift.get(`${DAILY_V3}-1000`);
  assert.ok(gift, "the gift is indexed under its contract and number");
  assert.equal(gift.version, 3);
  assert.equal(gift.kind, "daily");
  assert.equal(gift.openingKey, OPENING_KEY);
  assert.equal(gift.recipient, RECIPIENT);
  assert.equal(gift.daysEarned, 1);
  assert.equal(gift.amountEarned, 187_000n);
  assert.equal(gift.status, "ended");
  assert.equal(gift.daysGivenBack, 29);
  assert.equal(gift.amountReturned, 29n * 187_000n, "the days given back, at the gift's amount per day");
  assert.equal(gift.amountRefunded, 5_423_000n, "what went back to the funder, counted once, on the transfer");
  const second = await indexer.Gift.get(`${DAILY_V2}-5`);
  assert.equal(second?.version, 2);
  const global = await indexer.GlobalStat.get("global");
  assert.equal(global?.giftsCreated, 2);
  assert.equal(global?.giftsEnded, 1);
  assert.equal(global?.daysEarned, 1);
  assert.equal(global?.eventsIndexed, 7);
});
