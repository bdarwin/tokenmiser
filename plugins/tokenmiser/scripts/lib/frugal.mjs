// Injected once at session start. Kept short on purpose: it is paid for on every turn
// (cheaply, since it sits in the cached prefix).
export function frugalPrompt({ agent = 'copilot', tm = null } = {}) {
  const explorer = agent === 'claude' ? '"tokenmiser:scout" agent (cheap model)' : 'built-in "explore" agent (lightweight model)';
  const lines = [
    'Credit-saving mode (tokenmiser) is on. Work frugally:',
    '- Answer tersely. No preamble, no restating the task, no recap of edits unless asked.',
    '- Locate before reading: search first, then view only the needed line range. Never re-read a file already in context.',
    '- Batch related shell steps into one command. Use quiet flags (-q, --silent) and pipe noisy output through `| tail -n 60`.',
    "- Make focused edits; don't rewrite whole files to change a few lines.",
    `- Hand broad, multi-thread exploration to the ${explorer} and work from its summary.`,
    '- Long tool output may be trimmed; the message says where the full text was saved. Read it (by range or grep) only if the trimmed part matters.',
  ];
  if (tm) {
    lines.push(
      `- Code index — use it instead of grep/find + reading to orient: "where is X defined" → \`${tm} sym X\` (file, line range, enclosing class); before reading an unfamiliar file → \`${tm} outline <file>\` then read only the range you need; "who uses X" → \`${tm} refs X\`; repo overview → \`${tm} map [dir]\`.`,
      '- Search results may end with "[tokenmiser] enclosing definitions": read exactly those line ranges.',
    );
  }
  return lines.join('\n');
}
