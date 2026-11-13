import test from 'node:test';
import assert from 'node:assert/strict';
import { compareMacElement, createMacReadState } from '../plugins/sleight/lib/mac-driver/diff.mjs';
import { attacks } from './fixtures/rt11f-attacks.mjs';

const header = 'Window: "Draft", App: Editor.\n';
const tree = lines => header + lines.map((line, n) => line.replace(/^(\t*)/, `$1${n} `)).join('\n');
const window = { windowId: '101', pid: 120, processStart: '100.25', bundleId: 'com.example.Editor',
  app: 'Editor', title: 'Draft', identityVerified: true };
const snapshot = (readId, text) => ({ window, readId, text, truncated: false });
const request = (readId, target) => ({ windowId: '101', processStart: '100.25', readId, args: [target] });
const deliver = (state, read) => state.endCell([{ type: 'text', text: read.text }], [read]);
const fault = { code: 'STALE_READ', delivery: 'not-sent', retry: 'safe' };

// Independent acceptance examples: one label for each action family in each
// requested language. These are behavior probes, not imports of the matcher.
const languages = ['en', 'es', 'fr', 'de', 'pt', 'it', 'ja', 'zh', 'ko'];
const families = [
  ['confirm', 'Confirm|Confirmar|Confirmer|Bestätigen|Confirmar|Conferma|確認|确认|확인'],
  ['submit', 'Submit|Enviar|Soumettre|Absenden|Submeter|Invia|提出|提交|제출'],
  ['send', 'Send|Enviar|Envoyer|Senden|Enviar|Invia|送信|发送|보내기'],
  ['authorize', 'Authorize|Autorizar|Autoriser|Autorisieren|Autorizar|Autorizza|認可|授权|허가'],
  ['approve', 'Approve|Aprobar|Approuver|Genehmigen|Aprovar|Approva|承認|批准|승인'],
  ['sign', 'Sign|Firmar|Signer|Unterschreiben|Assinar|Firma|署名|签署|서명'],
  ['pay', 'Pay|Pagar|Payer|Bezahlen|Pagar|Paga|支払い|支付|결제'],
  ['payment', 'Payment|Pago|Paiement|Zahlung|Pagamento|Pagamento|決済|付款|지불'],
  ['purchase', 'Purchase|Comprar|Acheter|Kaufen|Comprar|Acquista|購入|购买|구매'],
  ['checkout', 'Check out|Finalizar compra|Passer commande|Zur Kasse|Finalizar compra|Procedi al pagamento|決済|结账|결제'],
  ['subscribe', 'Subscribe|Suscribirse|Souscrire|Abonnieren|Subscrever|Abbonati|購読|订阅|구독'],
  ['transfer', 'Transfer|Transferir|Transférer|Überweisen|Transferir|Trasferisci|送金|转账|이체'],
  ['withdraw', 'Withdraw|Retirar|Retirer|Abheben|Sacar|Preleva|出金|提现|출금'],
  ['remove', 'Remove|Eliminar|Supprimer|Entfernen|Remover|Rimuovi|削除|移除|제거'],
  ['erase', 'Erase|Borrar|Effacer|Löschen|Apagar|Cancella|消去|擦除|지우기'],
  ['publish', 'Publish|Publicar|Publier|Veröffentlichen|Publicar|Pubblica|公開|发布|발행'],
  ['post', 'Post|Publicar|Publier|Posten|Postar|Pubblica|投稿|发表|게시'],
  ['reply', 'Reply|Responder|Répondre|Antworten|Responder|Rispondi|返信|回复|답장'],
  ['share', 'Share|Compartir|Partager|Teilen|Compartilhar|Condividi|共有|分享|공유'],
  ['order', 'Order|Pedir|Commander|Bestellen|Encomendar|Ordina|注文|下单|주문'],
  ['book', 'Book|Reservar|Réserver|Buchen|Reservar|Prenota|予約|预订|예약'],
  ['buy', 'Buy|Comprar|Acheter|Kaufen|Comprar|Compra|買う|买|구입'],
  ['delete', 'Delete|Eliminar|Supprimer|Löschen|Excluir|Elimina|削除|删除|삭제'],
  ['save', 'Save|Guardar|Enregistrer|Speichern|Salvar|Salva|保存|保存|저장'],
  ['finish', 'Finish|Finalizar|Terminer|Beenden|Terminar|Termina|終了|结束|마침'],
  ['complete', 'Complete|Completar|Compléter|Abschließen|Concluir|Completa|完了|完成|완료'],
  ['reserve', 'Reserve|Reservar|Réserver|Reservieren|Reservar|Riserva|予約|预约|예약'],
  ['donate', 'Donate|Donar|Faire un don|Spenden|Doar|Dona|寄付|捐款|기부'],
  ['upgrade', 'Upgrade|Mejorar|Mettre à niveau|Upgraden|Atualizar|Aggiorna|アップグレード|升级|업그레이드'],
  ['charge', 'Charge|Cobrar|Facturer|Belasten|Cobrar|Addebita|請求|收费|청구'],
];
function assertBound(label) {
  const original = ['standard window Draft', '\ttext Ready', '\tbutton ' + label, '\ttext Later'];
  const before = tree(original);
  assert.equal(compareMacElement(before, before, 2).to, 2, 'unchanged tree');
  for (const [name, lines] of [
    ['below', original.map(line => line.replace('text Later', 'text Changed'))],
    ['above', original.map(line => line.replace('text Ready', 'text Changed'))],
    ['insert', [original[0], '\ttext Banner', ...original.slice(1)]],
    ['remove', [original[0], ...original.slice(2)]],
    ['append', [...original, '\ttext Added']],
    ['flags', original.map(line => line.replace('button ', 'button (focused) '))],
  ]) {
    const after = tree(lines);
    const result = compareMacElement(before, after, 2, { acted: [2] });
    assert.equal(result.to, undefined, name);
    assert.equal(result.why, 'consequential-tree', name);
    // Exercise delivery, refusal disposition and a fresh delivered read too.
    const state = createMacReadState(); deliver(state, state.read(snapshot(1, before)));
    const current = state.read(snapshot(2, after)), params = request(2, 2);
    assert.throws(() => state.assertCurrent('click', params, 'labels'), fault, name);
    assert.equal(params.args[0], 2, 'refusal does not mutate the number');
    deliver(state, current);
    const target = lines.findIndex(line => line.includes('button '));
    state.assertCurrent('click', request(2, target), 'fresh');
  }
}
for (const [family, labels] of families) {
  const examples = labels.split('|');
  assert.equal(examples.length, languages.length);
  for (const [i, label] of examples.entries()) test(`RT11J ${family} in ${languages[i]}: ${label}`, () => assertBound(label));
}

