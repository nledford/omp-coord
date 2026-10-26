/** The shared decision log: short notes every session sees, kept like the event log (see the store's retention). */
import { type Board, emit, labelOf, type Note } from "./model.ts";

export const MAX_NOTE_CHARS = 2000;

export type NoteResult = { ok: true; note: Note } | { ok: false; reason: string };

export function addNote(
  board: Board,
  n: { sessionId: string | null; author: string; text: string; now: number },
): NoteResult {
  const text = n.text.trim();
  if (!text) return { ok: false, reason: "the note is empty" };
  if (text.length > MAX_NOTE_CHARS)
    return { ok: false, reason: `a note holds at most ${MAX_NOTE_CHARS} characters; link to a file for more` };
  const note: Note = {
    id: Math.max(0, ...board.notes.map(x => x.id)) + 1,
    at: n.now,
    label: n.sessionId === null ? null : (labelOf(board, n.sessionId) ?? null),
    author: n.author,
    text,
  };
  board.notes.push(note);
  emit(board, n.now, "note_added", n.sessionId, { note: note.id, author: n.author, chars: text.length });
  return { ok: true, note };
}
