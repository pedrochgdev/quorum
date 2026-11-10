// PayPal tools available to the merchant agent before it negotiates.
//
// In sandbox/live mode the tools run on PayPal's own remote MCP server
// (mcp.sandbox.paypal.com): Quorum is an MCP *client* here, and PayPal executes
// list_products, show_product_details, list_transactions, list_disputes and
// get_order. If the MCP server cannot be reached, the same tools fall back to
// PayPal's REST API. In mock mode they answer from Quorum's simulated ledger.
//
// Only read tools are exposed. The agent can look, never move money.
import { config } from '../config.ts';
import { all, get, run } from '../db.ts';
import type { AgentTool } from '../ai/llm.ts';
import type { Product } from '../models.ts';
import { connectPayPalMcp, type McpSseClient } from './mcp-client.ts';
import { paypalFetch } from './rest.ts';

export type MerchantToolkit = { tools: AgentTool[]; source: string; close: () => void };

const isMock = () => config.paypal.mode === 'mock';

const SCHEMAS = {
  show_product_details: { type: 'object', properties: { product_id: { type: 'string', description: 'PayPal catalog product id. Omit for the product being negotiated.' } }, required: [] },
  list_products: { type: 'object', properties: { page_size: { type: 'integer', description: '1-20' } }, required: [] },
  list_transactions: { type: 'object', properties: { days: { type: 'integer', description: 'How many days back, 1-31' } }, required: [] },
  list_disputes: { type: 'object', properties: {}, required: [] },
  get_order: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
};
const DESCRIPTIONS = {
  show_product_details: 'Show details of a product in the merchant PayPal catalog (Catalog Products API).',
  list_products: 'List products in the merchant PayPal catalog.',
  list_transactions: "List the merchant's recent PayPal transactions to understand current sales volume.",
  list_disputes: "List the merchant's open PayPal disputes (a signal of payment risk).",
  get_order: 'Get a PayPal order by id (Orders API), for example to confirm a buyer authorization exists.',
};

const dateRange = (days: number) => {
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400_000);
  return { start, end };
};
const clampDays = (d: unknown) => Math.min(31, Math.max(1, Math.floor(Number(d) || 30)));

const localProduct = (product: Product, source: string) => ({
  id: product.paypal_catalog_id ?? product.id,
  name: product.title,
  description: product.description,
  category: product.category,
  stock_on_hand: product.stock,
  source,
});

/** What Quorum itself has settled for this merchant (always available, in every mode). */
function quorumSales(product: Product, days: number) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const r = get<{ n: number; revenue: number }>(
    `SELECT COUNT(*) AS n, COALESCE(SUM(c.captured_amount - c.refunded_amount),0) AS revenue FROM commitments c
     JOIN quorums q ON q.id = c.quorum_id WHERE q.merchant_id = ? AND c.status = 'captured' AND c.updated_at >= ?`,
    product.merchant_id, since,
  )!;
  return { days, units_sold_through_quorum: r.n, revenue_through_quorum: r.revenue };
}

function simulatedTools(product: Product): AgentTool[] {
  return [
    { name: 'show_product_details', description: DESCRIPTIONS.show_product_details, input_schema: SCHEMAS.show_product_details, run: async () => localProduct(product, 'quorum-simulated-ledger') },
    {
      name: 'list_products', description: DESCRIPTIONS.list_products, input_schema: SCHEMAS.list_products,
      run: async () => all('SELECT id, title AS name, category, stock FROM products WHERE merchant_id = ? AND active = 1', product.merchant_id),
    },
    {
      name: 'list_transactions', description: DESCRIPTIONS.list_transactions, input_schema: SCHEMAS.list_transactions,
      run: async (input: { days?: number }) => ({ ...quorumSales(product, clampDays(input.days)), source: 'quorum-simulated-ledger' }),
    },
    {
      name: 'get_order', description: DESCRIPTIONS.get_order, input_schema: SCHEMAS.get_order,
      run: async (input: { id: string }) => get('SELECT id, status, amount FROM mock_paypal WHERE id = ?', input.id) ?? { error: 'not found' },
    },
  ];
}

