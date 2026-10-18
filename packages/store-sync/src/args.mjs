// A small strict parser: every option is declared, and anything else is an
// error, so a typo never silently changes what a run touches.
//   flags:    options that take no value
//   values:   options that take one value
//   lists:    options that take every following word up to the next option
export function parseArguments(args, { flags = [], values = [], lists = [] } = {}) {
  const parsed = { flags: new Set(), values: {}, lists: {}, positionals: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") continue;
    if (!argument.startsWith("--")) {
      parsed.positionals.push(argument);
      continue;
    }
    if (flags.includes(argument)) {
      parsed.flags.add(argument);
    } else if (values.includes(argument)) {
      if (argument in parsed.values) throw new Error(`Duplicate option ${argument}`);
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} needs a value`);
      }
      parsed.values[argument] = value;
      index += 1;
    } else if (lists.includes(argument)) {
      if (argument in parsed.lists) throw new Error(`Duplicate option ${argument}`);
      const words = [];
      while (index + 1 < args.length && !args[index + 1].startsWith("--")) {
        words.push(args[index + 1]);
        index += 1;
      }
      if (words.length === 0) throw new Error(`${argument} needs at least one value`);
      parsed.lists[argument] = words;
    } else {
      throw new Error(`Unknown option ${argument}`);
    }
  }
  return parsed;
}
