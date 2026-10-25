// These closure-free classifiers also run in the engine REPL and Chromium's
// isolated utility world. Page claims never supply authority to this policy.
export function resetsCookies(text) {
  return /\b(?:reset|clear|delete|remove)\b[^.!?;]*\bcookies?\b/iu.test(
    String(text ?? '').normalize('NFKC').replace(/\s+/g, ' '));
}

// Link or button text that only points at a policy or settings page (the cookie policy, cookie settings, privacy
// policy, terms) names no consent. Any other link text stays part of the sentence around it.
export function policyLinkText(text) {
  const page = '(?:(?:our |the )?(?:cookie|privacy|data|cookies) (?:policy|policies|settings|preferences|notice|statement)|(?:privacy|cookie) center|terms(?: (?:of (?:use|service)|and conditions))?|learn more|more info(?:rmation)?|manage (?:cookies|preferences|settings)|customi[sz]e|settings|preferences)';
  return new RegExp('^(?:(?:read|view|see|visit|open) (?:our |the )?)?' + page + '(?: (?:and|&) ' + page + ')*[.!]?$', 'iu')
    .test(String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim());
}

export function cookieWording(text) {
  const phrase = /(?<![\p{L}\p{N}])(?:we (?:and our partners )?use (?:(?:essential|necessary|optional|strictly necessary|non-essential) )?cookies|(?:this|our) (?:web)?(?:site|app|page|platform) (?:uses|stores) cookies|uses? cookies|cookies are used on this site|storing of cookies|use of cookies|cookies on your device|by (?:continuing|using|browsing|staying on|visiting|navigating)\b(?:(?!terms|privacy|service|conditions|account)[^.!?;])*\bcookies?(?:(?!terms|privacy|service|conditions|account)[^.!?;])*$|cookie (?:policy|settings|preferences|notice|consent)|accept(?: all)? cookies|consent to cookies|(?:diese (?:website|webseite) (?:verwendet|nutzt|benutzt)|wir (?:verwenden|nutzen|benutzen)) (?:cookies|kekse)|(?:cookie|cookies)[ -](?:einstellungen|richtlinie)|(?:nous utilisons|(?:ce|notre) site(?: web)? utilise) (?:des )?cookies|(?:politique|paramètres|préférences) (?:de |des |en matière de )?cookies|(?:usamos|utilizamos|(?:este|nuestro) sitio(?: web)? (?:usa|utiliza)) (?:cookies|galletas)|(?:política|configuración|preferencias) de cookies|(?:utilizziamo|(?:questo|il nostro) sito(?: web)? (?:usa|utilizza)) (?:i )?cookie|(?:impostazioni|preferenze) (?:dei )?cookie|(?:usamos|utilizamos|(?:este|nosso) site (?:usa|utiliza)) (?:cookies|biscoitos)|(?:política|configurações|preferências) de cookies|(?:wij gebruiken|deze website gebruikt) cookies|cookie[ -]?(?:instellingen|voorkeuren|beleid)|(?:używamy|ta strona używa) (?:plików )?cookie|(?:ustawienia|preferencje) (?:plików )?cookie|çerez(?:ler)? kullanıyoruz|çerez (?:ayarları|tercihleri|politikası)|(?:vi|denna webbplats) använder (?:kakor|cookies)|(?:inställningar|policy) för kakor|käytämme evästeitä|eväste(?:asetukset|käytännöt)|sütiket használunk|süti(?:beállítások|szabályzat))(?![\p{L}\p{N}])|クッキー(?:を使用|の設定|のポリシー|の同意)|(?:我们|我們)使用\s*(?:cookies?|饼干|餅乾)|(?:cookies?|饼干|餅乾)(?:政策|设置|設定|偏好)|쿠키(?:를 사용| 설정| 정책| 동의)/iu;
  const observed = String(text ?? '').normalize('NFKC').replace(/\s+/g, ' ');
  // Reset/clear confirmations change existing settings, not consent to a wall.
  const resetting = resetsCookies(observed);
  // A policy in an account/checkout agreement supplies no cookie consent.
  // Keep independent consent sentences in the same container observable.
  const words = observed.split(/[.!?;]+/u).filter(sentence => {
    const agreement = /\b(?:agree(?:s|d)? to|accept(?:s|ed)? (?:our|the|these))\b.*\b(?:terms|polic(?:y|ies)|agreement)\b|\bby (?:continuing|signing up|registering|using)\b.*\bagree\b/iu.test(sentence);
    if (!agreement) return true;
    // An agreement that names cookie use or storage ("you agree to the storing of cookies ... and our Privacy Policy",
    // "you agree to our use of cookies") is consent wording, whatever else it names. Only a cookie named as a policy
    // title, or a policy that "explains how we use cookies", is dropped.
    const rest = sentence
      .replace(/\bcookies? (?:preferences |settings )?(?:policy|policies|settings|preferences|notice|statement)\b/giu, '')
      .replace(/\b(?:explains?|describes?|sets? out|details?) how we use cookies\b/giu, '');
    if (/\bcookies?\b/iu.test(rest)) return true;
    // An account or checkout agreement (terms, privacy, service, conditions, account) that names cookies only as a
    // policy is not cookie consent. A browsing agreement ("By continuing you agree to our Cookie Policy") is.
    if (/\b(?:terms|privacy|service|conditions|account)\b/iu.test(sentence)) return false;
    return phrase.test(rest) || /\bby (?:continuing|using|browsing|staying on|visiting|navigating)\b.*\bcookies?\b/iu.test(sentence);
  })
    .map(sentence => resetting ? sentence.replace(/\bcookie (?:policy|settings|preferences|notice|consent)\b/giu, '') : sentence).join('. ');
  // Whole consent phrases keep cookie recipes, games and settings usable.
  // Narrow false positives of the general "uses cookies" and "use of cookies" matches.
  return phrase.test(words
    .replace(/\b(?:your|this) account uses cookies\b/giu, '')
    .replace(/\bmanage (?:our|your|the) use of cookies\b/giu, ''));
}

