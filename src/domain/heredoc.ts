/**
 * Heredoc bodies as text the `commands` rules do not judge. A note, a commit message or a PR body fed to `cat`, `tee`,
 * `git commit` or `gh pr create` through `<<EOF` may name `pkill` or `sed -i` without running it, and a rule that
 * matched it would refuse the command.
 *
 * Only the body is blanked: the `<<` line, the delimiter line and everything after it are judged as written. A body is
 * blanked only when its command is one of a few that read it as text, on a line that is that one simple command, and
 * when every step of reading the command is certain; anything else is judged as written, which at worst refuses a
 * command the rules would have refused before (an interpreter or shell fed a heredoc, a pipe, `sh -c`, a command
 * substitution, an unquoted delimiter whose body expands, a quote or comment this scan does not model).
 */

/** What replaces each character of a blanked body (its line breaks stay, so positions and lengths are kept). */
const BLANK = "_";

/** Commands that only read a heredoc as text: `cat` and `tee`, `git` messages and patches, `gh` PR and issue text. */
const TEXT_CONSUMER =
  /^[ \t]*(?:(?:cat|tee)|git(?:[ \t]+-[Cc][ \t]+[^\s'"]+)*[ \t]+(?:commit|tag|merge|am|apply|notes)|gh[ \t]+(?:pr|issue)[ \t]+[a-z]+)(?=[ \t]|$)/;

/** Characters that start another command, a substitution, a redirection to a process, a comment or an escape. */
const NOT_SIMPLE = /[;&|(){}<`$#\\!]/;

/** `<<`, an optional `-`, and the delimiter word: quoted (no expansion in the body), escaped, or bare. */
const OPERATOR = /^<<(-?)[ \t]*(?:'([\w.-]+)'|"([\w.-]+)"|\\(\w+)|(\w+))(?=$|[ \t>])/;

/** The body of an unquoted heredoc is expanded: a command substitution or parameter expansion in it runs or acts. */
const EXPANDS = /\$[({]|`/;

interface Scanned {
  /** Quote state at the end of the line. */
  quote: "" | "'" | '"';
  /** Where each `<<` heredoc operator starts. */
  operators: number[];
}

/**
 * Reads one line the way a shell would split it into quotes, tracking only what decides whether a `<<` is an
 * operator: single and double quotes and backslashes. `undefined` when the line holds something this scan does not
 * model (so the quote state after it is not certain): a backtick, `$(`, `${`, `$'`, `<(`, `>(`, a `#` that could start a
 * comment, a backslash at the end of the line.
 */
function scan(line: string, quote: "" | "'" | '"'): Scanned | undefined {
  const operators: number[] = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = "";
    } else if (c === "\\") {
      if (i + 1 >= line.length) return undefined;
      i++;
    } else if (c === "`" || (c === "$" && "({'".includes(line[i + 1] ?? ""))) {
      return undefined;
    } else if (quote === '"') {
      if (c === '"') quote = "";
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "#") {
      if (!/[\w$]/.test(line[i - 1] ?? "")) return undefined;
    } else if ((c === "<" || c === ">") && line[i + 1] === "(") {
      return undefined;
    } else if (c === "<" && line[i + 1] === "<") {
      if (line[i + 2] !== "<") operators.push(i);
      i += line[i + 2] === "<" ? 2 : 1;
    }
  }
  return { quote, operators };
}

/**
 * The command with each heredoc body blanked (`_` for every character but line breaks), where the heredoc is read
 * with certainty and its command only reads it as text. Everything else comes back as it was.
 */
export function blankHeredocBodies(command: string): string {
  if (!command.includes("<<") || command.includes("\r")) return command;
  const lines = command.split("\n");
  let quote: "" | "'" | '"' = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const read = scan(line, quote);
    // beyond a line this scan cannot read, whether a later `<<` is an operator is not certain
    if (read === undefined) break;
    const startQuote = quote;
    quote = read.quote;
    const [start, ...more] = read.operators;
    if (start === undefined) continue;
    const op = OPERATOR.exec(line.slice(start));
    if (op === null || more.length > 0 || startQuote !== "" || quote !== "") break;
    const rest = line.slice(0, start) + line.slice(start + op[0].length);
    if (!TEXT_CONSUMER.test(rest) || NOT_SIMPLE.test(rest)) break;
    const delimiter = op[2] ?? op[3] ?? op[4] ?? (op[5] as string);
    const end = lines.findIndex((l, k) => k > i && (op[1] === "-" ? l.replace(/^\t+/, "") : l) === delimiter);
    if (end < 0) break;
    const expands = op[5] !== undefined && lines.slice(i + 1, end).some(l => EXPANDS.test(l));
    if (!expands) for (let k = i + 1; k < end; k++) lines[k] = (lines[k] as string).replace(/[^\n]/g, BLANK);
    i = end;
  }
  return lines.join("\n");
}
