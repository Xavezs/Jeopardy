import React, { useState } from "react";
import { createPortal } from "react-dom";
import ShopModal from "./ShopModal";

/* =========================================================================
   ShopWidget
   Fixed bottom-left corner button (mirrors PlayerBgmWidget's bottom-right)
   that opens the ShopModal. Portaled to document.body for the same reason
   as PlayerBgmWidget — escapes any overflow-clipping ancestor.

   Works on all three screens:
     - PlayerView   (passes discordUserId so wallet is fetched)
     - JeopardyBoard host view (same)
     - RoleSelect   (discordUserId may be null — shop still opens but
                     wallet fetch will 401 gracefully until they log in)
   ========================================================================= */
export default function ShopWidget({ discordUserId, onChanged }) {
  const [open, setOpen] = useState(false);

  return createPortal(
    <>
      <div className="shop-widget">
        <button
          type="button"
          className="shop-widget-btn"
          onClick={() => setOpen((v) => !v)}
          title="Shop"
          aria-label="Open cosmetics shop"
        >
          {/* Simple shopping bag SVG — no emoji */}
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z" />
            <path d="M3 6h18" />
            <path d="M16 10a4 4 0 0 1-8 0" />
          </svg>
        </button>
      </div>

      {open && (
        <ShopModal
          discordUserId={discordUserId}
          onChanged={onChanged}
          onClose={() => setOpen(false)}
        />
      )}
    </>,
    document.body
  );
}
