// modules/costinventory/lib/timeout.js
//
// Edge freezes background tabs that have been idle for a while, and
// chrome.scripting.executeScript against a frozen tab never settles — it does
// not throw, it just never comes back, taking the whole pull with it and
// leaving the UI spinning forever. Every executeScript in this module goes
// through withTimeout so a wedged tab becomes a message instead of a hang.

export function withTimeout(promise, ms, message) {
  let timer;
  const bomb = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message + " (waited " + Math.round(ms / 1000) + "s)")), ms);
  });
  return Promise.race([promise, bomb]).finally(() => clearTimeout(timer));
}

/**
 * Is this tab still answering? A frozen tab fails this quickly, which is the
 * signal to open a fresh one rather than reuse it.
 */
export async function tabResponds(tabId, ms = 5000) {
  try {
    await withTimeout(
      chrome.scripting.executeScript({ target: { tabId }, func: () => true }),
      ms,
      "tab did not respond");
    return true;
  } catch {
    return false;
  }
}