for (const label of ['Authorise', 'Place order', 'Place your order', 'Complete order', 'Order now', 'Book now',
  'Send money', 'Confirm order', 'Confirm purchase', 'Confirm payment', 'Confirm and pay', 'Submit order', 'Submit payment',
  'S’abonner', "S'abonner", 'Buchung abschließen', 'Partilhar', 'Fazer pedido', 'Guardar', 'Prelevare', 'Condividere',
  '轉帳', '轉賬', '結帳', '發佈', '發布', '回覆', '訂閱', '刪除', '預約', '儲存', '捐贈', '송금', '인출'])
  test(`RT11J phrase or regional variant: ${label}`, () => assertBound(label));

for (const label of ['Send_it', 'CHECK_OUT', 'Send-it', 'Send‐it', 'Send−it', 'Send\u00a0it', '  Send\t it  ',
  'Con\u200bfirm', 'Con\u200cfirm', 'Con\u200dfirm', 'Con\u2060firm', 'Con\ufefffirm', 'Con\u202efirm',
  'Ｃonfirm', 'ＣＯＮＦＩＲＭ', 'Conﬁrm', 'Ѕend', 'Сonfirm', 'cоnfіrm', 'Αpprove', 'аррrоve', 'Аuthоrіze',
  'BEЅTÄTIGEN', 'LÖSCHEN', 'RÉPONDRE', '送\u200b信', '发\u2060送', '보\u200d내기', 'ＳＥＮＤ_ＭＯＮＥＹ'])
  test(`RT11J normalized label: ${JSON.stringify(label)}`, () => assertBound(label));

