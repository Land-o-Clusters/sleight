import { prepareMailFixture, setupMailImport, checkMailAnswer, cleanupMailImport } from './real-mail.mjs';

const requests = {
  'mail-folder': 'Open Projects > Orchard > Design. Open the message "Design folder marker" and report its folder code.',
  'mail-message': 'Find the message from mira.cole@example.test with subject "Orchard route note" and report its route code.',
  'mail-thread': 'In Projects > Orchard > Review, open the "Orchard handoff" conversation. Report the exact instruction after "Third reply:" in its third reply, counting from the oldest opening message.',
  'mail-attachment': 'In Projects > Orchard > Design, find "Orchard map attachment" and report its attachment filename. Do not open or save the attachment.',
  'mail-search': 'Search only this imported fixture mailbox for "blue lantern". Find "Blue lantern invoice" and report its invoice code. Never search All Mailboxes.',
};

export const mailTasks = Object.entries(requests).map(([id, request]) => ({
  id, app: 'Mail', prepare: prepareMailFixture, setup: setupMailImport,
  prompt: ctx => `Using computer use in the run-owned Mail viewer, navigate only the local On My Mac imported mailbox "${ctx.mail.name}". ` +
    request + ' Return JSON with exactly one field, {"answer":"the exact requested value"}. ' +
    'Do not compose, reply, forward, send, move, copy, flag, delete, mark read or unread, rename, create mailboxes, or change any mail or settings. ' +
    'Do not access the owner\'s accounts or real mail, or read, list, switch to or close any other windows or account mailboxes. ' +
    'Keep the owned viewer open for cleanup. Stop at any permission, sign-in, activation or first-run dialog and report it without dismissing it.',
  check: ctx => checkMailAnswer(ctx, id), cleanup: cleanupMailImport,
}));
