# Demo video script (2:50)

The rules ask for a video under three minutes, public on YouTube, showing the project working. Judges may score from the video alone, so every claim is shown on screen, including a real sandbox payment.

## Before recording

1. Use the deployed instance with all four services live (check the footer pills).
2. Reset the demo so the numbers match this script: `npm run seed -- --reset`, then reload.
3. Have one sandbox **personal** account ready, already logged in at sandbox.paypal.com in the same browser.
4. Open three tabs: home, the espresso group, the merchant console.
5. Record at 1920×1080, browser zoom 110%. No music, or music you have the rights to. Do not show other brands' logos beyond what the product itself displays.
6. Do one silent dry run of the PayPal approval first: the first popup on a new browser profile is slow.

## Script

| Time | On screen | Say |
| --- | --- | --- |
| 0:00–0:15 | Home page, cursor resting on the headline. | "Group buying keeps failing for one reason: coordinating strangers costs more than the discount. Quorum gives that work to AI agents, and uses PayPal so nobody pays unless the group actually forms." |
| 0:15–0:35 | Click the Spanish example ("Busco una cafetera…"), then "Find my group". The parsed chips and the explanation appear. | "I describe what I want, in English or Spanish. An intent agent on Claude extracts the product, my maximum price and my deadline, and finds people who want the same thing. Four are already waiting." |
| 0:35–1:05 | Open the group. Type the email, click the PayPal button, approve in the sandbox popup. Back on the page: "PayPal is holding $199", the progress bar moves to 5 of 5. | "I commit with PayPal. This is a real sandbox order with intent authorize: PayPal holds one hundred ninety-nine dollars and charges nothing. I can leave any time and the hold is released. The goal is reached." |
| 1:05–1:20 | Click "Draft my invite"; the message appears. Then click "Add simulated buyer" twice (7 members). | "A growth agent tells me what one more person is worth and writes the invite. Two more people join." |
| 1:20–2:00 | Click "Close group now". Let the briefing line show, then the bubbles arrive one by one. Hover a tool pill. End on the green banner. | "Now the group closes. The merchant's agent first reads its own PayPal account, through PayPal's MCP server. Then the two agents negotiate, live. Every offer passes rules written in code: never below the merchant's private floor, never above what buyers authorized. They agree, and PayPal captures less than it authorized from every buyer." |
| 2:00–2:15 | Scroll to "How this price was reached". Then click "Add late buyer (simulated)"; the price drops and the "back" pills appear. | "Every price is explained. And it can only get better: a late buyer reaches the next tier, the price drops, and PayPal refunds the difference to everyone already charged." |
| 2:15–2:35 | Merchant console. Click "Draft an offer with the pricing agent" on the standing-desk card; the form fills and the rationale shows market prices. | "Merchants see demand before they stock. Three people want a standing desk that nobody sells here. A pricing agent drafts the offer from what they would pay and live market prices from Channel3, and the merchant opens the group." |
| 2:35–2:50 | Home page, scroll to the "For AI assistants" strip showing the `/mcp` endpoint. End on the headline. | "Quorum is also an MCP server, so any assistant can join a group for its user, with a spending limit, while only the person approves the payment. Agents coordinate. PayPal holds the money. Quorum: buy together, pay only if the group forms." |

## If something goes wrong while recording

- **The PayPal popup is blocked:** allow popups for the site and click again; the order is created fresh each time.
- **The negotiation looks different from the script:** that is expected with live agents. The price always lands between the merchant's floor and the public tier, which is the point to make.
- **A service pill shows "off" or "simulated":** stop and fix the environment variable. Do not record a simulated payment as if it were PayPal.

## After recording

- Trim to under 3:00. Upload to YouTube as **Public**.
- Paste the link into the Devpost form and into `docs/DEVPOST.md` → "Try it out".
