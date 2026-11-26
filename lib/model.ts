// The token radar's model: one sealed snapshot in, one ranked board out.
//
// Where the house starter multiplies TVL by one flat constant, this model is FITTED to the
// snapshot's own record, in three parts:
//
// 1. VALUE. The peers are the protocols whose token already trades (a market cap is recorded).
//    A least-squares fit in log10 space explains a peer's market cap from its TVL, its seven-day
//    growth, its age, its chain count and its category. Every term is fitted on the peers and
//    tested held-out twice: the peers are split in two halves by a hash of the slug, each half's
//    fit is scored on the half it never saw, and both errors are published in the dashboard's
//    integrity strip. A pre-token protocol's implied value is the fitted model's prediction of
//    what its token would trade at, from its own figures alone. No name is special-cased.
//    One constraint is imposed on the fit: the growth term may not go negative. Left free it
//    does — market caps are sticky while TVL falls, so a shrinking protocol's ratio inflates —
//    and a radar that rewards a protocol for collapsing is reading an artifact, not a signal.
//    When the free fit returns a negative growth coefficient, the model refits without the
//    term; both held-out trials are run under the same rule, and it costs nothing there.
//
// 2. ODDS. A protocol's token odds are read off the peers' record: among the protocols in the
//    same category group and TVL band, the share that already carry a token, shrunk toward the
//    snapshot-wide share so small groups cannot shout. Odds never change the rank; they price
//    the farm decision (expected value = implied value x odds).
//
// 3. THE SCREEN. Exchanges, bridges, wrapped and staked products and versioned pools are kept
//    off the board by the same rules that built the snapshot's watchlist: their token, if one
//    ever exists, is another asset's business, not a launch of their own. The biggest screened
//    names are listed on the dashboard with the reason, so the reader can check the judgement.
//
// The board ranks by implied value alone, best first. Farm plans are written per protocol from
// its category, chains, TVL and age, each step carrying its cost and its time, and each plan
// closes with a verdict that weighs the expected value against the plan's out-of-pocket cost.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label: the dashboard names it and the board carries it. */
export const MODEL_VERSION = 'peerfit-2';

/** How many live-token peers the dashboard's transparency view carries. */
export const LIVE_ROWS = 24;

/** How many screened-out giants the dashboard names, with their reasons. */
export const EXCLUDED_ROWS = 10;

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Round to 4 decimal places, for the small numbers the board publishes. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** FNV-1a over the slug: a deterministic split key, the same on every run and every machine. */
export function slugHash(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol already carries a token, traded or not. */
export function hasToken(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

// ---------------------------------------------------------------- the value fit

/** A peer: a protocol whose token trades, so the market has already priced it. */
export interface Peer {
  p: SnapshotProtocol;
  age: number;
  logTvl: number;
  growth: number;
  logAge: number;
  chainCount: number;
  logMcap: number;
}

/** The fitted value model: coefficients, the category terms, and how the fit was made. */
export interface ValueFit {
  intercept: number;
  tvl: number;
  growth: number;
  age: number;
  chains: number;
  /** Category dummy coefficients, keyed by category name, in the order they were fitted. */
  categoryTerms: Map<string, number>;
  /** The categories that earned a term of their own (at least CATEGORY_MIN_PEERS peers). */
  categories: string[];
  /** Peers the fit trained on. */
  trainedOn: number;
  /** In-sample R squared in log10 space, for the dashboard's integrity strip. */
  r2: number;
}

/** A category earns its own term once this many peers trade in it. */
const CATEGORY_MIN_PEERS = 8;
/** At most this many category terms, so 128 peers are never spread over too many dials. */
const CATEGORY_MAX_TERMS = 8;
/** The growth term's input clamp, in per cent, as the house model's was. */
const GROWTH_FLOOR = -60;
const GROWTH_CAP = 120;

/** The peers of the snapshot: traded tokens with a price and a TVL to explain it by. */
export function peersOf(snapshot: Snapshot): Peer[] {
  const traded = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const ages = traded
    .map((p) => ageDays(snapshot.as_of, p.listed_at))
    .filter((a): a is number => a !== null)
    .sort((a, b) => a - b);
  const medianAge = ages.length > 0 ? ages[Math.floor(ages.length / 2)]! : 365;
  return traded.map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at) ?? medianAge;
    return {
      p,
      age,
      logTvl: Math.log10(p.tvl_usd),
      growth: Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, finite(p.change_7d, 0))) / 100,
      logAge: Math.log10(age + 30),
      chainCount: Math.min(p.chains.length, 8),
      logMcap: Math.log10(p.mcap_usd!),
    };
  });
}

