// Fairness model: a winner-take-all market is zero-sum iff
//   parValuePerShare = buyIn / sharesPerOption
// Then doing nothing => break even, and the pot exactly covers the payout.

export interface Economics {
  buyInCents: number;
  sharesPerOption: number;
}

export interface FairnessResult {
  parValueCents: number; // buyIn / shares (may be fractional cents)
  /** true when par is a whole number of cents — keeps settlement exact */
  exact: boolean;
  explanation: string;
}

export const DEFAULT_ECONOMICS: Economics = {
  buyInCents: 1000, // $10.00
  sharesPerOption: 10, // -> par $1.00/share
};

export const DEFAULT_MAX_OWE_PCT = 40;

/** The most a member may owe the ledger (in cents), from the buy-in and % cap. */
export function maxDebtCents(buyInCents: number, maxOwePct: number): number {
  return Math.round((buyInCents * maxOwePct) / 100);
}

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 50;
export const MAX_SHARES_PER_OPTION = 100_000;

export function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}$${(abs / 100).toFixed(2)}`;
}

export function computeFairness({ buyInCents, sharesPerOption }: Economics): FairnessResult {
  const parValueCents = buyInCents / sharesPerOption;
  const exact = Number.isInteger(parValueCents);
  const explanation =
    `Each buy-in of ${dollars(buyInCents)} grants ${sharesPerOption} shares of ` +
    `every option. The winning option redeems at ${dollars(Math.round(parValueCents))}/share, ` +
    `so if you do nothing you break even, and the pot always exactly covers every payout.`;
  return { parValueCents, exact, explanation };
}

/**
 * Settlement payout for a holder of `winningShares` of the winning option.
 * Uses integer math (multiply before divide) to keep the group zero-sum.
 */
export function payoutCents(
  winningShares: number,
  { buyInCents, sharesPerOption }: Economics,
): number {
  return Math.round((winningShares * buyInCents) / sharesPerOption);
}

export interface EconomicsValidation {
  ok: boolean;
  errors: string[];
}

export function validateEconomics(e: Economics): EconomicsValidation {
  const errors: string[] = [];
  if (!Number.isInteger(e.buyInCents) || e.buyInCents <= 0) {
    errors.push('Buy-in must be a positive amount.');
  }
  if (!Number.isInteger(e.sharesPerOption) || e.sharesPerOption < 1) {
    errors.push('Shares per option must be a whole number of at least 1.');
  }
  if (e.sharesPerOption > MAX_SHARES_PER_OPTION) {
    errors.push(`Shares per option cannot exceed ${MAX_SHARES_PER_OPTION}.`);
  }
  return { ok: errors.length === 0, errors };
}
