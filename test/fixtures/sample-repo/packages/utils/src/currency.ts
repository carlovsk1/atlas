/** Formats cents into a BRL string. */
export function formatCurrency(cents: number): string {
  return `R$ ${(cents / 100).toFixed(2)}`
}

export const TAX_RATE = 0.15
