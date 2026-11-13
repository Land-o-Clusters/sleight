import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { evaluateAppPolicy } from '../plugins/sleight/lib/app-policy.mjs';

// Opt in: this bank calls the two policies millions of times, without any app access.
// CLAUDE_CONFIG_DIR=$(mktemp -d /tmp/lane-claude-XXXXXX) SLEIGHT_POLICY_TITLE_COMPARISON=1 nice -n 20 \
//   node --test --test-reporter=spec tests/app-policy-title-comparison.test.mjs
const enabled = process.env.SLEIGHT_POLICY_TITLE_COMPARISON === '1';
const revision = '9c1cd1bc801a5a977eea3f85562dcdad59927ace';
// Sources taken verbatim with git show 9c1cd1bc8:<path>, including every JSON read.
// This snapshot also works in a release checkout without the private Git object.
const frozen = JSON.parse(readFileSync(new URL('./fixtures/app-policy-9c1cd1bc.json', import.meta.url), 'utf8'));
assert.equal(frozen.revision, revision);
const frozenRules = JSON.parse(frozen.files['app-policy/rules.json']);
const apps = ['com.apple.Terminal', 'com.openai.chat'];
const settings = { allowForbiddenTargets: true };
const facts = { executableName: 'Editor', processAncestry: [{ kind: 'non-app' }], operation: 'read',
  secureInput: false, focusedSecureField: false };

// Explicit sets make this bank reproducible even if the production table changes.
// The review specified set sizes, but did not publish its exact glyph inventory.
const lGlyphs = [...'lLIiℓｌⅬⅼӀʟłŁƚȽƛɫɬɭіιӏⅰıɪɨƖ'];
const iGlyphs = [...'iIlLɪіιӏⅰıɨƗℐ'];

function* combinations(letters, index = 0, prefix = '') {
  if (index === letters.length) { yield prefix; return; }
  const letter = letters[index];
  const choices = letter === 'l' ? lGlyphs : letter === 'i' ? iGlyphs : [letter];
  for (const choice of choices) yield* combinations(letters, index + 1, prefix + choice);
}

function* mutations(word, confusables) {
  const letters = [...word];
  const choices = letters.map(letter => [...new Set([
    ...(confusables[letter] ?? ''),
    ...(letter === 'i' ? iGlyphs : letter === 'l' ? lGlyphs : []),
    ...({ a: 'Ⱥ', d: 'ĐÐ', e: 'Ɇ', g: 'Ǥ', i: 'Ɨ', l: 'ɫɬɭ', t: 'Ⱦ', u: 'Ʉ' }[letter] ?? ''),
  ])].filter(choice => choice !== letter));
  for (let first = 0; first < letters.length; first++) {
    for (const a of choices[first]) {
      const single = [...letters]; single[first] = a;
      yield single.join('');
      for (let second = first + 1; second < letters.length; second++) {
        for (const b of choices[second]) {
          const double = [...single]; double[second] = b;
          yield double.join('');
        }
      }
    }
  }
}

function* ilVariants(word) {
  if (!word) { yield ''; return; }
  const [letter, ...rest] = [...word];
  for (const suffix of ilVariants(rest.join(''))) {
    for (const choice of /[il]/u.test(letter) ? ['i', 'l'] : [letter]) yield choice + suffix;
  }
}

