// A text-only, structural preflight. Token quotas and provider acceptance require Vertex validation.
const bytes = value => new TextEncoder().encode(value).byteLength;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const DATASET_BROWSER_MAX_BYTES = 400000;
export function validateDatasets(input, options = {}) {
  const maxBytes = options.maxBytes ?? DATASET_BROWSER_MAX_BYTES;
  const maxRows = options.maxRows ?? 2000;
  const issues = [];
  const add = (split, line, severity, message) => issues.push({ split, line, severity, message });
  if (!isObject(input) || typeof input.training !== 'string' || (input.validation !== undefined && typeof input.validation !== 'string')) {
    return { valid: false, training: null, validation: null, overlapCount: 0, issues: [{ split: 'input', line: 0, severity: 'error', message: 'Provide training JSONL text and optional validation JSONL text.' }], issueCount: 1 };
  }
  if (bytes(input.training) + bytes(input.validation || '') > maxBytes) {
    return { valid: false, training: null, validation: null, overlapCount: 0, issues: [{ split: 'input', line: 0, severity: 'error', message: `This validator accepts at most ${maxBytes.toLocaleString()} bytes per request. Use the local CLI for larger files.` }], issueCount: 1 };
  }
  function parse(text, split) {
    const seen = new Set(); const prompts = new Set();
    let examples = 0, duplicates = 0, blankLines = 0;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = index + 1; const source = lines[index];
      if (!source.trim()) { if (index !== lines.length - 1) blankLines++; continue; }
      examples++;
      if (examples > maxRows) { add(split, line, 'error', `This validator supports at most ${maxRows.toLocaleString()} examples per split.`); break; }
      let row;
      try { row = JSON.parse(source); } catch { add(split, line, 'error', 'Invalid JSON. Each example must occupy one complete JSONL line.'); continue; }
      if (!isObject(row)) { add(split, line, 'error', 'Each example must be a JSON object.'); continue; }
      const before = issues.length;
      if (Object.keys(row).some(key => !['contents', 'systemInstruction'].includes(key))) add(split, line, 'error', 'This text-only validator supports contents and optional systemInstruction fields.');
      function textParts(content, label) {
        if (!isObject(content) || !Array.isArray(content.parts) || !content.parts.length || content.parts.some(part => !isObject(part) || Object.keys(part).some(key => key !== 'text') || typeof part.text !== 'string' || !part.text.trim())) {
          add(split, line, 'error', `${label} must contain nonempty parts with text strings; multimodal parts are outside this validator's scope.`); return [];
        }
        return content.parts.map(part => part.text);
      }
      const system = row.systemInstruction ? textParts(row.systemInstruction, 'systemInstruction') : [];
      if (row.systemInstruction !== undefined && !isObject(row.systemInstruction)) add(split, line, 'error', 'systemInstruction must be an object.');
      if (!Array.isArray(row.contents) || row.contents.length < 2 || row.contents.length > 100) { add(split, line, 'error', 'Provide 2–100 alternating user/model turns ending with a model answer.'); continue; }
      const normalized = row.contents.map((content, i) => {
        const expected = i % 2 === 0 ? 'user' : 'model';
        if (!isObject(content) || content.role !== expected) add(split, line, 'error', `Turn ${i + 1} must have role ${expected}; use model rather than assistant.`);
        return [content?.role, textParts(content, `Turn ${i + 1}`)];
      });
      if (row.contents.at(-1)?.role !== 'model') add(split, line, 'error', 'The final turn must contain the model target answer.');
      if (issues.length !== before) continue;
      const canonical = JSON.stringify([system, normalized]);
      // Changing only the system instruction does not make a held-out prompt new.
      const prompt = JSON.stringify(normalized.slice(0, -1));
      if (seen.has(canonical)) { duplicates++; add(split, line, 'warning', 'Duplicate example within this split. Deduplicate before training.'); }
      seen.add(canonical); prompts.add(prompt);
    }
    if (!examples) add(split, 0, 'error', 'The dataset is empty.');
    if (blankLines) add(split, 0, 'warning', `${blankLines} blank line(s) were ignored. Remove blank lines before upload.`);
    return { examples, duplicates, bytes: bytes(text), seen, prompts };
  }
  const training = parse(input.training, 'training');
  const validation = input.validation?.trim() ? parse(input.validation, 'validation') : null;
  if (training.examples && training.examples < 100) add('training', 0, 'warning', 'Google recommends starting with at least 100 examples; this is a recommendation, not a hard minimum.');
  let overlapCount = 0;
  if (validation) {
    for (const prompt of validation.prompts) if (training.prompts.has(prompt)) overlapCount++;
    if (overlapCount) add('validation', 0, 'error', `${overlapCount} validation prompt(s) also appear in training. Keep held-out prompts separate, even when target answers differ.`);
    if (validation.examples > 5000) add('validation', 0, 'error', 'The Gemini 3.5 Flash profile allows at most 5,000 validation examples.');
    if (validation.examples > 1000 && validation.examples > training.examples * .3) add('validation', 0, 'error', 'For more than 1,000 validation examples, the Gemini 3.5 Flash profile limits validation to 30% of the training count.');
  } else add('validation', 0, 'warning', 'No validation split was supplied. Keep a separate held-out benchmark for measuring generalization.');
  add('input', 0, 'warning', 'Structural checks cannot verify model availability, training rights, answer quality, benchmark contamination, or tokenizer limits. Run provider preflight before submitting.');
  function summary(value) { if (!value) return null; const { seen, prompts, ...counts } = value; return counts; }
  return { valid: !issues.some(i => i.severity === 'error'), training: summary(training), validation: summary(validation), overlapCount, issueCount: issues.length, issues: issues.slice(0, 100), profile: 'Gemini 3.5 Flash · text-only SFT', maxBytes, maxRows };
}
