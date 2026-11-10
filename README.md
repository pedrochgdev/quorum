# Quorum

**Buy together. Pay only if the group forms.**

Quorum is group buying run by AI agents. You describe what you want in your own words. An intent agent finds people who want the same thing. PayPal **authorizes** each buyer's payment without charging it. When the group reaches its goal, a buyer agent negotiates a volume price with the merchant's agent, and Quorum **captures** each payment at the final price, which is never more than what the buyer authorized. If the group doesn't form, every authorization is **voided** and nobody is charged.

Group buying (Groupon's tipping point, Tilt, Pinduoduo) kept dying because coordinating strangers was expensive. Agents make that coordination nearly free: they read scattered demand, group it, negotiate for it, and grow it.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com).

---

## What it does

| Step | Who | What happens |
| --- | --- | --- |
| 1. Describe | Buyer + **intent agent** | Free text in English or Spanish ("cafetera espresso compacta, máximo $199") becomes a structured intent: category, requirements, max price, deadline. |
| 2. Group | **Intent agent** | Hard filters in code (price, category, deadline) plus similarity, then the model confirms the fit. The buyer joins an open group, a new group opens, or the request goes to the merchant **demand board**. |
| 3. Commit | Buyer + **PayPal** | Orders API with `intent: AUTHORIZE` at the list price (capped by the buyer's max). PayPal holds the funds; nothing is charged. The buyer can leave any time before the close: PayPal voids the hold. |
| 4. Grow | **Growth agent** | Shows each member what one more person is worth ("2 more and everyone pays $169"), drafts the invite in the buyer's language, tracks referrals. Optional referral rewards go out through the **Payouts API**. |
| 5. Negotiate | **Buyer agent vs merchant agent** | The merchant agent first reads its own PayPal account through **PayPal's MCP server**, then the two agents trade offers, shown live turn by turn. Every offer passes code-enforced limits: never below the merchant's private floor, never above the public tier price or what buyers authorized. |
| 6. Settle | **Settlement engine (no AI)** | Goal reached: each authorization is checked, reauthorized if past the 3-day honor period, and captured at the final price with `final_capture: true`. Goal missed: every authorization is voided. |
| 7. Keep improving | **Settlement engine + PayPal refunds** | A closed group stays joinable at the final price. If late buyers push it into a cheaper tier, the price falls by as much as the public price fell (never below the merchant's floor) and PayPal **refunds the difference** to everyone already charged. |

**Demand before supply.** Requests no product covers yet are clustered on the merchant console's demand board ("3 people want an electric standing desk under $300"). A **pricing agent** drafts the offer for that cluster from what buyers said they would pay and live comparable prices; code repairs the draft so it always obeys the pricing rules; the merchant reviews it and opens the group. The waiting requests that can afford it move in and are notified.

**Agent-to-agent.** Quorum is also an MCP server (`POST /mcp`). An external assistant can run the whole buyer flow for its user: find a group, start the PayPal authorization with a spending limit, confirm it, check it, and leave. Agents never move money on their own: the person still approves the PayPal authorization.

**Every price is explained.** Each group page shows how the price was reached: list price, public tier, negotiated price, the lowest authorization in the group (the ceiling), the cheapest comparable market offer, how many offers the rules rejected, and any refunds. The merchant's floor stays private.

## How it uses PayPal

| PayPal capability | Endpoint | Where |
| --- | --- | --- |
| Orders v2, two-step payments | `POST /v2/checkout/orders` (`intent: AUTHORIZE`), `POST /v2/checkout/orders/{id}/authorize` | `src/paypal/rest.ts`, `src/engine.ts` |
| Payments v2 | `GET /v2/payments/authorizations/{id}`, `…/capture` (partial, `final_capture`), `…/void`, `…/reauthorize`, `POST /v2/payments/captures/{id}/refund` | `src/engine.ts` |
| JavaScript SDK | PayPal Buttons with `intent=authorize` | `public/quorum.js` |
| **PayPal MCP server** (remote, `mcp.sandbox.paypal.com`) | `list_products`, `show_product_details`, `list_transactions`, `list_disputes`, `get_order`, `create_product` | `src/paypal/mcp-client.ts`, `src/paypal/merchant-tools.ts` |
| Catalog Products v1 | `POST /v1/catalogs/products` (through the MCP server, REST as fallback) | `src/paypal/merchant-tools.ts` |
| Payouts v1 | `POST /v1/payments/payouts` for referral rewards | `src/engine.ts` |
| Webhooks | `verify-webhook-signature`; handles `PAYMENT.AUTHORIZATION.CREATED/VOIDED`, `PAYMENT.CAPTURE.COMPLETED/DENIED/REFUNDED` | `src/paypal/webhooks.ts` |

Quorum is an MCP **client** of PayPal and an MCP **server** for other agents. The client is about 170 lines with no dependencies (HTTP + SSE transport). Only read tools and catalog sync are exposed to the merchant agent: it can look, never move money.

Every capture, void, refund and order carries a `PayPal-Request-Id`, so a retried settlement never charges or refunds twice. PayPal lets you [capture less than the authorized amount](https://developer.paypal.com/docs/checkout/standard/customize/authorization-honor/), which is what makes "authorize the list price, charge the group price" work without refunds. Authorized funds are guaranteed for 3 days (reauthorizable up to day 29), so groups default to 72 hours.

## How it uses AI

| Agent | Model call | Guardrail |
| --- | --- | --- |
| Intent agent | Structured extraction + fit confirmation (JSON schema output) | Price, category and deadline filters run in code first |
| Buyer and merchant agents | One structured offer per turn; the merchant runs a tool loop over PayPal's MCP tools first | `validateOffer()` rejects any price outside the floor/ceiling; rejected offers are shown and replaced; the engine clamps the result again |
| Pricing agent | Drafts list price, tiers and a suggested floor from demand + market data | `repairDraft()` forces the rules: goal reachable by waiting demand, goal price within buyers' median maximum, tiers fall with volume, floor at or below the cheapest tier |
| Growth agent | Drafts the invite, in English or Spanish | Template fallback; the link must be present verbatim |

Models: Anthropic Claude through the Messages API (`ANTHROPIC_MODEL`, default `claude-sonnet-5-5`, for negotiation and pricing; `ANTHROPIC_FAST_MODEL`, default `claude-haiku-5-5`, for extraction, fit and invites). Embeddings: a local hashed n-gram embedding with an English/Spanish synonym map (no network), or OpenAI embeddings if `OPENAI_API_KEY` is set. Market data: [Channel3](https://docs.trychannel3.com) `POST /v1/search`, filtered to offers in the product's own price class; it shows buyers the market, gives the buyer agent real leverage, and feeds the pricing agent. Without a Channel3 key, Quorum shows no market data instead of inventing it.

Untrusted text (buyer requests, product feeds, transcripts, tool output) is fenced in XML tags and the system prompts say to treat it as data. **The AI proposes; deterministic code moves the money.**

Without `ANTHROPIC_API_KEY`, every agent falls back to deterministic logic, so the whole product still runs (the UI shows "Rule-based agents").

## Run it

Requirements: **Node.js 22.18 or newer**. The app has no runtime dependencies: no `npm install`, no build step. Node runs the TypeScript directly and stores data with its built-in SQLite. (`npm install` is only needed for `npm run typecheck`.)

```bash
cp .env.example .env          # optional: add PayPal sandbox, Anthropic, Channel3 keys
npm run seed -- --reset       # demo merchants, products, 2 open groups, demand board
npm start                     # http://localhost:3000
```

With no keys at all, Quorum runs in **simulation mode**: PayPal approval happens on a clearly labelled simulation page, and agents are rule-based. Add keys to switch each part to the real service:

| Variable | Effect |
| --- | --- |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Real PayPal sandbox checkout (Buttons + REST) and PayPal MCP tools for the merchant agent. |
| `PAYPAL_WEBHOOK_ID` | Verifies webhooks sent to `/api/webhooks/paypal`. |
| `ANTHROPIC_API_KEY` | Claude-powered agents. |
| `CHANNEL3_API_KEY` | Live market prices (hackathon promo code `PAYPAL-HACKATHON-2026`). |
| `RESEND_API_KEY` | Emails buyer notifications. Without it they are only recorded in the outbox. |
| `DEMO_ADMIN=true` | Shows "Add simulated buyer" and "Close group now" on group pages, for demos. |
| `LATE_JOIN_HOURS` | How long a closed group stays joinable (default 24, 0 disables). |
| `PAYPAL_PAYEE_ROUTING=true` | Names each merchant's own PayPal account as the payee. See Limits. |

The footer always shows which mode each service is in. The full list is in `.env.example`.

### Check your PayPal sandbox app

```bash
npm run paypal:check         # credentials, an AUTHORIZE order, catalog, webhooks, PayPal MCP server (no browser)
npm run sandbox:live-test    # real sandbox: authorize $200 → capture $170 → refund $5; authorize → void
npm run e2e:sandbox          # the whole app against the real sandbox: join, leave, close, late join + refund
```

The last two need Chrome and no person: a real browser pays as a guest with a freshly generated sandbox test card, and every result is checked both in Quorum and directly at PayPal. If PayPal changes its checkout page and the automation stops working, `npm run sandbox:capture-test` prints a link you approve by hand instead.

### Demo script (under 3 minutes)

1. Home: type a request, or click an example. The intent agent groups you ("5 people are looking for…"). Switch to Spanish with the ES button.
2. Group page: commit with PayPal. In sandbox mode the page shows a test card: click PayPal, choose "Pay with debit or credit card" in its window and paste it. The progress bar moves; nothing is charged. "Leave the group" releases the hold.
3. "Draft my invite": the growth agent writes the message with your referral link. Add two simulated buyers.
4. "Close group now": the merchant agent reads its PayPal account through PayPal's MCP server, then the agents negotiate live. Everyone is charged the final price ($199 authorized, about $165 captured). "How this price was reached" explains it.
5. "Add late buyer": the eighth buyer reaches the next tier, the price drops, and everyone already charged is refunded the difference.
6. The expiring kettle group closes below its goal: all authorizations are voided.
7. Merchant console: the demand board shows clustered standing-desk requests. "Draft an offer with the pricing agent", then open the group.

## For judges

- **Hosted demo:** `BASE_URL` of the deployed instance (add after deploying).
- **Paying in the sandbox needs no account:** on a group page click the PayPal button, choose "Pay with debit or credit card" in PayPal's window and use the test card the page shows (expiry 12/30, CVV 123, any name and address). A sandbox personal account works too.
- Or run locally with no keys (simulation mode), as shown above.
- **Connect an assistant:** add `https://<hosted-demo>/mcp` as an MCP server (Streamable HTTP) and ask it to "find a group for a compact espresso machine under $200 and join for me".

## Submission material

- [`docs/DEVPOST.md`](docs/DEVPOST.md): the text for each field of the Devpost form, including the AI tools statement and testing instructions.
- [`docs/DEMO_VIDEO.md`](docs/DEMO_VIDEO.md): the shot-by-shot script for the demo video. `npm run demo:record` records it automatically (real Chrome, captions, MP4 in `out/`).

## Tests

```bash
npm test                  # 33 unit tests: pricing, negotiation limits (2,000 randomized cases), parsing, PayPal rules,
                          # leaving a group, late joins and price-drop refunds, pricing-agent repair, the MCP client, LLM paths with a stubbed API
npm run i18n:check        # every interface string has a Spanish translation
npm run e2e:mock          # full cycle over HTTP in simulation mode: checkout, live stream, close, late join + refunds, leave, demand board, MCP agent flow
npm run e2e:paypal-stub   # full cycle through the real PayPal REST client against a local PayPal stub, including signed webhooks
npm run e2e:browser       # a real Chrome clicks through the product: checkout window, live negotiation, refund, leaving, pricing agent, Spanish
npm run check             # all of the above (no keys, no network)
npm run e2e:sandbox       # the app against the REAL PayPal sandbox (needs sandbox keys and Chrome)
npm run typecheck         # tsc (needs npm install)
```

## Deploy (Render)

`render.yaml` defines the web service (with a 1 GB disk for SQLite) and a cron job that calls `POST /api/cron/settle` every 15 minutes. The web service also settles due groups in-process every `SETTLE_INTERVAL_SECONDS`.

1. Create the blueprint from this repository and set `BASE_URL`, the PayPal, Anthropic and Channel3 keys.
2. Nothing to seed: with `DEMO_AUTO_RESET=true` (set in the blueprint) the service seeds the demo on first start, and puts it back to the starting state whenever it is used up or expired and nobody has touched it for 45 minutes. A reset never happens while PayPal is holding a real buyer's authorization.
3. Register the webhook and save the id it prints as `PAYPAL_WEBHOOK_ID`:
   ```bash
   npm run paypal:webhook -- https://<your-app>.onrender.com
   ```
4. Check that real PayPal webhooks arrive and verify. This makes one sandbox payment from your machine and asks the deployed app what it received:
   ```bash
   npm run paypal:webhook-test -- https://<your-app>.onrender.com
   ```
5. Keep the service running until judging ends (December 15, 2026).

## Project structure

```
src/
  server.ts            HTTP server, pages, settlement loop
  api.ts               JSON API (intents, groups, checkout, live stream, merchant console, cron, webhooks)
  engine.ts            checkout + settlement: authorize, negotiate, capture or void, leave, late join, price-drop refunds (no AI)
  pricing.ts           volume tiers, authorization amounts, growth math
  live.ts              in-process pub/sub behind the Server-Sent Events stream
  notify.ts            buyer notifications: outbox + optional email
  mcp.ts               Quorum as an MCP server for external agents
  ai/intent.ts         intent agent: parse, filter, group, demand board
  ai/negotiate.ts      buyer and merchant agents with code-enforced limits
  ai/offer.ts          pricing agent for merchants, with code-enforced repair
  ai/growth.ts         growth agent: invites, referral links, momentum tips
  ai/llm.ts            Anthropic Messages API: structured outputs, tool loop
  ai/embed.ts          local multilingual embeddings (or OpenAI)
  ai/catalog.ts        Channel3 market search and comparable-offer filter
  paypal/rest.ts       PayPal REST client (Orders, Payments, Payouts, webhook verification)
  paypal/mcp-client.ts MCP client for PayPal's remote MCP server (HTTP + SSE)
  paypal/merchant-tools.ts  the merchant agent's PayPal tools: MCP server, REST fallback, simulated ledger
  paypal/mock.ts       simulated PayPal ledger with the same rules
  paypal/webhooks.ts   webhook verification and state sync
public/                styles, i18n (English/Spanish) and vanilla JS for the three pages
scripts/               seed, end-to-end checks (API, browser, real sandbox), PayPal checks, webhook registration
scripts/lib/           a small Chrome DevTools driver and the sandbox guest-checkout helper (no dependencies)
test/                  node:test unit tests
```

## Limits and next steps

- Verified against the real PayPal sandbox (`npm run e2e:sandbox`, `npm run sandbox:live-test`): order creation with `intent: AUTHORIZE`, approval through the redirect and through the PayPal Buttons, authorization, partial final capture, idempotent retries, void, partial refund, a Payouts batch, the Catalog Products API and the PayPal MCP server. Webhook signature verification is tested against a local stub only: PayPal can only deliver webhooks to a public URL, so register it after deploying (`npm run paypal:webhook`) and confirm it with `npm run paypal:webhook-test`.
- By default every payment settles in the platform's PayPal account. `PAYPAL_PAYEE_ROUTING=true` names each merchant's account as the payee of its orders. PayPal accepts those orders, but paying and capturing them needs the payee to be a real business account that granted the platform permission, so it stays off until checked with a second sandbox business account. Production would use PayPal's partner flows.
- The merchant agent's `list_transactions` tool needs "Transaction search" enabled on the PayPal app; without it the agent is told the data is unavailable and uses Quorum's own sales figures.
- The merchant console has no login; set `MERCHANT_TOKEN` to require a token on its API.
- One currency per deployment (`CURRENCY`, default USD).
- The interface is in English and Spanish. The agents negotiate in English.
- Fulfilment and shipping are out of scope: Quorum ends when the merchant is paid.

## License

MIT. See [LICENSE](LICENSE).
