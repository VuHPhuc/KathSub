// Cancelling a running job (audio extraction, Whisper, translation). main.js gives each job an AbortController;
// the services check its signal between steps and throw an error marked `cancelled` so the UI can tell
// "the user stopped it" apart from a real failure.

const CANCELLED_MESSAGE = 'Đã hủy';

function cancelledError() {
  return Object.assign(new Error(CANCELLED_MESSAGE), { cancelled: true });
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelledError();
}

// What a service returns instead of { success: false, error } when the user cancelled
const CANCELLED_RESULT = Object.freeze({ success: false, cancelled: true, error: CANCELLED_MESSAGE });

module.exports = { cancelledError, throwIfCancelled, CANCELLED_RESULT };
