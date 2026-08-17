import { formatCurrency, TAX_RATE } from '@utils/currency'
import { useInvoice } from '../hooks/useInvoice'
import { z } from 'zod'

/** The total of one invoice, taxed and formatted for display. */
export function invoiceTotal(cents: number) {
  return formatCurrency(cents * (1 + TAX_RATE))
}

export const invoiceHook = useInvoice
export const schema = z
