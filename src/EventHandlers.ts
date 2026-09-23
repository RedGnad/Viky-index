/**
 * Viky-index handlers: one function per event of Viky's contracts on Monad, each writing the row for the event and
 * moving the three aggregates (the day, the condition, the whole). Amounts stay in base units as the contracts emit
 * them; nothing is estimated here, every figure is a sum of what an event carried.
 *
 * Money words, as the contracts use them:
 *   earned    a recipient's credited days times the gift's per-day amount (daily), or a milestone's amount;
 *   returned  what left the recipient's side for the funder's: drained days (daily), an expiry (milestone);
 *   withdrawn what a recipient took out (EarnedWithdrawn);
 *   refunded  what went back to the funder's address (UnearnedRefunded, GiftCancelled).
 */
import { indexer, type ConditionStat, type DayStat, type Gift, type GlobalStat } from "envio";

const GLOBAL_ID = "global";

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
  daysEarned?: number;
  daysReturned?: number;
  milestonesReached?: number;
  amountEarned?: bigint;
  amountReturned?: bigint;
  amountWithdrawn?: bigint;
  amountRefunded?: bigint;
  exits?: number;
  exitAmountIn?: bigint;
};

function emptyDay(id: string): DayStat {
  return {
    id,
    giftsCreated: 0,
    giftsFunded: 0,
    giftsClaimed: 0,
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
  return { ...emptyDay(GLOBAL_ID), eventsIndexed: 0 };
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
// GiftEscrow, the daily contract (two addresses: the current one and the earlier one still running gift 1)
// ---------------------------------------------------------------------------------------------------------------

indexer.onEvent({ contract: "GiftEscrow", event: "GoalRegistered" }, async ({ event, context }) => {
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

indexer.onEvent({ contract: "GiftEscrow", event: "GiftCreated" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift: Gift = {
    id: giftKey(contract, event.params.giftId),
    contract,
    giftId: event.params.giftId,
    kind: "daily",
    funder: event.params.funder.toLowerCase(),
    refundTo: event.params.refundTo.toLowerCase(),
    recipientContactHash: event.params.recipientContactHash,
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
    amountEarned: 0n,
    amountReturned: 0n,
    amountWithdrawn: 0n,
    amountRefunded: 0n,
  };
  context.Gift.set(gift);
  await bump(context, event.block.timestamp, { giftsCreated: 1 }, { contract, goalType: gift.goalType, kind: "daily" });
});

indexer.onEvent({ contract: "GiftEscrow", event: "GiftFunded" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
  if (!gift) {
    await countOnly(context, event.block.timestamp);
    return;
  }
  context.Gift.set({ ...gift, fundedAmount: gift.fundedAmount + event.params.amount, status: gift.status === "created" ? "funded" : gift.status });
  await bump(context, event.block.timestamp, { giftsFunded: 1 }, { contract, goalType: gift.goalType, kind: "daily" });
});

indexer.onEvent({ contract: "GiftEscrow", event: "GiftClaimed" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
  if (!gift) {
    await countOnly(context, event.block.timestamp);
    return;
  }
  context.Gift.set({ ...gift, recipient: event.params.recipient.toLowerCase(), status: "claimed" });
  await bump(context, event.block.timestamp, { giftsClaimed: 1 }, { contract, goalType: gift.goalType, kind: "daily" });
});

indexer.onEvent({ contract: "GiftEscrow", event: "IdentityBound" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
  if (gift) context.Gift.set({ ...gift, identityHash: event.params.identityHash });
  await countOnly(context, event.block.timestamp);
});

indexer.onEvent({ contract: "GiftEscrow", event: "CheckInAccepted" }, async ({ event, context }) => {
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

indexer.onEvent({ contract: "GiftEscrow", event: "DaysDrained" }, async ({ event, context }) => {
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

indexer.onEvent({ contract: "GiftEscrow", event: "EarnedWithdrawn" }, async ({ event, context }) => {
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

indexer.onEvent({ contract: "GiftEscrow", event: "UnearnedRefunded" }, async ({ event, context }) => {
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

indexer.onEvent({ contract: "GiftEscrow", event: "GiftCancelled" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
  context.Refund.set({
    id: eventKey(event.chainId, event.block.number, event.logIndex),
    gift_id: giftKey(contract, event.params.giftId),
    reason: "cancelled",
    refundTo: gift?.refundTo ?? "",
    amount: event.params.refunded,
    at: timestampOf(event.block.timestamp),
    block: BigInt(event.block.number),
    transaction: event.transaction.hash,
  });
  if (gift) context.Gift.set({ ...gift, status: "cancelled", amountRefunded: gift.amountRefunded + event.params.refunded });
  await bump(
    context,
    event.block.timestamp,
    { amountRefunded: event.params.refunded },
    gift ? { contract, goalType: gift.goalType, kind: "daily" } : undefined,
  );
});

indexer.onEvent({ contract: "GiftEscrow", event: "GiftFinalised" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
  if (gift) context.Gift.set({ ...gift, status: "finalised" });
  await countOnly(context, event.block.timestamp);
});

// ---------------------------------------------------------------------------------------------------------------
// MilestoneGift
// ---------------------------------------------------------------------------------------------------------------

indexer.onEvent({ contract: "MilestoneGift", event: "GoalRegistered" }, async ({ event, context }) => {
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

indexer.onEvent({ contract: "MilestoneGift", event: "GiftCreated" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift: Gift = {
    id: giftKey(contract, event.params.giftId),
    contract,
    giftId: event.params.giftId,
    kind: "milestone",
    funder: event.params.funder.toLowerCase(),
    refundTo: event.params.refundTo.toLowerCase(),
    recipientContactHash: event.params.recipientContactHash,
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
    amountEarned: 0n,
    amountReturned: 0n,
    amountWithdrawn: 0n,
    amountRefunded: 0n,
  };
  context.Gift.set(gift);
  await bump(context, event.block.timestamp, { giftsCreated: 1 }, { contract, goalType: gift.goalType, kind: "milestone" });
});

indexer.onEvent({ contract: "MilestoneGift", event: "GiftFunded" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
  if (!gift) {
    await countOnly(context, event.block.timestamp);
    return;
  }
  context.Gift.set({ ...gift, fundedAmount: gift.fundedAmount + event.params.amount, status: gift.status === "created" ? "funded" : gift.status });
  await bump(context, event.block.timestamp, { giftsFunded: 1 }, { contract, goalType: gift.goalType, kind: "milestone" });
});

indexer.onEvent({ contract: "MilestoneGift", event: "GiftClaimed" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
  if (!gift) {
    await countOnly(context, event.block.timestamp);
    return;
  }
  context.Gift.set({ ...gift, recipient: event.params.recipient.toLowerCase(), status: "claimed" });
  await bump(context, event.block.timestamp, { giftsClaimed: 1 }, { contract, goalType: gift.goalType, kind: "milestone" });
});

indexer.onEvent({ contract: "MilestoneGift", event: "StartRecorded" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
  if (gift) context.Gift.set({ ...gift, identityHash: event.params.identityHash, deadline: event.params.deadline });
  await countOnly(context, event.block.timestamp);
});

indexer.onEvent({ contract: "MilestoneGift", event: "MilestoneReached" }, async ({ event, context }) => {
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
  if (gift) context.Gift.set({ ...gift, amountEarned: gift.amountEarned + event.params.amount });
  await bump(
    context,
    event.block.timestamp,
    { milestonesReached: 1, amountEarned: event.params.amount },
    gift ? { contract, goalType: gift.goalType, kind: "milestone" } : undefined,
  );
});

indexer.onEvent({ contract: "MilestoneGift", event: "GiftExpired" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
  context.Refund.set({
    id: eventKey(event.chainId, event.block.number, event.logIndex),
    gift_id: giftKey(contract, event.params.giftId),
    reason: "expired",
    refundTo: gift?.refundTo ?? "",
    amount: event.params.amount,
    at: timestampOf(event.block.timestamp),
    block: BigInt(event.block.number),
    transaction: event.transaction.hash,
  });
  if (gift) context.Gift.set({ ...gift, status: "expired", amountReturned: gift.amountReturned + event.params.amount });
  await bump(
    context,
    event.block.timestamp,
    { amountReturned: event.params.amount },
    gift ? { contract, goalType: gift.goalType, kind: "milestone" } : undefined,
  );
});

indexer.onEvent({ contract: "MilestoneGift", event: "EarnedWithdrawn" }, async ({ event, context }) => {
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

indexer.onEvent({ contract: "MilestoneGift", event: "UnearnedRefunded" }, async ({ event, context }) => {
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

indexer.onEvent({ contract: "MilestoneGift", event: "GiftCancelled" }, async ({ event, context }) => {
  const contract = event.srcAddress.toLowerCase();
  const gift = await context.Gift.get(giftKey(contract, event.params.giftId));
  context.Refund.set({
    id: eventKey(event.chainId, event.block.number, event.logIndex),
    gift_id: giftKey(contract, event.params.giftId),
    reason: "cancelled",
    refundTo: gift?.refundTo ?? "",
    amount: event.params.refunded,
    at: timestampOf(event.block.timestamp),
    block: BigInt(event.block.number),
    transaction: event.transaction.hash,
  });
  if (gift) context.Gift.set({ ...gift, status: "cancelled", amountRefunded: gift.amountRefunded + event.params.refunded });
  await bump(
    context,
    event.block.timestamp,
    { amountRefunded: event.params.refunded },
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