export function consentManager(text) {
  // Camel-case roots expose vendor words. Exclude the ordinary hyphenated
  // word ketch-up before testing whole vendor words, including root suffixes.
  return /(?<![\p{L}\p{N}])(?:sp_message_(?:iframe|container)_[a-z0-9_-]+|qc-cmp2(?:-[a-z0-9_-]+)?|truste(?:-[a-z0-9_-]+)?|one[ _-]?trust|cookie[ _-]?bot|didomi|quantcast|trust[ _-]?arc|user[ _-]?centrics|cookie[ _-]?yes|osano|iubenda|source[ _-]?point|ketch(?![-_]up(?=$|[^\p{L}\p{N}]))|termly|complianz|borlabs)(?![\p{L}\p{N}])/iu.test(
    String(text ?? '').normalize('NFKC').replace(/([a-z])([A-Z])/g, '$1 $2'));
}

// Whole accessible names only. A substring such as "reject and customise" or
// an ellipsis describes another step, not a one-click decline of every option.
export function declinesCookies(name) {
  const text = String(name ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  return /^(?:disagree|refuse all(?: cookies)?|continue without (?:accepting|agreeing)|nicht zustimmen|ohne zustimmung fortfahren|continuer sans (?:accepter|consentir)|continuar sin aceptar|continua senza accettare|continuar sem aceitar|doorgaan zonder akkoord|kontynuuj bez zgody|fortsätt utan att godkänna|reject(?: (?:all|optional|non-essential)(?: cookies)?)?|decline(?: all(?: cookies)?)?|deny(?: all)?|(?:use |allow |accept )?(?:only (?:strictly )?(?:necessary|essential)(?: cookies)?|(?:strictly )?(?:necessary|essential)(?: cookies)? only)|(?:(?:alle|alles)(?: cookies)? )?ablehnen|nur (?:technisch )?(?:notwendige|erforderliche|essenzielle)(?: cookies)?(?: akzeptieren| zulassen)?|(?:refuser|tout refuser|refuser tout|refuser tous les cookies|uniquement les cookies (?:nécessaires|essentiels))|rechazar(?: todo| todas| todos(?: los cookies| las cookies)?)?|solo (?:cookies )?(?:necesarias|necesarios|esenciales)|rifiuta(?: tutti| tutto)?|solo (?:cookie )?(?:necessari|essenziali)|rejeitar(?: todos| tudo)?|apenas (?:cookies )?(?:necessários|essenciais)|(?:alles |alle cookies )?weigeren|alleen (?:noodzakelijke|essentiële)(?: cookies)?|odrzuć(?: wszystkie)?|tylko (?:niezbędne|konieczne)(?: pliki cookie)?|(?:すべて|全て)(?:のクッキーを)?拒否(?:する)?|必要(?:なクッキー)?のみ|(?:全部|全部予以|所有)?拒绝(?:所有(?:cookie|cookies))?|(?:全部|所有)?拒絕(?:全部|所有(?:cookie|cookies))?|仅(?:限)?必要(?:的)?(?:cookie|cookies)?|僅(?:限)?必要(?:的)?(?:cookie|cookies)?|(?:tümünü |tüm çerezleri )?reddet|yalnızca gerekli çerezler|avvisa(?: alla)?|neka(?: alla)?|endast nödvändiga(?: kakor)?|hylkää(?: kaikki)?|vain välttämättömät(?: evästeet)?|(?:összes )?elutasítása|csak szükséges(?: sütik)?|모두 거부|전체 거부|필수(?: 쿠키)?만(?: 허용)?)$/iu.test(text);
}

// Check both names independently. A decline in one cannot excuse an Accept
// label in the other. Whole decline labels exempt necessary-only wording.
export function acceptsCookies(name) {
  const text = String(name ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  if (declinesCookies(text)) return false;
  return /(?<![\p{L}\p{N}])(?:accept(?: all)?|allow(?: all)?|agree|ok(?:ay)?|got it|continue|i understand|yes,? that is fine|consent|understood|proceed|yes|sounds good|enable all|akzeptieren|zustimmen|einverstanden|zulassen|verstanden|accepter|j'accepte|autoriser|d'accord|compris|continuer|aceptar|permitir|acepto|de acuerdo|continuar|entiendo|accetta|consenti|acconsento|concordo|ho capito|aceitar|permitir|concordar|entendi|accepteren|toestaan|akkoord|doorgaan|begrepen|zaakceptuj|akceptuj|zezwól|zgadzam się|kontynuuj|rozumiem|kabul et|onayla|tamam|devam|anladım|godkänn|acceptera|tillåt|jag godkänner|fortsätt|jag förstår|hyväksy|salli|jatka|ymmärrän|elfogad(?:ás|ása|om)?|engedélyez(?:és|em)?|rendben|folytatás|értem)(?![\p{L}\p{N}])|同意する|同意して|すべて許可|全て許可|受け入れる|承諾|続行|わかりました|同意|接受|允[许許]|繼續|继续|知道了|동의|허용|계속|확인|이해했습니다/iu.test(text);
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
    const body = m[3], parts = body.split(/, (?=(?:Description|Value|Help|ID|URL|Placeholder|Secondary Actions|Frame): )/);
    const own = parts[0].replace(/^(?:standard window|HTML content|alert dialog|alertdialog|dialog|sheet|alert|region|section|main|navigation|banner|complementary|content info|form|group|container|button|link|text|heading|check box|text field|switch|image)(?: \([^)]*\))*(?: |$)/, '');
    const description = parts.find(part => part.startsWith('Description: '))?.slice(13);
    // Geometry is optional in an engine tree. Never infer a point target from
    // its label or proximity when that observation has no frame.
    const geometry = parts.find(part => part.startsWith('Frame: '))?.slice(7);
    let frame;
    if (geometry) {
      const values = geometry.match(/-?\d+(?:\.\d+)?/g)?.map(Number);
      if (values?.length === 4 && values[2] > 0 && values[3] > 0) frame = values;
    }
    const row = { id: Number(m[2]), depth: m[1].length, body, own, name: description ?? own, frame,
      words: [own, description !== own ? description : '', parts.find(part => part.startsWith('Value: '))?.slice(7)].filter(Boolean).join(' '),
      ancestors: stack.length ? [stack.at(-1), ...stack.at(-1).ancestors] : [] };
    rows.push(row); stack.push(row);
  }
  const boundary = row => /^(?:HTML content|standard window|dialog|alert dialog|alertdialog|sheet|alert|region|section|main|navigation|banner|complementary|content info|form)\b/.test(row.body);
  const under = (row, root) => row === root || row.ancestors.includes(root);
  const scopedUnder = (row, root) => row === root || under(row, root) && !row.ancestors.slice(0, row.ancestors.indexOf(root)).some(boundary) && !boundary(row);
  const container = row => {
    const cmp = consentManager(row.name + ' ' + row.own + ' ' + (/, ID: ([^,]+)/.exec(row.body)?.[1] ?? ''));
    const dialog = /^(?:dialog|alert dialog|alertdialog)\b/.test(row.body);
    // AX exposes dialog roles, but no CSS fixed/sticky observation. A named
    // region or heading cannot supply that missing shape.
    if (!cmp && !dialog) return;
    const words = rows.filter(other => scopedUnder(other, row) &&
      ![other, ...other.ancestors.slice(0, other.ancestors.indexOf(row))].some(part => /^link\b/.test(part.body) && policyLinkText(part.name || rows.filter(r => r === part || under(r, part)).map(r => r.words).join(' ')))).map(other => other.words).join(' ').replace(/\s+/g, ' ').trim();
    if (dialog && resetsCookies(words) && !cookieWording(words)) return;
    if (cmp) return { row, ask: true };
    const fullText = rows.filter(other => under(other, row)).map(other => other.words).join(' ').replace(/\s+/g, ' ').trim();
    if (fullText.length >= 1500) return;
    if (words.length >= 1500 || !cookieWording(words)) return;
    return { row, ask: cmp || dialog };
  };
  const contextual = row => {
    for (const ancestor of row.ancestors) {
      const context = container(ancestor);
      if (context) return context;
      if (boundary(ancestor)) break;
    }
  };
  const accepting = row => acceptsCookies(row.name) || acceptsCookies(row.own);
  const declining = row => !accepting(row) && (declinesCookies(row.name) || declinesCookies(row.own));
  const declineControl = row => /^(?:button|link|check box|radio button|switch|pop up button)\b/.test(row.body) &&
    !/^[^(]*\([^)]*\bdisabled\b/.test(row.body) && declining(row);
  if (after) {
    const context = typeof after === 'object' ? after : undefined;
    const remains = context && rows.some(row => row.body === context.body);
    return { blocked: !rows.length || !context || remains };
  }
  const keyed = /^(?:pressKey|typeText|paste)$/.test(name);
  if (keyed && !(name === 'pressKey' && /(?:^|\+)(?:enter|return|numpadenter|space| |\r|\n)$/i.test(String(args[0])) ||
    name === 'typeText' && /^(?: |\n|\r\n?)$/.test(String(args[0])))) return;
  let target = rows.find(row => row.id === (keyed ? focus : args[0]));
  if (!keyed && Array.isArray(args[0]) && args[0].length === 2 && args[0].every(Number.isFinite)) {
    const [x, y] = args[0];
    const hits = rows.filter(row => row.frame && x >= row.frame[0] && y >= row.frame[1] && x < row.frame[0] + row.frame[2] && y < row.frame[1] + row.frame[3]);
    const deepest = hits.filter(row => !hits.some(other => other.ancestors.includes(row)));
    // Overlapping siblings have no proved hit order in AX. Precision takes
    // priority over a guessed block.
    if (deepest.length === 1) target = deepest[0];
  }
  if (!target) return;
  // A text/image child can resolve the hit on a containing Accept control.
  const candidates = [target, ...target.ancestors];
  for (const candidate of candidates) {
    if (candidate !== target && boundary(candidate)) break;
    if (!accepting(candidate) && !declining(candidate)) continue;
    const context = contextual(candidate);
    if (!context) continue;
    if (accepting(candidate)) {
      const decline = rows.find(row => scopedUnder(row, context.row) && declineControl(row));
      return { blocked: true, why: 'accepting cookies is blocked.' + (decline
        ? ' Use the page control ' + JSON.stringify(decline.name) + ' (untrusted page label) to decline non-essential cookies'
        : context.ask ? ' This wall has no reject option. Stop and ask the user' : ' No one-click decline was observed in this cookie container') };
    }
    if (declineControl(candidate) && /^(?:click|press|pressKey|performAction)$/.test(name)) return { decline: true, body: context.row.body };
  }
}