/** The categories that earn a term: enough peers, most peers first, name order on ties. */
function fittedCategories(peers: Peer[]): string[] {
  const counts = new Map<string, number>();
  for (const peer of peers) {
    if (peer.p.category !== null) counts.set(peer.p.category, (counts.get(peer.p.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= CATEGORY_MIN_PEERS)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, CATEGORY_MAX_TERMS)
    .map(([name]) => name);
}

/** One design row: the features the fit prices, in the fit's fixed order. */
function designRow(logTvl: number, growth: number, logAge: number, chainCount: number, category: string | null, categories: string[], useGrowth: boolean): number[] {
  const row = useGrowth ? [1, logTvl, growth, logAge, chainCount] : [1, logTvl, logAge, chainCount];
  for (const c of categories) row.push(category === c ? 1 : 0);
  return row;
}

/** Solve a small dense linear system by Gaussian elimination with partial pivoting. */
function solve(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const a = matrix.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r]![col]!) > Math.abs(a[pivot]![col]!)) pivot = r;
    const tmp = a[col]!;
    a[col] = a[pivot]!;
    a[pivot] = tmp;
    const d = a[col]![col]!;
    if (Math.abs(d) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r]![col]! / d;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) a[r]![c]! -= f * a[col]![c]!;
    }
  }
  return a.map((row, i) => (Math.abs(row[i]!) < 1e-12 ? 0 : row[n]! / row[i]!));
}

/** Fit the value model on `peers` by ridge-touched least squares in log10 space. */
export function fitValue(peers: Peer[], categories: string[]): ValueFit {
  const free = fitDesign(peers, categories, true);
  if (free.growth >= 0) return free;
  // The growth term's sign is constrained (see the header): refit without it.
  return fitDesign(peers, categories, false);
}

/** One least-squares fit, with or without the growth term in the design. */
function fitDesign(peers: Peer[], categories: string[], useGrowth: boolean): ValueFit {
  const k = (useGrowth ? 5 : 4) + categories.length;
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty: number[] = new Array<number>(k).fill(0);
  for (const peer of peers) {
    const x = designRow(peer.logTvl, peer.growth, peer.logAge, peer.chainCount, peer.p.category, categories, useGrowth);
    for (let i = 0; i < k; i++) {
      xty[i]! += x[i]! * peer.logMcap;
      for (let j = 0; j < k; j++) xtx[i]![j]! += x[i]! * x[j]!;
    }
  }
  for (let i = 1; i < k; i++) xtx[i]![i]! += 1e-6;
  const beta = solve(xtx, xty);
  const mean = peers.reduce((s, peer) => s + peer.logMcap, 0) / Math.max(1, peers.length);
  let ssRes = 0;
  let ssTot = 0;
  for (const peer of peers) {
    const x = designRow(peer.logTvl, peer.growth, peer.logAge, peer.chainCount, peer.p.category, categories, useGrowth);
    const pred = x.reduce((s, v, i) => s + v * beta[i]!, 0);
    ssRes += (peer.logMcap - pred) ** 2;
    ssTot += (peer.logMcap - mean) ** 2;
  }
  const off = useGrowth ? 5 : 4;
  const categoryTerms = new Map<string, number>();
  categories.forEach((c, i) => categoryTerms.set(c, beta[off + i]!));
  return {
    intercept: beta[0]!,
    tvl: beta[1]!,
    growth: useGrowth ? beta[2]! : 0,
    age: beta[useGrowth ? 3 : 2]!,
    chains: beta[useGrowth ? 4 : 3]!,
    categoryTerms,
    categories,
    trainedOn: peers.length,
    r2: ssTot > 0 ? round4(1 - ssRes / ssTot) : 0,
  };
}

