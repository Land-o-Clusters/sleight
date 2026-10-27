// app.pickFromList([list,] label): the engine-path counterpart of turbo's pick-from-list.mjs, which needs Playwright.
// Serialized into the engine's realm alongside the cooperative app guard, like elementWait, so nothing
// here may use module scope. Every key, wheel step and the final click go through the guarded handle (window,
// lease and stale-element checks); the helper adds its own checks on the list it pages through.
// The Firefox travel form's 1,000-row airport list cost 34.6 and 36.3 s of small scroll/read loops
// (astra-1018-forms, 2026-10-18). Paging four keys a read, the offline model found every label in 1,000/1,000 lists
// with 18 to 20 reads; jumping to the row the labels around it predict (CC3), 16 keys at most between reads, a mean of
// 7.9 to 8.8 reads sees the row.
//
// What b7 (race-1017, 2026-10-19) measured, and what this follows: after the click the skill asks for, the read
// names a "Selected:" row instead of the focused list (5 of 7 calls stopped there). Page_Down moves Safari's web list
// about 2.2 rows a key and Firefox's about 9, and the wheel moves Safari's 10 rows a tick, so the mover is chosen by
// the rows each step moved. Rows rendered past the list's visible band have no frame (Safari r1, -10005), so a matched
// row is brought toward the middle of the rendered rows before the click.
export function listPicker({ read, observe, press, scroll, click, parse, sameElement, expected, clicked, lineSeen, uniqueSeen, rebound,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = () => Date.now() }) {
  const LIST_ROLE = /^(?:list box|listbox|list)(?: \([^()]*\))*(?: |,|$)/;
  // Totals per search; a key step with fewer rows a key than MIN_KEY_ROWS moves to the wheel. GROW caps an extrapolated jump.
  // BURST caps the keys sent between two reads.
  const MAX_KEYS = 400, MAX_TICKS = 400, MIN_KEY_ROWS = 5, FIRST_TICKS = 2, MAX_TICK_STEP = 32, MAX_CENTERING = 3, GROW = 4, BURST = 16;
  const compare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const words = value => String(value).replace(/\s+/g, ' ').trim();
  // The list's rows from one tree: a row's label is its first line without role and states.
  // Its later lines (a name above a code) are kept, so the name alone can name the row.
  // The list is the focused element or its parent; or, when the read names only a "Selected:" row, that row's
  // parent, if this call's last action clicked that list or one of its rows (keys could reach anything else).
  const parseRows = text => {
    const rows = [], selected = [];
    let open = false, tail = false, inSelection = false;
    for (const line of String(text).split('\n')) {
      if (/^(?:The focused UI element is |Selected:\r?$)/.test(line)) { tail = true; open = false; inSelection = /^Selected:/.test(line); continue; }
      const m = /^(\t*)(\d+) (.*?)\r?$/.exec(line);
      if (tail) {
        if (inSelection && m && m[1].length === 1) selected.push({ number: Number(m[2]), body: m[3] });
        else inSelection = false;
        continue;
      }
      if (m) { rows.push({ depth: m[1].length, number: Number(m[2]), body: m[3], extra: [] }); open = true; }
      else if (!line.trim()) open = false;
      else if (open && !/^Window: /.test(line)) rows.at(-1).extra.push(line.replace(/\r$/, ''));
    }
    return { rows, selected };
  };
  const childRows = (rows, at) => {
    const kids = [];
    for (let i = at + 1; i < rows.length && rows[i].depth > rows[at].depth; i++) if (rows[i].depth === rows[at].depth + 1) kids.push(rows[i]);
    return kids;
  };
  const parent = (rows, at) => {
    for (let i = at - 1; i >= 0; i--) if (rows[i].depth < rows[at].depth) return i;
    return -1;
  };
  const listOf = (rows, at) => {
    for (let i = at; i >= 0; i = parent(rows, i)) if (LIST_ROLE.test(rows[i].body)) return i;
    return -1;
  };
  // Focus below a list must pass only through plain display elements, including the direct row.
  // Unknown roles, settable elements and advertised actions get the wheel only.
  const keyFocus = (rows, at, list) => {
    for (let i = at; i !== list; i = parent(rows, i)) {
      const body = rows[i].body, role = /^[a-z]+(?: [a-z]+)*/.exec(body)?.[0];
      if (!['text', 'static text', 'image', 'group', 'cell'].includes(role) ||
          /\([^()]*\bsettable\b[^()]*\)/.test(body) || /(?:^|, )(?:Secondary Actions|Actions):/.test(body)) return false;
    }
    return true;
  };
  // CC2: the list the call names (an element number, its label, or { label }, { id } or { line }); a row's number names its
  // list. A stale number may follow its unique named list, as scroll does; an absent or ambiguous identity stops.
  const locate = (text, ref, seenLine) => {
    const { rows } = parseRows(text);
    const nameOf = body => body.replace(LIST_ROLE, '').split(/, (?=(?:Value|ID|Help|Secondary Actions|Description|URL): )/)[0].trim();
    const idOf = body => /(?:^|, )ID: ([^,]+)/.exec(body)?.[1]?.trim();
    const isList = i => LIST_ROLE.test(rows[i].body);
    let found;
    if (typeof ref === 'number') {
      let at = rows.findIndex(row => row.number === ref);
      if (seenLine !== undefined && !sameElement(seenLine, rows[at]?.body)) {
        const matches = uniqueSeen?.(ref) && LIST_ROLE.test(seenLine) && nameOf(seenLine)
          ? rows.map((row, i) => i).filter(i => sameElement(seenLine, rows[i].body)) : [];
        if (matches.length !== 1 || !isList(matches[0])) {
          return { problem: 'Element ' + ref + ' changed since you read the window (was ' + JSON.stringify(String(seenLine).slice(0, 60)) + ', now ' + JSON.stringify((rows[at]?.body ?? 'missing').slice(0, 60)) + ').' };
        }
        at = matches[0];
        rebound?.(ref, rows[at].number, seenLine);
      }
      const list = at >= 0 ? listOf(rows, at) : -1;
      found = list >= 0 ? [list] : [];
      if (!found.length) return { problem: 'Element ' + ref + (at < 0 ? ' is not in the window.' : ' is not a list or one of its rows.') };
    } else {
      const want = typeof ref === 'string' ? { label: ref } : ref;
      found = rows.map((row, i) => i).filter(i => isList(i) && (typeof want.line === 'string' ? sameElement(want.line, rows[i].body)
        : typeof want.id === 'string' ? idOf(rows[i].body) === want.id : nameOf(rows[i].body) === words(want.label ?? '')));
      if (found.length !== 1) return { problem: (found.length ? found.length + ' lists match ' : 'No list matches ') + JSON.stringify(ref) + '.' };
    }
    return { list: rows[found[0]], kids: childRows(rows, found[0]) };
  };
  // A list's rows with their labels, and the role they share: the lowercase words every row starts with ("text", then
  // states such as "(selectable)").
  const labelRows = kids => {
    const runs = kids.map(kid => {
      const parts = kid.body.split(' '), end = parts.findIndex(word => !/^[a-z]+$/.test(word));
      return parts.slice(0, end < 0 ? parts.length : end);
    });
    const role = runs.reduce((common, run) => {
      let n = 0;
      while (n < common.length && common[n] === run[n]) n++;
      return common.slice(0, n);
    }, runs[0] ?? []).join(' ');
    const labelOf = body => {
      const rest = body.slice(role.length).trimStart().replace(/^(?:\([^()]*\) )+/, '');
      const described = /^Description: (.*?)(?=, (?:Value|ID|Help|Secondary Actions): |$)/.exec(rest);
      return described ? described[1] : rest.split(/, (?=(?:Value|ID|Help|Secondary Actions|Description|URL): )/)[0];
    };
    const labeled = kids.map(kid => ({ number: kid.number, body: kid.body, label: labelOf(kid.body), name: kid.extra[0] }))
      .filter(row => row.label);
    return { role, labeled };
  };
  // Rows that act when clicked: the focusing click goes only to a list of plain rows.
  const ACTIONABLE = /\b(?:button|link|menu item|check box|tab|switch|disclosure triangle)$/;
  const view = (text, trusted) => {
    const { rows, selected } = parseRows(text);
    const focus = /^The focused UI element is (\d+) (.+?)\r?$/m.exec(text);
    const anchors = focus ? [{ number: Number(focus[1]), body: focus[2] }] : selected;
    if (!anchors.length) return { problem: 'The window names no focused element or selected row, so the list cannot be verified.' };
    const anchoredList = anchor => {
      const at = rows.findIndex(row => row.number === anchor.number);
      if (at < 0 || !sameElement(anchor.body, rows[at].body)) return { problem: 'The ' + (focus ? 'focused' : 'selected') + ' element is missing from the tree.' };
      const list = listOf(rows, at);
      return list >= 0 ? { at: list, keySafe: keyFocus(rows, at, list) } : { not: rows[at] };
    };
    const found = anchors.map(anchoredList);
    const problem = found.find(item => item.problem)?.problem;
    if (problem) return { problem };
    const outside = found.find(item => item.not);
    if (outside || found.some(item => item.at !== found[0].at)) {
      return { problem: (focus ? 'Focus' : 'The selection') + ' is on ' + JSON.stringify((outside?.not ?? rows[found[0].at]).body.slice(0, 60)) + ', not a list or one of its rows.' };
    }
    const listAt = found[0].at, list = rows[listAt], kids = childRows(rows, listAt);
    // The list this search already accepted needs no click: its rows moved under these keys or wheel steps.
    if (!focus && !(trusted && sameElement(trusted, list.body)) &&
        !(lastClick && rows.some((row, i) => row.number === lastClick.number && sameElement(lastClick.line, row.body) && listOf(rows, i) === listAt))) {
      return { problem: 'The read names a selected row in ' + JSON.stringify(list.body.slice(0, 60)) + ' but no focused element, and the action just before was not a click on that list or one of its rows.' };
    }
    const { labeled } = labelRows(kids);
    return { list: list.body, rows: labeled, labels: labeled.map(row => row.label),
      focused: !!focus && found.every(item => item.keySafe) };
  };
  let lastClick;
  return async (...args) => {
    // pickFromList(list, "<row>", options): with the list named first the helper makes the focusing click itself (CC2).
    const listRef = typeof args[1] === 'string' ? args.shift() : undefined;
    const [label, options = {}] = args;
    lastClick = clicked;
    if (listRef !== undefined && !(Number.isInteger(listRef) && listRef >= 0) && !(typeof listRef === 'string' && listRef.trim()) &&
        !(listRef && typeof listRef === 'object' && ['label', 'id', 'line'].some(key => typeof listRef[key] === 'string' && listRef[key].trim()))) {
      throw new Error('pickFromList takes the list as an element number, its label, or { label }, { id } or { line }, then the row text.');
    }
    const maxReads = options?.maxReads ?? 60, coarse = options?.coarse ?? 4, timeoutMs = options?.timeoutMs ?? 20000;
    if (typeof label !== 'string' || !label.trim()) throw new Error('pickFromList needs the exact label of a row.');
    if (!Number.isInteger(maxReads) || maxReads < 1 || maxReads > 100 || !Number.isInteger(coarse) || coarse < 1 || coarse > 8 ||
        !Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000) {
      throw new Error('pickFromList takes maxReads from 1 to 100, coarse from 1 to 8 pages and timeoutMs up to 60000.');
    }
    // "Norcrest Point International\nMAO" (Firefox r2, b7) is the row's name and code on two lines.
    const target = words(label), deadline = now() + timeoutMs;
    const isMatch = row => row.label === target || words(row.name ?? '') === target;
    let identity = expected, reads = 0, keys = 0, ticks = 0, v, listLine, previous, direction = 0, fine = false, confirmed = null;
    // The mover in use, the units of the last move, and the rows one unit moved (measured, per mover).
    let mover = 'key', step = coarse, lastStep = 0, lastMover = 'key', centering = 0, centerDir = 0, heldAt = 0, retried = false;
    // The first and last labels seen in this search, which tell whether the list can be at its top or end.
    let lowest, highest, lastText, focusRow;
    const rate = {};
    const near = new Set();
    // CC3: each tracked read's labels with the row of its first label (`pos`), counted from the first tracked read. A move
    // adds the rows its overlap shows, or its units times the measured rate; a move that measures nothing starts a new frame.
    let pos = 0, era = 0, frameView, pending, marks = [], lastWidth, stalls = 0, circled = false;
    const windows = new Map();
    const look = async () => {
      const text = await read();
      reads++;
      const header = parse(text);
      if (!header || (identity && ['title', 'app', 'url'].some(key => header[key] !== identity[key]))) {
        throw new Error('pickFromList stopped: window changed or its full header is missing.\n' + text);
      }
      identity = header;
      observe(text);
      lastText = text;
      const seen = view(text, listLine);
      if (seen.labels?.length) {
        if (!lowest || compare(seen.labels[0], lowest) < 0) lowest = seen.labels[0];
        if (!highest || compare(seen.labels.at(-1), highest) > 0) highest = seen.labels.at(-1);
        track(seen);
      }
      for (const row of seen.rows ?? []) if (near.size < 3 && row.label.startsWith(target + ' ')) near.add(row.label);
      return seen;
    };
    const stop = (reason, note, extra) => ({ found: false, clicked: false, reason, reads, keys, ...(ticks ? { ticks } : {}),
      ...(v?.labels?.length ? { first: v.labels[0], last: v.labels.at(-1) } : {}),
      ...(near.size ? { near: [...near] } : {}), ...extra,
      note: (focusRow ? 'The focusing click went to ' + JSON.stringify(focusRow.slice(0, 60)) + '; no other row clicked. ' : 'No row clicked. ') +
        note + (near.size ? ' Rows starting with it: ' + [...near].join('; ') + '. Pass a whole row label.' : '') });
    const sameRows = (a, b) => !!a.labels && !!b?.labels && a.labels.length === b.labels.length && a.labels.every((x, i) => x === b.labels[i]);
    const track = seen => {
      if (frameView && !sameRows(seen, frameView)) {
        const d = pending?.d || (compare(seen.labels[0], frameView.labels[0]) > 0 ? 1 : -1);
        const rows = shifted(frameView, seen, d);
        if (rows !== undefined) pos += d * rows;
        // A move past every rendered row counts its units times the mover's rate, unless the mover was seen to move fewer
        // rows for more units (Firefox's wheel moves at most 9 rows a call): then it starts a new frame.
        // Such a move may stop at the list's end or top, so the rows after it start a new era.
        else if (pending && rate[pending.how] > 0 && !(pending.units > 1 && capped[pending.how])) { pos += d * pending.units * rate[pending.how]; era++; }
        else { pos = 0; marks = []; }
        pending = undefined;
      }
      frameView = seen;
      // A row an earlier era also showed fixes the offset between the eras: the later ones move to the earlier count (a
      // jump that stopped at the list's end counted rows it never moved).
      for (const m of marks) {
        if (m.era >= era) continue;
        const j = m.labels.findIndex(text => seen.labels.includes(text));
        if (j < 0) continue;
        const offset = pos + seen.labels.indexOf(m.labels[j]) - (m.pos + j);
        if (offset) { for (const later of marks) if (later.era > m.era) later.pos -= offset; pos -= offset; }
        break;
      }
      const mark = { pos, labels: seen.labels, era };
      // Rows whose order contradicts their counted rows (an earlier era's row sorts after this read's but counts before it):
      // that era's count overshot an end, so it and every era before it go.
      const wrong = marks.filter(m => m.era < era && (compare(m.labels.at(-1), mark.labels[0]) < 0 ? m.pos + m.labels.length - 1 >= mark.pos
        : compare(m.labels[0], mark.labels.at(-1)) > 0 ? m.pos <= mark.pos + mark.labels.length - 1 : false));
      if (wrong.length) { const last = Math.max(...wrong.map(m => m.era)); marks = marks.filter(m => m.era > last); }
      if (marks.at(-1)?.pos !== pos || !sameRows(marks.at(-1), seen)) marks.push(mark);
      if (marks.length > 24) marks.shift();
    };
    // Where the target's row should be, from the labels on both sides of it (interpolated) or on one side (extrapolated from
    // the two farthest apart, at most GROW times the rows seen). Labels compare by their first characters after the prefix
    // they share; the order itself always comes from `compare`, so a poor estimate costs reads, never a wrong row.
    const fold = s => words(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    // Letters spread over the scale and everything else sorts below them, as the collation puts spaces, punctuation and digits.
    const rank = c => c === undefined ? 0 : c >= 'a' && c <= 'z' ? 2 + c.charCodeAt(0) - 97 : c > 'z' ? 28 : 1;
    // A digit run at `from` counts as its number, as the numeric collation sorts it, when all three labels have one there.
    const digits = (s, from) => { let k = from; while (k > 0 && /\d/.test(s[k - 1])) k--; return /^\d+/.exec(s.slice(k))?.[0]; };
    const spot = (s, from, numeric) => {
      if (numeric) return Number(digits(s, from));
      let x = 0, w = 1;
      for (let i = 0; i < 8; i++) { w /= 29; x += rank(s[from + i]) * w; }
      return x;
    };
    const shared = (...xs) => { let n = 0; while (xs.every(x => n < x.length && x[n] === xs[0][n])) n++; return n; };
    const estimate = () => {
      let lo, hi;
      const points = [];
      for (const m of marks) m.labels.forEach((text, i) => {
        const p = { idx: m.pos + i, label: text, folded: fold(text), side: Math.sign(compare(text, target)), mark: m };
        points.push(p);
        if (p.side < 0 && (!lo || compare(text, lo.label) > 0)) lo = p;
        if (p.side > 0 && (!hi || compare(text, hi.label) < 0)) hi = p;
      });
      const t = fold(target);
      // The row where the target's value falls on the line through a and b. Values that disagree with the order `compare`
      // gives (a below b, the target on its side of them) mean the measure doesn't fit these labels, so nothing is estimated.
      const line = (a, b, from) => {
        const numeric = [a.folded, b.folded, t].every(s => digits(s, from) !== undefined);
        const va = spot(a.folded, from, numeric), vb = spot(b.folded, from, numeric), vt = spot(t, from, numeric);
        const side = Math.sign(compare(target, a.label)) + Math.sign(compare(target, b.label));
        const fits = vb > va && (side === 0 ? vt > va && vt < vb : side > 0 ? vt > vb : vt < va);
        return b.idx - a.idx >= 2 && fits ? a.idx + (vt - va) / (vb - va) * (b.idx - a.idx) : undefined;
      };
      // From one side: the slope between the nearest point and the farthest one that differs from it no later than the target
      // does, preferring the one sharing the longest prefix with both, so it comes from rows that differ where the target
      // differs. Rows of one cluster ("Dalbridge" to "Dalwood") say nothing about the distance to "Dunbridge".
      const extrapolate = (near, local) => {
        const split = shared(near.folded, t);
        const best = points.filter(p => p.side === near.side && Math.abs(p.idx - near.idx) >= 4 && (!local || p.mark === near.mark))
          .reduce((best, p) => {
            const k = shared(p.folded, near.folded, t), d = Math.abs(p.idx - near.idx), early = shared(p.folded, near.folded) <= split;
            return !best || early > best.early || (early === best.early && (k > best.k || (k === best.k && d > best.d))) ? { p, k, d, early } : best;
          }, undefined);
        // Without a row that differs from the nearest one where the target does, the slope of the rows seen still stands
        // for one side (the extrapolation's cap bounds it), but not inside a bracket.
        return best && (best.early || !local) ? (near === lo ? line(best.p, lo, best.k) : line(hi, best.p, best.k)) : undefined;
      };
      let idx;
      if (lo && hi) {
        if (hi.idx - lo.idx < 2) return undefined;
        // Interpolation, or the middle of the bracket after two moves that each left more than half of it (skewed labels).
        const width = hi.idx - lo.idx, halve = stalls >= 2;
        // A side sharing more of the target's prefix than the two sides share knows the spacing near the target better, from
        // the rows of its own read.
        const from = shared(lo.folded, hi.folded), closer = [lo, hi].filter(p => shared(p.folded, t) > from)
          .sort((a, b) => shared(b.folded, t) - shared(a.folded, t))[0];
        // That read's own rows know nothing past them, so it reaches at most four reads' worth of rows.
        const local = closer && extrapolate(closer, true), reach = 4 * closer?.mark.labels.length;
        idx = halve ? undefined : local !== undefined ? Math.max(closer.idx - reach, Math.min(closer.idx + reach, local)) : line(lo, hi, from);
        // An estimate outside the bracket says the measure doesn't fit here: the middle of the bracket instead.
        if (!(idx > lo.idx && idx < hi.idx)) idx = (lo.idx + hi.idx) / 2;
        return { idx, bracket: true, width };
      } else if (lo || hi) {
        const span = Math.max(...points.map(p => p.idx)) - Math.min(...points.map(p => p.idx)) + 1;
        // Past the rows seen so far: the slope's estimate, at most GROW times those rows; without a slope, as many rows again.
        const near = lo ?? hi;
        idx = extrapolate(near) ?? near.idx + (lo ? span : -span);
        idx = lo ? Math.min(idx, lo.idx + GROW * span) : Math.max(idx, hi.idx - GROW * span);
      }
      return Number.isFinite(idx) ? { idx, bracket: false } : undefined;
    };
    // Rows the list moved from `a` to `b` in direction d, from their overlap. Without one it moved past every rendered
    // row (Firefox: 36 rows a 4-key step against 16 rendered), which measures nothing but is no slow mover.
    const shifted = (a, b, d) => {
      const at = d > 0 ? a.labels.indexOf(b.labels[0]) : b.labels.indexOf(a.labels[0]);
      return at >= 0 ? at : undefined;
    };
    // A list held at an end shifts its rendered rows less than it moved, so the largest measurement stands.
    // A step past every rendered row moved at least that many rows: a lower bound (`atLeast`), never a rate for moves.
    const atLeast = {}, capped = {};
    // The mover's rows take the larger of the shifts its first and last labels show: at the list's top the first rendered
    // row stays put while the rows below it move.
    const measure = (how, a, b, d, units) => {
      const back = d > 0 ? b.labels.indexOf(a.labels.at(-1)) : a.labels.indexOf(b.labels.at(-1));
      const rows = Math.max(shifted(a, b, d) ?? -1, back < 0 ? -1 : (d > 0 ? b : a).labels.length - 1 - back);
      if (rows < 0) return void (atLeast[how] = Math.max(atLeast[how] ?? 0, a.labels.length / units));
      // A move of several units that went well under the best rate per unit seen: the mover tops out near those rows a move.
      if (units > 1 && rows < 0.6 * units * (rate[how] ?? 0)) capped[how] = Math.max(capped[how] ?? 0, rows);
      rate[how] = Math.max(rate[how] ?? 0, rows / units);
    };
    const move = async (d, units, how = mover) => {
      if (how === 'key' && !v.focused) throw new Error('pickFromList stopped: no read shows the focus on the list, so no key was sent. Read the window again.');
      lastMover = how; confirmed = null;
      let next;
      if (how === 'key') {
        // At most BURST keys go out unread. Between bursts a read must show the same list focused and the row still
        // ahead; a read that shows the row, or one past it, ends the move there. The time cap ends a burst after a key.
        for (let pressed = 0; pressed < units;) {
          const burst = Math.min(BURST, units - pressed);
          pending = { d, units: burst, how };
          let sent = 0;
          while (sent < burst && !(pressed + sent && now() >= deadline)) { await press(d > 0 ? 'Page_Down' : 'Page_Up'); keys++; sent++; }
          pending.units = sent; pressed += sent; lastStep = pressed;
          next = await look();
          if (sent < burst || pressed >= units || reads >= maxReads || next.problem || !next.focused || !sameElement(v.list, next.list) ||
              !next.labels.length || next.rows.some(isMatch) || compare(target, d > 0 ? next.labels.at(-1) : next.labels[0]) * d <= 0) break;
        }
      } else {
        pending = { d, units, how };
        await scroll(v.list, d > 0 ? 'down' : 'up', units); ticks += units; lastStep = units;
        next = await look();
      }
      // An unchanged window can be a redraw still in flight: look once more before calling it stuck.
      if (sameRows(next, v) && reads < maxReads) { await sleep(80); next = await look(); }
      return next;
    };
    // The finest measured mover, for small moves; a key when nothing was measured yet. Keys only after a read that shows
    // the focus on the list: with only a "Selected:" row nothing shows where keys go.
    const finest = () => {
      const keyed = v.focused || !scroll;
      const movers = ['key', 'wheel'].filter(how => rate[how] > 0 && (how === 'key' ? keyed : scroll));
      return movers.sort((a, b) => rate[a] - rate[b])[0] ?? (scroll && (rate.key === 0 || !keyed) ? 'wheel' : 'key');
    };
    const moverName = how => how === 'key' ? (direction > 0 ? 'Page_Down' : 'Page_Up') : 'the scroll wheel';
    v = await look();
    // CC2: a list named in the call that the read doesn't show focused gets one click on a row in the band shown wherever
    // the list is scrolled (the middle of the rendered rows), or on the list itself after that row has no frame. Haiku's own
    // first click hit an overscan row with no frame in 3 of 6 Firefox travel runs (codex-vs-cc-1019).
    if (listRef !== undefined) {
      const named = locate(lastText, listRef, typeof listRef === 'number' ? lineSeen?.(listRef) : undefined);
      if (named.problem) return stop('not-a-list', named.problem + ' No key was sent.');
      if (v.problem || !sameElement(v.list, named.list.body)) {
        // Only a sorted list of plain rows gets the click: at least three labels in strictly ascending order, and no role
        // that acts when clicked (a row of buttons or a tab strip).
        const { role, labeled } = labelRows(named.kids), order = labeled.map(row => row.label);
        if (ACTIONABLE.test(role)) return stop('not-a-list', JSON.stringify(named.list.body.slice(0, 60)) + ' holds ' + role + ' rows, which act when clicked, so it was not clicked. No key was sent.');
        if (order.length < 3 || order.some((text, i) => i && compare(order[i - 1], text) >= 0)) {
          return stop('not-a-list', JSON.stringify(named.list.body.slice(0, 60)) + ' does not show three or more labeled rows in ascending order, so it was not clicked. No key was sent.');
        }
        const n = named.kids.length, lo = Math.floor(3 * n / 8), hi = Math.max(lo, Math.ceil(5 * n / 8) - 1);
        const tries = [...(n ? [named.kids[Math.floor((lo + hi) / 2)]] : []), named.list];
        for (let i = 0; ; i++) {
          try { await click(tries[i].body); }
          catch (error) {
            if (!/elementHasNoFrame|\bis an invalid element ID\b/.test(String(error?.message ?? error))) throw error;
            if (i + 1 < tries.length) continue;
            return stop('not-a-list', 'Neither a row of the list nor the list itself had a frame to click (' + String(error?.message ?? error).split('\n')[0] + '). No key was sent.');
          }
          lastClick = { number: tries[i].number, line: tries[i].body }; focusRow = tries[i].body;
          break;
        }
        v = await look();
        // A background click can select its row while focus still names an enclosing container (Firefox, release
        // smoke 2026-10-27). Give that read one chance to settle. Repeat only the exact row whose selection is then
        // proven, in the same unique list, with focus on a passive ancestor. No key or wheel goes out on this path.
        const focusCandidate = () => {
          const { rows } = parseRows(lastText);
          const lists = rows.map((row, i) => i).filter(i => LIST_ROLE.test(rows[i].body) && sameElement(named.list.body, rows[i].body));
          if (lists.length !== 1) return undefined;
          const list = lists[0], focus = /^The focused UI element is (\d+) (.+?)\r?$/m.exec(lastText);
          const at = focus ? rows.findIndex(row => row.number === Number(focus[1]) && sameElement(focus[2], row.body)) : -1;
          if (at < 0 || !/^(?:container|scroll area|standard window|HTML content)(?: |,|$)/i.test(rows[at].body)) return undefined;
          if (/\([^()]*\bsettable\b[^()]*\)/.test(rows[at].body) || /(?:^|, )(?:Secondary Actions|Actions):/.test(rows[at].body)) return undefined;
          let ancestor = parent(rows, list);
          while (ancestor >= 0 && ancestor !== at) ancestor = parent(rows, ancestor);
          if (ancestor !== at) return undefined;
          const matches = childRows(rows, list).filter(row => sameElement(lastClick.line, row.body));
          if (matches.length !== 1 || !keyFocus(rows, rows.indexOf(matches[0]), list)) return undefined;
          return matches[0];
        };
        if (v.problem && focusCandidate() && reads < maxReads && now() < deadline) {
          await sleep(Math.min(80, deadline - now()));
          if (now() < deadline) v = await look();
          const row = focusCandidate();
          if (v.problem && row && /\((?:[^()]*, )?selected(?:, [^()]*)?\)/.test(row.body) && reads < maxReads && now() < deadline) {
            await click(row.body);
            lastClick = { number: row.number, line: row.body };
            v = await look();
          }
        }
        if (v.problem || !sameElement(v.list, named.list.body)) return stop('focus-lost', 'The click did not focus the named list. No key was sent.');
      }
    }
    // A read that names only a selected row: the wheel on the list, which needs no focus, until a read shows the focus.
    let blind = !v.problem && !v.focused;
    if (blind) {
      if (!scroll) return stop('not-a-list', 'Only a selected row names the list, and keys need a read that shows the focus on it.');
      mover = 'wheel'; step = FIRST_TICKS;
    }
    for (;;) {
      if (v.problem) return stop(listLine ? 'focus-lost' : 'not-a-list', v.problem + (listLine ? (keys ? ' Keys may have reached another control.' : ' No key was sent.') : listRef === undefined ? ' Name the list first: `app.pickFromList(<list number>, "<whole row text>")`.' : ' The click on the list did not focus it.'));
      if (listLine && !sameElement(listLine, v.list)) {
        return stop('focus-lost', 'Focus moved from ' + JSON.stringify(listLine.slice(0, 60)) + ' to ' + JSON.stringify(v.list.slice(0, 60)) + '. Keys may have reached another control.');
      }
      if (listLine && keys && !v.focused) {
        return stop('focus-lost', 'Focus is no longer on the list or a plain row descendant. Keys may have reached another control.');
      }
      listLine ??= v.list;
      if (v.labels.length < 3) return stop('not-a-list', 'The list shows fewer than three labeled rows, so its order cannot be checked.');
      const bad = v.labels.findIndex((text, i) => i && compare(v.labels[i - 1], text) >= 0);
      if (bad > 0) return stop('unsorted', 'The visible rows are not in strictly ascending order (' + JSON.stringify(v.labels[bad - 1]) + ' before ' + JSON.stringify(v.labels[bad]) + '), so a position cannot be inferred.');
      if (previous) {
        if (sameRows(v, previous)) {
          // A single measuring key can stay inside rows the list renders past its top (Safari: 2.2 rows a key): a coarse step
          // before deciding that keys don't reach the list.
          if (lastMover === 'key' && lastStep < coarse && rate.key === undefined && keys + coarse <= MAX_KEYS && now() < deadline) {
            v = await move(direction, coarse);
            continue;
          }
          // Keys that move nothing may not reach the list; the wheel scrolls the list itself.
          if (lastMover === 'key' && scroll && rate.wheel === undefined) {
            rate.key = 0; mover = 'wheel'; step = FIRST_TICKS;
            if (now() >= deadline || ticks + step > MAX_TICKS) return stop('cap', 'The search reached its ' + (now() >= deadline ? 'time' : 'wheel') + ' cap.');
            v = await move(direction, step);
            continue;
          }
          // Firefox's wheel moves about half a row a tick (10 ticks, 5 rows: b7 r2 c16), which the overscan held at the top
          // of the list hides. The ticks double up to 8 before the wheel counts as stuck.
          if (lastMover === 'wheel' && lastStep < 8 && ticks + lastStep * 2 <= MAX_TICKS && now() < deadline) {
            step = lastStep * 2;
            v = await move(direction, step);
            continue;
          }
          return stop('no-progress', 'The list did not move after ' + moverName(lastMover) + ' (' + (direction > 0 ? 'the end' : 'the top') + ' of the list, or ' + (lastMover === 'key' ? 'keys' : 'the wheel') + ' not reaching it).');
        }
        const was = previous.labels;
        // A list held at its end moves only its first rendered rows, and at its top only its last.
        const ends = [compare(v.labels[0], was[0]), compare(v.labels.at(-1), was.at(-1))].map(n => n * direction);
        const moved = ends.every(n => n >= 0) && ends.some(n => n > 0);
        if (!moved) return stop('unsorted', 'The rows went the wrong way after ' + moverName(lastMover) + ', so the list is not a plain sorted list.');
        if (fine && lastStep === 1 && !v.labels.some(text => was.includes(text))) {
          return stop('gap', 'One step moved past every previously seen row, so rows may have been skipped.');
        }
        measure(lastMover, previous, v, direction, lastStep);
        heldAt = 0;
        // Safari's web list: about 2.2 rows a Page_Down against 10 a wheel tick (b7 r1 and r3).
        if (mover === 'key' && lastMover === 'key' && rate.key < MIN_KEY_ROWS && scroll) { mover = 'wheel'; step = FIRST_TICKS; }
      }
      // Focus shows on the list now: keys may go, and they take over from a wheel slower than MIN_KEY_ROWS rows a tick.
      if (blind && v.focused) {
        blind = false;
        if (!(Math.max(rate.wheel ?? 0, atLeast.wheel ?? 0) >= MIN_KEY_ROWS)) { mover = 'key'; step = fine ? 1 : coarse; }
      }
      const hits = v.rows.filter(isMatch);
      if (hits.length > 1) return stop('ambiguous', hits.length + ' rows match ' + JSON.stringify(target) + '.');
      if (hits.length === 1) {
        // Rows rendered past the visible band have no frame, or a frame under other controls. The travel list renders 16
        // rows and shows 10: rendered rows 3 to 12 in the middle of the list, 0 to 9 at its top and 6 to 15 at its end. The
        // row is clicked inside the band shown at every place the list can still be. It can be at its top until a row before
        // the first rendered one is seen, and is known there once a move up leaves the rows as they were; its end likewise.
        // Generic bands: the middle half, plus the first or last five eighths at an end.
        const n = v.rows.length, at = v.rows.indexOf(hits[0]);
        const topOpen = !!lowest && compare(lowest, v.labels[0]) < 0, endOpen = !!highest && compare(highest, v.labels.at(-1)) > 0;
        let lo = Math.floor(n / 4), hi = n - 1 - Math.floor(n / 4);
        if (heldAt < 0) { lo = 0; hi = Math.ceil(5 * n / 8) - 1; }
        else if (heldAt > 0) { lo = Math.floor(3 * n / 8); hi = n - 1; }
        else {
          if (!topOpen) hi = Math.min(hi, Math.ceil(5 * n / 8) - 1);
          if (!endOpen) lo = Math.max(lo, Math.floor(3 * n / 8));
        }
        if ((at < lo || at > hi) && centering < MAX_CENTERING && reads < maxReads - 1 && now() < deadline) {
          // d > 0 scrolls the list down, which moves the row up the rendered rows.
          const d = at > hi ? 1 : -1;
          let how = finest(), unit = rate[how] > 0 ? rate[how] : undefined;
          const landing = units => at - d * units * unit, miss = i => i < lo ? lo - i : i > hi ? i - hi : 0;
          // The units that leave the row nearest the band and still rendered, if that is nearer than now: a 10-row wheel
          // tick would take Safari's fourth rendered row to its fourteenth. A move back the other way goes only into the
          // band: a 9-row Firefox key otherwise takes a row from one side of it to the other and back.
          let units = unit ? 0 : 1;
          for (let k = 1; unit && k <= Math.ceil(n / unit); k++) {
            const i = landing(k);
            if (i >= 0 && i <= n - 1 && miss(i) < miss(units ? landing(units) : at)) units = k;
          }
          if (d === -centerDir && !(unit && units && !miss(landing(units)))) units = 0;
          // No count of this mover reaches the band (a 9-row Firefox key from two rows past it to two rows before it, a 10-row
          // Safari wheel tick likewise): one unit of the other mover, unmeasured so far, which the next pass measures.
          const other = how === 'key' ? 'wheel' : 'key';
          if (!units && rate[other] === undefined && !atLeast[other] && (other === 'wheel' ? !!scroll : v.focused)) { how = other; unit = undefined; units = 1; }
          if (units > 0 && (how === 'key' ? keys + units <= MAX_KEYS : ticks + units <= MAX_TICKS)) {
            centering++; centerDir = d;
            const before = v;
            v = await move(d, units, how);
            // Rows that stay put after a move toward an end: the list is at that end when rows past the other side were
            // seen, or when the move was longer than the rows rendered past the shown ones (3/8 of them), so it was no
            // overscan held at the other end. An unmeasured move up counts as long: a list opens at its top.
            if (sameRows(v, before)) { if ((d < 0 ? endOpen : topOpen) || (unit ? units * unit >= 3 * n / 8 : d < 0)) heldAt = d; }
            else { heldAt = 0; measure(how, before, v, d, units); }
            previous = undefined;
            continue;
          }
        }
        // The match came from a tree taken before any later key or redraw. Click only a row that the newest tree shows
        // once, with no key pressed since the tree before it. A row outside the band moves first and is confirmed after.
        if (confirmed !== hits[0].label) {
          if (reads >= maxReads) return stop('cap', 'The search reached its read cap before confirming the row.');
          confirmed = hits[0].label; previous = undefined;
          v = await look();
          continue;
        }
        try { await click(hits[0].body); }
        catch (error) {
          if (!/elementHasNoFrame|\bis an invalid element ID\b/.test(String(error?.message ?? error))) throw error;
          // The engine sends nothing for a row with no frame. Read again, move the row one unit toward the middle, and
          // retry once.
          if (!retried && reads < maxReads - 2 && now() < deadline) {
            retried = true; previous = undefined; confirmed = null;
            const before = v;
            v = await look();
            const again = v.rows?.find(isMatch);
            centering = 0; centerDir = 0;
            if (again && sameRows(v, before)) {
              const d = v.rows.indexOf(again) > (v.rows.length - 1) / 2 ? 1 : -1;
              v = await move(d, 1, finest());
              if (!sameRows(v, before)) { heldAt = 0; measure(lastMover, before, v, d, 1); }
              // Centering may go on the same way; back the other way only into the band, never to where it had no frame.
              centerDir = d;
            }
            continue;
          }
          return { found: true, clicked: false, reason: 'click-failed', reads, keys, ...(ticks ? { ticks } : {}), label: hits[0].label,
            note: 'The row was found but could not be clicked (' + String(error.message ?? error).split('\n')[0] + '). Input may have been sent. Read the window before retrying.' };
        }
        // The read after the click must show this row selected: a click on a row the list does not show reaches what is
        // drawn there (in Firefox's travel form, the Back and Next buttons sit right under the list).
        const after = await look();
        const picked = after.rows?.find(isMatch);
        if (!picked || !/\((?:[^()]*, )?selected(?:, [^()]*)?\)/.test(picked.body)) {
          return { found: true, clicked: false, reason: 'click-unverified', reads, keys, ...(ticks ? { ticks } : {}), label: hits[0].label,
            note: 'The row was clicked, but the read after it does not show it selected, so the click may have reached another control. Read the window before retrying.' };
        }
        return { found: true, clicked: true, label: hits[0].label, reads, keys, ...(ticks ? { ticks } : {}), ...(focusRow ? { focusClick: focusRow } : {}) };
      }
      const first = v.labels[0], last = v.labels.at(-1);
      if (compare(target, first) >= 0 && compare(target, last) <= 0) {
        return stop('not-in-list', JSON.stringify(target) + ' sorts between visible rows ' + JSON.stringify(first) + ' and ' + JSON.stringify(last) + ' but no row has that label.');
      }
      const need = compare(target, last) > 0 ? 1 : -1;
      // CC3: once a step measured the mover, move straight to the estimated row, aimed at the middle of the rendered rows.
      // A window seen a third time means the jumps go round in a circle (a rate measured short at the list's top): the
      // search finishes with the steps below, as it did before jumps.
      const key = v.labels[0] + '\n' + v.labels.at(-1);
      windows.set(key, (windows.get(key) ?? 0) + 1);
      if (windows.get(key) >= 3) circled = true;
      // Jumps stop once they have spent three quarters of the key or wheel budget, leaving the steps below room to finish.
      if (keys > MAX_KEYS * 3 / 4 || ticks > MAX_TICKS * 3 / 4) circled = true;
      const guess = rate[mover] > 0 && !circled ? estimate() : undefined;
      let units;
      if (guess) {
        const rows = guess.idx - (pos + (v.labels.length - 1) / 2);
        units = Math.sign(rows) === need ? Math.round(Math.abs(rows) / rate[mover]) : 0;
        // A bracket two windows wide or less is stepped through one unit at a time, so no row in it goes unseen.
        if (guess.bracket && guess.width <= 2 * v.labels.length) units = Math.min(units, 1);
      }
      // The bracket this move starts from, for the next estimate to check that it shrank.
      stalls = guess?.bracket && lastWidth !== undefined && guess.width > lastWidth / 2 ? stalls + 1 : 0;
      lastWidth = guess?.width;
      if (units >= 2) {
        // A mover that tops out moves no more than its top rows' worth of units at once.
        const most = capped[mover] ? Math.max(1, Math.ceil(capped[mover] / rate[mover])) : Infinity;
        step = Math.max(1, Math.min(units, most, (mover === 'key' ? MAX_KEYS : MAX_TICKS) * 3 / 4 - (mover === 'key' ? keys : ticks)));
      } else {
        if (direction && need !== direction) {
          // Only when this window came from that single step: a redraw in between proves nothing about the rows passed.
          if (fine && lastStep === 1 && previous) return stop('not-in-list', 'Rows on both sides were checked step by step and none has that label.');
          fine = true;
        }
        // The row is within a unit or two of an interpolated estimate: single steps.
        if (guess?.bracket) fine = true;
        // Unmeasured keys take one, which measures them for the jumps above (unless one key moves past every rendered row),
        // then page coarse, and one at a time after the first reversal. The wheel doubles its ticks until it passes the
        // row, then halves them each step; after a step past every rendered row it takes one tick, which measures it.
        if (mover === 'key') step = fine || (rate.key === undefined && !atLeast.key) ? 1 : coarse;
        else if (guess?.bracket || (rate.wheel === undefined && atLeast.wheel > 0)) step = 1;
        else if (fine) step = Math.max(1, Math.floor(step / 2));
        else if (direction === need && lastMover === 'wheel') step = Math.min(MAX_TICK_STEP, step * 2);
      }
      direction = need;
      if (reads >= maxReads || (mover === 'key' ? keys + step > MAX_KEYS : ticks + step > MAX_TICKS) || now() >= deadline) {
        return stop('cap', 'The search reached its ' + (reads >= maxReads ? 'read' : now() >= deadline ? 'time' : mover === 'key' ? 'key' : 'wheel') + ' cap.');
      }
      previous = v;
      v = await move(direction, step);
    }
  };
}

// CC1: the list in `after` whose rows a scroll or page key moved since `before` and that still shows at least three rows in
// strictly ascending order, as { number, body }, or undefined. Lines are a tree's lines (tabs, number, text). Haiku scrolled
// the travel airport list before trying the helper in 5 of 6 Firefox runs (codex-vs-cc-1019); the relay names the helper then.
export function sortedListShift(before, after) {
  const LIST = /^(?:list box|listbox|list)(?: \([^()]*\))*(?: |,|$)/;
  const compare = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const lists = lines => {
    const rows = (Array.isArray(lines) ? lines : []).map(line => /^(\t*)(\d+) (.*?)\r?$/.exec(line)).filter(Boolean)
      .map(m => ({ depth: m[1].length, number: Number(m[2]), body: m[3] }));
    const found = [];
    rows.forEach((row, at) => {
      if (!LIST.test(row.body)) return;
      const kids = [];
      for (let i = at + 1; i < rows.length && rows[i].depth > row.depth; i++) if (rows[i].depth === row.depth + 1) kids.push(rows[i].body);
      // The role is the lowercase words every row starts with, states included, as the helper reads it.
      const runs = kids.map(body => { const parts = body.split(' '), end = parts.findIndex(word => !/^[a-z]+$/.test(word)); return parts.slice(0, end < 0 ? parts.length : end); });
      const role = runs.reduce((common, run) => { let n = 0; while (n < common.length && common[n] === run[n]) n++; return common.slice(0, n); }, runs[0] ?? []).join(' ');
      const labels = kids.map(body => body.slice(role.length).trimStart().replace(/^(?:\([^()]*\) )+/, '').split(/, (?=(?:Value|ID|Help|Secondary Actions|Description|URL): )/)[0]).filter(Boolean);
      // Rows that act when clicked (the helper's ACTIONABLE roles) make no list the helper would pick from.
      if (!/\b(?:button|link|menu item|check box|tab|switch|disclosure triangle)$/.test(role)) found.push({ number: row.number, body: row.body, labels });
    });
    return found;
  };
  const was = lists(before);
  for (const list of lists(after)) {
    const old = was.find(item => item.body === list.body) ?? was.find(item => item.number === list.number && LIST.test(item.body));
    if (!old || list.labels.length < 3 || JSON.stringify(old.labels) === JSON.stringify(list.labels)) continue;
    if (list.labels.every((label, i) => !i || compare(list.labels[i - 1], label) < 0)) return { number: list.number, body: list.body };
  }
  return undefined;
}

// Kept outside the default serialized picker until the completeness A/B qualifies it.
export function withNativeCompleteness(pick) {
  return async (...args) => {
    const result = await pick(...args);
    return { ...result, completeness: result.clicked ? 'complete (selection readback); row total unknown'
      : result.found ? 'row total unknown; selection unverified' : 'row total unknown; search incomplete' };
  };
}

export function listPickerCode(completeness = false) {
  return completeness ? `options => (${withNativeCompleteness.toString()})((${listPicker.toString()})(options))` : listPicker.toString();
}
