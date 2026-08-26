const XML_ENTITIES = Object.freeze({
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
  "'": '&apos;',
});

const NUMBER_TOKEN = /[0-9\u0660-\u0669]+(?:[,\u066C][0-9\u0660-\u0669]{3})*(?:[.\u066B][0-9\u0660-\u0669]+)?%?/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const DIGIT = /[0-9\u0660-\u0669]/u;

export function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (character) => XML_ENTITIES[character]);
}

function digitCount(value) {
  return [...value].filter((character) => /[0-9\u0660-\u0669]/u.test(character)).length;
}

function numberSsml(rawNumber) {
  const compact = rawNumber.replace(/[,\u066C]/gu, '');
  const hasDecimal = /[.\u066B]/u.test(compact);
  const interpretAs = !hasDecimal && digitCount(compact) > 6 ? 'number_digit' : 'cardinal';
  return `<say-as interpret-as="${interpretAs}">${escapeXml(compact)}</say-as>`;
}

/**
 * Escape approved speech text and add conservative Arabic number hints.
 * Long identifiers such as ISBNs are read digit by digit; ordinary values,
 * years, and decimals are read as numbers; percentages gain an Arabic suffix.
 */
export function textToAzureSsml(value) {
  const text = String(value);
  let cursor = 0;
  let result = '';
  for (const match of text.matchAll(NUMBER_TOKEN)) {
    const whole = match[0];
    const start = match.index;
    const end = start + whole.length;
    const previous = text[start - 1] ?? '';
    const next = text[end] ?? '';
    const embedded = LETTER_OR_DIGIT.test(previous)
      || LETTER_OR_DIGIT.test(next)
      || ((previous === '.' || previous === '\u066B') && DIGIT.test(text[start - 2] ?? ''))
      || ((next === '.' || next === '\u066B') && DIGIT.test(text[end + 1] ?? ''));
    result += escapeXml(text.slice(cursor, start));
    if (embedded) {
      result += escapeXml(whole);
      cursor = end;
      continue;
    }
    const percent = whole.endsWith('%');
    const number = percent ? whole.slice(0, -1) : whole;
    result += numberSsml(number);
    if (percent) result += ' في المئة';
    cursor = end;
  }
  return result + escapeXml(text.slice(cursor));
}

export function buildAzureSsml({ language, voice, rate = '0%', items, numberHints = true }) {
  if (!language || !voice || !Array.isArray(items) || !items.length) throw new Error('Azure SSML requires language, voice, and at least one speech item.');
  const paragraphs = items.map((item) => {
    const speechText = numberHints ? textToAzureSsml(item.text) : escapeXml(item.text);
    const body = `<prosody rate="${escapeXml(rate)}">${speechText}</prosody>`;
    if (item.type === 'title') return `<p>${body}<break time="260ms"/></p>`;
    if (/^h\d$/u.test(item.type)) return `<p><break time="160ms"/>${body}<break time="180ms"/></p>`;
    return `<p>${body}</p>`;
  }).join('');
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${escapeXml(language)}"><voice name="${escapeXml(voice)}">${paragraphs}</voice></speak>`;
}
