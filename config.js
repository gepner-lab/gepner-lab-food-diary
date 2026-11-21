// ============================================================================
// STUDY CONFIGURATION  —  the only file the research team needs to edit.
// ============================================================================
window.STUDY_CONFIG = {
    // URL of the Google Apps Script web app (ends with /exec).
    // Leave empty ('') to run in local-only demo mode (no cloud upload).
    BACKEND_URL: 'https://script.google.com/macros/s/AKfycbxZ3Sm7mqnu3CnrobkeiUaQXmqC_dR-nnnTw6c739bEYQ3yE199Mr6wru3So52f0ss8/exec',

    // Must match the STUDY_KEY script property in the Apps Script project.
    // Blocks random traffic; it is NOT a password (anyone can read this file).
    STUDY_KEY: 'c3deb09b6a9d4815a1c5',

    // PIN the researcher types to reveal nutrition values for an RT (blinded)
    // participant. Keeps participants from peeking by accident; not real security.
    RESEARCHER_PIN: '',

    // How often (ms) to retry uploading meals that have not synced yet.
    SYNC_RETRY_MS: 60000
};
