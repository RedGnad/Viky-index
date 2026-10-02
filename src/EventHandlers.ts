/**
 * Viky-index handlers: one function per event of Viky's contracts on Monad, each writing the row for the event and
 * moving the three aggregates (the day, the condition, the whole). Amounts stay in base units as the contracts emit
 * them; nothing is estimated here, every figure is a sum of what an event carried.
 *
 * Money words, as the contracts use them:
 *   earned    a recipient's credited days times the gift's per-day amount (daily), or a milestone's amount;
 *   returned  what left the recipient's side for the funder's: drained days (daily), an expiry (milestone);
 *   withdrawn what a recipient took out (EarnedWithdrawn);
 *   refunded  what went back to the funder's address: UnearnedRefunded, and nothing else. A cancellation, an expiry
 *             and an ending say what a gift became; the money they send back is always an UnearnedRefunded of its own,
 *             in the same transaction or a later one, so counting it on both would count it twice.
 */
import { indexer, type ConditionStat, type DayStat, type Gift, type GlobalStat } from "envio";

const GLOBAL_ID = "global";

/**
 * The two versions of each gift contract. The second (the audit of 1 Oct 2026) emits the same events as the first for
 * everything they share, so one handler serves both; what differs is registered apart: how a gift is created (an
 * opening key where the first version had a contact hash) and the ending by the person the gift is for.
 */
const DAILY = ["GiftEscrow", "GiftEscrowV2"] as const;
const MILESTONE = ["MilestoneGift", "MilestoneGiftV2"] as const;

function giftKey(contract: string, giftId: bigint): string {
  return `${contract.toLowerCase()}-${giftId.toString()}`;
}

function eventKey(chainId: number, block: number, logIndex: number): string {
  return `${chainId}-${block}-${logIndex}`;
}