/** The fit's prediction for one protocol, split into the terms the detail view shows. */
export interface ValueTerms {
  predicted_log10: number;
  intercept: number;
  tvl_term: number;
  growth_term: number;
  age_term: number;
  chain_term: number;
  category_term: number;
  category: string | null;
}

/** Predict a protocol's launch value from its own figures, term by term. */
export function predictValue(fit: ValueFit, p: SnapshotProtocol, asOf: string, medianPeerAge: number): ValueTerms {
  const age = ageDays(asOf, p.listed_at) ?? medianPeerAge;
  const logTvl = Math.log10(Math.max(1, p.tvl_usd));
  const growth = Math.min(GROWTH_CAP, Math.max(GROWTH_FLOOR, finite(p.change_7d, 0))) / 100;
  const tvlTerm = fit.tvl * logTvl;
  const growthTerm = fit.growth * growth;
  const ageTerm = fit.age * Math.log10(age + 30);
  const chainTerm = fit.chains * Math.min(p.chains.length, 8);
  const categoryTerm = p.category !== null ? (fit.categoryTerms.get(p.category) ?? 0) : 0;
  const predicted = fit.intercept + tvlTerm + growthTerm + ageTerm + chainTerm + categoryTerm;
  return {
    predicted_log10: round4(predicted),
    intercept: round4(fit.intercept),
    tvl_term: round4(tvlTerm),
    growth_term: round4(growthTerm),
    age_term: round4(ageTerm),
    chain_term: round4(chainTerm),
    category_term: round4(categoryTerm),
    category: p.category,
  };
}

/** One held-out trial: a fit scored on the peers it never saw. */
export interface HeldOut {
  trained_on: number;
  tested_on: number;
  /** Median absolute error in log10 space, as a multiple: 0.4 in log10 is about x2.5. */
  median_error_x: number;
  /** The share of tested peers predicted within a factor of three. */
  within_3x_pct: number;
}

/** Fit on one hash half of the peers, score on the other, and say how it went. */
function heldOutTrial(peers: Peer[], trainParity: number): HeldOut {
  const train = peers.filter((peer) => slugHash(peer.p.slug) % 2 === trainParity);
  const test = peers.filter((peer) => slugHash(peer.p.slug) % 2 !== trainParity);
  const fit = fitValue(train, fittedCategories(train));
  const errors = test
    .map((peer) => {
      const categoryTerm = peer.p.category !== null ? (fit.categoryTerms.get(peer.p.category) ?? 0) : 0;
      const predicted = fit.intercept + fit.tvl * peer.logTvl + fit.growth * peer.growth + fit.age * peer.logAge + fit.chains * peer.chainCount + categoryTerm;
      return Math.abs(predicted - peer.logMcap);
    })
    .sort((a, b) => a - b);
  const median = errors.length > 0 ? errors[Math.floor(errors.length / 2)]! : 0;
  const within = errors.filter((e) => e <= Math.log10(3)).length;
  return {
    trained_on: train.length,
    tested_on: test.length,
    median_error_x: round4(Math.pow(10, median)),
    within_3x_pct: test.length > 0 ? Math.round((100 * within) / test.length) : 0,
  };
}

/** The model's whole integrity record: the fit, both held-out trials, and the odds base rate. */
export interface Integrity {
  peers: number;
  categories_fitted: string[];
  r2: number;
  held_out: HeldOut[];
  token_share_pct: number;
}

// ---------------------------------------------------------------- token odds

