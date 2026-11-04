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
| 2. Group | **Intent agent** | Hard filters in code (price, category, deadline) plus similarity, then the LLM confirms the fit. The buyer joins an open group, a new group opens, or the request goes to the merchant **demand board**. |
| 3. Commit | Buyer + **PayPal** | Orders API with `intent: AUTHORIZE` at the list price (capped by the buyer's max). PayPal holds the funds; nothing is charged. |
| 4. Grow | **Growth agent** | Shows each member what one more person is worth ("2 more and everyone pays $169"), drafts the invite, tracks referrals. Optional referral rewards go out through the **Payouts API**. |
| 5. Negotiate | **Buyer agent vs merchant agent** | The merchant agent briefs itself with PayPal tools (catalog, transactions, orders), then the two agents trade offers. Every offer passes code-enforced limits: never below the merchant's private floor, never above the public tier price or what buyers authorized. |
| 6. Settle | **Settlement engine (no AI)** | Goal reached: each authorization is checked, reauthorized if past the 3-day honor period, and captured at the final price with `final_capture: true`. Goal missed: every authorization is voided. |

**Demand before supply.** Requests no product covers yet are clustered on the merchant console's demand board ("3 people want an electric standing desk under $300"). A merchant can create a product and open a group straight from that cluster, and the waiting requests that can afford it move in.

**Agent-to-agent.** Quorum is also an MCP server (`POST /mcp`), so an external assistant can add its user's intent to a group and hand back the approval link. Agents never move money: the person still approves the PayPal authorization.

## How it uses PayPal

| PayPal capability | Endpoint | Where |
| --- | --- | --- |
| Orders v2, two-step payments | `POST /v2/checkout/orders` (`intent: AUTHORIZE`), `POST /v2/checkout/orders/{id}/authorize` | `src/paypal/rest.ts`, `src/engine.ts` |
| Payments v2 | `GET /v2/payments/authorizations/{id}`, `…/capture` (partial, `final_capture`), `…/void`, `…/reauthorize`, `POST /v2/payments/captures/{id}/refund` | `src/engine.ts` |
| JavaScript SDK | PayPal Buttons with `intent=authorize` | `public/quorum.js` |
| Payouts v1 | `POST /v1/payments/payouts` for referral rewards | `src/engine.ts` |
| Webhooks | `verify-webhook-signature`; handles `PAYMENT.AUTHORIZATION.CREATED/VOIDED`, `PAYMENT.CAPTURE.COMPLETED/DENIED` | `src/paypal/webhooks.ts` |
| Agent tools (PayPal Agent Toolkit names and endpoints) | `show_product_details`, `list_products`, `list_transactions`, `get_order` | `src/paypal/merchant-tools.ts` |

Every capture, void and order carries a `PayPal-Request-Id`, so a retried settlement never charges twice. PayPal lets you [capture less than the authorized amount](https://developer.paypal.com/docs/checkout/standard/customize/authorization-honor/), which is what makes "authorize the list price, charge the group price" work without refunds. Authorized funds are guaranteed for 3 days (reauthorizable up to day 29), so groups default to 72 hours.

## How it uses AI

| Agent | Model call | Guardrail |
| --- | --- | --- |
| Intent agent | Structured extraction (forced tool call) + fit confirmation | Price, category and deadline filters run in code first |
| Buyer and merchant agents | One structured offer per turn; merchant runs a tool loop over PayPal tools first | `validateOffer()` rejects any price outside the floor/ceiling; rejected offers are shown and replaced; the engine clamps the result again |
| Growth agent | Drafts the invite | Template fallback; the link must be present verbatim |

Models: Anthropic Claude through the Messages API (`ANTHROPIC_MODEL`, default `claude-sonnet-5-5`; `ANTHROPIC_FAST_MODEL` for extraction). Embeddings: a local hashed n-gram embedding with an English/Spanish synonym map (no network), or OpenAI embeddings if `OPENAI_API_KEY` is set. Market data: [Channel3](https://docs.trychannel3.com) `POST /v1/search`, used to show buyers the market price and to give the buyer agent real alternatives. Without a Channel3 key, Quorum shows no market data instead of inventing it.

Untrusted text (buyer requests, product feeds, transcripts) is fenced in XML tags and the system prompts say to treat it as data. **The AI proposes; deterministic code moves the money.**

Without `ANTHROPIC_API_KEY`, every agent falls back to deterministic logic, so the whole product still runs (the UI shows "Rule-based agents").

## Run it

Requirements: **Node.js 22.18 or newer**. There are no dependencies: no `npm install`, no build step. Node runs the TypeScript directly and stores data with its built-in SQLite.

```bash
cp .env.example .env          # optional: add PayPal sandbox, Anthropic, Channel3 keys
npm run seed -- --reset       # demo merchants, products, 2 open groups, demand board
DEMO_ADMIN=true npm start     # http://localhost:3000
```

With no keys at all, Quorum runs in **simulation mode**: PayPal approval happens on a clearly labelled simulation page, and agents are rule-based. Add keys to switch each part to the real service:

| Variable | Effect |
| --- | --- |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | Real PayPal sandbox checkout (Buttons + REST). |
| `PAYPAL_WEBHOOK_ID` | Verifies webhooks sent to `/api/webhooks/paypal`. |
| `ANTHROPIC_API_KEY` | Claude-powered agents. |
| `CHANNEL3_API_KEY` | Live market prices (hackathon promo code `PAYPAL-HACKATHON-2026`). |
| `DEMO_ADMIN=true` | Shows "Add simulated buyer" and "Close group now" on group pages, for demos. |

The footer always shows which mode each service is in.

### Check the PayPal sandbox first

The whole model depends on capturing less than you authorized. Check it on your sandbox app:

```bash
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run sandbox:capture-test
```

It authorizes $200 and captures $170 (sandbox test card, or a PayPal-wallet approval link as fallback) and prints PASS or FAIL.

### Demo script (under 3 minutes)

1. Home: type a request, or click an example. The intent agent groups you ("4 people are looking for…").
2. Group page: commit with PayPal. The progress bar moves; nothing is charged.
3. "Draft my invite": the growth agent writes the message with your referral link. Add two simulated buyers.
4. "Close group now": watch the agents negotiate, then everyone is charged the final price ($199 authorized, $169 captured).
5. The expiring kettle group closes below its goal: all authorizations are voided.
6. Merchant console: the demand board shows clustered standing-desk requests; open a group from it.

## For judges

- **Hosted demo:** `BASE_URL` of the deployed instance (add after deploying).
- **Sandbox buyer accounts:** add the email and password of two sandbox personal accounts here before submitting, so you can approve a payment yourself.
- Or run locally with no keys (simulation mode), as shown above.

## Tests

```bash
npm test                  # unit tests: pricing, negotiation limits (2,000 randomized cases), parsing, PayPal rules, LLM paths with a stubbed API
npm run e2e:mock          # full cycle over HTTP in simulation mode, including MCP and the demand board
npm run e2e:paypal-stub   # full cycle through the real PayPal REST client against a local PayPal stub, including signed webhooks
npm run check             # all of the above
```

## Deploy (Render)

`render.yaml` defines the web service (with a 1 GB disk for SQLite) and a cron job that calls `POST /api/cron/settle` every 15 minutes. The web service also settles due groups in-process every `SETTLE_INTERVAL_SECONDS`. Set `BASE_URL`, the PayPal, Anthropic and Channel3 keys, and point the PayPal webhook to `https://<your-app>/api/webhooks/paypal`. Keep the service running until judging ends (December 15, 2026).

## Project structure

```
src/
  server.ts            HTTP server, pages, settlement loop
  api.ts               JSON API (intents, groups, checkout, merchant console, cron, webhooks)
  engine.ts            checkout + settlement: authorize, negotiate, capture or void (no AI)
  pricing.ts           volume tiers, authorization amounts, growth math
  mcp.ts               MCP server for external agents
  ai/intent.ts         intent agent: parse, filter, group, demand board
  ai/negotiate.ts      buyer and merchant agents with code-enforced limits
  ai/growth.ts         growth agent: invites, referral links, momentum tips
  ai/llm.ts            Anthropic Messages API: forced structured output, tool loop
  ai/embed.ts          local multilingual embeddings (or OpenAI)
  ai/catalog.ts        Channel3 market search
  paypal/rest.ts       PayPal REST client (Orders, Payments, Payouts, webhook verification)
  paypal/mock.ts       simulated PayPal ledger with the same rules
  paypal/merchant-tools.ts  PayPal tools for the merchant agent
  paypal/webhooks.ts   webhook verification and state sync
public/                styles and vanilla JS for the three pages
scripts/               seed, end-to-end checks, sandbox capture test
test/                  node:test unit tests
```

## Limits and next steps

- The merchant console has no login; set `MERCHANT_TOKEN` to require a token on its API.
- One currency per deployment (`CURRENCY`, default USD).
- Fulfilment and shipping are out of scope: Quorum ends when the merchant is paid.
- Agents and the PayPal SDK are wired for Claude and sandbox; production would add PayPal's partner flows so each merchant is paid into its own account.

## License

MIT. See [LICENSE](LICENSE).
