import { getIdentity } from "../../../shared/identity.js";
import { seal, open } from "./crypto.js";

// Shared edit attribution, separate from usage telemetry. Identity labels
// are encrypted with the module's existing display-name encryption.
export async function encodeEditor() {
  const identity = await getIdentity().catch(() => ({}));
  return {
    n: await seal(identity?.displayName || identity?.win || "Unknown user"),
    at: new Date().toISOString(),
  };
}

export async function decodeEditor(editor) {
  if (!editor) return null;
  return { label: (await open(editor.n)) || "Unknown user", at: editor.at || null };
}

export function editorText(editor) {
  if (!editor) return "Last saved by: unavailable for this older record";
  const date = new Date(editor.at || NaN);
  return `Last saved by ${editor.label || "Unknown user"}${Number.isNaN(date.getTime()) ? "" : ` · ${date.toLocaleString()}`}`;
}
