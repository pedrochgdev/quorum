// PayPal tools available to the merchant agent during negotiation.
// Names, descriptions and endpoints follow the PayPal Agent Toolkit
// (github.com/paypal/agent-toolkit): show_product_details, list_products,
// list_transactions, get_order. In sandbox/live mode they call PayPal's REST
// API; in mock mode they answer from Quorum's own ledger.
import { config } from '../config.ts';
import { all, get } from '../db.ts';
import type { AgentTool } from '../ai/llm.ts';
import type { Product } from '../models.ts';
import { paypalFetch } from './rest.ts';

const isMock = () => config.paypal.mode === 'mock';

export function merchantTools(product: Product): AgentTool[] {
  return [
    {
      name: 'show_product_details',
      description: 'Show details of a product in the PayPal catalog (Catalog Products API).',
      input_schema: { type: 'object', properties: { product_id: { type: 'string' } }, required: [] },
      run: async (input: { product_id?: string }) => {
        const id = input.product_id || product.paypal_catalog_id;
        if (!isMock() && id) return paypalFetch(`/v1/catalogs/products/${encodeURIComponent(id)}`);
        return {
          id: product.paypal_catalog_id ?? product.id,
          name: product.title,
          description: product.description,
          category: product.category,
          stock_on_hand: product.stock,
          source: isMock() ? 'quorum-simulated-ledger' : 'quorum-catalog',
        };
      },
    },
    {
      name: 'list_products',
      description: 'List products in the merchant PayPal catalog.',
      input_schema: { type: 'object', properties: { page_size: { type: 'integer' } }, required: [] },
      run: async (input: { page_size?: number }) => {
        if (!isMock()) return paypalFetch(`/v1/catalogs/products?page_size=${Math.min(20, input.page_size ?? 10)}&page=1&total_required=true`);
        return all('SELECT id, title AS name, category, stock FROM products WHERE merchant_id = ? AND active = 1', product.merchant_id);
      },
    },
    {
      name: 'list_transactions',
      description: 'List the merchant\'s recent transactions (Transaction Search API) to understand current sales volume.',
      input_schema: { type: 'object', properties: { days: { type: 'integer', minimum: 1, maximum: 31 } }, required: [] },
      run: async (input: { days?: number }) => {
        const days = Math.min(31, Math.max(1, input.days ?? 30));
        if (!isMock()) {
          const end = new Date();
          const start = new Date(end.getTime() - days * 86400_000);
          const q = new URLSearchParams({
            start_date: start.toISOString().replace(/\.\d+Z$/, '-0000'),
            end_date: end.toISOString().replace(/\.\d+Z$/, '-0000'),
            fields: 'transaction_info',
            page_size: '100',
          });
          const r = await paypalFetch<{ transaction_details?: unknown[]; total_items?: number }>(`/v1/reporting/transactions?${q}`);
          return { days, total_items: r.total_items ?? r.transaction_details?.length ?? 0 };
        }
        const since = new Date(Date.now() - days * 86400_000).toISOString();
        const r = get<{ n: number; revenue: number }>(
          `SELECT COUNT(*) AS n, COALESCE(SUM(c.captured_amount),0) AS revenue FROM commitments c
           JOIN quorums q ON q.id = c.quorum_id WHERE q.merchant_id = ? AND c.status = 'captured' AND c.updated_at >= ?`,
          product.merchant_id, since,
        )!;
        return { days, units_sold: r.n, revenue: r.revenue, source: 'quorum-simulated-ledger' };
      },
    },
    {
      name: 'get_order',
      description: 'Get a PayPal order by id (Orders API), e.g. to confirm a buyer authorization exists.',
      input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: async (input: { id: string }) => {
        if (!isMock()) return paypalFetch(`/v2/checkout/orders/${encodeURIComponent(input.id)}`);
        return get('SELECT id, status, amount FROM mock_paypal WHERE id = ?', input.id) ?? { error: 'not found' };
      },
    },
  ];
}
