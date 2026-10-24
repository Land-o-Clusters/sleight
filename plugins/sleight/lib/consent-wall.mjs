// These closure-free classifiers also run in the engine REPL and Chromium's
// isolated utility world. Page claims never supply authority to this policy.
export function cookieWording(text) {
  return /\b(?:cookies?|consent|consentement|einwilligung|zustimmung|consentimiento|consenso|consentimento|toestemming|zgod[ayę])\b|クッキー|同意|饼干|餅乾|쿠키|동의/i.test(String(text ?? ''));
}

// Whole accessible names only. A substring such as "reject and customise" or
// an ellipsis describes another step, not a one-click decline of every option.
export function declinesCookies(name) {
  const text = String(name ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  return /^(?:reject(?: all(?: cookies)?)?|decline(?: all(?: cookies)?)?|deny all|(?:use |allow |accept )?(?:only (?:strictly )?(?:necessary|essential)(?: cookies)?|(?:strictly )?(?:necessary|essential)(?: cookies)? only)|(?:alle(?: cookies)? )?ablehnen|nur (?:technisch )?(?:notwendige|erforderliche|essenzielle)(?: cookies)?(?: akzeptieren| zulassen)?|(?:tout refuser|refuser tout|refuser tous les cookies|uniquement les cookies (?:nécessaires|essentiels))|rechazar(?: todo| todas| todos(?: los cookies| las cookies)?)?|solo (?:cookies )?(?:necesarias|necesarios|esenciales)|rifiuta(?: tutti| tutto)?|solo (?:cookie )?(?:necessari|essenziali)|rejeitar(?: todos| tudo)?|apenas (?:cookies )?(?:necessários|essenciais)|(?:alles |alle cookies )?weigeren|alleen (?:noodzakelijke|essentiële)(?: cookies)?|odrzuć(?: wszystkie)?|tylko (?:niezbędne|konieczne)(?: pliki cookie)?|(?:すべて|全て)(?:のクッキーを)?拒否(?:する)?|必要(?:なクッキー)?のみ|(?:全部|全部予以|所有)?拒绝(?:所有(?:cookie|cookies))?|(?:全部|所有)?拒絕(?:所有(?:cookie|cookies))?|仅(?:限)?必要(?:的)?(?:cookie|cookies)?|僅(?:限)?必要(?:的)?(?:cookie|cookies)?|모두 거부|전체 거부|필수(?: 쿠키)?만(?: 허용)?)$/iu.test(text);
}

// Contradictory *outcome* text, not the original wall's Accept button or its
// quoted instructions. This is evidence of a bad handler, never permission.
export function acceptedCookies(text) {
  return /(?:all|optional|non[- ]essential|analytics|advertising) (?:cookies? )?(?:accepted|enabled|allowed)|(?:accepted|enabled|allowed) (?:all|optional|non[- ]essential|analytics|advertising)(?: cookies?)|cookies? (?:accepted|consent(?:ed)?\s*[:=]\s*(?:all|true|yes))/i.test(String(text ?? ''));
}

// A consent record with an unknown encoding cannot verify declining. Only
// classifications cross the isolated-world boundary, never the stored values.
export function consentRecord(key, value) {
  if (!/(?:cookie|consent|analytics|advertising|marketing|tracking|statistics)/i.test(String(key))) return null;
  if (typeof value !== 'string' || value.length > 4096) return 'unknown';
  let text;
  try { text = decodeURIComponent(value).trim(); } catch { return 'unknown'; }
  if (/^(?:all|accept(?:ed)?|allow(?:ed)?|grant(?:ed)?|true|yes|1)$/i.test(text)) return 'accepted';
  if (/^(?:reject(?:ed)?(?:[-_ ]all)?|declin(?:e|ed)|den(?:y|ied)|false|no|0|(?:necessary|essential)(?:[-_ ]only)?|only[-_ ](?:necessary|essential))$/i.test(text)) return 'declined';
  let parsed;
  try { parsed = JSON.parse(text); } catch { return 'unknown'; }
  const classify = (item, depth = 0) => {
    if (depth > 4 || !item || typeof item !== 'object' || Array.isArray(item)) return 'unknown';
    const entries = Object.entries(item);
    if (!entries.length || entries.length > 64) return 'unknown';
    let unknown = false;
    for (const [name, chosen] of entries) {
      if (/^(?:necessary|essential|required)$/i.test(name)) continue;
      const state = chosen && typeof chosen === 'object' ? classify(chosen, depth + 1) :
        consentRecord('consent', String(chosen));
      if (state === 'accepted') return 'accepted';
      if (state !== 'declined') unknown = true;
    }
    return unknown ? 'unknown' : 'declined';
  };
  return classify(parsed);
}

export function engineConsent(name, args, text, after = false) {
  if (typeof text !== 'string') return { blocked: true, why: 'cookie-wall state could not be read' };
  const rows = [], stack = [];
  let focus;
  for (const raw of text.split('\n')) {
    const focused = /^The focused UI element is (\d+) /.exec(raw);
    if (focused) focus = Number(focused[1]);
    const m = /^(\t*)(\d+) (.*)$/.exec(raw);
    if (!m) continue;
    while (stack.length && stack.at(-1).depth >= m[1].length) stack.pop();
    const body = m[3], parts = body.split(/, (?=(?:Description|Value|Help|ID|URL|Placeholder|Secondary Actions): )/);
    // The role list is explicit because labels can begin with lower-case words.
    const own = parts[0].replace(/^(?:standard window|HTML content|alert dialog|dialog|sheet|alert|region|group|container|button|link|text|heading)(?: \([^)]*\))*(?: |$)/, '');
    const description = parts.find(part => part.startsWith('Description: '))?.slice(13);
    const row = { id: Number(m[2]), depth: m[1].length, body, own, name: description ?? own,
      words: parts.filter(part => !/^(?:Help|ID|URL|Placeholder|Secondary Actions): /.test(part)).join(' '),
      ancestors: stack.length ? [stack.at(-1), ...stack.at(-1).ancestors] : [] };
    rows.push(row); stack.push(row);
  }
  const under = (row, root) => row === root || row.ancestors.includes(root);
  const walls = rows.filter(row => /^(?:dialog|alert dialog|sheet|alert)\b/.test(row.body)
    ? cookieWording(rows.filter(other => under(other, row)).map(other => other.words).join(' '))
    : /^(?:region|group|container)\b/.test(row.body) && cookieWording(row.name));
  const settings = after && rows.some(row => /^heading\b/.test(row.body) && cookieWording(row.words)) &&
    rows.some(row => /^(?:check ?box|switch|toggle button|radio button|button)\b/.test(row.body));
  if (after) return { blocked: !rows.length || walls.length > 0 || settings || acceptedCookies(rows.filter(row => /^text\b/.test(row.body)).map(row => row.words).join(' ')),
    why: 'the decline was not verified, the wall remains, settings opened, or the page reports acceptance' };
  if (!walls.length) return;
  if (walls.some(wall => !rows.some(row => under(row, wall) && /^(?:button|link)\b/.test(row.body) && declinesCookies(row.name))))
    return { blocked: true, why: 'the wall offers no recognised one-click decline' };
  const keyed = /^(?:pressKey|typeText|paste)$/.test(name), target = rows.find(row => row.id === (keyed ? focus : args[0]));
  if (target && !walls.some(wall => under(target, wall))) return;
  if (name === 'click' && target && /^(?:button|link)\b/.test(target.body) && declinesCookies(target.name)) return { decline: true };
  return { blocked: true, why: 'only a one-click Reject or necessary-only control can decline all non-essential cookies' };
}
