import { appPolicySkeleton } from './app-policy.mjs';

// hand-translated list, not a claim to recognize every language or spelling.
export const consequentialLabels = Object.freeze({
  en: 'confirm|submit|send|authorize|authorise|approve|sign|pay|payment|purchase|checkout|check out|subscribe|transfer|withdraw|remove|erase|publish|post|reply|share|order|place order|place your order|complete order|order now|book|book now|buy|delete|trash|save|finish|complete|reserve|donate|upgrade|send money|charge|confirm order|confirm purchase|confirm payment|confirm and pay|submit order|submit payment',
  es: 'confirmar|enviar|autorizar|aprobar|firmar|pagar|pago|comprar|finalizar compra|suscribirse|transferir|retirar|eliminar|borrar|publicar|responder|compartir|pedir|realizar pedido|reservar|guardar|finalizar|completar|donar|mejorar|cobrar',
  fr: 'confirmer|soumettre|envoyer|autoriser|approuver|signer|payer|paiement|acheter|passer commande|souscrire|s’abonner|s\'abonner|transférer|retirer|supprimer|effacer|publier|répondre|partager|commander|réserver|enregistrer|sauvegarder|terminer|finaliser|compléter|faire un don|mettre à niveau|facturer',
  de: 'bestätigen|absenden|senden|autorisieren|genehmigen|zustimmen|unterschreiben|signieren|bezahlen|zahlen|zahlung|kaufen|zur kasse|abonnieren|übertragen|überweisen|abheben|entfernen|löschen|veröffentlichen|posten|antworten|teilen|bestellen|buchung abschließen|buchen|speichern|beenden|fertigstellen|abschließen|reservieren|spenden|upgraden|belasten',
  pt: 'confirmar|submeter|enviar|autorizar|aprovar|assinar|pagar|pagamento|comprar|finalizar compra|subscrever|transferir|retirar|sacar|remover|apagar|eliminar|excluir|publicar|postar|responder|partilhar|compartilhar|encomendar|fazer pedido|reservar|guardar|salvar|terminar|concluir|completar|doar|atualizar|cobrar',
  it: 'confermare|conferma|inviare|invia|autorizzare|autorizza|approvare|approva|firmare|firma|pagare|paga|pagamento|acquistare|acquista|procedi al pagamento|abbonarsi|abbonati|trasferire|trasferisci|prelevare|preleva|rimuovere|rimuovi|cancellare|cancella|eliminare|elimina|pubblicare|pubblica|rispondere|rispondi|condividere|condividi|ordinare|ordina|prenotare|prenota|comprare|compra|salvare|salva|terminare|termina|completare|completa|riservare|riserva|donare|dona|aggiornare|aggiorna|addebitare|addebita',
  ja: '確認|確定|送信|提出|承認|許可|認可|署名|支払う|支払い|支払|決済|購入|購読|登録|送金|振込|転送|引き出す|出金|削除|消去|公開|投稿|返信|共有|注文|予約|買う|保存|終了|完了|寄付|アップグレード|請求',
  zh: '确认|確認|确定|確定|提交|发送|發送|傳送|授权|授權|批准|同意|签名|簽名|签署|簽署|支付|付款|购买|購買|结账|結帳|订阅|訂閱|转账|轉帳|轉賬|转移|轉移|提现|提現|提款|取款|移除|删除|刪除|擦除|清除|发布|發佈|發布|发表|發表|回复|回覆|分享|共享|下单|下單|订购|訂購|预订|預訂|预约|預約|买|買|保存|储存|儲存|结束|結束|完成|捐款|捐赠|捐贈|升级|升級|收费|收費|扣款',
  ko: '확인|확정|제출|보내기|전송|허가|인증|승인|서명|지불|결제|구매|구입|구독|이체|송금|전송하기|인출|출금|제거|삭제|지우기|발행|게시|답장|응답|공유|주문|예약|저장|종료|마침|완료|기부|업그레이드|청구',
});
// Clipboard writes refuse even when the tree is unchanged. Keep this table
// separate from consequential labels, whose rule governs stale-number remaps.
export const clipboardWriteLabels = Object.freeze({
  en: 'copy|cut',
  es: 'copiar|cortar',
  fr: 'copier|couper',
  de: 'kopieren|ausschneiden',
  pt: 'copiar|cortar|recortar',
  it: 'copia|copiare|taglia|tagliare',
  ja: 'コピー|切り取り|切取',
  zh: '复制|複製|拷贝|拷貝|剪切|剪下',
  ko: '복사|잘라내기',
});
export const MAC_CLIPBOARD_WRITE_REFUSAL = 'This action would overwrite the clipboard. Nothing was sent. Use a direct text operation instead.';
export function normalizeActionLabel(value) {
  try {
    if (typeof value !== 'string' || /\p{Cs}/u.test(value)) return null;
    // Upper/lower expansion folds case (including sharp s); the shared policy
    // skeleton supplies all confusables, NFKD and combining/ignorable removal.
    return appPolicySkeleton(value.normalize('NFKC').replace(/(\p{Ll}{2,})(\p{Lu})/gu, '$1 $2').toUpperCase().toLowerCase()
      .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
      .replace(/[\p{Z}\p{Pd}_\s\u2212]+/gu, ' ')).replace(/\s+/gu, ' ').trim();
  } catch { return null; }
}
export const regexWord = word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const consequentialWords = new RegExp(Object.entries(consequentialLabels).flatMap(([language, labels]) =>
  labels.split('|').map(label => {
    const word = regexWord(normalizeActionLabel(label));
    // CJK labels may abut particles or object names without word separators.
    return /^(?:ja|zh|ko)$/.test(language) ? word : `(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`;
  })).join('|'), 'u');
export const clipboardWriteWords = new RegExp(Object.entries(clipboardWriteLabels).flatMap(([language, labels]) =>
  labels.split('|').map(label => {
    const word = regexWord(normalizeActionLabel(label));
    return /^(?:ja|zh|ko)$/.test(language) ? word : `(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`;
  })).join('|'), 'u');
export function clipboardLabelWrites(shown) {
  const label = normalizeActionLabel(shown);
  const mixedCopy = typeof shown === 'string' && shown.normalize('NFKC').includes('Υ') && /(?<![\p{L}\p{N}])copu(?![\p{L}\p{N}])/u.test(label);
  return label === null || clipboardWriteWords.test(label) || mixedCopy;
}
export function refuseClipboardLabel(shown) {
  if (!clipboardLabelWrites(shown)) return;
  throw Object.assign(Error(MAC_CLIPBOARD_WRITE_REFUSAL), { code: 'ACTION_UNSUPPORTED', parentSafety: true,
    delivery: 'not-sent', retry: 'safe', clipboard: 'untouched' });
}
