# Devpost submission text

Copy each section into the matching field of the submission form. Replace the three placeholders in angle brackets before submitting.

---

## Project name

Quorum

## Tagline

Buy together. AI agents form the group and negotiate; PayPal holds each payment and charges only if the group forms.

## Inspiration

Group buying keeps being invented and keeps dying. Groupon's tipping point, Tilt and countless WhatsApp "who wants to split a pallet" threads all hit the same wall: coordinating strangers costs more than the discount is worth. Someone has to find the others, hold the money, chase the stragglers and haggle with the seller.

Two things changed. Agents make coordination nearly free: they can read scattered demand, group it, negotiate for it and grow it. And PayPal already has the payment primitive group buying always needed: an authorization that holds funds without charging, and can be captured for **less** than was authorized. Put together, a buyer can commit with zero risk and a merchant can negotiate with a group whose money is already guaranteed.

## What it does

1. **Describe.** You type what you want in English or Spanish: "cafetera espresso compacta, máximo $199". An intent agent turns it into a structured request and finds people who want the same thing.
2. **Commit without paying.** PayPal authorizes the list price. Nothing is charged. You can leave any time before the close and PayPal voids the hold.
3. **Grow.** A growth agent shows what one more person is worth ("2 more and everyone pays $169") and drafts the invite.
4. **Negotiate, live.** When the group reaches its goal, the merchant's agent reads its own PayPal account through PayPal's MCP server, then a buyer agent and the merchant agent trade offers on screen. Code rejects any offer below the merchant's private floor or above what buyers authorized.
5. **Settle.** Each authorization is captured at the final price, below what the buyer authorized. If the group never forms, every authorization is voided.
6. **Keep improving.** The closed group stays joinable. If late buyers reach a cheaper tier, the price drops and PayPal refunds the difference to everyone already charged.

For merchants, requests no product covers yet are clustered on a **demand board**. A pricing agent drafts the offer for a cluster from what buyers said they would pay and live market prices, and the merchant opens the group in one click: demand before supply.

For other agents, Quorum is an **MCP server**. An assistant can find a group for its user, start the PayPal authorization with a spending limit, confirm it, check it and leave. Only the person can approve the payment.

Every group page explains **how its price was reached**: list price, public tier, negotiated price, the ceiling set by the lowest authorization, the cheapest comparable market offer, and how many offers the rules rejected.

## How we built it

- **PayPal.** Orders v2 with `intent: AUTHORIZE` and the JavaScript SDK buttons for checkout; Payments v2 to check, reauthorize, partially capture (`final_capture`), void and refund; Payouts for referral rewards; signed webhooks to keep state in sync. Every write carries a `PayPal-Request-Id`, so a retried settlement never charges or refunds twice.
- **PayPal MCP server.** Quorum is an MCP client of `mcp.sandbox.paypal.com`. The merchant agent's tools (`list_products`, `show_product_details`, `list_transactions`, `list_disputes`, `get_order`) run there, and products are synced to the PayPal catalog with `create_product`. The client is about 170 lines of TypeScript with no dependencies.
- **Agents.** Four agents on Claude through the Anthropic Messages API: intent, negotiation (buyer and merchant), pricing and growth. Every answer that touches a price is structured JSON validated by code.
- **Channel3.** Live market prices show buyers the alternatives, give the buyer agent real leverage, and feed the pricing agent.
- **Stack.** Node.js running TypeScript directly, built-in SQLite, vanilla JS, Server-Sent Events. No runtime dependencies, no build step. Deployed on Render.

## How we used AI

- **Claude Sonnet 5.5** (`claude-sonnet-5-5`): the buyer and merchant negotiation agents (one structured offer per turn), the merchant's tool loop over PayPal's MCP tools, and the merchant pricing agent.
- **Claude Haiku 5.5** (`claude-haiku-5-5`): intent extraction from free text, confirming a product fits a request, and drafting invites.
- **Local multilingual embeddings** (hashed n-grams with an English/Spanish synonym map) to group similar requests without a network call.
- **Claude Code** was used as a coding assistant while building the project.

The rule throughout: **the AI proposes, deterministic code moves the money.** Prices from a model pass `validateOffer()` and are clamped again by the settlement engine; the pricing agent's draft passes `repairDraft()`; untrusted text is fenced and treated as data. With no AI key the whole product still runs on rule-based agents.

## Challenges we ran into

- **Making "pay less than you authorized" the core mechanic.** The model only works because PayPal allows a final capture below the authorized amount. We built a sandbox test for exactly that before anything else, plus a full PayPal stub to check every request the client sends.
- **Letting agents near money safely.** A model that hallucinates a price must not be able to charge it. Limits live in code, rejected offers are shown in the transcript, and the engine that captures has no AI in it.
- **Honor periods.** Authorized funds are guaranteed for 3 days, so groups default to 72 hours and longer ones are reauthorized.
- **Refunding fairly.** When late buyers reach a cheaper tier, the price falls by as much as the public price fell, never below the merchant's floor, and the buyer who triggers the drop is charged the new price directly instead of being charged and refunded.

## Accomplishments that we're proud of

- A negotiation between two agents that you can watch live, where the merchant's agent prepares by reading PayPal through PayPal's own MCP server.
- Being both an MCP client (of PayPal) and an MCP server (for any assistant) in a project with zero runtime dependencies.
- A demand board that turns "nobody sells this yet" into a priced, ready-to-open group.
- 31 unit tests and two end-to-end suites, including 2,000 randomized negotiations that never leave the allowed price range.

## What we learned

Authorize-then-capture is an underused primitive: it turns commitment into something a seller can trust and a buyer can walk away from. And agents are most useful where the work is coordination, not judgment: grouping, inviting, haggling inside limits a person set.

## What's next for Quorum

- PayPal partner flows so each merchant is paid into its own account (the order already supports naming the merchant as payee).
- Shipment tracking after the close, using PayPal's tracking tools.
- Recurring groups for things people rebuy.
- Local currencies and more languages, starting with Latin America.

## Built with

`paypal` `paypal-orders-api` `paypal-payments-api` `paypal-payouts` `paypal-mcp-server` `paypal-js-sdk` `webhooks` `claude` `anthropic` `model-context-protocol` `channel3` `node.js` `typescript` `sqlite` `server-sent-events` `render`

## Try it out

- Hosted demo: `<https://your-app.onrender.com>`
- Source: https://github.com/webiwabou/quorum
- Demo video: `<https://youtu.be/...>`

## Testing instructions for judges

1. Open the hosted demo. The footer shows which services are live (PayPal sandbox, Claude, Channel3, PayPal MCP server).
2. On the home page, click an example request and "Find my group". Open the group.
3. Enter any email and pay with PayPal using this sandbox buyer account: `<email>` / `<password>`. Nothing is charged: PayPal holds the amount.
4. Under "Demo controls", add two simulated buyers and press "Close group now". Watch the agents negotiate, then see what you were charged.
5. Press "Add late buyer (simulated)" to see the price drop and the refund.
6. Open "Merchant console" and press "Draft an offer with the pricing agent" on the standing-desk demand.
7. Optional: connect an assistant to `<https://your-app.onrender.com>/mcp` and ask it to find and join a group.

Without credentials, clone the repository and run `npm run seed -- --reset && npm start`: the same flow works in a clearly labelled simulation mode.