// 64 titles per language, each bare and with two common app suffixes: 768 titles.
// Authored offline. They are fixtures, not observations of the owner's windows.
const ordinaryTitles = {
  en: ['Untitled', 'New document', 'Downloads', 'Documents', 'Desktop', 'Home', 'Inbox', 'Sent mail',
    'Calendar', 'Contacts', 'Meeting notes', 'Project plan', 'Shopping list', 'Invoice', 'Budget', 'Report',
    'Annual report', 'Medical data', 'Local data', 'Research notes', 'Family photos', 'Travel itinerary',
    'Weekly schedule', 'Release notes', 'Source code', 'Search results', 'Print preview', 'Save document',
    'Open file', 'Recent files', 'Set the timings', 'Setting the sails',
    'Help', 'About this app', 'Welcome', 'Get started', 'New tab', 'Bookmarks', 'History', 'Extensions',
    'Task list', 'Archive', 'Trash', 'Music library', 'Now playing', 'Playlist', 'Photo library', 'Album',
    'Presentation', 'Spreadsheet', 'Quarterly results', 'Project timeline', 'Team directory', 'Address book',
    'Activity monitor', 'Disk usage', 'Network status', 'Connection details', 'File transfer', 'Upload complete',
    'Physical data', 'Historical data', 'Medical database', 'Local database'],
  de: ['Unbenannt', 'Neues Dokument', 'Downloads', 'Dokumente', 'Schreibtisch', 'Persönlicher Ordner',
    'Posteingang', 'Gesendete Nachrichten', 'Kalender', 'Kontakte', 'Besprechungsnotizen', 'Projektplan',
    'Einkaufsliste', 'Rechnung', 'Haushaltsplan', 'Bericht', 'Jahresbericht', 'Medizinische Daten',
    'Lokale Daten', 'Forschungsnotizen', 'Familienfotos', 'Reiseplan', 'Wochenplan', 'Versionshinweise',
    'Quelltext', 'Suchergebnisse', 'Druckvorschau', 'Dokument speichern', 'Datei öffnen',
    'Zuletzt verwendete Dateien', 'Zeiten festlegen', 'Die Segel setzen',
    'Hilfe', 'Über diese App', 'Willkommen', 'Erste Schritte', 'Neuer Tab', 'Lesezeichen', 'Verlauf', 'Erweiterungen',
    'Aufgabenliste', 'Archiv', 'Papierkorb', 'Musikmediathek', 'Aktuelle Wiedergabe', 'Wiedergabeliste',
    'Fotomediathek', 'Album', 'Präsentation', 'Tabellenkalkulation', 'Quartalsergebnisse', 'Projektzeitplan',
    'Teamverzeichnis', 'Adressbuch', 'Aktivitätsanzeige', 'Speicherbelegung', 'Netzwerkstatus',
    'Verbindungsdetails', 'Dateiübertragung', 'Hochladen abgeschlossen', 'Physikalische Daten',
    'Historische Daten', 'Medizinische Datenbank', 'Lokale Datenbank'],
  fr: ['Sans titre', 'Nouveau document', 'Téléchargements', 'Documents', 'Bureau', 'Dossier personnel',
    'Boîte de réception', 'Messages envoyés', 'Calendrier', 'Contacts', 'Notes de réunion', 'Plan du projet',
    'Liste de courses', 'Facture', 'Budget', 'Rapport', 'Rapport annuel', 'Données médicales',
    'Données locales', 'Notes de recherche', 'Photos de famille', 'Itinéraire de voyage', 'Planning hebdomadaire',
    'Notes de version', 'Code source', 'Résultats de recherche', 'Aperçu avant impression',
    'Enregistrer le document', 'Ouvrir un fichier', 'Fichiers récents', 'Définir les horaires', 'Mettre les voiles',
    'Aide', 'À propos de cette app', 'Bienvenue', 'Premiers pas', 'Nouvel onglet', 'Favoris', 'Historique',
    'Extensions', 'Liste des tâches', 'Archives', 'Corbeille', 'Bibliothèque musicale', 'Lecture en cours',
    'Liste de lecture', 'Photothèque', 'Album', 'Présentation', 'Feuille de calcul', 'Résultats trimestriels',
    'Calendrier du projet', 'Annuaire de l’équipe', 'Carnet d’adresses', 'Moniteur d’activité',
    'Utilisation du disque', 'État du réseau', 'Détails de la connexion', 'Transfert de fichiers',
    'Envoi terminé', 'Données physiques', 'Données historiques', 'Base de données médicales', 'Base de données locales'],
  es: ['Sin título', 'Nuevo documento', 'Descargas', 'Documentos', 'Escritorio', 'Carpeta personal',
    'Bandeja de entrada', 'Mensajes enviados', 'Calendario', 'Contactos', 'Notas de reunión', 'Plan del proyecto',
    'Lista de compras', 'Factura', 'Presupuesto', 'Informe', 'Informe anual', 'Datos médicos', 'Datos locales',
    'Notas de investigación', 'Fotos familiares', 'Itinerario de viaje', 'Horario semanal', 'Notas de la versión',
    'Código fuente', 'Resultados de búsqueda', 'Vista previa de impresión', 'Guardar documento',
    'Abrir archivo', 'Archivos recientes', 'Definir los horarios', 'Izar las velas',
    'Ayuda', 'Acerca de esta app', 'Bienvenido', 'Primeros pasos', 'Nueva pestaña', 'Marcadores', 'Historial',
    'Extensiones', 'Lista de tareas', 'Archivo', 'Papelera', 'Biblioteca de música', 'Reproduciendo',
    'Lista de reproducción', 'Fototeca', 'Álbum', 'Presentación', 'Hoja de cálculo', 'Resultados trimestrales',
    'Cronograma del proyecto', 'Directorio del equipo', 'Libreta de direcciones', 'Monitor de actividad',
    'Uso del disco', 'Estado de la red', 'Detalles de la conexión', 'Transferencia de archivos',
    'Carga completada', 'Datos físicos', 'Datos históricos', 'Base de datos médicos', 'Base de datos locales'],
};

