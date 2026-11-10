// Interface language: English or Spanish. Strings are keyed by their English
// text, so untranslated strings fall back to English instead of breaking.
// `npm run i18n:check` fails when a string has no Spanish entry.
(function () {
  const ES = {
    // Layout
    'Start a group': 'Iniciar un grupo',
    'Open groups': 'Grupos abiertos',
    'Merchant console': 'Consola del comercio',
    'Quorum · built for the PayPal AI Hackathon': 'Quorum · creado para el PayPal AI Hackathon',
    'Loading…': 'Cargando…',
    'Loading group…': 'Cargando grupo…',
    'Loading console…': 'Cargando consola…',

    // Home
    'Group buying, run by agents': 'Compras en grupo, a cargo de agentes',
    'Buy together.<br>Pay only if the group forms.': 'Compra en grupo.<br>Paga solo si el grupo se forma.',
    'Tell Quorum what you want. An AI agent finds people who want the same thing, PayPal holds your payment without charging it, and an agent negotiates a volume price for the whole group. No group, no charge.':
      'Dile a Quorum qué quieres. Un agente de IA encuentra a quienes quieren lo mismo, PayPal retiene tu pago sin cobrarlo y un agente negocia un precio por volumen para todo el grupo. Sin grupo, no hay cobro.',
    'PayPal authorizes, never charges, until the group forms': 'PayPal autoriza y no cobra hasta que el grupo se forma',
    'You never pay more than you authorized': 'Nunca pagas más de lo que autorizaste',
    'Leave any time before the group closes': 'Puedes salir cuando quieras antes del cierre',
    'What do you want to buy?': '¿Qué quieres comprar?',
    'A compact espresso machine for two, under $200, before December': 'Una cafetera espresso compacta para dos, máximo $200, antes de diciembre',
    Email: 'Correo',
    '(optional, to hear when your group closes)': '(opcional, para avisarte cuando cierre tu grupo)',
    'Find my group': 'Buscar mi grupo',
    'Describe it': 'Descríbelo',
    'In your own words, in English or Spanish. The intent agent extracts what you need, your max price and your deadline.':
      'Con tus palabras, en español o inglés. El agente de intención extrae lo que necesitas, tu precio máximo y tu plazo.',
    'Commit without paying': 'Comprométete sin pagar',
    'PayPal authorizes the list price. Nothing is charged. Each new member lowers the price for everyone.':
      'PayPal autoriza el precio de lista. No se cobra nada. Cada persona nueva baja el precio para todos.',
    'Agents close the deal': 'Los agentes cierran el trato',
    "When the group forms, a buyer agent negotiates with the merchant's agent. You pay the final group price, never more than you authorized.":
      'Cuando el grupo se forma, un agente comprador negocia con el agente del comercio. Pagas el precio final del grupo, nunca más de lo que autorizaste.',
    'The price can only get better': 'El precio solo puede mejorar',
    'Late buyers can still join. If they unlock a cheaper tier, PayPal refunds the difference to everyone already charged.':
      'Todavía pueden entrar compradores tardíos. Si alcanzan un precio menor, PayPal devuelve la diferencia a quienes ya pagaron.',
    'Join one directly, or describe what you want above.': 'Únete a uno directamente o describe arriba lo que quieres.',
    'For AI assistants': 'Para asistentes de IA',
    'Your assistant can buy with a group': 'Tu asistente puede comprar en grupo',
    'Quorum is an MCP server. An assistant can find a group, start the PayPal authorization with a spending limit, check it and leave. Only you can approve the payment.':
      'Quorum es un servidor MCP. Un asistente puede encontrar un grupo, iniciar la autorización de PayPal con un límite de gasto, consultarla y salir. Solo tú puedes aprobar el pago.',
    'Reading your request…': 'Leyendo tu pedido…',
    'max {price}': 'máx. {price}',
    'by {date}': 'para el {date}',
    'Read by the intent agent (Claude)': 'Leído por el agente de intención (Claude)',
    'Read by rules': 'Leído con reglas',
    'We opened a new group for you': 'Abrimos un grupo nuevo para ti',
    'We found your group': 'Encontramos tu grupo',
    'See the group and commit': 'Ver el grupo y comprometerme',
    "You're on the demand board": 'Estás en el tablero de demanda',
    'Merchants see requests like yours grouped together and can open a group for them.':
      'Los comercios ven pedidos como el tuyo agrupados y pueden abrir un grupo para ellos.',
    'No groups yet. Describe what you want above to start one.': 'Aún no hay grupos. Describe arriba lo que quieres para iniciar uno.',
    'Still joinable': 'Aún puedes entrar',
    '{n} of {goal} committed': '{n} de {goal} comprometidos',
    'Could not load groups: {error}': 'No se pudieron cargar los grupos: {error}',

    // Shared
    'closing…': 'cerrando…',
    Open: 'Abierto',
    Negotiating: 'Negociando',
    Settling: 'Cobrando',
    'Closed · paid': 'Cerrado · pagado',
    'Did not form': 'No se formó',
    '{n} buyers': '{n} compradores',
    '{n} buyers committed': '{n} compradores comprometidos',

    // Group page
    'Group not found': 'Grupo no encontrado',
    'Back to start': 'Volver al inicio',
    'Buyer agent': 'Agente comprador',
    '{merchant} agent': 'Agente de {merchant}',
    'Checked first on {source}:': 'Antes consultó en {source}:',
    'Buyer agent is writing…': 'El agente comprador está escribiendo…',
    '{merchant} agent is writing…': 'El agente de {merchant} está escribiendo…',
    '{merchant} agent is reading its PayPal account before negotiating…': 'El agente de {merchant} está revisando su cuenta de PayPal antes de negociar…',
    Negotiation: 'Negociación',
    "When the group closes with at least {n} buyers, the buyer agent negotiates with the merchant agent. Every offer passes Quorum's rules: never below the merchant's floor, never above what buyers authorized.":
      'Cuando el grupo cierra con al menos {n} compradores, el agente comprador negocia con el agente del comercio. Cada oferta pasa por las reglas de Quorum: nunca por debajo del piso del comercio, nunca por encima de lo que los compradores autorizaron.',
    'Claude agents': 'Agentes Claude',
    'Rule-based agents': 'Agentes con reglas',
    Live: 'En vivo',
    'List price, buying alone': 'Precio de lista, comprando solo',
    'Public group price for {n} buyers': 'Precio público del grupo para {n} compradores',
    'Public group price once {n} commit': 'Precio público del grupo cuando se comprometan {n}',
    'Negotiated by the agents': 'Negociado por los agentes',
    'After late buyers unlocked a cheaper tier': 'Después de que compradores tardíos alcanzaron un precio menor',
    'Ceiling: the lowest PayPal authorization in the group is {amount}. No one can be charged more than they authorized.':
      'Techo: la autorización de PayPal más baja del grupo es {amount}. A nadie se le puede cobrar más de lo que autorizó.',
    "Floor: the merchant's lowest acceptable price is private. Code rejects any offer below it; {n} offers were rejected in this negotiation.":
      'Piso: el precio mínimo que acepta el comercio es privado. El código rechaza cualquier oferta por debajo; en esta negociación se rechazaron {n} ofertas.',
    "Floor: the merchant's lowest acceptable price is private. Code rejects any offer below it.":
      'Piso: el precio mínimo que acepta el comercio es privado. El código rechaza cualquier oferta por debajo.',
    'Market: the cheapest comparable offer found is {price} at {shop} (Channel3). The buyer agent uses it as leverage.':
      'Mercado: la oferta comparable más barata es {price} en {shop} (Channel3). El agente comprador la usa para negociar.',
    'Refunds: {amount} went back to earlier buyers through PayPal when the price dropped.':
      'Reembolsos: {amount} volvieron a los primeros compradores por PayPal cuando el precio bajó.',
    'Result: each buyer saved {amount} ({pct}%) against the list price.': 'Resultado: cada comprador ahorró {amount} ({pct}%) frente al precio de lista.',
    'How this price was reached': 'Cómo se llegó a este precio',
    'How the price is decided': 'Cómo se decide el precio',
    'Final price': 'Precio final',
    'Group price now, before negotiation': 'Precio del grupo ahora, antes de negociar',
    'Group price once {n} commit': 'Precio del grupo cuando se comprometan {n}',
    'You paid {paid}': 'Pagaste {paid}',
    '(you had authorized {amount}).': '(habías autorizado {amount}).',
    '{amount} was refunded when the price dropped.': 'Se te devolvieron {amount} cuando el precio bajó.',
    'The group formed. Everyone paid {price}.': 'El grupo se formó. Todos pagaron {price}.',
    '{n} buyers, {saved} below the {list} list price each.': '{n} compradores, cada uno {saved} por debajo del precio de lista de {list}.',
    'Late buyers unlocked a cheaper tier, so earlier buyers were refunded the difference.':
      'Compradores tardíos alcanzaron un precio menor, así que a los primeros se les devolvió la diferencia.',
    'This group did not form': 'Este grupo no se formó',
    'It reached {n} of {goal} buyers. Every PayPal authorization was voided; nobody was charged.':
      'Llegó a {n} de {goal} compradores. Se anularon todas las autorizaciones de PayPal; no se le cobró a nadie.',
    'Start another request': 'Hacer otro pedido',
    'Goal reached.': 'Meta alcanzada.',
    "The buyer agent is negotiating with {merchant}'s agent. Payments are captured right after.":
      'El agente comprador está negociando con el agente de {merchant}. Los pagos se cobran justo después.',
    'Sold by {merchant}': 'Vendido por {merchant}',
    'committed / goal': 'comprometidos / meta',
    'left to join': 'para unirse',
    closed: 'cerrado',
    'saved per buyer': 'ahorro por comprador',
    'Price tiers': 'Precios por volumen',
    Buyers: 'Compradores',
    'Price each': 'Precio por unidad',
    Saving: 'Ahorro',
    Alone: 'Solo',
    'The merchant agent may go below the tier price when it negotiates. It is never above it.':
      'El agente del comercio puede bajar del precio público al negociar. Nunca lo supera.',
    "Who's in": 'Quiénes están',
    'simulated buyer': 'comprador simulado',
    'Nobody yet. Be the first.': 'Nadie todavía. Sé la primera persona.',
    'Grey avatars are simulated demo buyers.': 'Los avatares grises son compradores simulados para la demo.',
    'paid {paid}': 'pagó {paid}',
    '{amount} back': '{amount} devueltos',
    late: 'tardío',
    released: 'liberado',
    failed: 'falló',
    'Market check': 'Precios del mercado',
    'Comparable live offers from Channel3. The buyer agent uses the cheapest one as leverage.':
      'Ofertas comparables en vivo de Channel3. El agente comprador usa la más barata para negociar.',
    'Why agents decided what they did': 'Por qué los agentes decidieron así',
    'Demo view': 'Vista de demo',
    'Messages sent to buyers': 'Mensajes enviados a los compradores',
    "You're in": 'Ya estás dentro',
    'Paid {paid}': 'Pagaste {paid}',
    'PayPal is holding {amount}': 'PayPal retiene {amount}',
    'The group formed and you paid the final group price.': 'El grupo se formó y pagaste el precio final del grupo.',
    "Nothing has been charged. If the group forms you pay the final group price, never more than {amount}. If it doesn't, the hold is released.":
      'No se te cobró nada. Si el grupo se forma pagas el precio final del grupo, nunca más de {amount}. Si no se forma, la retención se libera.',
    'Leave the group': 'Salir del grupo',
    'Join this group': 'Únete a este grupo',
    'Commit now, pay only if it forms': 'Comprométete ahora, paga solo si se forma',
    'PayPal authorizes up to {list} and charges nothing today. When the group closes you pay the negotiated group price{hint}.':
      'PayPal autoriza hasta {list} y hoy no cobra nada. Cuando el grupo cierre pagas el precio negociado del grupo{hint}.',
    '{price} or less': '{price} o menos',
    'Join late at {price}': 'Entra ahora por {price}',
    'The group already formed, so PayPal charges {price} as soon as you approve.': 'El grupo ya se formó, así que PayPal cobra {price} en cuanto apruebes.',
    '{n} more and the price drops to {price}: everyone already charged gets {refund} back.':
      'Con {n} más el precio baja a {price}: a quienes ya pagaron se les devuelven {refund}.',
    'Want something else?': '¿Buscas otra cosa?',
    'Describe it and an agent will find or start a group.': 'Descríbelo y un agente encontrará o iniciará un grupo.',
    'Start a request': 'Hacer un pedido',
    'Price-drop guarantee': 'Garantía de baja de precio',
    '{n} more and you get {refund} back': 'Con {n} más te devuelven {refund}',
    'The group stays open to late buyers. If it reaches the next tier, PayPal refunds the difference to everyone already charged.':
      'El grupo sigue abierto a compradores tardíos. Si llega al siguiente precio, PayPal devuelve la diferencia a quienes ya pagaron.',
    'Demo controls': 'Controles de demo',
    'Add late buyer (simulated)': 'Agregar comprador tardío (simulado)',
    'Add simulated buyer': 'Agregar comprador simulado',
    'Close group now': 'Cerrar el grupo ahora',
    'Visible because DEMO_ADMIN=true. Closing runs negotiation and capture (or void) immediately.':
      'Visible porque DEMO_ADMIN=true. Al cerrar se ejecutan la negociación y el cobro (o la anulación) de inmediato.',
    'Your email': 'Tu correo',
    'PayPal is in simulation mode on this server: no sandbox credentials are set.':
      'PayPal está en modo simulación en este servidor: no hay credenciales de sandbox.',
    'PayPal sandbox: approve with a sandbox personal account. No real money moves.':
      'Sandbox de PayPal: aprueba con una cuenta personal de sandbox. No se mueve dinero real.',
    'Grow the group': 'Haz crecer el grupo',
    'Every new member lowers the price': 'Cada persona nueva baja el precio',
    'Get a ready-to-send invite with your personal link.': 'Recibe una invitación lista para enviar con tu enlace personal.',
    'Draft my invite': 'Redactar mi invitación',
    'Leave this group? PayPal releases the hold and you are not charged.': '¿Salir de este grupo? PayPal libera la retención y no se te cobra.',
    'You left the group. PayPal released the hold.': 'Saliste del grupo. PayPal liberó la retención.',
    'Simulated buyer added': 'Comprador simulado agregado',
    'Closing…': 'Cerrando…',
    'The growth agent is writing your invite…': 'El agente de crecimiento está redactando tu invitación…',
    Copy: 'Copiar',
    'Invite copied': 'Invitación copiada',
    'Copy failed: select the text instead': 'No se pudo copiar: selecciona el texto',
    'You are in. PayPal charged the final group price.': 'Ya estás dentro. PayPal cobró el precio final del grupo.',
    'You are in. PayPal is holding the payment; nothing was charged.': 'Ya estás dentro. PayPal retiene el pago; no se cobró nada.',
    'Enter a valid email first': 'Primero escribe un correo válido',
    'Commit with PayPal (simulated)': 'Comprometerme con PayPal (simulado)',
    'Payment cancelled': 'Pago cancelado',
    'Allow pop-ups to approve the payment': 'Permite las ventanas emergentes para aprobar el pago',
    'Could not load PayPal. Check your connection or ad blocker.': 'No se pudo cargar PayPal. Revisa tu conexión o el bloqueador de anuncios.',

    // Merchant console
    'Console unavailable': 'Consola no disponible',
    'Sell to groups that already committed': 'Vende a grupos que ya se comprometieron',
    'Set a private floor and public volume tiers. Your agent negotiates within them. You only fulfil groups whose payments PayPal already holds.':
      'Define un piso privado y precios públicos por volumen. Tu agente negocia dentro de ellos. Solo despachas a grupos cuyos pagos PayPal ya retiene.',
    'Demand board': 'Tablero de demanda',
    'Requests no product covers yet, grouped by the intent agent': 'Pedidos que ningún producto cubre aún, agrupados por el agente de intención',
    'No unmet demand right now.': 'No hay demanda sin atender por ahora.',
    'Your catalog': 'Tu catálogo',
    'Floor price is private: only your agent knows it': 'El piso es privado: solo tu agente lo conoce',
    Product: 'Producto',
    List: 'Lista',
    'Floor (private)': 'Piso (privado)',
    'Tiers (buyers:price)': 'Niveles (compradores:precio)',
    Stock: 'Stock',
    Groups: 'Grupos',
    'Open groups lock their tiers; buyers committed to them': 'Un grupo abierto bloquea sus niveles; los compradores se comprometieron con ellos',
    Status: 'Estado',
    Committed: 'Comprometidos',
    'Price now': 'Precio actual',
    Final: 'Final',
    Closes: 'Cierra',
    'No groups yet.': 'Aún no hay grupos.',
    'Where you get paid': 'Dónde recibes tus pagos',
    'Orders name this PayPal account as the payee': 'Las órdenes nombran esta cuenta de PayPal como beneficiaria',
    'Payee routing is off: payments settle in the platform account': 'El envío al comercio está apagado: los pagos llegan a la cuenta de la plataforma',
    'Joined, charged, released, refunded, matched': 'Ingreso, cobro, liberación, reembolso, coincidencia',
    request: 'pedido',
    requests: 'pedidos',
    'median max {price}': 'máximo mediano {price}',
    'earliest deadline {date}': 'plazo más cercano {date}',
    'Draft an offer with the pricing agent': 'Redactar una oferta con el agente de precios',
    'Create a group offer': 'Crear una oferta de grupo',
    'Product title': 'Nombre del producto',
    Merchant: 'Comercio',
    Category: 'Categoría',
    'List price': 'Precio de lista',
    'Open for (hours)': 'Abierto por (horas)',
    Description: 'Descripción',
    Keywords: 'Palabras clave',
    'Create product and open group': 'Crear producto y abrir grupo',
    inactive: 'inactivo',
    'Locked while a group is open': 'Bloqueado mientras haya un grupo abierto',
    Save: 'Guardar',
    'See group': 'Ver grupo',
    'Open group': 'Abrir grupo',
    'PayPal email': 'Correo de PayPal',
    'The pricing agent is reading demand and market prices…': 'El agente de precios está leyendo la demanda y los precios del mercado…',
    'Pricing agent (Claude)': 'Agente de precios (Claude)',
    'Pricing agent (rules)': 'Agente de precios (reglas)',
    '{reach} of {count} waiting buyers can afford the goal price of {price}.': '{reach} de {count} compradores en espera pueden pagar el precio meta de {price}.',
    'Review the numbers below, especially the floor, before publishing.': 'Revisa los números de abajo, sobre todo el piso, antes de publicar.',
    Saved: 'Guardado',
    'Group opened; {n} waiting requests matched': 'Grupo abierto; {n} pedidos en espera coincidieron',
    'Group opened': 'Grupo abierto',

    // Messages from the server
    '@server': '',
    'Enter a valid email so we can tell you when the group closes': 'Escribe un correo válido para avisarte cuando cierre el grupo',
    'You are already in this group': 'Ya estás en este grupo',
    'This group is no longer open': 'Este grupo ya no está abierto',
    "Your maximum price is below this group's price": 'Tu precio máximo está por debajo del precio de este grupo',
    'Too many requests, slow down a little': 'Demasiadas solicitudes; espera un momento',
    'Describe what you want in 3 to 500 characters': 'Describe lo que quieres en 3 a 500 caracteres',
    'The group is already closing; you can no longer leave': 'El grupo ya está cerrando; ya no puedes salir',
    'This group closed before your authorization': 'Este grupo cerró antes de tu autorización',
  };

  let lang = 'en';
  try {
    // A link can choose the language: /?lang=es
    const asked = new URLSearchParams(location.search).get('lang');
    if (asked === 'es' || asked === 'en') localStorage.setItem('quorum:lang', asked);
    lang = localStorage.getItem('quorum:lang') || ((navigator.language || 'en').toLowerCase().startsWith('es') ? 'es' : 'en');
  } catch {}
  if (lang !== 'es') lang = 'en';

  function t(text, vars) {
    let out = lang === 'es' && Object.prototype.hasOwnProperty.call(ES, text) ? ES[text] : text;
    if (vars) for (const k of Object.keys(vars)) out = out.split(`{${k}}`).join(vars[k]);
    return out;
  }

  function apply() {
    document.documentElement.lang = lang;
    document.querySelectorAll('[data-t]').forEach((el) => { el.textContent = t(el.textContent.trim()); });
    document.querySelectorAll('[data-t-html]').forEach((el) => { el.innerHTML = t(el.innerHTML.trim()); });
    document.querySelectorAll('[data-t-placeholder]').forEach((el) => { el.placeholder = t(el.placeholder); });
    const toggle = document.getElementById('lang-toggle');
    if (toggle) {
      toggle.textContent = lang === 'es' ? 'EN' : 'ES';
      toggle.title = lang === 'es' ? 'Switch to English' : 'Cambiar a español';
      toggle.onclick = () => {
        try { localStorage.setItem('quorum:lang', lang === 'es' ? 'en' : 'es'); } catch {}
        location.reload();
      };
    }
  }

  window.I18N = { lang, t, dictionary: ES };
  // Deferred scripts run before DOMContentLoaded, so the shells are translated before the dynamic parts render.
  document.addEventListener('DOMContentLoaded', apply);
})();
