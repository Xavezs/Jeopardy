/* =========================================================================
   STORAGE — public entry point
   Re-exports the three separated concerns below as one surface, so nothing
   elsewhere in the app needs to change its import path (still
   `from "./lib/storage"` / `from "../lib/storage"`, now resolving to this
   folder's index.js instead of a single storage.js file).

   - kvStore.js      → localStorage wrapper + in-memory fallback
   - mediaStore.js   → IndexedDB blob storage + media-type detection
   - sessionStore.js → session data shape, migration, and CRUD
   ========================================================================= */
export { requestPersistentStorage } from "./kvStore";

export {
  MediaStore,
  isMediaRef,
  detectMediaTypeFromFile,
  detectMediaTypeFromUrl,
  getMediaUrl,
} from "./mediaStore";

export {
  newId,
  timestamp,
  blankClue,
  blankCategory,
  defaultSessionData,
  SessionStore,
  migrateClueSchemaIfNeeded,
} from "./sessionStore";