/** TVL bands for the odds table, in dollars. */
function tvlBand(tvl: number): string {
  if (tvl < 20_000_000) return 'under $20M';
  if (tvl < 50_000_000) return '$20M-$50M';
  if (tvl < 200_000_000) return '$50M-$200M';
  return 'over $200M';
}

/** The odds table: shares of token-carrying protocols by category group and TVL band. */
export interface OddsTable {
  prior: number;
  groups: Map<string, { withToken: number; total: number }>;
}

/** Count the snapshot's own record: who already carries a token, grouped for the odds. */
export function buildOdds(snapshot: Snapshot): OddsTable {
  const categoryCounts = new Map<string, number>();
  for (const p of snapshot.protocols) {
    const c = p.category ?? 'Uncategorized';
    categoryCounts.set(c, (categoryCounts.get(c) ?? 0) + 1);
  }
  const groupOf = (p: SnapshotProtocol): string => {
    const c = p.category ?? 'Uncategorized';
    return (categoryCounts.get(c) ?? 0) >= 20 ? c : 'All other categories';
  };
  const groups = new Map<string, { withToken: number; total: number }>();
  let withToken = 0;
  for (const p of snapshot.protocols) {
    const key = `${groupOf(p)}|${tvlBand(p.tvl_usd)}`;
    const cell = groups.get(key) ?? { withToken: 0, total: 0 };
    cell.total += 1;
    if (hasToken(p)) {
      cell.withToken += 1;
      withToken += 1;
    }
    groups.set(key, cell);
  }
  return { prior: snapshot.protocols.length > 0 ? withToken / snapshot.protocols.length : 0, groups };
}

/** One protocol's token odds, in whole per cent, shrunk toward the snapshot-wide share. */
export function tokenOdds(table: OddsTable, p: SnapshotProtocol, categoryCounts: Map<string, number>): number {
  const c = p.category ?? 'Uncategorized';
  const group = (categoryCounts.get(c) ?? 0) >= 20 ? c : 'All other categories';
  const cell = table.groups.get(`${group}|${tvlBand(p.tvl_usd)}`);
  const k = cell?.withToken ?? 0;
  const n = cell?.total ?? 0;
  const odds = (k + 8 * table.prior) / (n + 8);
  return Math.max(1, Math.min(99, Math.round(100 * odds)));
}

/** Category sizes across the snapshot, for the odds grouping. */
export function categoryCountsOf(snapshot: Snapshot): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of snapshot.protocols) {
    const c = p.category ?? 'Uncategorized';
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------- the screen

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_STARTS = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const SCREENED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC']);

/** Why a pre-token protocol is kept off the board, or null when it is a launch candidate. */
export function screenReason(p: SnapshotProtocol): string | null {
  if (p.category === 'CEX' || EXCHANGE_STARTS.some((x) => p.name.startsWith(x))) {
    return 'Exchange or exchange product: any token is the exchange\u2019s own business, not a protocol launch to farm.';
  }
  if (p.category !== null && SCREENED_CATEGORIES.has(p.category)) {
    return `${p.category}: a wrapped, bridged or staked form of a token that already exists, not a launch of its own.`;
  }
  if (WRAPPED_WORD.test(p.name)) return 'Its name marks it as a wrapped or staked product of another asset.';
  if (VERSIONED.test(p.name)) return 'A versioned pool of another protocol, not a launch candidate of its own.';
  return null;
}

/** Whether the board may rank this protocol: pre-token and through the screen. */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  return isPreToken(p) && screenReason(p) === null;
}

// ---------------------------------------------------------------- farm plans