// Capitals whose lowercase is not a Latin lookalike (Greek Nu, Eta, Beta; Cyrillic Ve, En) escape the shared
// skeleton, so a word mixing Latin with Greek or Cyrillic fails closed (rt11j-review SHOULD-FIX 1).
for (const label of ['SEΝD', 'COΝFIRM', 'TRAΝSFER', 'ΒOOK', 'ВUY', 'CΗARGE', 'SIGН', 'ΒUY NOW', 'Ѕtart'])
  test(`RT11J mixed-script capital lookalike: ${JSON.stringify(label)}`, () => assertBound(label));

for (const label of ['Confirmé', 'Sendé', 'Booké', 'Saveé', 'Submité', 'Transferé', 'Orderé', 'Buyé', 'Deleteé',
  'Finishé', 'Completeé', 'Reserveé', 'Place your orderé'])
  test(`RT11J preserves an existing English boundary refusal: ${label}`, () => assertBound(label));

for (const target of ['button Sending', 'button Orders', 'button Books', 'button Deleted', 'button Confirmation',
  'button Approval', 'button Authorization', 'button Signature', 'button Significant', 'button Republish',
  'button Shared', 'button Replied', 'heading Confirmation', 'text Confirmation',
  'button Help, ID: Enviar', 'button Help, URL: Approve', 'button Help, Help: 送信',
  'button Help, Secondary Actions: Publish', 'text field (settable) Value: Enviar', 'link Help, Value: Confirmar'])
  test(`RT11J neutral near miss: ${target}`, () => {
    const before = tree(['standard window Draft', '\t' + target, '\ttext Later']);
    assert.equal(compareMacElement(before, before.replace('text Later', 'text Changed'), 1).to, 1);
    // Named neutral targets retain their existing insertion remap.
    if (target.startsWith('button ') && !target.startsWith('button Help,')) {
      const shifted = tree(['standard window Draft', '\ttext Banner', '\t' + target, '\ttext Later']);
      assert.equal(compareMacElement(before, shifted, 1).to, 2);
    }
  });

test('RT11J Send in a chat composer is consequential; Confirmation heading does not rename Next', () => {
  const original = tree(['standard window Draft', '\tcontainer Chat', '\t\ttext entry area (settable) Value: Hello',
    '\t\tbutton Send', '\theading Confirmation', '\tbutton Next', '\ttext Later']);
  const after = original.replace('text Later', 'text Changed');
  assert.equal(compareMacElement(original, after, 3).to, undefined);
  assert.equal(compareMacElement(original, after, 5).to, 5);
});

for (const label of ['', ' ', '\u200b\u2060', '\ud800', '\udfff', 'Description: ', 'Value: ', 'ID: commit'])
  test(`RT11J empty or malformed form button: ${JSON.stringify(label)}`, () => {
    const original = tree(['standard window Draft', '\tcontainer Form', '\t\ttext field (settable) Value: old',
      '\t\tcontainer Actions', '\t\t\tbutton ' + label, '\ttext Later']);
    assert.equal(compareMacElement(original, original, 4).to, 4);
    for (const after of [original.replace('text Later', 'text Changed'), original.replace('Value: old', 'Value: new')]) {
      const result = compareMacElement(original, after, 4, { acted: [2], writes: new Map([[2, 'new']]) });
      assert.equal(result.to, undefined);
      assert.equal(result.why, 'consequential-tree');
    }
  });

test('RT11J a normalization exception on a form button fails closed', t => {
  const original = tree(['standard window Draft', '\ttext field (settable) Value: old', '\tbutton Continue', '\ttext Later']);
  t.mock.method(String.prototype, 'normalize', () => { throw Error('normalization unavailable'); });
  assert.equal(compareMacElement(original, original.replace('text Later', 'text Changed'), 2).why, 'consequential-tree');
});