function comparisonRules(rules) {
  const confusables = new Map(Object.entries(rules.titleConfusables)
    .flatMap(([latin, variants]) => [...variants].map(character => [character, latin])));
  const skeleton = value => [...value.normalize('NFKD').toLowerCase()
      .replace(/[\p{M}\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')]
      .map(character => confusables.get(character) ?? character).join('');
  const normalizeTitle = value => skeleton(value).replace(/[^\p{L}\p{N}]/gu, '');
  const wordVariants = rules.settingsTitleWords.map(word => {
    const normalized = normalizeTitle(word), length = [...normalized].length;
    return { word, normalized, length, expanded: length >= 7,
      variants: length >= 7 ? [...ilVariants(normalized)] : [normalized] };
  });
  const shortExceptions = wordVariants.filter(row => !row.expanded).flatMap(row =>
    [...ilVariants(row.normalized)].filter(variant => variant !== row.normalized)
      .map(variant => ({ word: row.word, normalized: row.normalized, variant })));
  // Literal audit of the permitted class, independent of the production matcher.
  assert.deepEqual(shortExceptions, [{ word: 'cài đặt', normalized: 'caidat', variant: 'caldat' }]);
  // Substring matching intentionally includes ordinary titles such as Medical data.
  const exceptionFor = title => shortExceptions.find(row => normalizeTitle(title).includes(row.variant));
  return { rules, normalizeTitle, wordVariants, shortExceptions, exceptionFor };
}

function smallTitleBank(rules, normalizeTitle) {
  const titles = new Set();
  const glyphs = [...new Set([...lGlyphs, ...iGlyphs, ...'ĺľḷｌŀļḽḻ']), 'l\u0336', 'l\u0338'];
  for (const word of rules.settingsTitleWords) {
    titles.add(word);
    // Cover every ASCII i/l subset, plus individual glyph substitutions in raw words.
    for (const title of ilVariants(normalizeTitle(word))) {
      for (const padded of [title, `${title} - TextEdit`, `~/notes/${title}`]) titles.add(padded);
    }
    const letters = [...word];
    for (let index = 0; index < letters.length; index++) {
      if (!/^[il]$/u.test(normalizeTitle(letters[index]))) continue;
      for (const glyph of glyphs) {
        const variant = [...letters]; variant[index] = glyph;
        titles.add(variant.join(''));
      }
    }
  }
  for (const bank of Object.values(ordinaryTitles)) {
    for (const title of bank) {
      for (const suffix of ['', ' - TextEdit', ' - Firefox']) titles.add(title + suffix);
    }
  }
  assert.ok(titles.size >= 2000 && titles.size <= 6000, `keep the small bank bounded: ${titles.size}`);
  return titles;
}

function compareSmallTitleBank(baseline, current) {
  const { rules, normalizeTitle, exceptionFor } = comparisonRules(frozenRules);
  const titles = smallTitleBank(rules, normalizeTitle);
  let newlyAllowed = 0, shortWordExceptions = 0;
  const unexpectedAllows = [];
  for (const windowTitle of titles) {
    for (const bundleId of apps) {
      const metadata = { ...facts, bundleId, windowTitle };
      const before = baseline(metadata, settings), after = current(metadata, settings);
      assert.notEqual(before.code, 'APP_POLICY_INVALID_METADATA');
      assert.notEqual(after.code, 'APP_POLICY_INVALID_METADATA');
      if (!before.allow && after.allow) {
        newlyAllowed++;
        if (exceptionFor(windowTitle)) shortWordExceptions++;
        else unexpectedAllows.push({ windowTitle, bundleId });
      }
    }
  }
  assert.ok(shortWordExceptions > 0, 'the small bank must exercise the accepted short-word gap');
  assert.deepEqual(unexpectedAllows, [], 'newly allowed titles outside the accepted short-word gap');
  return { revision, titles: titles.size, comparisons: titles.size * apps.length,
    newlyAllowed, shortWordExceptions, unexpectedAllows: unexpectedAllows.length };
}

test('small title bank newly allows zero titles outside the listed short-word class', async t => {
  const baseline = await loadPolicy(t, frozen.files);
  t.diagnostic(JSON.stringify(compareSmallTitleBank(baseline, evaluateAppPolicy)));
});

async function loadPolicy(t, files) {
  const temp = mkdtempSync(join(tmpdir(), 'rt28k-policy-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  mkdirSync(join(temp, 'app-policy'));
  for (const [path, source] of Object.entries(files)) {
    writeFileSync(join(temp, path), source);
  }
  return (await import(pathToFileURL(join(temp, 'app-policy.mjs')).href)).evaluateAppPolicy;
}

test('small comparison detects a live rules change that allows a frozen refusal', async t => {
  const baseline = await loadPolicy(t, frozen.files);
  const liveFiles = Object.fromEntries(Object.keys(frozen.files).map(path => [path,
    readFileSync(new URL(`../plugins/sleight/lib/${path}`, import.meta.url), 'utf8')]));
  const rules = JSON.parse(liveFiles['app-policy/rules.json']);
  assert.ok(rules.settingsTitleWords.includes('settings'));
  rules.settingsTitleWords = rules.settingsTitleWords.filter(word => word !== 'settings');
  liveFiles['app-policy/rules.json'] = JSON.stringify(rules);
  const mutated = await loadPolicy(t, liveFiles);
  const metadata = { ...facts, bundleId: 'com.openai.chat', windowTitle: 'Settings' };
  assert.equal(baseline(metadata, settings).allow, false);
  assert.equal(evaluateAppPolicy(metadata, settings).allow, false);
  assert.equal(mutated(metadata, settings).allow, true);
  assert.throws(() => compareSmallTitleBank(baseline, mutated), error =>
    error.code === 'ERR_ASSERTION' &&
    error.message.includes('newly allowed titles outside the accepted short-word gap') &&
    error.actual.some(row => row.bundleId === metadata.bundleId && row.windowTitle === 'settings'));
});

test('baseline refusals newly allow only listed short-word i/l variants', {
  skip: enabled ? false : 'set SLEIGHT_POLICY_TITLE_COMPARISON=1 to run the exhaustive title bank',
}, async t => {
  assert.equal(lGlyphs.length, 26);
  assert.equal(new Set(lGlyphs).size, 26);
  assert.equal(iGlyphs.length, 13);
  assert.equal(new Set(iGlyphs).size, 13);
  const baseline = await loadPolicy(t, frozen.files);
  const { rules, normalizeTitle, wordVariants, shortExceptions, exceptionFor } = comparisonRules(frozenRules);
  const totals = { words: rules.settingsTitleWords.length, titles: 0, comparisons: 0,
    baselineRefusals: 0, currentRefusals: 0, newlyAllowed: 0, shortWordExceptions: 0, unexpectedAllows: 0 };
  const banks = {}, samples = [], exceptionWords = {};
  for (const bank of ['il-cartesian', 'single-double']) {
    const counts = { titles: 0, comparisons: 0, baselineRefusals: 0, currentRefusals: 0,
      newlyAllowed: 0, shortWordExceptions: 0, unexpectedAllows: 0 };
    banks[bank] = counts;
    for (const word of rules.settingsTitleWords) {
      // The reviewer bounded its Cartesian bank to five i/l positions.
      const positions = [...word].filter(letter => letter === 'i' || letter === 'l').length;
      assert.ok(positions <= 5, `add a bound for ${word} before extending this bank`);
      const titles = bank === 'il-cartesian' ? combinations([...word]) : mutations(word, rules.titleConfusables);
      for (const windowTitle of titles) {
        counts.titles++; totals.titles++;
        if (totals.titles % 4096 === 0) await yieldTurn();
        for (const bundleId of apps) {
          const metadata = { ...facts, bundleId, windowTitle };
          const before = baseline(metadata, settings), after = evaluateAppPolicy(metadata, settings);
          assert.notEqual(before.code, 'APP_POLICY_INVALID_METADATA');
          assert.notEqual(after.code, 'APP_POLICY_INVALID_METADATA');
          counts.comparisons++; totals.comparisons++;
          if (!before.allow) { counts.baselineRefusals++; totals.baselineRefusals++; }
          if (!after.allow) { counts.currentRefusals++; totals.currentRefusals++; }
          if (!before.allow && after.allow) {
            counts.newlyAllowed++; totals.newlyAllowed++;
            const exception = exceptionFor(windowTitle);
            if (exception) {
              counts.shortWordExceptions++; totals.shortWordExceptions++;
              exceptionWords[exception.word] = (exceptionWords[exception.word] ?? 0) + 1;
            } else {
              counts.unexpectedAllows++; totals.unexpectedAllows++;
            }
            if (samples.length < 12) samples.push({ bank, word, windowTitle, bundleId, exception });
          }
        }
      }
      // Stream progress while the owned terminal remains available for Ctrl-C.
      process.stdout.write(`${JSON.stringify({ bank, word, ...counts })}\n`);
    }
  }
  const ordinary = [];
  const requiredTitles = ['Medical data', 'Local data', '~/local/data', 'Physical data.csv',
    'Historical Data', 'Technical data', 'Medical Data - Notes',
    'Lịch làm việc', 'Tài liệu', 'Bài tập', 'Cài phần mềm', 'Cài driver'];
  const collisionCounts = {};
  const checkOrdinary = (windowTitle, bank) => {
    const key = normalizeTitle(windowTitle);
    const longVariantMatches = wordVariants.filter(row => row.expanded &&
      row.variants.some(variant => variant !== row.normalized && key.includes(variant)));
    for (const bundleId of apps) {
      const metadata = { ...facts, bundleId, windowTitle };
      const row = { windowTitle, bundleId, bank, baselineAllow: baseline(metadata, settings).allow,
        currentAllow: evaluateAppPolicy(metadata, settings).allow,
        longVariantMatches: longVariantMatches.map(row => row.word) };
      ordinary.push(row);
      const counts = collisionCounts[bank] ??= { titles: 0, comparisons: 0, baselineRefusals: 0,
        currentRefusals: 0, longVariantCollisions: 0, newlyAllowed: 0, unexpectedAllows: 0 };
      counts.comparisons++;
      if (!row.baselineAllow) counts.baselineRefusals++;
      if (!row.currentAllow) counts.currentRefusals++;
      if (longVariantMatches.length) counts.longVariantCollisions++;
      if (!row.baselineAllow && row.currentAllow) {
        counts.newlyAllowed++;
        if (!exceptionFor(windowTitle)) counts.unexpectedAllows++;
      }
    }
    collisionCounts[bank].titles++;
  };
  for (const title of requiredTitles) checkOrdinary(title, 'required');
  // Keep the explicit timing and short-gap checks separate from the original 24 pairs.
  for (const title of ['Set the timings', 'Cal dat']) checkOrdinary(title, 'additional');
  for (const [language, titles] of Object.entries(ordinaryTitles)) {
    assert.equal(titles.length, 64, language);
    for (const title of titles) {
      for (const suffix of ['', ' - TextEdit', ' - Firefox']) checkOrdinary(title + suffix, language);
    }
  }
  t.diagnostic(JSON.stringify({ revision, apps, totals, banks, samples, exceptionWords, shortExceptions,
    collisionCounts, ordinary: ordinary.filter(row => row.bank === 'required' || !row.currentAllow ||
      row.longVariantMatches.length), wordVariants,
    totalWordVariants: wordVariants.reduce((sum, row) => sum + row.variants.length, 0) }));
  assert.equal(ordinary.filter(row => !row.currentAllow).length, 0, 'required ordinary titles must stay eligible');
  assert.equal(ordinary.filter(row => row.longVariantMatches.length).length, 0, 'long variants collide with ordinary titles');
  assert.equal(Object.values(collisionCounts).reduce((sum, row) => sum + row.unexpectedAllows, 0), 0);
  assert.ok(totals.shortWordExceptions > 0, 'the bank must exercise the short-word exception');
  assert.equal(totals.newlyAllowed, totals.shortWordExceptions);
  assert.equal(totals.unexpectedAllows, 0, JSON.stringify({ totals, samples }));
});
