// Unknown prompt provenance gets session recovery. Only the pane addresses the person.
const personRecovery = "The person's next message clears Stop; do not use sleight again before then.";
const paneRecovery = 'Your next message clears it.';
const sessionRecovery = 'Start a new session to continue.';
const refusal = 'The user stopped sleight.';
export const stopRecovery = (person, pane = false) => person ? (pane ? paneRecovery : personRecovery) : sessionRecovery;
export const stopRefusal = person => `${refusal} ${stopRecovery(person)}`;
export const stopNoticeInventory = () => [personRecovery, paneRecovery, sessionRecovery, refusal];