for (const role of ['secure text field', 'text entry area', 'search field', 'combo box', 'checkbox', 'radio button',
  'switch', 'toggle button', 'pop up button', 'menu button', 'slider', 'stepper'])
  test(`RT11J an empty button after a ${role} can end a form`, () => {
    const before = tree(['standard window Draft', '\t' + role, '\tbutton ID: submit', '\ttext Later']);
    assert.equal(compareMacElement(before, before.replace('text Later', 'text Changed'), 2).why, 'consequential-tree');
  });

test('RT11J empty form button classification applies on either side and cannot remap', () => {
  const original = ['standard window Draft', '\ttext field (settable) Value: old', '\tbutton ID: end', '\ttext Later'];
  assert.equal(compareMacElement(tree(original), tree([original[0], '\ttext Banner', ...original.slice(1)]), 2).to, undefined);
  const before = tree(['standard window Draft', '\ttext Ready', '\tbutton ID: end', '\ttext Later']);
  const after = before.replace('text Ready', 'text field (settable) Value: old');
  assert.equal(compareMacElement(before, after, 2).why, 'consequential-tree');
  assert.equal(compareMacElement(after, before, 2).why, 'consequential-tree');
});

test('RT11J no field or a later field alone does not invent a form-ending button', () => {
  for (const lines of [
    ['standard window Draft', '\tbutton ID: next', '\ttext Later'],
    ['standard window Draft', '\tbutton ID: next', '\ttext field (settable) Value: old', '\ttext Later'],
  ]) {
    const before = tree(lines);
    assert.equal(compareMacElement(before, before.replace('text Later', 'text Changed'), 1).to, 1);
  }
});

test('RT11J localized Description, control Value and nearby ancestor labels bind the tree', () => {
  for (const lines of [
    ['standard window Draft', '\tbutton Description: Enviar', '\ttext Later'],
    ['standard window Draft', '\tbutton Value: Bestätigen', '\ttext Later'],
    ['standard window Draft', '\tcontainer Description: 送信', '\t\tbutton Yes', '\ttext Later'],
  ]) {
    const before = tree(lines), target = lines.findIndex(line => line.includes('button'));
    assert.equal(compareMacElement(before, before.replace('text Later', 'text Changed'), target).to, undefined);
  }
});

test('RT11J own field writes never waive a localized submit', () => {
  for (const label of ['Enviar', 'Bestätigen', '送信', 'Approve']) {
    const before = tree(['standard window Draft', '\ttext field (settable) Value: old', '\tbutton ' + label]);
    const result = compareMacElement(before, before.replace('Value: old', 'Value: new'), 2,
      { acted: [1], writes: new Map([[1, 'new']]) });
    assert.equal(result.why, 'consequential-tree');
    assert.equal(result.to, undefined);
  }
});

test('GLR1 RT11F attack counts: 10 allow, 8 remap, 102 refuse', t => {
  const counts = { actions: 0, allow: 0, remap: 0, refuse: 0 };
  const baselineTighter = new Set(['S2', 'S6', 'T7', 'W1', 'W6', 'F3', 'R1', 'R2', 'R6', 'R8c', 'R21', 'R22', 'R24', 'R25', 'R17c', ...attacks.filter(p => p.id.startsWith('I1-')).map(p => p.id)]);
  let equal = 0, stricter = 0;
  for (const probe of attacks) {
    const result = compareMacElement(tree(probe.before), tree(probe.after), probe.n,
      { acted: probe.acted, writes: new Map(probe.writes) });
    const actual = result.to === undefined ? 'refuse' : result.to === probe.n ? 'allow' : `remap:${result.to}`;
    const expected = baselineTighter.has(probe.id) ? 'refuse' : probe.expected;
    counts.actions++; counts[actual.startsWith('remap:') ? 'remap' : actual]++;
    if (actual === expected) equal++;
    else { assert.equal(probe.id, 'X2'); assert.equal(actual, 'refuse'); stricter++; }
  }
  assert.deepEqual(counts, { actions: 120, allow: 10, remap: 8, refuse: 102 });
  assert.deepEqual({ equal, stricter }, { equal: 119, stricter: 1 });
  t.diagnostic(JSON.stringify({ ...counts, equal, stricter, looser: 0 }));
});

test('GLC2 Move to Trash binds every byte of the read', () => assertBound('Move to Trash'));
