// These closure-free classifiers also run in the engine REPL and Chromium's
// isolated utility world. Page claims never supply authority to this policy.
export function cookieWording(text) {
  return /(?<![\p{L}\p{N}])(?:cookies?|tracking|trackers?|personali[sz](?:ed|ierte|eerde|zowane) (?:ads|advertising|werbung)|partners?|partenaires|socios|parceiros|onetrust|cookiebot|trustarc|didomi|quantcast|sourcepoint|usercentrics|iubenda|çerez(?:ler)?|kakor|kaka|eväste(?:et|itä)?|süti(?:k|ket)?|rastre(?:o|amento)|suivi|tracciamento)(?![\p{L}\p{N}])|クッキー|トラッキング|追跡|饼干|餅乾|追踪|追蹤|쿠키|추적/iu.test(String(text ?? '').normalize('NFKC'));
}

// Whole accessible names only. A substring such as "reject and customise" or
// an ellipsis describes another step, not a one-click decline of every option.
export function declinesCookies(name) {
  const text = String(name ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  return /^(?:reject(?: (?:all|optional|non-essential)(?: cookies)?)?|decline(?: all(?: cookies)?)?|deny(?: all)?|continue without accepting|(?:use |allow |accept )?(?:only (?:strictly )?(?:necessary|essential)(?: cookies)?|(?:strictly )?(?:necessary|essential)(?: cookies)? only)|(?:(?:alle|alles)(?: cookies)? )?ablehnen|nur (?:technisch )?(?:notwendige|erforderliche|essenzielle)(?: cookies)?(?: akzeptieren| zulassen)?|(?:refuser|tout refuser|refuser tout|refuser tous les cookies|uniquement les cookies (?:nécessaires|essentiels))|rechazar(?: todo| todas| todos(?: los cookies| las cookies)?)?|solo (?:cookies )?(?:necesarias|necesarios|esenciales)|rifiuta(?: tutti| tutto)?|solo (?:cookie )?(?:necessari|essenziali)|rejeitar(?: todos| tudo)?|apenas (?:cookies )?(?:necessários|essenciais)|(?:alles |alle cookies )?weigeren|alleen (?:noodzakelijke|essentiële)(?: cookies)?|odrzuć(?: wszystkie)?|tylko (?:niezbędne|konieczne)(?: pliki cookie)?|(?:すべて|全て)(?:のクッキーを)?拒否(?:する)?|必要(?:なクッキー)?のみ|(?:全部|全部予以|所有)?拒绝(?:所有(?:cookie|cookies))?|(?:全部|所有)?拒絕(?:全部|所有(?:cookie|cookies))?|仅(?:限)?必要(?:的)?(?:cookie|cookies)?|僅(?:限)?必要(?:的)?(?:cookie|cookies)?|(?:tümünü |tüm çerezleri )?reddet|yalnızca gerekli çerezler|avvisa(?: alla)?|neka(?: alla)?|endast nödvändiga(?: kakor)?|hylkää(?: kaikki)?|vain välttämättömät(?: evästeet)?|(?:összes )?elutasítása|csak szükséges(?: sütik)?|모두 거부|전체 거부|필수(?: 쿠키)?만(?: 허용)?)$/iu.test(text);
}

// Check both names independently. A decline in one cannot excuse an Accept
// label in the other. Whole decline labels exempt necessary-only wording.
export function acceptsCookies(name) {
  const text = String(name ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  if (declinesCookies(text)) return false;
  return /(?<![\p{L}\p{N}])(?:accept(?: all)?|allow(?: all)?|agree|ok(?:ay)?|got it|continue|akzeptieren|zustimmen|einverstanden|zulassen|accepter|j'accepte|autoriser|d'accord|compris|continuer|aceptar|permitir|acepto|de acuerdo|continuar|accetta|consenti|acconsento|concordo|aceitar|permitir|concordar|accepteren|toestaan|akkoord|doorgaan|zaakceptuj|akceptuj|zezwól|zgadzam się|kontynuuj|kabul et|onayla|tamam|devam|godkänn|acceptera|tillåt|jag godkänner|fortsätt|hyväksy|salli|jatka|elfogad(?:ás|ása|om)?|engedélyez(?:és|em)?|rendben|folytatás)(?![\p{L}\p{N}])|同意する|同意して|すべて許可|全て許可|受け入れる|承諾|続行|わかりました|同意|接受|允[许許]|繼續|继续|知道了|동의|허용|계속|확인/iu.test(text);
}

export function engineConsent(name, args, text, after = false) {
  if (typeof text !== 'string') return after ? { blocked: true } : undefined;
  const rows = [], stack = [];
  let focus;
  for (const raw of text.split('\n')) {
    const focused = /^The focused UI element is (\d+) /.exec(raw);
    if (focused) focus = Number(focused[1]);
    const m = /^(\t*)(\d+) (.*)$/.exec(raw);
    if (!m) continue;
    while (stack.length && stack.at(-1).depth >= m[1].length) stack.pop();
    const body = m[3], parts = body.split(/, (?=(?:Description|Value|Help|ID|URL|Placeholder|Secondary Actions): )/);
    const own = parts[0].replace(/^(?:standard window|HTML content|alert dialog|dialog|sheet|alert|region|main|navigation|banner|complementary|content info|form|group|container|button|link|text|heading|check box|text field)(?: \([^)]*\))*(?: |$)/, '');
    const description = parts.find(part => part.startsWith('Description: '))?.slice(13);
    const row = { id: Number(m[2]), depth: m[1].length, body, own, name: description ?? own,
      words: parts.filter(part => !/^(?:Help|ID|URL|Placeholder|Secondary Actions): /.test(part)).join(' '),
      ancestors: stack.length ? [stack.at(-1), ...stack.at(-1).ancestors] : [] };
    rows.push(row); stack.push(row);
  }
  const boundary = row => /^(?:HTML content|standard window|dialog|alert dialog|sheet|alert|region|main|navigation|banner|complementary|content info|form)\b/.test(row.body);
  const under = (row, root) => row === root || row.ancestors.includes(root);
  const scopedUnder = (row, root) => row === root || under(row, root) && !row.ancestors.slice(0, row.ancestors.indexOf(root)).some(boundary) && (row === root || !boundary(row));
  const contextual = row => {
    let context;
    for (const ancestor of row.ancestors) {
      const cookie = cookieWording(rows.filter(other => scopedUnder(other, ancestor)).map(other => other.words).join(' '));
      if (cookie) context ??= ancestor;
      if (boundary(ancestor)) {
        if (cookie && !/^(?:HTML content|standard window)\b/.test(ancestor.body)) context = ancestor;
        break;
      }
    }
    return context;
  };
  const control = row => /^(?:button|link|check box|radio button|switch|pop up button)\b/.test(row.body);
  const accepting = row => acceptsCookies(row.name) || acceptsCookies(row.own);
  const declining = row => !accepting(row) && (declinesCookies(row.name) || declinesCookies(row.own));
  if (after) {
    // Match the original container by its role and label. A fresh AX
    // capture can reuse numbers for unrelated page content.
    const context = typeof after === 'object' ? after : undefined;
    const remains = context && rows.some(row => row.body === context.body);
    return { blocked: !rows.length || !context || remains };
  }
  const keyed = /^(?:pressKey|typeText|paste)$/.test(name);
  const target = rows.find(row => row.id === (keyed ? focus : args[0]));
  if (!target || !control(target)) return;
  if (keyed && (name !== 'pressKey' || !/(?:^|\+)(?:enter|return|space| )$/i.test(String(args[0])))) return;
  const context = contextual(target);
  if (!context) return;
  if (accepting(target)) {
    const decline = rows.find(row => scopedUnder(row, context) && control(row) && declining(row));
    return { blocked: true, why: decline ? 'accepting cookies is blocked. Use the page control ' + JSON.stringify(decline.name) + ' (untrusted page label) to decline non-essential cookies'
      : 'this wall has no reject option. Stop and ask the user' };
  }
  if (declining(target) && /^(?:click|press|pressKey|performAction)$/.test(name)) return { decline: true, body: context.body };
}