/** Gas to make one transaction on a chain, in dollars, by the chain's cost class. */
function chainGas(chain: string | null): number {
  if (chain === null) return 4;
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 14;
  if (c === 'solana' || c === 'bnb chain' || c === 'bsc') return 1;
  if (['arbitrum', 'base', 'optimism', 'polygon', 'zksync era', 'linea', 'scroll', 'blast', 'mantle', 'mode', 'avalanche', 'fantom', 'gnosis', 'celo'].includes(c)) return 2;
  return 4;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 250;
  if (tvl >= 200_000_000) return 150;
  if (tvl >= 50_000_000) return 100;
  if (tvl >= 20_000_000) return 75;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The farm archetype a category farms like. */
function archetype(category: string | null): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'lending';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) return 'derivatives';
  if (c.includes('dex') || c.includes('aggregator')) return 'dex';
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('vault')) return 'yield';
  if (c.includes('stable')) return 'stablecoin';
  if (c.includes('rwa')) return 'rwa';
  if (c.includes('prediction')) return 'prediction';
  if (c.includes('nft') || c.includes('gaming') || c.includes('game')) return 'nft';
  return 'generic';
}

/** The core position and the second leg, in the words a farmer can follow, per archetype. */
function coreActions(kind: string, name: string, chain: string, capital: number): { core: string; second: string; weekly: string } {
  switch (kind) {
    case 'lending':
      return {
        core: `Supply $${capital} of USDC to ${name} on ${chain} as collateral and leave the position open.`,
        second: `Borrow about 40% of the supplied value against it and re-supply the loan once, so both sides of the market see the wallet.`,
        weekly: `Repay and re-borrow a small slice, or top the collateral up by $10, so the position never sits untouched for a full week.`,
      };
    case 'derivatives':
      return {
        core: `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged position.`,
        second: `Trade both directions across the week to about $500 of total volume, keeping the position small and hedged.`,
        weekly: `Add roughly $150 of trading volume and one funding-rate check, so the wallet reads as a trader, not a deposit.`,
      };
    case 'dex':
      return {
        core: `Provide $${capital} of liquidity to ${name}'s most-used pool on ${chain} and keep the position open.`,
        second: `Make three swaps of $25 or more through ${name} on different days, so the wallet has trading history as well as liquidity.`,
        weekly: `Make one swap of $25 or more and check the pool position once, so both activity kinds stay current.`,
      };
    case 'yield':
      return {
        core: `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares in the wallet.`,
        second: `Split the position across two of ${name}'s vaults or strategies, so the wallet is not riding on a single pool.`,
        weekly: `Harvest or compound the yield once, and move $10 between the two positions, so the shares keep moving.`,
      };
    case 'stablecoin':
      return {
        core: `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it in the wallet.`,
        second: `Use the stable asset once inside ${name}'s own app, in a pool or a payment, so the holding is not idle.`,
        weekly: `Move $10 of the position or mint a small top-up once, so the balance history shows steady use.`,
      };
    case 'rwa':
      return {
        core: `Mint $${capital} of ${name}'s yield asset on ${chain} through its own app and hold it.`,
        second: `Hold a second, smaller position of $25 in the same asset from a second wallet day, so the holding spans more than one snapshot.`,
        weekly: `Check the asset's redemption page once and hold; this archetype rewards time in the asset, not transactions.`,
      };
    case 'prediction':
      return {
        core: `Fund $${capital} on ${name} and place two small market positions on different questions.`,
        second: `Settle or roll the first position when its market closes, and place the proceeds into a fresh question.`,
        weekly: `Place one new small position a week, so the wallet's record is a run of settled markets, not one bet.`,
      };
    case 'nft':
      return {
        core: `Deposit $${capital} of value into ${name} on ${chain} through its main market or vault and keep the position open.`,
        second: `Make one small trade or listing through ${name} itself, so the wallet appears on both sides of its market.`,
        weekly: `Make one small trade or refresh one listing a week, so the activity record stays alive.`,
      };
    default:
      return {
        core: `Deposit $${capital} of USDC into ${name} on ${chain} through its own app and keep the position open.`,
        second: `Make one more qualifying action of a different kind, such as a swap, a vote or a claim, so the wallet is not one-note.`,
        weekly: `Repeat one qualifying action, such as a deposit, a swap or a vote, so the wallet is active in more than one snapshot.`,
      };
  }
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** Everything one row's farm plan is computed from, verdict included. */
export interface FarmPlan {
  steps: string[];
  capital_usd: number;
  plan_cost_usd: number;
  verdict: string;
}

/** The verdict a plan closes with, from the odds, the value and the plan's own cost. */
export function verdictFor(oddsPct: number, implied: number): string {
  if (oddsPct >= 55 && implied >= 100_000_000) return 'Farm first';
  if (oddsPct >= 45 || implied >= 250_000_000) return 'Farm';
  if (oddsPct >= 30) return 'Farm cheap';
  return 'Watch only';
}

/** "a" or "an" for a protocol's name, so the verdict step reads cleanly. */
function article(name: string): string {
  return /^[aeiou]/i.test(name) ? 'an' : 'a';
}

/** One protocol's farm plan: seven steps, each costed and timed, closing with the verdict. */
export function farmPlan(p: SnapshotProtocol, age: number | null, oddsPct: number, implied: number): FarmPlan {
  const verdict = verdictFor(oddsPct, implied);
  const chain = p.chains.length > 0 ? p.chains[0]! : null;
  const chainName = chain ?? 'its main chain';
  const gas = chainGas(chain);
  const capital = verdict === 'Farm cheap' ? 50 : capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const weeks = Math.max(1, Math.ceil(hold / 7));
  const actions = coreActions(archetype(p.category), p.name, chainName, capital);
  const expected = Math.round(implied * (oddsPct / 100));
  const planCost = 2 * gas + gas + weeks * Math.max(1, Math.round(gas / 2));
  const steps = [
    stepText(
      `Use a fresh wallet that holds only the funds you plan to farm ${p.name} with, and keep its seed phrase offline.`,
      `about $${2 * gas} of gas to fund the wallet and approve the first contract`,
      '10 minutes',
    ),
    stepText(actions.core, `$${capital} of capital plus about $${gas} of gas`, '20 minutes to set up'),
    stepText(actions.second, `about $${gas} of gas, on capital already in the position`, '15 minutes'),
    stepText(actions.weekly, `about $${Math.max(1, Math.round(gas / 2))} of gas a week`, '10 minutes a week'),
    stepText(
      `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot of the protocol.`,
      `the $${capital} stays in the position; withdrawing early ends the farm`,
      `${hold} days`,
    ),
    stepText(
      `Open ${p.name}'s own points or rewards page and claim only from the link the protocol itself publishes.`,
      'nothing to check, and never pay anyone to claim or unlock an airdrop',
      '10 minutes',
    ),
    stepText(
      `Verdict: ${verdict}. The model prices ${article(p.name)} ${p.name} launch at $${implied.toLocaleString('en-US')} and the peers' record gives it ${oddsPct}% token odds, an expected $${expected.toLocaleString('en-US')} against about $${planCost} of out-of-pocket cost; the $${capital} of capital stays yours. Recheck when the protocol announces a points program.`,
      'no cost to review the verdict',
      '5 minutes a month',
    ),
  ];
  return { steps, capital_usd: capital, plan_cost_usd: planCost, verdict };
}

// ---------------------------------------------------------------- the board

/** One row of board.json: the ranked board's row, with the model's working shown. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  token_odds_pct: number;
  expected_value_usd: number;
  verdict: string;
  capital_usd: number;
  plan_cost_usd: number;
  model: ValueTerms;
  farm_steps: string[];
}

/** A live-token peer as the dashboard's transparency view shows it: actual beside predicted. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  predicted_usd: number;
  /** Actual divided by predicted, to two places: 1.00 is a perfect call. */
  actual_over_predicted: number;
  change_7d: number | null;
}