/** The UTC day of a block timestamp, "YYYY-MM-DD". */
function dayOf(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function timestampOf(seconds: number): Date {
  return new Date(seconds * 1000);
}

type Counters = {
  giftsCreated?: number;
  giftsFunded?: number;
  giftsClaimed?: number;
  giftsEnded?: number;
  daysEarned?: number;
  daysReturned?: number;
  milestonesReached?: number;
  amountEarned?: bigint;
  amountReturned?: bigint;
  amountWithdrawn?: bigint;
  amountRefunded?: bigint;
  exits?: number;
  exitAmountIn?: bigint;
  // The anchor of agreements: counted on the whole only, a day and a condition hold no such column.
  consentKeysBound?: number;
  yesAnchored?: number;
  stopsAnchored?: number;
};

function emptyDay(id: string): DayStat {
  return {
    id,
    giftsCreated: 0,
    giftsFunded: 0,
    giftsClaimed: 0,
    giftsEnded: 0,
    daysEarned: 0,
    daysReturned: 0,
    milestonesReached: 0,
    amountEarned: 0n,
    amountReturned: 0n,
    amountWithdrawn: 0n,
    amountRefunded: 0n,
    exits: 0,
    exitAmountIn: 0n,
  };
}

function emptyGlobal(): GlobalStat {
  return { ...emptyDay(GLOBAL_ID), consentKeysBound: 0, yesAnchored: 0, stopsAnchored: 0, eventsIndexed: 0 };
}

function emptyCondition(contract: string, goalType: number, kind: "daily" | "milestone"): ConditionStat {
  return {
    id: `${contract}-${goalType}`,
    contract,
    goalType,
    kind,
    giftsCreated: 0,
    giftsFunded: 0,
    giftsClaimed: 0,
    giftsEnded: 0,
    daysEarned: 0,
    daysReturned: 0,
    milestonesReached: 0,
    amountEarned: 0n,
    amountReturned: 0n,
    amountWithdrawn: 0n,
    amountRefunded: 0n,
  };
}

function add<T extends Record<string, unknown>>(row: T, delta: Counters): T {
  const next: Record<string, unknown> = { ...row };
  for (const [key, value] of Object.entries(delta)) {
    if (value === undefined || !(key in next)) continue;
    const current = next[key];
    next[key] = typeof current === "bigint" ? (current as bigint) + (value as bigint) : (current as number) + (value as number);
  }
  return next as T;
}

/** Moves the three aggregates at once; the condition is skipped when the event names no gift. */
async function bump(
  context: any,
  timestamp: number,
  delta: Counters,
  condition?: { contract: string; goalType: number; kind: "daily" | "milestone" },
): Promise<void> {
  const dayId = dayOf(timestamp);
  const day = (await context.DayStat.get(dayId)) ?? emptyDay(dayId);
  context.DayStat.set(add(day, delta));
  const global = (await context.GlobalStat.get(GLOBAL_ID)) ?? emptyGlobal();
  context.GlobalStat.set(add({ ...global, eventsIndexed: global.eventsIndexed + 1 }, delta));
  if (condition) {
    const id = `${condition.contract}-${condition.goalType}`;
    const row = (await context.ConditionStat.get(id)) ?? emptyCondition(condition.contract, condition.goalType, condition.kind);
    context.ConditionStat.set(add(row, delta));
  }
}

async function countOnly(context: any, timestamp: number): Promise<void> {
  await bump(context, timestamp, {});
}

// ---------------------------------------------------------------------------------------------------------------
// GiftEscrow, the daily contract (two addresses: the current one and the earlier one still running gift 1), and
// its second version
// ---------------------------------------------------------------------------------------------------------------

for (const name of DAILY) {
  indexer.onEvent({ contract: name, event: "GoalRegistered" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    context.Goal.set({
      id: `${contract}-${event.params.goalType}`,
      contract,
      goalType: Number(event.params.goalType),
      providerId: event.params.providerId,
      shape: undefined,
      registeredAt: timestampOf(event.block.timestamp),
    });
    context.GoalRegistration.set({
      id: eventKey(event.chainId, event.block.number, event.logIndex),
      contract,
      goalType: Number(event.params.goalType),
      providerId: event.params.providerId,
      shape: undefined,
      at: timestampOf(event.block.timestamp),
      block: BigInt(event.block.number),
      transaction: event.transaction.hash,
    });
    await countOnly(context, event.block.timestamp);
  });
}

indexer.onEvent({ contract: "GiftEscrow", event: "GiftCreated" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift: Gift = {
    id: giftKey(contract, event.params.giftId),
    contract,
    giftId: event.params.giftId,
    kind: "daily",
    funder: event.params.funder.toLowerCase(),
    refundTo: event.params.refundTo.toLowerCase(),
    version: 1,
    recipientContactHash: event.params.recipientContactHash,
    openingKey: undefined,
    goalType: Number(event.params.goalType),
    dailyTarget: Number(event.params.dailyTarget),
    perDay: event.params.perDay,
    shape: undefined,
    target: undefined,
    maximumStart: undefined,
    subject: undefined,
    deadline: undefined,
    durationDays: Number(event.params.durationDays),
    amount: event.params.amount,
    status: "created",
    recipient: undefined,
    identityHash: undefined,
    createdAt: timestampOf(event.block.timestamp),
    createdAtBlock: BigInt(event.block.number),
    createdInTransaction: event.transaction.hash,
    fundedAmount: 0n,
    daysEarned: 0,
    daysReturned: 0,
    daysGivenBack: 0,
    amountEarned: 0n,
    amountReturned: 0n,
    amountWithdrawn: 0n,
    amountRefunded: 0n,
  };
  context.Gift.set(gift);
  await bump(context, event.block.timestamp, { giftsCreated: 1 }, { contract, goalType: gift.goalType, kind: "daily" });
});

indexer.onEvent({ contract: "GiftEscrowV2", event: "GiftCreated" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift: Gift = {
    id: giftKey(contract, event.params.giftId),
    contract,
    giftId: event.params.giftId,
    kind: "daily",
    funder: event.params.funder.toLowerCase(),
    refundTo: event.params.refundTo.toLowerCase(),
    version: 2,
    recipientContactHash: undefined,
    openingKey: event.params.openingKey.toLowerCase(),
    goalType: Number(event.params.goalType),
    dailyTarget: Number(event.params.dailyTarget),
    perDay: event.params.perDay,
    shape: undefined,
    target: undefined,
    maximumStart: undefined,
    subject: undefined,
    deadline: undefined,
    durationDays: Number(event.params.durationDays),
    amount: event.params.amount,
    status: "created",
    recipient: undefined,
    identityHash: undefined,
    createdAt: timestampOf(event.block.timestamp),
    createdAtBlock: BigInt(event.block.number),
    createdInTransaction: event.transaction.hash,
    fundedAmount: 0n,
    daysEarned: 0,
    daysReturned: 0,
    daysGivenBack: 0,
    amountEarned: 0n,
    amountReturned: 0n,
    amountWithdrawn: 0n,
    amountRefunded: 0n,
  };
  context.Gift.set(gift);
  await bump(context, event.block.timestamp, { giftsCreated: 1 }, { contract, goalType: gift.goalType, kind: "daily" });
});

for (const name of DAILY) {
  indexer.onEvent({ contract: name, event: "GiftFunded" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
    if (!gift) {
      await countOnly(context, event.block.timestamp);
      return;
    }
    context.Gift.set({ ...gift, fundedAmount: gift.fundedAmount + event.params.amount, status: gift.status === "created" ? "funded" : gift.status });
    await bump(context, event.block.timestamp, { giftsFunded: 1 }, { contract, goalType: gift.goalType, kind: "daily" });
  });
}

for (const name of DAILY) {
  indexer.onEvent({ contract: name, event: "GiftClaimed" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
    if (!gift) {
      await countOnly(context, event.block.timestamp);
      return;
    }
    context.Gift.set({ ...gift, recipient: event.params.recipient.toLowerCase(), status: "claimed" });
    await bump(context, event.block.timestamp, { giftsClaimed: 1 }, { contract, goalType: gift.goalType, kind: "daily" });
  });
}

for (const name of DAILY) {
  indexer.onEvent({ contract: name, event: "IdentityBound" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
    if (gift) context.Gift.set({ ...gift, identityHash: event.params.identityHash });
    await countOnly(context, event.block.timestamp);
  });
}

for (const name of DAILY) {
  indexer.onEvent({ contract: name, event: "CheckInAccepted" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
    const creditedDays = Number(event.params.creditedDays);
    const amountEarned = gift?.perDay ? gift.perDay * BigInt(creditedDays) : 0n;
    context.CheckIn.set({
      id: eventKey(event.chainId, event.block.number, event.logIndex),
      gift_id: giftKey(contract, event.params.giftId),
      recipient: event.params.recipient.toLowerCase(),
      fromDay: Number(event.params.fromDay),
      toDay: Number(event.params.toDay),
      creditedDays,
      amountEarned,
      metricValue: event.params.metricValue,
      observedAt: event.params.observedAt,
      at: timestampOf(event.block.timestamp),
      block: BigInt(event.block.number),
      transaction: event.transaction.hash,
    });
    if (gift) {
      context.Gift.set({ ...gift, daysEarned: gift.daysEarned + creditedDays, amountEarned: gift.amountEarned + amountEarned });
    }
    await bump(
      context,
      event.block.timestamp,
      { daysEarned: creditedDays, amountEarned },
      gift ? { contract, goalType: gift.goalType, kind: "daily" } : undefined,
    );
  });
}

for (const name of DAILY) {
  indexer.onEvent({ contract: name, event: "DaysDrained" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
    const missedDays = Number(event.params.missedDays);
    context.Drain.set({
      id: eventKey(event.chainId, event.block.number, event.logIndex),
      gift_id: giftKey(contract, event.params.giftId),
      fromDay: Number(event.params.fromDay),
      toDay: Number(event.params.toDay),
      missedDays,
      amount: event.params.amount,
      at: timestampOf(event.block.timestamp),
      block: BigInt(event.block.number),
      transaction: event.transaction.hash,
    });
    if (gift) {
      context.Gift.set({ ...gift, daysReturned: gift.daysReturned + missedDays, amountReturned: gift.amountReturned + event.params.amount });
    }
    await bump(
      context,
      event.block.timestamp,
      { daysReturned: missedDays, amountReturned: event.params.amount },
      gift ? { contract, goalType: gift.goalType, kind: "daily" } : undefined,
    );
  });
}

for (const name of DAILY) {
  indexer.onEvent({ contract: name, event: "EarnedWithdrawn" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
    context.Withdrawal.set({
      id: eventKey(event.chainId, event.block.number, event.logIndex),
      gift_id: giftKey(contract, event.params.giftId),
      recipient: event.params.recipient.toLowerCase(),
      to: event.params.to.toLowerCase(),
      amount: event.params.amount,
      at: timestampOf(event.block.timestamp),
      block: BigInt(event.block.number),
      transaction: event.transaction.hash,
    });
    if (gift) context.Gift.set({ ...gift, amountWithdrawn: gift.amountWithdrawn + event.params.amount });
    await bump(
      context,
      event.block.timestamp,
      { amountWithdrawn: event.params.amount },
      gift ? { contract, goalType: gift.goalType, kind: "daily" } : undefined,
    );
  });
}

for (const name of DAILY) {
  indexer.onEvent({ contract: name, event: "UnearnedRefunded" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
    context.Refund.set({
      id: eventKey(event.chainId, event.block.number, event.logIndex),
      gift_id: giftKey(contract, event.params.giftId),
      reason: "unearned",
      refundTo: event.params.refundTo.toLowerCase(),
      amount: event.params.amount,
      at: timestampOf(event.block.timestamp),
      block: BigInt(event.block.number),
      transaction: event.transaction.hash,
    });
    if (gift) context.Gift.set({ ...gift, amountRefunded: gift.amountRefunded + event.params.amount });
    await bump(
      context,
      event.block.timestamp,
      { amountRefunded: event.params.amount },
      gift ? { contract, goalType: gift.goalType, kind: "daily" } : undefined,
    );
  });
}

for (const name of DAILY) {
  indexer.onEvent({ contract: name, event: "GiftCancelled" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
    // The status, and nothing else: the money a cancellation sends back is an UnearnedRefunded of its own, in the
    // same transaction, and that event carries the amount. Adding it here too counted it twice.
    if (gift) context.Gift.set({ ...gift, status: "cancelled" });
    await countOnly(context, event.block.timestamp);
  });
}

for (const name of DAILY) {
  indexer.onEvent({ contract: name, event: "GiftFinalised" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
    if (gift) context.Gift.set({ ...gift, status: "finalised" });
    await countOnly(context, event.block.timestamp);
  });
}

/**
 * The person a daily gift is for ends it (second version only). What was counted stays theirs; the days neither
 * counted nor missed are given back, which is neither earned nor a miss. The transfer to the funder's side is the
 * UnearnedRefunded of the same transaction, counted there.
 */
indexer.onEvent({ contract: "GiftEscrowV2", event: "GiftEnded" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
  const givenBackDays = Number(event.params.givenBackDays);
  const amountGivenBack = gift?.perDay ? gift.perDay * BigInt(givenBackDays) : 0n;
  context.Ending.set({
    id: eventKey(event.chainId, event.block.number, event.logIndex),
    gift_id: giftKey(contract, event.params.giftId),
    recipient: event.params.recipient.toLowerCase(),
    kept: event.params.kept,
    givenBack: event.params.givenBack,
    givenBackDays,
    at: timestampOf(event.block.timestamp),
    block: BigInt(event.block.number),
    transaction: event.transaction.hash,
  });
  if (gift) context.Gift.set({ ...gift, status: "ended", daysGivenBack: givenBackDays, amountReturned: gift.amountReturned + amountGivenBack });
  await bump(
    context,
    event.block.timestamp,
    { giftsEnded: 1, amountReturned: amountGivenBack },
    gift ? { contract, goalType: gift.goalType, kind: "daily" } : undefined,
  );
});

// ---------------------------------------------------------------------------------------------------------------
// MilestoneGift
// ---------------------------------------------------------------------------------------------------------------

for (const name of MILESTONE) {
  indexer.onEvent({ contract: name, event: "GoalRegistered" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    context.Goal.set({
      id: `${contract}-${event.params.goalType}`,
      contract,
      goalType: Number(event.params.goalType),
      providerId: event.params.providerId,
      shape: Number(event.params.shape),
      registeredAt: timestampOf(event.block.timestamp),
    });
    context.GoalRegistration.set({
      id: eventKey(event.chainId, event.block.number, event.logIndex),
      contract,
      goalType: Number(event.params.goalType),
      providerId: event.params.providerId,
      shape: Number(event.params.shape),
      at: timestampOf(event.block.timestamp),
      block: BigInt(event.block.number),
      transaction: event.transaction.hash,
    });
    await countOnly(context, event.block.timestamp);
  });
}

indexer.onEvent({ contract: "MilestoneGift", event: "GiftCreated" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift: Gift = {
    id: giftKey(contract, event.params.giftId),
    contract,
    giftId: event.params.giftId,
    kind: "milestone",
    funder: event.params.funder.toLowerCase(),
    refundTo: event.params.refundTo.toLowerCase(),
    version: 1,
    recipientContactHash: event.params.recipientContactHash,
    openingKey: undefined,
    goalType: Number(event.params.goalType),
    dailyTarget: undefined,
    perDay: undefined,
    shape: Number(event.params.shape),
    target: event.params.target,
    maximumStart: event.params.maximumStart,
    subject: event.params.subject,
    deadline: event.params.deadline,
    durationDays: Number(event.params.durationDays),
    amount: event.params.amount,
    status: "created",
    recipient: undefined,
    identityHash: undefined,
    createdAt: timestampOf(event.block.timestamp),
    createdAtBlock: BigInt(event.block.number),
    createdInTransaction: event.transaction.hash,
    fundedAmount: 0n,
    daysEarned: 0,
    daysReturned: 0,
    daysGivenBack: 0,
    amountEarned: 0n,
    amountReturned: 0n,
    amountWithdrawn: 0n,
    amountRefunded: 0n,
  };
  context.Gift.set(gift);
  await bump(context, event.block.timestamp, { giftsCreated: 1 }, { contract, goalType: gift.goalType, kind: "milestone" });
});

indexer.onEvent({ contract: "MilestoneGiftV2", event: "GiftCreated" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift: Gift = {
    id: giftKey(contract, event.params.giftId),
    contract,
    giftId: event.params.giftId,
    kind: "milestone",
    funder: event.params.funder.toLowerCase(),
    refundTo: event.params.refundTo.toLowerCase(),
    version: 2,
    recipientContactHash: undefined,
    openingKey: event.params.openingKey.toLowerCase(),
    goalType: Number(event.params.goalType),
    dailyTarget: undefined,
    perDay: undefined,
    shape: Number(event.params.shape),
    target: event.params.target,
    maximumStart: event.params.maximumStart,
    subject: event.params.subject,
    deadline: event.params.deadline,
    durationDays: Number(event.params.durationDays),
    amount: event.params.amount,
    status: "created",
    recipient: undefined,
    identityHash: undefined,
    createdAt: timestampOf(event.block.timestamp),
    createdAtBlock: BigInt(event.block.number),
    createdInTransaction: event.transaction.hash,
    fundedAmount: 0n,
    daysEarned: 0,
    daysReturned: 0,
    daysGivenBack: 0,
    amountEarned: 0n,
    amountReturned: 0n,
    amountWithdrawn: 0n,
    amountRefunded: 0n,
  };
  context.Gift.set(gift);
  await bump(context, event.block.timestamp, { giftsCreated: 1 }, { contract, goalType: gift.goalType, kind: "milestone" });
});

for (const name of MILESTONE) {
  indexer.onEvent({ contract: name, event: "GiftFunded" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
    if (!gift) {
      await countOnly(context, event.block.timestamp);
      return;
    }
    context.Gift.set({ ...gift, fundedAmount: gift.fundedAmount + event.params.amount, status: gift.status === "created" ? "funded" : gift.status });
    await bump(context, event.block.timestamp, { giftsFunded: 1 }, { contract, goalType: gift.goalType, kind: "milestone" });
  });
}

for (const name of MILESTONE) {
  indexer.onEvent({ contract: name, event: "GiftClaimed" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
    if (!gift) {
      await countOnly(context, event.block.timestamp);
      return;
    }
    context.Gift.set({ ...gift, recipient: event.params.recipient.toLowerCase(), status: "claimed" });
    await bump(context, event.block.timestamp, { giftsClaimed: 1 }, { contract, goalType: gift.goalType, kind: "milestone" });
  });
}

for (const name of MILESTONE) {
  indexer.onEvent({ contract: name, event: "StartRecorded" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
    if (gift) context.Gift.set({ ...gift, identityHash: event.params.identityHash, deadline: event.params.deadline });
    await countOnly(context, event.block.timestamp);
  });
}

for (const name of MILESTONE) {
  indexer.onEvent({ contract: name, event: "MilestoneReached" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
    context.Milestone.set({
      id: eventKey(event.chainId, event.block.number, event.logIndex),
      gift_id: giftKey(contract, event.params.giftId),
      recipient: event.params.recipient.toLowerCase(),
      metricValue: event.params.metricValue,
      observedAt: event.params.observedAt,
      amount: event.params.amount,
      at: timestampOf(event.block.timestamp),
      block: BigInt(event.block.number),
      transaction: event.transaction.hash,
    });
    if (gift) context.Gift.set({ ...gift, status: "reached", amountEarned: gift.amountEarned + event.params.amount });
    await bump(
      context,
      event.block.timestamp,
      { milestonesReached: 1, amountEarned: event.params.amount },
      gift ? { contract, goalType: gift.goalType, kind: "milestone" } : undefined,
    );
  });
}

for (const name of MILESTONE) {
  indexer.onEvent({ contract: name, event: "GiftExpired" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
    // An expiry moves no money: it makes the amount the funder's to take, and the transfer is an UnearnedRefunded,
    // then or later. So no refund row is written here: one would say money left that had not.
    if (gift) context.Gift.set({ ...gift, status: "expired", amountReturned: gift.amountReturned + event.params.amount });
    await bump(
      context,
      event.block.timestamp,
      { amountReturned: event.params.amount },
      gift ? { contract, goalType: gift.goalType, kind: "milestone" } : undefined,
    );
  });
}

for (const name of MILESTONE) {
  indexer.onEvent({ contract: name, event: "EarnedWithdrawn" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
    context.Withdrawal.set({
      id: eventKey(event.chainId, event.block.number, event.logIndex),
      gift_id: giftKey(contract, event.params.giftId),
      recipient: event.params.recipient.toLowerCase(),
      to: event.params.to.toLowerCase(),
      amount: event.params.amount,
      at: timestampOf(event.block.timestamp),
      block: BigInt(event.block.number),
      transaction: event.transaction.hash,
    });
    if (gift) context.Gift.set({ ...gift, amountWithdrawn: gift.amountWithdrawn + event.params.amount });
    await bump(
      context,
      event.block.timestamp,
      { amountWithdrawn: event.params.amount },
      gift ? { contract, goalType: gift.goalType, kind: "milestone" } : undefined,
    );
  });
}

for (const name of MILESTONE) {
  indexer.onEvent({ contract: name, event: "UnearnedRefunded" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
    context.Refund.set({
      id: eventKey(event.chainId, event.block.number, event.logIndex),
      gift_id: giftKey(contract, event.params.giftId),
      reason: "unearned",
      refundTo: event.params.refundTo.toLowerCase(),
      amount: event.params.amount,
      at: timestampOf(event.block.timestamp),
      block: BigInt(event.block.number),
      transaction: event.transaction.hash,
    });
    if (gift) context.Gift.set({ ...gift, amountRefunded: gift.amountRefunded + event.params.amount });
    await bump(
      context,
      event.block.timestamp,
      { amountRefunded: event.params.amount },
      gift ? { contract, goalType: gift.goalType, kind: "milestone" } : undefined,
    );
  });
}

for (const name of MILESTONE) {
  indexer.onEvent({ contract: name, event: "GiftCancelled" }, async ({ event, context }) => {
    const contract = event.srcAddress.toLowerCase();
    const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
    // The status, and nothing else: the money a cancellation sends back is an UnearnedRefunded of its own, in the
    // same transaction, and that event carries the amount. Adding it here too counted it twice.
    if (gift) context.Gift.set({ ...gift, status: "cancelled" });
    await countOnly(context, event.block.timestamp);
  });
}

/** The person a milestone gift is for ends it (second version only): nothing was earned, the whole amount goes back. */
indexer.onEvent({ contract: "MilestoneGiftV2", event: "GiftEnded" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
  context.Ending.set({
    id: eventKey(event.chainId, event.block.number, event.logIndex),
    gift_id: giftKey(contract, event.params.giftId),
    recipient: event.params.recipient.toLowerCase(),
    kept: event.params.kept,
    givenBack: event.params.givenBack,
    givenBackDays: undefined,
    at: timestampOf(event.block.timestamp),
    block: BigInt(event.block.number),
    transaction: event.transaction.hash,
  });
  if (gift) context.Gift.set({ ...gift, status: "ended", amountReturned: gift.amountReturned + event.params.givenBack });
  await bump(
    context,
    event.block.timestamp,
    { giftsEnded: 1, amountReturned: event.params.givenBack },
    gift ? { contract, goalType: gift.goalType, kind: "milestone" } : undefined,
  );
});

// ---------------------------------------------------------------------------------------------------------------
// ExitRouter: payouts by currency (tokenOut) and rail (exchange)
// ---------------------------------------------------------------------------------------------------------------

indexer.onEvent({ contract: "ExitRouter", event: "ExchangeAllowed" }, async ({ event, context }) => {
  context.Exchange.set({
    id: event.params.exchange.toLowerCase(),
    allowed: event.params.allowed,
    mustPointAt: event.params.mustPointAt.toLowerCase(),
    updatedAt: timestampOf(event.block.timestamp),
  });
  await countOnly(context, event.block.timestamp);
});

indexer.onEvent({ contract: "ExitRouter", event: "Exited" }, async ({ event, context }) => {
  const tokenOut = event.params.tokenOut.toLowerCase();
  const exchange = event.params.exchange.toLowerCase();
  context.Exit.set({
    id: eventKey(event.chainId, event.block.number, event.logIndex),
    payer: event.params.payer.toLowerCase(),
    amountIn: event.params.amountIn,
    tokenOut,
    amountOut: event.params.amountOut,
    exchange,
    at: timestampOf(event.block.timestamp),
    block: BigInt(event.block.number),
    transaction: event.transaction.hash,
  });
  const payoutId = `${tokenOut}-${exchange}`;
  const payout = (await context.PayoutStat.get(payoutId)) ?? { id: payoutId, tokenOut, exchange, exits: 0, amountIn: 0n, amountOut: 0n };
  context.PayoutStat.set({
    ...payout,
    exits: payout.exits + 1,
    amountIn: payout.amountIn + event.params.amountIn,
    amountOut: payout.amountOut + event.params.amountOut,
  });
  await bump(context, event.block.timestamp, { exits: 1, exitAmountIn: event.params.amountIn });
});

// ---------------------------------------------------------------------------------------------------------------
// ConsentAnchor: the agreement of the person a gift is for, written down in public (second version)
// ---------------------------------------------------------------------------------------------------------------

/** The contract's two kinds, in words. Anything else is refused by the contract itself and never emitted. */
const CONSENT_KINDS: Record<number, string> = { 1: "yes", 2: "stop" };

indexer.onEvent({ contract: "ConsentAnchor", event: "ConsentKeyBound" }, async ({ event, context }) => {
  const account = event.params.account.toLowerCase();
  context.ConsentKey.set({
    id: account,
    account,
    key: event.params.key,
    at: timestampOf(event.block.timestamp),
    block: BigInt(event.block.number),
    transaction: event.transaction.hash,
  });
  await bump(context, event.block.timestamp, { consentKeysBound: 1 });
});

indexer.onEvent({ contract: "ConsentAnchor", event: "ConsentAnchored" }, async ({ event, context }) => {
  const kind = CONSENT_KINDS[Number(event.params.kind)] ?? `kind ${event.params.kind}`;
  context.ConsentEntry.set({
    id: eventKey(event.chainId, event.block.number, event.logIndex),
    account: event.params.account.toLowerCase(),
    giftId: event.params.giftId,
    kind,
    sequence: Number(event.params.sequence),
    digest: event.params.digest,
    signatureR: event.params.signatureR,
    signatureS: event.params.signatureS,
    at: timestampOf(event.block.timestamp),
    block: BigInt(event.block.number),
    transaction: event.transaction.hash,
  });
  await bump(context, event.block.timestamp, kind === "yes" ? { yesAnchored: 1 } : kind === "stop" ? { stopsAnchored: 1 } : {});
});