function restTools(product: Product): AgentTool[] {
  return [
    {
      name: 'show_product_details', description: DESCRIPTIONS.show_product_details, input_schema: SCHEMAS.show_product_details,
      run: async (input: { product_id?: string }) => {
        const id = input.product_id || product.paypal_catalog_id;
        return id ? paypalFetch(`/v1/catalogs/products/${encodeURIComponent(id)}`) : localProduct(product, 'quorum-catalog');
      },
    },
    {
      name: 'list_products', description: DESCRIPTIONS.list_products, input_schema: SCHEMAS.list_products,
      run: async (input: { page_size?: number }) =>
        paypalFetch(`/v1/catalogs/products?page_size=${Math.min(20, Math.max(1, Math.floor(Number(input.page_size) || 10)))}&page=1&total_required=true`),
    },
    {
      name: 'list_transactions', description: DESCRIPTIONS.list_transactions, input_schema: SCHEMAS.list_transactions,
      run: async (input: { days?: number }) => {
        const days = clampDays(input.days);
        const { start, end } = dateRange(days);
        const q = new URLSearchParams({
          start_date: start.toISOString().replace(/\.\d+Z$/, '-0000'),
          end_date: end.toISOString().replace(/\.\d+Z$/, '-0000'),
          fields: 'transaction_info',
          page_size: '100',
        });
        const r = await paypalFetch<{ transaction_details?: unknown[]; total_items?: number }>(`/v1/reporting/transactions?${q}`);
        return { paypal_transactions: r.total_items ?? r.transaction_details?.length ?? 0, ...quorumSales(product, days) };
      },
    },
    {
      name: 'get_order', description: DESCRIPTIONS.get_order, input_schema: SCHEMAS.get_order,
      run: async (input: { id: string }) => paypalFetch(`/v2/checkout/orders/${encodeURIComponent(input.id)}`),
    },
  ];
}

/** The same tools, executed by PayPal's MCP server. */
function mcpTools(product: Product, mcp: McpSseClient, available: Set<string>): AgentTool[] {
  const tools: AgentTool[] = [
    {
      name: 'show_product_details', description: DESCRIPTIONS.show_product_details, input_schema: SCHEMAS.show_product_details,
      run: async (input: { product_id?: string }) => {
        const id = input.product_id || product.paypal_catalog_id;
        return id ? mcp.callTool('show_product_details', { product_id: id }) : localProduct(product, 'quorum-catalog');
      },
    },
    {
      name: 'list_products', description: DESCRIPTIONS.list_products, input_schema: SCHEMAS.list_products,
      run: async (input: { page_size?: number }) =>
        mcp.callTool('list_products', { page_size: Math.min(20, Math.max(1, Math.floor(Number(input.page_size) || 10))), total_required: true }),
    },
    {
      name: 'list_transactions', description: DESCRIPTIONS.list_transactions, input_schema: SCHEMAS.list_transactions,
      run: async (input: { days?: number }) => {
        const days = clampDays(input.days);
        const { start, end } = dateRange(days);
        const r = (await mcp.callTool('list_transactions', { start_date: start.toISOString(), end_date: end.toISOString() })) as any;
        const paypal = Array.isArray(r?.transaction_details)
          ? { paypal_transactions: r.total_items ?? r.transaction_details.length }
          : { paypal_transactions: 'unavailable', paypal_note: String(r?.message ?? r ?? '').slice(0, 160) };
        return { ...paypal, ...quorumSales(product, days) };
      },
    },
    {
      name: 'list_disputes', description: DESCRIPTIONS.list_disputes, input_schema: SCHEMAS.list_disputes,
      run: async () => {
        const r = (await mcp.callTool('list_disputes', {})) as any;
        return Array.isArray(r?.items) ? { open_disputes: r.items.length } : r;
      },
    },
    {
      name: 'get_order', description: DESCRIPTIONS.get_order, input_schema: SCHEMAS.get_order,
      run: async (input: { id: string }) => mcp.callTool('get_order', { id: String(input.id) }),
    },
  ];
  return tools.filter((t) => available.has(t.name));
}

/** Make sure the product exists in the merchant's PayPal catalog, so the agent's catalog tools return it. */
async function syncCatalogProduct(product: Product, mcp: McpSseClient | null): Promise<Product> {
  if (product.paypal_catalog_id) return product;
  const body = { name: product.title.slice(0, 127), type: 'PHYSICAL', description: (product.description || product.title).slice(0, 256) };
  try {
    const created = (mcp ? await mcp.callTool('create_product', body) : await paypalFetch('/v1/catalogs/products', { method: 'POST', body, requestId: `catalog-${product.id}` })) as any;
    if (typeof created?.id === 'string') {
      run('UPDATE products SET paypal_catalog_id = ? WHERE id = ?', created.id, product.id);
      return { ...product, paypal_catalog_id: created.id };
    }
  } catch (err) {
    console.warn('[paypal] catalog sync skipped:', (err as Error).message);
  }
  return product;
}

/** Open the merchant agent's toolkit. Always close() it when the negotiation ends. */
export async function openMerchantToolkit(product: Product): Promise<MerchantToolkit> {
  if (isMock()) return { tools: simulatedTools(product), source: 'Simulated PayPal ledger', close: () => {} };
  if (config.paypal.mcp) {
    try {
      const mcp = await connectPayPalMcp();
      const available = new Set((await mcp.listTools()).map((t) => t.name));
      const synced = available.has('create_product') ? await syncCatalogProduct(product, mcp) : product;
      return { tools: mcpTools(synced, mcp, available), source: 'PayPal MCP server', close: () => mcp.close() };
    } catch (err) {
      console.warn('[paypal] MCP server unavailable, using REST tools:', (err as Error).message);
    }
  }
  return { tools: restTools(await syncCatalogProduct(product, null)), source: 'PayPal REST API', close: () => {} };
}