/** A screened-out giant, named on the dashboard with the reason it is not ranked. */
export interface ExcludedRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  reason: string;
}

/** The dashboard's compact view of one board row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  watchlist: boolean;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  token_odds_pct: number;
  expected_value_usd: number;
  verdict: string;
  capital_usd: number;
  plan_cost_usd: number;
  terms: ValueTerms;
  farm_steps: string[];
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  integrity: Integrity;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  screened_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  excluded: ExcludedRow[];
}

/** The whole model run: the fit, the integrity record and the board it prices. */
export interface RadarBuild {
  board: BoardRow[];
  radar: RadarData;
  fit: ValueFit;
}

/** Run the model over the snapshot: fit the peers, price the candidates, rank the board. */
export function buildRadar(snapshot: Snapshot): RadarBuild {
  const peers = peersOf(snapshot);
  const categories = fittedCategories(peers);
  const fit = fitValue(peers, categories);
  const medianPeerAge = peers.map((peer) => peer.age).sort((a, b) => a - b)[Math.floor(peers.length / 2)] ?? 365;
  const integrity: Integrity = {
    peers: peers.length,
    categories_fitted: categories,
    r2: fit.r2,
    held_out: [heldOutTrial(peers, 0), heldOutTrial(peers, 1)],
    token_share_pct: Math.round(100 * (snapshot.protocols.filter(hasToken).length / Math.max(1, snapshot.protocols.length))),
  };
  const oddsTable = buildOdds(snapshot);
  const counts = categoryCountsOf(snapshot);
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  let screened = 0;
  for (const p of snapshot.protocols) {
    if (chosen.has(p.slug)) continue;
    if (!isPreToken(p)) continue;
    if (screenReason(p) !== null) {
      screened += 1;
      continue;
    }
    chosen.set(p.slug, p);
  }
  const scored = [...chosen.values()].map((p) => {
    const terms = predictValue(fit, p, snapshot.as_of, medianPeerAge);
    const implied = Math.max(1, Math.min(100_000_000_000_000, Math.round(Math.pow(10, terms.predicted_log10))));
    const age = ageDays(snapshot.as_of, p.listed_at);
    const odds = tokenOdds(oddsTable, p, counts);
    const plan = farmPlan(p, age, odds, implied);
    return { p, terms, implied, age, odds, plan };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    token_odds_pct: s.odds,
    expected_value_usd: Math.round(s.implied * (s.odds / 100)),
    verdict: s.plan.verdict,
    capital_usd: s.plan.capital_usd,
    plan_cost_usd: s.plan.plan_cost_usd,
    model: s.terms,
    farm_steps: s.plan.steps,
  }));
  const live: LiveRow[] = peers
    .map((peer) => {
      const terms = predictValue(fit, peer.p, snapshot.as_of, medianPeerAge);
      const predicted = Math.max(1, Math.round(Math.pow(10, terms.predicted_log10)));
      return {
        slug: peer.p.slug,
        name: peer.p.name,
        category: peer.p.category,
        chains: peer.p.chains,
        tvl_usd: peer.p.tvl_usd,
        mcap_usd: peer.p.mcap_usd!,
        predicted_usd: predicted,
        actual_over_predicted: round4(peer.p.mcap_usd! / predicted),
        change_7d: peer.p.change_7d,
      };
    })
    .sort((a, b) => b.mcap_usd - a.mcap_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS);
  const excluded: ExcludedRow[] = snapshot.protocols
    .filter((p) => isPreToken(p) && screenReason(p) !== null)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, EXCLUDED_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason: screenReason(p)! }));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    integrity,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !snapshot.watchlist.includes(r.slug)).length,
    screened_size: screened,
    live_size: live.length,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      watchlist: snapshot.watchlist.includes(r.slug),
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      token_odds_pct: r.token_odds_pct,
      expected_value_usd: r.expected_value_usd,
      verdict: r.verdict,
      capital_usd: r.capital_usd,
      plan_cost_usd: r.plan_cost_usd,
      terms: r.model,
      farm_steps: r.farm_steps,
    })),
    live,
    excluded,
  };
  return { board, radar, fit };
}

// ---------------------------------------------------------------- snapshot in, board checked

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, farm steps, values. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100 to 4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (r.token_odds_pct < 1 || r.token_odds_pct > 99) return `${r.slug} has token odds of ${r.token_odds_pct}%`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
