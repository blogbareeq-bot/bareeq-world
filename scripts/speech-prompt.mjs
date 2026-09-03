export const LEGACY_GEMINI_STYLE = `### TASK
Synthesize the Arabic transcript below as speech. Speak only the text under TRANSCRIPT, exactly as written. Do not read these directions or labels aloud, and do not add commentary.

### AUDIO PROFILE
A mature, well-read Arabic narrator for Bareeq, a refined knowledge blog for curious adult readers.

### SCENE
A contemporary Arabic recording studio in daylight. The narrator speaks naturally to one attentive listener in a calm, professional setting.

### DIRECTOR'S NOTES
Use clear Modern Standard Arabic. Sound natural, human, warm, and intellectually engaging. Use a normal conversational volume, never a whisper or a breathy delivery. Keep a comfortable medium pace with subtle organic variation. Articulate clearly without over-pronouncing words or sounding like a news anchor. Let questions carry gentle curiosity, explanations sound calm and confident, and conclusions feel reflective and quietly uplifting. Avoid theatrical acting, advertising energy, excessive solemnity, and monotone delivery.`;

export const GEMINI_STYLE = `### TASK
Synthesize the approved Arabic transcript below as speech. TRANSCRIPT is the authoritative, linguistically reviewed Speech Script. Speak only its words, exactly as written. Every written Arabic diacritic is binding: do not reinterpret a vocalized word as another reading. Preserve each token's exact lexical and morphological form; never replace it with a more common, related, or neighboring form. For example, if the transcript says «تصعد», pronounce «تصعد» exactly and never substitute «تصاعد». Do not add, omit, paraphrase, or reorder any word. Do not normalize a written token into another lexical or morphological form. Do not read these directions or labels aloud.

### AUDIO PROFILE
A mature, well-read Arabic narrator for Bareeq, a refined knowledge blog for curious adult readers.

### SCENE
A contemporary Arabic recording studio in daylight. The narrator speaks naturally to one attentive listener in a calm, professional setting.

### DIRECTOR'S NOTES
Use clear Modern Standard Arabic. Sound natural, human, warm, and intellectually engaging. Use a normal conversational volume, never a whisper or a breathy delivery. Keep a comfortable medium pace with subtle organic variation. Articulate clearly without over-pronouncing words or sounding like a news anchor. Let questions carry gentle curiosity, explanations sound calm and confident, and conclusions feel reflective and quietly uplifting. Avoid theatrical acting, advertising energy, excessive solemnity, and monotone delivery.`;

export function buildGeminiPrompt(part, context) {
  const topic = String(context?.articleTitle || '').replace(/[\r\n]+/g, ' ').trim();
  const sequence = Number.isInteger(context?.partIndex) && Number.isInteger(context?.partCount)
    ? `This is continuity segment ${context.partIndex + 1} of ${context.partCount}. Keep the same narrator identity and recording distance as the other segments.`
    : '';
  const correction = String(context?.correctionHint || '').replace(/[\r\n]+/g, ' ').trim();
  const correctionLine = correction
    ? `Previous synthesis QA found a specific verbatim error in this segment. Correction note (DO NOT READ ALOUD): ${correction}`
    : '';
  return `${GEMINI_STYLE}\n\n### CONTEXT (DO NOT READ ALOUD)\nArticle topic: ${topic}\n${sequence}\n${correctionLine}\n\n### TRANSCRIPT\n${part.text}`;
}
